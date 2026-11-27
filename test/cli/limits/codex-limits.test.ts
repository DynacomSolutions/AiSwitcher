import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_WHAM_USAGE_URL,
  codexPlanLabel,
  fetchCodexLimits,
  fetchCodexLimitsViaStore,
  isCodexAuthRejectionError,
  extraUsageFromCredits,
  isTransientCodexLimitsError,
  manualResetFromWire,
  overageFromSnapshot,
  type RateLimitResetCreditsWire,
  type RateLimitSnapshotWire,
} from "../../../src/cli/limits/codex-limits.ts";

describe("codexPlanLabel", () => {
  test("maps the known ChatGPT plan types to short display labels", () => {
    expect(codexPlanLabel("plus")).toBe("Plus");
    expect(codexPlanLabel("pro")).toBe("Pro");
    expect(codexPlanLabel("team")).toBe("Team");
    expect(codexPlanLabel("enterprise")).toBe("Enterprise");
    expect(codexPlanLabel("free")).toBe("Free");
    expect(codexPlanLabel("go")).toBe("Go");
    expect(codexPlanLabel("PRO")).toBe("Pro");
  });

  test("any other plan type shows the words of the wire in title case", () => {
    // Plan types that the live accounts send (seen 2026-11-25).
    expect(codexPlanLabel("promax")).toBe("Promax");
    expect(codexPlanLabel("self_serve_business_prolite")).toBe("Self Serve Business Prolite");
    // The case of the wire and the outer spaces change nothing.
    expect(codexPlanLabel("PROMAX")).toBe("Promax");
    expect(codexPlanLabel(" Self_Serve_Business_Prolite ")).toBe("Self Serve Business Prolite");
    // A space splits words in the same way as an underscore.
    expect(codexPlanLabel("business pro lite")).toBe("Business Pro Lite");
    expect(codexPlanLabel("future_tier")).toBe("Future Tier");
  });

  test("an absent, empty or placeholder plan type yields undefined, so no label is shown", () => {
    expect(codexPlanLabel(undefined)).toBeUndefined();
    expect(codexPlanLabel(null)).toBeUndefined();
    expect(codexPlanLabel("")).toBeUndefined();
    expect(codexPlanLabel("   ")).toBeUndefined();
    // A value with no word.
    expect(codexPlanLabel("_")).toBeUndefined();
    expect(codexPlanLabel(" _ ")).toBeUndefined();
    // Each placeholder word.
    expect(codexPlanLabel("unknown")).toBeUndefined();
    expect(codexPlanLabel("none")).toBeUndefined();
    expect(codexPlanLabel("null")).toBeUndefined();
    expect(codexPlanLabel("n/a")).toBeUndefined();
    expect(codexPlanLabel("-")).toBeUndefined();
    // The same words in any case and with outer spaces.
    expect(codexPlanLabel("UNKNOWN")).toBeUndefined();
    expect(codexPlanLabel(" None ")).toBeUndefined();
    expect(codexPlanLabel("Null")).toBeUndefined();
    expect(codexPlanLabel("N/A")).toBeUndefined();
    expect(codexPlanLabel(" - ")).toBeUndefined();
  });
});

/** A stand-in for `codex app-server --stdio`. It answers `initialize` with an
 * empty result and `account/rateLimits/read` with a snapshot that carries the
 * given plan type. */
const appServerStandIn = (planType: string) => `
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    const result =
      request.method === "initialize"
        ? {}
        : { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 }, secondary: { usedPercent: 20, windowDurationMins: 10080 }, planType: ${JSON.stringify(planType)} } };
    process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
  }
});
`;

describe("the plan on each limits path", () => {
  let scratch: string;
  let savedPath: string | undefined;
  const member = () => ({ name: "member", label: "member", configDir: join(scratch, "identity") });
  const memberRoot = () => join(scratch, "members");
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "ais-codex-limits-"));
    savedPath = process.env.PATH;
  });
  afterEach(async () => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await rm(scratch, { recursive: true, force: true });
  });

  test("the app-server snapshot puts the plan type of the wire on the row", async () => {
    // PATH holds only the stand-in folder, and the scratch home holds no managed binary.
    // Thus the limits read starts no real codex binary.
    const bin = join(scratch, "bin");
    await mkdir(bin);
    await writeFile(join(scratch, "stand-in.js"), appServerStandIn("promax"));
    await writeFile(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${join(scratch, "stand-in.js")}"\n`, { mode: 0o755 });
    process.env.PATH = bin;
    const r = await fetchCodexLimits(member(), { memberRoot: memberRoot() });
    expect(r.status).toBe("live");
    expect(r.plan).toBe("Promax");
  }, 20_000);

  test("the wham usage read puts the plan type of the wire on the row, and a placeholder puts none", async () => {
    await mkdir(join(memberRoot(), "codex", "member"), { recursive: true });
    await writeFile(
      join(memberRoot(), "codex", "member", "auth.json"),
      JSON.stringify({ tokens: { access_token: "SYNTHETIC_FIXTURE-codex-store-access" } }),
    );
    const primaryWindow = { used_percent: 42, limit_window_seconds: 18_000, reset_at: 1_789_200_600 };
    const read = async (planType: string) => {
      const calls: string[] = [];
      const fetchImpl = (async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({ plan_type: planType, rate_limit: { primary_window: primaryWindow } }), { status: 200 });
      }) as unknown as typeof fetch;
      const result = await fetchCodexLimitsViaStore(member(), { fetchImpl, memberRoot: memberRoot() });
      return { calls, result };
    };
    const live = await read("self_serve_business_prolite");
    expect(live.result.status).toBe("live");
    expect(live.result.plan).toBe("Self Serve Business Prolite");
    expect(live.calls).toEqual([CODEX_WHAM_USAGE_URL]);
    const placeholder = await read("unknown");
    expect(placeholder.result.status).toBe("live");
    expect("plan" in placeholder.result).toBe(false);
  });
});

