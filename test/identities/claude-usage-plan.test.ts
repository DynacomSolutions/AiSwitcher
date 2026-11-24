import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLastGood } from "../../src/cli/limits/claude-limits.ts";
import { PLAN_TTL_MS, claudePlanLabel, claudePlanLabelFor, fetchMemberUsage } from "../../src/identities/claude-usage-api.ts";
import { claudeAdapter } from "../../src/identities/pool/claude-adapter.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ais-plan-"));
  const configDir = join(root, "acct");
  mkdirSync(configDir, { recursive: true });
  // The login's saved fields say Pro: the plan must come from the profile, not from here.
  writeFileSync(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "access-SYNTHETIC_FIXTURE", refreshToken: "refresh-SYNTHETIC_FIXTURE", expiresAt: Date.now() + 3600_000, scopes: ["x"], subscriptionType: "pro" } }));
  return { identity: { name: "acct", label: "Acct", configDir }, cacheDir: join(root, "cache"), claudeRegistryPath: join(root, "identities.json") };
}

const usage = { five_hour: { utilization: 40 }, seven_day: { utilization: 10 } };

function fake(profile: () => Response) {
  const calls = { profile: 0 };
  const fetchImpl = (async (url: unknown) => {
    if (String(url).endsWith("/api/oauth/profile")) {
      calls.profile++;
      return profile();
    }
    return Response.json(usage);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("a live read carries the plan from the profile, and an upgrade shows after the plan TTL", async () => {
  const { identity, cacheDir, claudeRegistryPath } = setup();
  let org = { organization_type: "claude_pro", rate_limit_tier: "default_claude_ai" };
  const { fetchImpl, calls } = fake(() => Response.json({ organization: org }));
  let now = Date.parse("2026-11-24T00:00:00.000Z");
  const deps = { fetchImpl, cacheDir, claudeRegistryPath, noRefresh: true, fresh: true, now: () => now };
  expect((await claudeAdapter.fetchUsage(identity, deps)).plan).toMatchObject({ type: "claude_pro", tier: "default_claude_ai" });
  // Upgraded upstream. Within the TTL the plan is not read again.
  org = { organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" };
  now += 60_000;
  expect((await fetchMemberUsage(identity, deps)).plan?.type).toBe("claude_pro");
  expect(calls.profile).toBe(1);
  now += PLAN_TTL_MS;
  expect((await fetchMemberUsage(identity, deps)).plan).toMatchObject({ type: "claude_max", tier: "default_claude_max_20x" });
  expect(calls.profile).toBe(2);
});

test("a failed profile read keeps the last plan, marked stale, and is not retried at every poll", async () => {
  const { identity, cacheDir, claudeRegistryPath } = setup();
  let ok = true;
  const { fetchImpl, calls } = fake(() => (ok ? Response.json({ organization: { organization_type: "claude_max" } }) : new Response("{}", { status: 429 })));
  let now = Date.parse("2026-11-24T00:00:00.000Z");
  const deps = { fetchImpl, cacheDir, claudeRegistryPath, noRefresh: true, fresh: true, now: () => now };
  await fetchMemberUsage(identity, deps);
  ok = false;
  now += PLAN_TTL_MS + 1;
  expect((await fetchMemberUsage(identity, deps)).plan).toMatchObject({ type: "claude_max", stale: true });
  now += 60_000;
  expect((await fetchMemberUsage(identity, deps)).plan).toMatchObject({ type: "claude_max", stale: true });
  expect(calls.profile).toBe(2);
});

test("no plan is made up when the profile never answered", async () => {
  const { identity, cacheDir, claudeRegistryPath } = setup();
  const { fetchImpl } = fake(() => new Response("{}", { status: 500 }));
  const u = await fetchMemberUsage(identity, { fetchImpl, cacheDir, claudeRegistryPath, noRefresh: true, fresh: true });
  expect(u.status).toBe("live");
  expect(u.plan).toBeUndefined();
});

describe("claudePlanLabel", () => {
  test("maps the known profile plans to short display labels", () => {
    expect(claudePlanLabel({ type: "claude_max", tier: "default_claude_max_20x" })).toBe("Max 20x");
    expect(claudePlanLabel({ type: "claude_max", tier: "default_claude_max_5x" })).toBe("Max 5x");
    expect(claudePlanLabel({ type: "claude_max" })).toBe("Max");
    expect(claudePlanLabel({ type: "claude_pro", tier: "default_claude_ai" })).toBe("Pro");
    expect(claudePlanLabel({ type: "claude_team" })).toBe("Team");
    expect(claudePlanLabel({ type: "claude_enterprise" })).toBe("Enterprise");
  });

  test("an unknown plan type yields undefined, never a guess", () => {
    expect(claudePlanLabel({ type: "claude_future" })).toBeUndefined();
    expect(claudePlanLabel({ type: "" })).toBeUndefined();
  });
});

describe("claudePlanLabelFor", () => {
  test("reads the label through the shared plan reader and reuses its hourly cache", async () => {
    const { identity, cacheDir, claudeRegistryPath } = setup();
    const { fetchImpl, calls } = fake(() => Response.json({ organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" } }));
    const deps = { fetchImpl, cacheDir, claudeRegistryPath, noRefresh: true };
    expect(await claudePlanLabelFor(identity, deps)).toBe("Max 20x");
    expect(await claudePlanLabelFor(identity, deps)).toBe("Max 20x");
    expect(calls.profile).toBe(1);
  });

  test("a profile that never answered yields undefined", async () => {
    const { identity, cacheDir, claudeRegistryPath } = setup();
    const { fetchImpl } = fake(() => new Response("{}", { status: 500 }));
    expect(await claudePlanLabelFor(identity, { fetchImpl, cacheDir, claudeRegistryPath, noRefresh: true })).toBeUndefined();
  });

  test("a live usage read writes the plan label into the shared last-good file", async () => {
    const { identity, cacheDir, claudeRegistryPath } = setup();
    const { fetchImpl } = fake(() => Response.json({ organization: { organization_type: "claude_team" } }));
    await fetchMemberUsage(identity, { fetchImpl, cacheDir, claudeRegistryPath, noRefresh: true, fresh: true });
    expect((await loadLastGood(identity, cacheDir))?.plan).toBe("Team");
  });
});
