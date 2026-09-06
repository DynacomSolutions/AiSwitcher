import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchClaudeLimits,
  overageFromExtraUsage,
  readClaudeCredentialState,
  windowsFromUsageResponse,
  type ClaudeUsageResponseWire,
} from "../../../src/cli/limits/claude-limits.ts";
import type { Identity } from "../../../src/identities/types.ts";

/** fetchClaudeLimits does real filesystem I/O against the identity's
 * configDir, so exercise it against real temp dirs (the same convention as
 * test/cli/doctor/collect.test.ts), never the user's actual identities. */
const tempDirs: string[] = [];

const realFetch = globalThis.fetch;
const realSleep = Bun.sleep;
const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

afterEach(async () => {
  globalThis.fetch = realFetch;
  Bun.sleep = realSleep;
  fetchCalls.length = 0;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Stub fetch to answer with the given responder, recording every call so
 * the no-request states (wiped file, locally-expired token) can assert the
 * probe NEVER even attempted the API call. Bun.sleep is collapsed so
 * http.ts's backoff pauses don't slow the network-error cases. */
function stubFetch(respond: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), ...(init !== undefined ? { init } : {}) });
    return respond(String(url));
  }) as typeof fetch;
  Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;
}

async function makeConfigDir(credentials?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-claude-limits-test-"));
  tempDirs.push(dir);
  if (credentials !== undefined) {
    await writeFile(join(dir, ".credentials.json"), JSON.stringify(credentials));
  }
  return dir;
}

function identity(configDir: string): Identity {
  return { name: "personal", label: "Personal", configDir };
}

/** The wipe signature, verbatim from the live machine 2026-09-07: both
 * token fields empty, expiresAt 0, metadata preserved. */
const WIPED_CREDENTIALS = {
  claudeAiOauth: {
    accessToken: "",
    refreshToken: "",
    expiresAt: 0,
    refreshTokenExpiresAt: 1790794435676,
    scopes: ["user:file_upload", "user:inference", "user:mcp_servers", "user:profile", "user:sessions:claude_code"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
  },
};

function validCredentials(expiresAt: number): unknown {
  return {
    claudeAiOauth: {
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      expiresAt,
      scopes: ["user:inference"],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    },
  };
}

/** Same formatting the adapter itself applies, recomputed here so the
 * assertions pin the ISO->display-string mapping without hardcoding one
 * machine's locale output (same convention as kimi-limits.test.ts). */
function expectedResetsAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

describe("readClaudeCredentialState", () => {
  test("a missing credentials file is the absent state", async () => {
    const dir = await makeConfigDir();
    expect(await readClaudeCredentialState(dir)).toEqual({ kind: "absent" });
  });

  test("a file without a claudeAiOauth block is the no-oauth state (API-key/console billing)", async () => {
    const dir = await makeConfigDir({ someOtherKey: true });
    expect(await readClaudeCredentialState(dir)).toEqual({ kind: "no-oauth" });
  });

  test("the wipe signature (tokens empty, expiresAt 0, metadata kept) is the wiped state", async () => {
    const dir = await makeConfigDir(WIPED_CREDENTIALS);
    expect(await readClaudeCredentialState(dir)).toEqual({ kind: "wiped" });
  });

  test("a usable token reads back with its expiry", async () => {
    const dir = await makeConfigDir(validCredentials(1893456000000));
    expect(await readClaudeCredentialState(dir)).toEqual({
      kind: "oauth",
      accessToken: "test-access-token",
      expiresAtMs: 1893456000000,
    });
  });

  test("a corrupt file throws rather than being guessed at", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ais-claude-limits-test-"));
    tempDirs.push(dir);
    await writeFile(join(dir, ".credentials.json"), "{not json");
    await expect(readClaudeCredentialState(dir)).rejects.toThrow(/could not parse credentials file/);
  });
});