describe("a rejected store login", () => {
  test("the usage read says the Codex login is dead when the gateway API reports it, and keeps the plain text otherwise", async () => {
    const root = await mkdtemp(join(tmpdir(), "ais-codex-revoked-"));
    try {
      const dir = join(root, "codex", "member");
      await mkdir(dir, { recursive: true });
      const auth = JSON.stringify({ tokens: { access_token: "SYNTHETIC_FIXTURE-access", refresh_token: "SYNTHETIC_FIXTURE-refresh" } });
      await writeFile(join(dir, "auth.json"), auth);
      const secretsPath = join(root, "secrets");
      await writeFile(secretsPath, "AIS_GATEWAY_ADMIN_URL=http://gw.invalid\nAIS_GATEWAY_ADMIN_TOKEN=SYNTHETIC_FIXTURE_token\n");
      const identity = { name: "member", label: "member", configDir: join(root, "identity") };
      const rejected = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
      const gatewayAnswering = (row: Record<string, unknown> | undefined) => ({
        secretsPath,
        fetch: (async () => Response.json({ limits: row ? [{ provider: "codex", identity: "member", status: "unavailable", windows: [], ...row }] : [] })) as unknown as typeof fetch,
      });

      const plain = await fetchCodexLimitsViaStore(identity, { fetchImpl: rejected, memberRoot: root, gateway: gatewayAnswering({}) });
      expect(plain.error).toContain("HTTP 401");

      const dead = await fetchCodexLimitsViaStore(identity, { fetchImpl: rejected, memberRoot: root, gateway: gatewayAnswering({ loginRevoked: true }) });
      expect(dead.status).toBe("unavailable");
      expect(dead.error).toBe("OpenAI rejected this Codex login. Sign in again in the AIS portal, Identities tab.");

      // The marker file is no source: this code never opens it. A marker that matches the login changes nothing.
      const { refreshFingerprint, refreshOf } = await import("../../../src/identities/gateway-routed.ts");
      const fingerprint = refreshFingerprint(refreshOf("codex", auth)!);
      await writeFile(join(dir, "login-revoked.json"), JSON.stringify({ at: "2026-11-26T22:56:00.000Z", code: "refresh_token_invalidated", fingerprint }));
      expect((await fetchCodexLimitsViaStore(identity, { fetchImpl: rejected, memberRoot: root, gateway: gatewayAnswering({}) })).error).toContain("HTTP 401");
      // A gateway that cannot be read leaves the plain text too.
      expect((await fetchCodexLimitsViaStore(identity, { fetchImpl: rejected, memberRoot: root, gateway: { secretsPath: join(root, "none") } })).error).toContain("HTTP 401");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("extraUsageFromCredits", () => {
  test("maps the credits block", () => {
    expect(extraUsageFromCredits({})).toBeUndefined();
    expect(extraUsageFromCredits({ credits: null })).toBeUndefined();
    expect(extraUsageFromCredits({ credits: { unlimited: true } })).toEqual({ enabled: true, available: true, label: "unlimited credits" });
    expect(extraUsageFromCredits({ credits: { hasCredits: true, balance: "12.5" } })).toEqual({ enabled: true, available: true, label: "credits 12.5" });
    expect(extraUsageFromCredits({ credits: { hasCredits: true, balance: null } })).toEqual({ enabled: true, available: true, label: "credits" });
    expect(extraUsageFromCredits({ credits: { hasCredits: true, balance: "0" } })?.available).toBe(false);
    expect(extraUsageFromCredits({ credits: { hasCredits: false, unlimited: false, balance: "0" } })).toEqual({ enabled: false, available: false, label: "no credits" });
  });
});

describe("overageFromSnapshot", () => {
  test("neither signal set yields undefined", () => {
    expect(overageFromSnapshot({})).toBeUndefined();
  });

  test("credits_depleted takes precedence over spendControlReached, matching deriveNote's own precedence", () => {
    const snapshot: RateLimitSnapshotWire = {
      spendControlReached: true,
      rateLimitReachedType: "workspace_owner_credits_depleted",
    };
    expect(overageFromSnapshot(snapshot)).toEqual({ active: false, label: "credits depleted" });
  });

  test("spendControlReached alone is reported with the exact wording deriveNote already uses", () => {
    expect(overageFromSnapshot({ spendControlReached: true })).toEqual({
      active: false,
      label: "spend control reached",
    });
  });

  test("a rateLimitReachedType that isn't credits_depleted (e.g. usage_limit_reached) is not treated as overage", () => {
    expect(overageFromSnapshot({ rateLimitReachedType: "usage_limit_reached" })).toBeUndefined();
  });

  test("active is always false — this signal only ever describes a blocked state, never confirmed ongoing overage", () => {
    const result = overageFromSnapshot({ spendControlReached: true });
    expect(result?.active).toBe(false);
  });
});

describe("isTransientCodexLimitsError", () => {
  test("all three observed upstream-flakiness signatures are transient", () => {
    // Representative upstream transport and timeout errors.
    expect(isTransientCodexLimitsError("failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)")).toBe(true);
    expect(isTransientCodexLimitsError("codex app-server did not respond within 30s.")).toBe(true);
    expect(isTransientCodexLimitsError("codex app-server closed its output before responding.")).toBe(true);
  });

  test("codex's semantic answers are never retried", () => {
    expect(
      isTransientCodexLimitsError("ChatGPT-plan login required (API-key auth doesn't expose rate limits)"),
    ).toBe(false);
    expect(isTransientCodexLimitsError("codex app-server returned no rate-limit data.")).toBe(false);
    expect(
      isTransientCodexLimitsError("codex reported no active rate-limit windows (primary and secondary both empty)."),
    ).toBe(false);
  });

  test("absent or unrelated errors are not transient", () => {
    expect(isTransientCodexLimitsError(undefined)).toBe(false);
    expect(isTransientCodexLimitsError("spawnSync /nonexistent ENOENT")).toBe(false);
  });
});

describe("manualResetFromWire", () => {
  /** Synthetic reset-credit fixture matching the upstream wire shape. */
  const fixtureGrant: RateLimitResetCreditsWire = {
    availableCount: 1,
    credits: [
      {
        id: "RateLimitResetCredit_SYNTHETIC_FIXTURE_001",
        resetType: "codexRateLimits",
        status: "available",
        grantedAt: 1700000000,
        expiresAt: 1702592000,
        title: "Full reset (Weekly + 5 hr)",
        description: "Thanks for using Codex! You've been granted one free rate limit reset.",
      },
    ],
  };

  test("the fixture grant maps to a count-1 manual reset with title and expiry", () => {
    expect(manualResetFromWire(fixtureGrant)).toEqual({
      availableCount: 1,
      label: "Full reset (Weekly + 5 hr)",
      expiresAt: new Date(1702592000 * 1000).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
      creditExpiries: [
        { id: "RateLimitResetCredit_SYNTHETIC_FIXTURE_001", label: "Full reset (Weekly + 5 hr)", endsAt: new Date(1702592000 * 1000).toISOString() },
      ],
    });
  });

  test("absent wire block (accounts without the concept) yields undefined", () => {
    expect(manualResetFromWire(undefined)).toBeUndefined();
    expect(manualResetFromWire({})).toBeUndefined();
  });

  test("a zero availableCount yields undefined rather than a fabricated no-resets row", () => {
    expect(manualResetFromWire({ availableCount: 0, credits: fixtureGrant.credits })).toBeUndefined();
  });

  test("a non-numeric availableCount falls back to counting status-available credits", () => {
    const wire: RateLimitResetCreditsWire = {
      credits: [
        { status: "available", title: "Full reset (Weekly + 5 hr)" },
        { status: "used", title: "Full reset (Weekly + 5 hr)" },
      ],
    };
    expect(manualResetFromWire(wire)).toEqual({ availableCount: 1, label: "Full reset (Weekly + 5 hr)" });
  });

  test("credits with a non-available status never count or supply title/expiry", () => {
    const wire: RateLimitResetCreditsWire = { availableCount: 1, credits: [{ status: "used", title: "Full reset" }] };
    expect(manualResetFromWire(wire)).toEqual({ availableCount: 1 });
  });
});

describe("isCodexAuthRejectionError", () => {
  test("matches the 401/token_expired family", () => {
    for (const error of [
      "codex request failed: HTTP 401 Unauthorized",
      "failed to fetch codex rate limits: 401 token_expired from https://chatgpt.com/backend-api/wham/usage",
      "token has expired",
      "Unauthorized (invalid access token)",
    ]) {
      expect(isCodexAuthRejectionError(error)).toBe(true);
    }
  });

  test("does not match the auth GATE or ordinary failures", () => {
    for (const error of [
      "ChatGPT-plan login required (API-key auth doesn't expose rate limits)",
      "codex app-server did not respond within 30s.",
      "error sending request for url (https://chatgpt.com/backend-api/wham/usage)",
      undefined,
    ]) {
      expect(isCodexAuthRejectionError(error)).toBe(false);
    }
  });
});
