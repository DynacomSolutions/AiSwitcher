import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_RESETS_URL, CLAUDE_RESETS_USER_AGENT, fetchMemberUsage } from "../../src/identities/claude-usage-api.ts";
import { claudeAdapter } from "../../src/identities/pool/claude-adapter.ts";
import { usageFromLimits } from "../../src/identities/pool/grant-file-adapter.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ais-grants-"));
  const configDir = join(root, "acct");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "access-SYNTHETIC_FIXTURE", refreshToken: "refresh-SYNTHETIC_FIXTURE", expiresAt: Date.now() + 3600_000, scopes: ["x"] } }));
  return { identity: { name: "acct", label: "Acct", configDir }, cacheDir: join(root, "cache"), claudeRegistryPath: join(root, "identities.json") };
}

const usage = { five_hour: { utilization: 40 }, seven_day: { utilization: 100 } };
const cedar = { eligible: true, grants: [{ id: "full-reset-2611", label: "Full reset", resets_left: 2, usable_now: true }] };

test("the gateway usage poll reads the reset grants (cedar_ember) and carries them", async () => {
  const { identity, cacheDir, claudeRegistryPath } = setup();
  const seen: Array<{ url: string; ua: string | null }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), ua: new Headers(init?.headers).get("user-agent") });
    return Response.json({ ...usage, cedar_ember: cedar });
  }) as unknown as typeof fetch;
  const poll = await claudeAdapter.fetchUsage(identity, { fetchImpl, cacheDir, claudeRegistryPath, noRefresh: true, fresh: true });
  expect(seen.filter((r) => !r.url.endsWith("/api/oauth/profile"))).toEqual([{ url: CLAUDE_RESETS_URL, ua: CLAUDE_RESETS_USER_AGENT }]);
  expect(poll.status).toBe("live");
  expect(poll.manualReset).toMatchObject({ availableCount: 2, label: "Full reset", grants: [{ id: "full-reset-2611", kind: "full", resetsLeft: 2, usableNow: true }] });
});

test("a read that omits cedar_ember keeps the last grants, marked stale, with nothing counted", async () => {
  const { identity, cacheDir, claudeRegistryPath } = setup();
  let body: unknown = { ...usage, cedar_ember: cedar };
  const fetchImpl = (async () => Response.json(body)) as unknown as typeof fetch;
  const deps = { fetchImpl, cacheDir, claudeRegistryPath, noRefresh: true, fresh: true };
  await fetchMemberUsage(identity, deps);
  body = usage;
  const next = await fetchMemberUsage(identity, deps);
  expect(next.manualReset).toMatchObject({ availableCount: 0, stale: true, grants: [{ id: "full-reset-2611" }] });
});

test("a read with no grants and none before carries none", async () => {
  const { identity, cacheDir, claudeRegistryPath } = setup();
  const fetchImpl = (async () => Response.json(usage)) as unknown as typeof fetch;
  expect((await fetchMemberUsage(identity, { fetchImpl, cacheDir, claudeRegistryPath, fresh: true })).manualReset).toBeUndefined();
});

test("usageFromLimits carries manualReset additively", () => {
  const manualReset = { availableCount: 1 };
  const win = { label: "week", category: "week" as const, usedPercent: 10 };
  expect(usageFromLimits([{ status: "live", windows: [win], manualReset }]).manualReset).toEqual(manualReset);
  expect(usageFromLimits([{ status: "live", windows: [win] }]).manualReset).toBeUndefined();
});

test("usageFromLimits carries the plan label of a live read", () => {
  const win = { label: "week", category: "week" as const, usedPercent: 10 };
  expect(usageFromLimits([{ status: "live", windows: [win], plan: "Standard" }]).planLabel).toBe("Standard");
  expect(usageFromLimits([{ status: "live", windows: [win] }]).planLabel).toBeUndefined();
  expect(usageFromLimits([{ status: "unavailable", windows: [], plan: "Standard" }]).planLabel).toBeUndefined();
});