describe("windowsFromUsageResponse", () => {
  test("maps the realistic live payload to the report's established labels, in UI order", () => {
    const payload: ClaudeUsageResponseWire = {
      five_hour: { utilization: 6, resets_at: "2026-09-07T19:20:00.000000Z" },
      seven_day: { utilization: 30, resets_at: "2026-09-11T00:00:00.000000Z" },
      seven_day_sonnet: { utilization: 12, resets_at: "2026-09-11T00:00:00.000000Z" },
      seven_day_opus: { utilization: 0, resets_at: null },
    };
    expect(windowsFromUsageResponse(payload)).toEqual([
      { label: "session (5h)", category: "session", usedPercent: 6, resetsAt: expectedResetsAt("2026-09-07T19:20:00.000000Z") },
      { label: "week (all)", category: "week", usedPercent: 30, resetsAt: expectedResetsAt("2026-09-11T00:00:00.000000Z") },
      { label: "week (Sonnet)", category: "week", usedPercent: 12, resetsAt: expectedResetsAt("2026-09-11T00:00:00.000000Z") },
      { label: "week (Opus)", category: "week", usedPercent: 0, resetsAt: undefined },
    ]);
  });

  test("null windows and null utilizations are omitted, matching the binary's own UI rule", () => {
    const payload: ClaudeUsageResponseWire = {
      five_hour: null,
      seven_day: { utilization: null, resets_at: "2026-09-11T00:00:00.000000Z" },
      seven_day_sonnet: { utilization: 40, resets_at: null },
    };
    expect(windowsFromUsageResponse(payload)).toEqual([
      { label: "week (Sonnet)", category: "week", usedPercent: 40, resetsAt: undefined },
    ]);
  });

  test("unknown keys (cinder_cove, limits, seven_day_oauth_apps) are tolerated and ignored", () => {
    const payload = {
      five_hour: { utilization: 1, resets_at: null },
      seven_day_oauth_apps: { utilization: 99, resets_at: null },
      cinder_cove: { anything: true },
      limits: [],
    } as unknown as ClaudeUsageResponseWire;
    expect(windowsFromUsageResponse(payload)).toEqual([
      { label: "session (5h)", category: "session", usedPercent: 1, resetsAt: undefined },
    ]);
  });

  test("a utilization outside 0-100 is clamped, and an unparseable resets_at yields no resetsAt", () => {
    const payload: ClaudeUsageResponseWire = {
      five_hour: { utilization: 120, resets_at: "not a date" },
      seven_day: { utilization: -5, resets_at: null },
    };
    const windows = windowsFromUsageResponse(payload);
    expect(windows[0]).toMatchObject({ label: "session (5h)", usedPercent: 100, resetsAt: undefined });
    expect(windows[1]).toMatchObject({ label: "week (all)", usedPercent: 0 });
  });

  test("an empty payload yields no windows", () => {
    expect(windowsFromUsageResponse({})).toEqual([]);
  });
});

describe("overageFromExtraUsage", () => {
  test("no extra_usage block at all yields undefined (not a confirmed zero)", () => {
    expect(overageFromExtraUsage(undefined)).toBeUndefined();
  });

  test("a disabled_reason or a null monthly_limit is a confirmed-zero not-available state", () => {
    expect(
      overageFromExtraUsage({ monthly_limit: 20, used_credits: 0, utilization: 0, currency: "USD", disabled_reason: "seat_ineligible" }),
    ).toEqual({ active: false, label: "extra usage not available on this seat", spentUsd: 0 });
    expect(
      overageFromExtraUsage({ monthly_limit: null, used_credits: 0, utilization: null, currency: null, disabled_reason: null }),
    ).toEqual({ active: false, label: "extra usage not available on this seat", spentUsd: 0 });
  });

  test("a monthly limit with nothing used is a confirmed-zero subscription-only state", () => {
    expect(
      overageFromExtraUsage({ monthly_limit: 20, used_credits: 0, utilization: 0, currency: "USD", disabled_reason: null }),
    ).toEqual({ active: false, label: "subscription only", spentUsd: 0 });
    expect(
      overageFromExtraUsage({ monthly_limit: 20, used_credits: null, utilization: null, currency: "USD", disabled_reason: null }),
    ).toEqual({ active: false, label: "subscription only", spentUsd: 0 });
  });

  test("used_credits > 0 is active but label-only (the field's units are unconfirmed, so no spentUsd)", () => {
    expect(
      overageFromExtraUsage({ monthly_limit: 20, used_credits: 4.2, utilization: 21, currency: "USD", disabled_reason: null }),
    ).toEqual({ active: true, label: "using extra usage" });
  });
});

