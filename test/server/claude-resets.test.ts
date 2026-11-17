import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchClaudeLimits, loadLastGood, saveLastGood } from "../../src/cli/limits/claude-limits.ts";
import { createApp } from "../../src/server/app.ts";
import { CLAUDE_PROFILE_URL, claudeResetUrl, useClaudeReset } from "../../src/server/claude-resets.ts";
import { HttpError } from "../../src/server/types.ts";
import type { Identity } from "../../src/identities/types.ts";

const ACCESS = "access-SYNTHETIC_FIXTURE";
const ORG = "org-uuid-SYNTHETIC_FIXTURE";
const GRANT = "full-reset-2611-SYNTHETIC_FIXTURE";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ais-reset-"));
  const configDir = join(root, "acct");
  mkdirSync(configDir, { recursive: true });
  const expiresAt = Date.now() + 3600_000;
  writeFileSync(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: ACCESS, refreshToken: "refresh-SYNTHETIC_FIXTURE", expiresAt, scopes: ["x"] } }));
  const identity: Identity = { name: "acct", label: "Acct", configDir };
  return { root, identity, cacheDir: join(root, "cache"), claudeRegistryPath: join(root, "identities.json") };
}

describe("useClaudeReset", () => {
  test("reads the org from the profile and posts the grant with the account's own token", async () => {
    const { identity, cacheDir, claudeRegistryPath } = setup();
    await saveLastGood(identity, {
      toolName: "claude",
      identity,
      windows: [{ label: "week (all)", category: "week", usedPercent: 100 }],
      status: "live",
      capturedAt: new Date().toISOString(),
      manualReset: { availableCount: 1, grants: [{ id: GRANT, kind: "full", resetsLeft: 1, usableNow: true, paused: false }] },
    }, cacheDir);
    const calls: { url: string; method: string; auth: string | null; body?: unknown }[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      calls.push({ url: String(url), method: init?.method ?? "GET", auth: h.get("authorization"), ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
      if (String(url) === CLAUDE_PROFILE_URL) return Response.json({ organization: { uuid: ORG } });
      return Response.json({ result: "reset", grant_id: GRANT, resets_left: 0, cleared: ["weekly_all"], cooldown_until: "2026-11-13T00:00:00Z" });
    }) as unknown as typeof fetch;
    const r = await useClaudeReset("acct", GRANT, { resolveIdentity: async () => identity, fetchImpl, cacheDir, claudeRegistryPath, newRequestId: () => "req-SYNTHETIC_FIXTURE" });
    expect(r).toEqual({ identity: "acct", grantId: GRANT, result: "reset", resetsLeft: 0, cleared: ["weekly_all"], cooldownUntil: "2026-11-13T00:00:00Z" });
    expect(calls.map((c) => [c.method, c.url])).toEqual([["GET", CLAUDE_PROFILE_URL], ["POST", claudeResetUrl(ORG)]]);
    expect(calls.every((c) => c.auth === `Bearer ${ACCESS}`)).toBe(true);
    expect(calls[1]!.body).toEqual({ program: "cedar_ember", grant_id: GRANT, request_id: "req-SYNTHETIC_FIXTURE" });
    const cached = (await loadLastGood(identity, cacheDir))?.manualReset;
    expect(cached).toMatchObject({ availableCount: 0, cooldownUntil: "2026-11-13T00:00:00Z", grants: [{ id: GRANT, resetsLeft: 0, usableNow: false }] });
  });

  test("after a spend the next limits read goes to Anthropic for the cleared windows and keeps the spent count", async () => {
    const { identity, cacheDir, claudeRegistryPath } = setup();
    await saveLastGood(identity, {
      toolName: "claude",
      identity,
      windows: [{ label: "week (all)", category: "week", usedPercent: 100 }],
      status: "live",
      capturedAt: new Date().toISOString(),
      manualReset: { availableCount: 2, grantsCapturedAt: new Date().toISOString(), grants: [{ id: GRANT, kind: "full", resetsLeft: 2, usableNow: true, paused: false }] },
    }, cacheDir);
    const fetchImpl = (async (url: unknown) =>
      String(url) === CLAUDE_PROFILE_URL ? Response.json({ organization: { uuid: ORG } }) : Response.json({ result: "reset", grant_id: GRANT, resets_left: 1, cleared: ["weekly_all"] })) as unknown as typeof fetch;
    await useClaudeReset("acct", GRANT, { resolveIdentity: async () => identity, fetchImpl, cacheDir, claudeRegistryPath });
    expect((await loadLastGood(identity, cacheDir))?.status).toBe("cached");

    let reads = 0;
    const reconcile = async () => undefined as never;
    // Anthropic leaves cedar_ember out once the account is clear of its limit: the spent count is carried from the cache.
    const after = await fetchClaudeLimits(identity, { reconcile, cacheDir, fetchBody: async () => (reads++, { body: { seven_day: { utilization: 0, resets_at: "2026-11-20T00:00:00Z" } } }) });
    expect(reads).toBe(1);
    expect(after.status).toBe("live");
    expect(after.windows.find((w) => w.category === "week")?.usedPercent).toBe(0);
    expect(after.manualReset?.grants?.[0]).toMatchObject({ id: GRANT, resetsLeft: 1 });

    // Anthropic refusing the read still shows the spent count, never the pre-spend one.
    await useClaudeReset("acct", GRANT, { resolveIdentity: async () => identity, fetchImpl, cacheDir, claudeRegistryPath });
    const refused = await fetchClaudeLimits(identity, { reconcile, cacheDir, fetchBody: async () => ({ error: "usage endpoint answered HTTP 429", status: 429 }) });
    expect(refused.status).toBe("cached");
    expect(refused.manualReset?.grants?.[0]).toMatchObject({ id: GRANT, resetsLeft: 1 });
  });

  test("refusals are honest and never reach Anthropic for a bad grant id, pool or retired identity", async () => {
    const { identity, cacheDir, claudeRegistryPath } = setup();
    let hits = 0;
    const refuse = (async (url: unknown) => {
      hits++;
      if (String(url) === CLAUDE_PROFILE_URL) return Response.json({ organization: { uuid: ORG } });
      return Response.json({ error: { type: "invalid_request_error", message: "cooldown active" } }, { status: 409 });
    }) as unknown as typeof fetch;
    const deps = { fetchImpl: refuse, cacheDir, claudeRegistryPath };
    const err = await useClaudeReset("acct", GRANT, { ...deps, resolveIdentity: async () => identity }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect((err as HttpError).message).toContain("cooldown active");
    expect((err as HttpError).message).not.toContain(ACCESS);
    hits = 0;
    await expect(useClaudeReset("acct", "bad id/..", { ...deps, resolveIdentity: async () => identity })).rejects.toThrow("invalid grant id");
    await expect(useClaudeReset("acct", GRANT, { ...deps, resolveIdentity: async () => ({ ...identity, retired: true }) })).rejects.toThrow("retired");
    await expect(useClaudeReset("acct", GRANT, { ...deps, resolveIdentity: async () => ({ ...identity, swapPool: { accounts: ["a"] } }) as Identity })).rejects.toThrow("swap pool");
    expect(hits).toBe(0);
  });

  test("the route needs the console header and reaches the seam", async () => {
    const seen: string[] = [];
    let invalidated = 0;
    const app = createApp({
      token: "t", port: 47129, startedAt: Date.now(), peerAddress: "127.0.0.1", peerPort: 50000, peerUid: () => process.getuid?.(),
      claudeUseReset: async (identity, grant) => {
        seen.push(`${identity}:${grant}`);
        if (grant === "refused") throw new HttpError(409, "Anthropic refused the reset (HTTP 409)");
        return { identity, grantId: grant, result: "reset", cleared: [] };
      },
      invalidateLimits: () => void invalidated++,
    });
    const path = `/api/limits/claude/acct/resets/${GRANT}`;
    expect((await app.request(path, { method: "POST", headers: { Host: "127.0.0.1:47129" } })).status).toBe(403);
    const ok = await app.request(path, { method: "POST", headers: { Host: "127.0.0.1:47129", "X-AIS-Console": "1" } });
    expect(ok.status).toBe(200);
    expect(seen).toEqual([`acct:${GRANT}`]);
    // The page refetches limits next: the cached read must not answer it.
    expect(invalidated).toBe(1);
    const refused = await app.request("/api/limits/claude/acct/resets/refused", { method: "POST", headers: { Host: "127.0.0.1:47129", "X-AIS-Console": "1" } });
    expect(refused.status).toBe(409);
    expect(invalidated).toBe(1);
  });
});