describe("fetchClaudeLimits", () => {
  test("a missing credentials file reports not authenticated, without any API call", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    const result = await fetchClaudeLimits(identity(await makeConfigDir()));
    expect(result).toMatchObject({ toolName: "claude", status: "unavailable", windows: [], error: "not authenticated" });
    expect(fetchCalls).toHaveLength(0);
  });

  test("a file without claudeAiOauth reports no subscription rate-limit data, without any API call", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    const result = await fetchClaudeLimits(identity(await makeConfigDir({ mcpOAuth: {} })));
    expect(result.status).toBe("unavailable");
    expect(result.error).toContain("no subscription rate-limit data");
    expect(fetchCalls).toHaveLength(0);
  });

  test("a wiped credentials file reports the re-login state, without any API call", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    const result = await fetchClaudeLimits(identity(await makeConfigDir(WIPED_CREDENTIALS)));
    expect(result.status).toBe("unavailable");
    expect(result.error).toBe(
      "credentials invalidated by a failed token refresh: run `claude auth login` under this identity to re-authenticate",
    );
    expect(fetchCalls).toHaveLength(0);
  });

  test("a locally-expired access token reports the expired state and NEVER makes the API call (never refreshes)", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    const result = await fetchClaudeLimits(identity(await makeConfigDir(validCredentials(Date.now() - 60_000))));
    expect(result.status).toBe("unavailable");
    expect(result.error).toBe("access token expired: run `claude` once interactively under this identity to refresh");
    expect(fetchCalls).toHaveLength(0);
  });

  test("a 401 from the endpoint is terminal (no retry, no refresh) and reports the expired state", async () => {
    stubFetch(() => new Response("Unauthorized", { status: 401 }));
    const result = await fetchClaudeLimits(identity(await makeConfigDir(validCredentials(Date.now() + 3_600_000))));
    expect(result.status).toBe("unavailable");
    expect(result.error).toBe("access token expired: run `claude` once interactively under this identity to refresh");
    expect(fetchCalls).toHaveLength(1);
  });

  test("a 403 is treated exactly like a 401", async () => {
    stubFetch(() => new Response("Forbidden", { status: 403 }));
    const result = await fetchClaudeLimits(identity(await makeConfigDir(validCredentials(Date.now() + 3_600_000))));
    expect(result.status).toBe("unavailable");
    expect(result.error).toBe("access token expired: run `claude` once interactively under this identity to refresh");
  });

  test("a network failure reports a clear fetch error (after http.ts's backoff retries)", async () => {
    stubFetch(() => {
      throw new Error("The operation timed out.");
    });
    const result = await fetchClaudeLimits(identity(await makeConfigDir(validCredentials(Date.now() + 3_600_000))));
    expect(result.status).toBe("unavailable");
    expect(result.error).toContain("usage fetch failed: The operation timed out.");
  });

  test("a non-auth HTTP error status is reported with the status", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    const result = await fetchClaudeLimits(identity(await makeConfigDir(validCredentials(Date.now() + 3_600_000))));
    expect(result.status).toBe("unavailable");
    expect(result.error).toBe("usage fetch failed (HTTP 500)");
  });

  test("the happy path returns live windows with the OAuth headers and the extra_usage overage", async () => {
    const payload = {
      five_hour: { utilization: 6, resets_at: "2026-09-07T19:20:00.000000Z" },
      seven_day: { utilization: 30, resets_at: "2026-09-11T00:00:00.000000Z" },
      seven_day_sonnet: { utilization: null, resets_at: null },
      extra_usage: { monthly_limit: 20, used_credits: 0, utilization: 0, currency: "USD", disabled_reason: null },
    };
    stubFetch(() => new Response(JSON.stringify(payload), { status: 200 }));
    const result = await fetchClaudeLimits(identity(await makeConfigDir(validCredentials(Date.now() + 3_600_000))));

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://api.anthropic.com/api/oauth/usage");
    const headers = fetchCalls[0]!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-access-token");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");

    expect(result.status).toBe("live");
    expect(result.capturedAt).toBeDefined();
    expect(result.windows).toEqual([
      { label: "session (5h)", category: "session", usedPercent: 6, resetsAt: expectedResetsAt("2026-09-07T19:20:00.000000Z") },
      { label: "week (all)", category: "week", usedPercent: 30, resetsAt: expectedResetsAt("2026-09-11T00:00:00.000000Z") },
    ]);
    expect(result.overage).toEqual({ active: false, label: "subscription only", spentUsd: 0 });
  });

  test("a successful response with no usable windows reports no subscription rate-limit data", async () => {
    stubFetch(() => new Response(JSON.stringify({ five_hour: null, seven_day: null }), { status: 200 }));
    const result = await fetchClaudeLimits(identity(await makeConfigDir(validCredentials(Date.now() + 3_600_000))));
    expect(result.status).toBe("unavailable");
    expect(result.error).toContain("no subscription rate-limit data");
  });
});
