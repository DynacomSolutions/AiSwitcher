import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeMemberAt, decideWriteBack, performSwap, readSwapEvents } from "../../src/identities/claude-swap.ts";
import { withClaudeLocks, SwapLockError } from "../../src/identities/claude-swap-lock.ts";
import { chooseBest, swapIfLimited } from "../../src/identities/claude-swap-ops.ts";
import { parseUsageBody, fetchMemberUsage } from "../../src/identities/claude-usage-api.ts";
import { refreshIdentityOAuthGrant, writeGrantThroughStores, convergeClaudePoolStores } from "../../src/identities/oauth-refresh.ts";
import { loadIdentitiesFile, parseIdentitiesFile } from "../../src/identities/store.ts";
import { validateMembers } from "../../src/identities/swap-pool.ts";
import { claudeSwapLaunchCheck } from "../../src/identities/claude-swap-launch.ts";
import { ClaudeSwapScheduler } from "../../src/server/claude-swap-auto.ts";
import { attributeLine } from "../../src/cli/claude-swap/attribution.ts";
import type { Identity, IdentitiesFile } from "../../src/identities/types.ts";

// All tokens are short synthetic strings built for this test only.
const tempDirs: string[] = [];
let root = "";
let registry = "";
let ledger = "";
const NOW_S = 1_800_000_000;

const cred = (access: string, refresh: string, expiresAtS: number) =>
  JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: expiresAtS * 1000, scopes: ["x"] } });
const claudeJson = (uuid: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: `${uuid}@example.com` }, ...extra });

async function seedMember(name: string, access: string, refresh: string, exp: number) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".credentials.json"), cred(access, refresh, exp));
  await writeFile(join(dir, ".claude.json"), claudeJson(`uuid-${name}`));
  return dir;
}

async function writeRegistry(poolExtra: Record<string, unknown> = {}) {
  const file: IdentitiesFile = {
    version: 1,
    identities: [
      { name: "a", label: "a", configDir: join(root, "a") },
      { name: "b", label: "b", configDir: join(root, "b") },
      { name: "c", label: "c", configDir: join(root, "c") },
      { name: "pool", label: "pool", configDir: join(root, "pool"), swapPool: { accounts: ["a", "b", "c"], active: "a", ...poolExtra } },
    ],
  };
  await writeFile(registry, JSON.stringify(file));
}

const read = async (p: string) => JSON.parse(await readFile(p, "utf8"));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-claude-swap-"));
  tempDirs.push(root);
  registry = join(root, "identities.json");
  ledger = join(root, "ledger.jsonl");
  await seedMember("a", "at-a1", "rt-a1", NOW_S + 1000);
  await seedMember("b", "at-b1", "rt-b1", NOW_S + 2000);
  await seedMember("c", "at-c1", "rt-c1", NOW_S + 3000);
  await mkdir(join(root, "pool"), { recursive: true });
  await writeFile(join(root, "pool", ".credentials.json"), cred("at-a1", "rt-a1", NOW_S + 1000));
  await writeFile(join(root, "pool", ".claude.json"), claudeJson("uuid-a", { theme: "dark", projects: { p: 1 } }));
});
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("registry", () => {
  test("swapPool is optional and validated structurally", () => {
    const base = { version: 1, identities: [{ name: "p", label: "p", configDir: "/x/p" }] };
    expect(parseIdentitiesFile(base).identities[0]!.swapPool).toBeUndefined();
    const withPool = (swapPool: unknown) => ({ version: 1, identities: [{ ...base.identities[0], swapPool }] });
    expect(parseIdentitiesFile(withPool({ accounts: ["a", "b"], active: "a", auto: true, thresholdPercent: 90 })).identities[0]!.swapPool!.active).toBe("a");
    expect(() => parseIdentitiesFile(withPool({ accounts: ["a"], active: "z" }))).toThrow();
    expect(() => parseIdentitiesFile(withPool({ accounts: ["a", "a"] }))).toThrow();
    expect(() => parseIdentitiesFile(withPool({ accounts: ["a"], disallowed: ["q"] }))).toThrow();
    expect(() => parseIdentitiesFile(withPool({ accounts: ["a"], thresholdPercent: 0 }))).toThrow();
  });

  test("validateMembers rejects missing, retired, pool and self members", async () => {
    await writeRegistry();
    const file = await loadIdentitiesFile(registry);
    file.identities.push({ name: "gone", label: "g", configDir: "/x", retired: true } as Identity);
    expect(validateMembers(file, "new", ["a", "b"])).toEqual(["a", "b"]);
    expect(() => validateMembers(file, "new", ["a", "nope"])).toThrow(/not an existing/);
    expect(() => validateMembers(file, "new", ["a", "gone"])).toThrow(/retired/);
    expect(() => validateMembers(file, "new", ["a", "pool"])).toThrow(/swap pool/);
    expect(() => validateMembers(file, "new", ["a"])).toThrow(/at least two/);
  });
});

describe("decideWriteBack", () => {
  const g = (access: string, refresh: string, exp: number) => ({ access_token: access, refresh_token: refresh, expires_at: exp });
  test("newer pool grant is written back; older or identical is not", () => {
    expect(decideWriteBack({ pool: g("n", "r2", 20), member: g("o", "r1", 10) })).toBe("written");
    expect(decideWriteBack({ pool: g("o", "r1", 10), member: g("n", "r2", 20) })).toBe("none-member-newer");
    expect(decideWriteBack({ pool: g("o", "r1", 10), member: g("o", "r1", 10) })).toBe("none-identical");
    expect(decideWriteBack({ member: g("o", "r1", 10) })).toBe("none-no-live-credentials");
    expect(decideWriteBack({ pool: g("n", "r2", 20), member: g("o", "r1", 10), poolAccountUuid: "x", memberAccountUuid: "y" })).toBe("none-account-mismatch");
  });
});

describe("performSwap", () => {
  test("copies credentials and oauthAccount, preserves other keys, mode 0600, persists active, logs event", async () => {
    await writeRegistry();
    const r = await performSwap({ registryPath: registry, ledgerPath: ledger, target: "b", reason: "manual" });
    expect(r).toMatchObject({ from: "a", to: "b", noop: false, writeBack: "none-identical" });
    const creds = await read(join(root, "pool", ".credentials.json"));
    expect(creds.claudeAiOauth.accessToken).toBe("at-b1");
    expect((await stat(join(root, "pool", ".credentials.json"))).mode & 0o777).toBe(0o600);
    const cj = await read(join(root, "pool", ".claude.json"));
    expect(cj.oauthAccount.accountUuid).toBe("uuid-b");
    expect(cj.theme).toBe("dark");
    expect(cj.projects).toEqual({ p: 1 });
    expect((await loadIdentitiesFile(registry)).identities.find((i) => i.name === "pool")!.swapPool!.active).toBe("b");
    const events = await readSwapEvents(ledger);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ pool: "pool", from: "a", to: "b", reason: "manual" });
    // locks released
    await expect(stat(join(root, "pool", ".oauth_refresh.lock"))).rejects.toThrow();
    await expect(stat(join(root, "pool", ".claude.json.lock"))).rejects.toThrow();
  });

  test("writes the rotated pool grant back to the active member before swapping", async () => {
    await writeRegistry();
    await writeFile(join(root, "pool", ".credentials.json"), cred("at-a2", "rt-a2", NOW_S + 5000));
    const r = await performSwap({ registryPath: registry, ledgerPath: ledger, target: "b", reason: "auto" });
    expect(r.writeBack).toBe("written");
    const a = await read(join(root, "a", ".credentials.json"));
    expect(a.claudeAiOauth.refreshToken).toBe("rt-a2");
    expect(a.claudeAiOauth.scopes).toEqual(["x"]);
  });

  test("does not write a live grant of another account back to the active member and keeps a backup", async () => {
    await writeRegistry();
    await writeFile(join(root, "pool", ".credentials.json"), cred("at-z", "rt-z", NOW_S + 9000));
    await writeFile(join(root, "pool", ".claude.json"), claudeJson("uuid-z"));
    const r = await performSwap({ registryPath: registry, ledgerPath: ledger, target: "b", reason: "manual" });
    expect(r.writeBack).toBe("none-account-mismatch");
    expect((await read(join(root, "a", ".credentials.json"))).claudeAiOauth.refreshToken).toBe("rt-a1");
    expect((await read(join(root, "pool", ".credentials.json.pre-swap.bak"))).claudeAiOauth.refreshToken).toBe("rt-z");
  });

  test("target already active with credentials in place is a no-op without an event", async () => {
    await writeRegistry();
    const r = await performSwap({ registryPath: registry, ledgerPath: ledger, target: "a", reason: "manual" });
    expect(r.noop).toBe(true);
    expect(await readSwapEvents(ledger)).toHaveLength(0);
  });

  test("disallowed account needs --force; unknown or non-member is refused", async () => {
    await writeRegistry({ disallowed: ["c"] });
    await expect(performSwap({ registryPath: registry, ledgerPath: ledger, target: "c", reason: "manual" })).rejects.toThrow(/not allowed/);
    await expect(performSwap({ registryPath: registry, ledgerPath: ledger, target: "zzz", reason: "manual" })).rejects.toThrow(/not a member/);
    const r = await performSwap({ registryPath: registry, ledgerPath: ledger, target: "c", reason: "manual", force: true });
    expect(r.to).toBe("c");
  });

  test("a member without a login fails clearly and leaves the pool untouched", async () => {
    await writeRegistry();
    await rm(join(root, "b", ".credentials.json"));
    await expect(performSwap({ registryPath: registry, ledgerPath: ledger, target: "b", reason: "manual" })).rejects.toThrow(/no usable Claude login/);
    expect((await read(join(root, "pool", ".credentials.json"))).claudeAiOauth.accessToken).toBe("at-a1");
  });

  test("fails clearly when a lock cannot be taken", async () => {
    await writeRegistry();
    await mkdir(join(root, "pool", ".oauth_refresh.lock"));
    await expect(
      performSwap({ registryPath: registry, ledgerPath: ledger, target: "b", reason: "manual", lock: { timeoutMs: 150, pollMs: 20 } }),
    ).rejects.toThrow(SwapLockError);
  });

  test("a stale lock dir is broken", async () => {
    await mkdir(join(root, "locked", ".oauth_refresh.lock"), { recursive: true });
    let ran = false;
    await withClaudeLocks(join(root, "locked"), async () => { ran = true; }, { staleMs: -1, timeoutMs: 500 });
    expect(ran).toBe(true);
  });
});

describe("ledger attribution", () => {
  test("activeMemberAt maps timestamps to members", () => {
    const events = [
      { ts: "2026-10-01T00:00:00.000Z", pool: "p", from: null, to: "a", reason: "manual" as const },
      { ts: "2026-10-02T00:00:00.000Z", pool: "p", from: "a", to: "b", reason: "auto" as const },
    ];
    expect(activeMemberAt(events, "p", Date.parse("2026-09-30T00:00:00Z"))).toBeUndefined();
    expect(activeMemberAt(events, "p", Date.parse("2026-10-01T12:00:00Z"))).toBe("a");
    expect(activeMemberAt(events, "p", Date.parse("2026-10-03T00:00:00Z"))).toBe("b");
    const line = JSON.stringify({ timestamp: "2026-10-03T00:00:00Z", message: { usage: { input_tokens: 3, output_tokens: 4 } } });
    expect(attributeLine(line, events, "p", 0)).toMatchObject({ member: "b", usage: { input: 3, output: 4 } });
  });
});

describe("refresh integration with a pool", () => {
  test("write-through updates the pool store while the member is active, not otherwise", async () => {
    await writeRegistry();
    const a = (await loadIdentitiesFile(registry)).identities.find((i) => i.name === "a")!;
    const grant = { access_token: "at-a9", refresh_token: "rt-a9", expires_at: NOW_S + 7000 };
    const report = await writeGrantThroughStores("claude", a, grant, { claudeRegistryPath: registry, piDir: "" });
    expect(report.failed).toEqual([]);
    expect((await read(join(root, "pool", ".credentials.json"))).claudeAiOauth.refreshToken).toBe("rt-a9");
    expect((await read(join(root, "a", ".credentials.json"))).claudeAiOauth.refreshToken).toBe("rt-a9");
    const b = (await loadIdentitiesFile(registry)).identities.find((i) => i.name === "b")!;
    await writeGrantThroughStores("claude", b, { access_token: "at-b9", refresh_token: "rt-b9", expires_at: NOW_S + 7000 }, { claudeRegistryPath: registry, piDir: "" });
    expect((await read(join(root, "pool", ".credentials.json"))).claudeAiOauth.refreshToken).toBe("rt-a9");
  });

  test("refresh reads the fresher pool copy (Claude rotated inside the pool) and never forks it", async () => {
    await writeRegistry();
    await writeFile(join(root, "pool", ".credentials.json"), cred("at-a2", "rt-a2", NOW_S + 5000));
    const a = (await loadIdentitiesFile(registry)).identities.find((i) => i.name === "a")!;
    const seen: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: { body?: URLSearchParams }) => {
      seen.push(String(init?.body?.get("refresh_token")));
      return new Response(JSON.stringify({ access_token: "at-a3", refresh_token: "rt-a3", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await refreshIdentityOAuthGrant("claude", a, { force: true, fetchImpl, claudeRegistryPath: registry, now: () => NOW_S * 1000 });
    expect(out.outcome).toBe("refreshed");
    expect(seen).toEqual(["rt-a2"]);
    expect((await read(join(root, "pool", ".credentials.json"))).claudeAiOauth.refreshToken).toBe("rt-a3");
    expect((await read(join(root, "a", ".credentials.json"))).claudeAiOauth.refreshToken).toBe("rt-a3");
  });

  test("converge pushes a newer member-file grant into the pool", async () => {
    await writeRegistry();
    await writeFile(join(root, "a", ".credentials.json"), cred("at-a4", "rt-a4", NOW_S + 6000));
    const a = (await loadIdentitiesFile(registry)).identities.find((i) => i.name === "a")!;
    const r = await convergeClaudePoolStores(a, registry);
    expect(r.written).toEqual([join(root, "pool")]);
    expect((await read(join(root, "pool", ".credentials.json"))).claudeAiOauth.refreshToken).toBe("rt-a4");
  });

  test("the pool identity itself is never refreshed", async () => {
    await writeRegistry();
    const pool = (await loadIdentitiesFile(registry)).identities.find((i) => i.name === "pool")!;
    const out = await refreshIdentityOAuthGrant("claude", pool, { force: true, claudeRegistryPath: registry, fetchImpl: (async () => { throw new Error("must not call"); }) as unknown as typeof fetch });
    expect(out.outcome).toBe("no-grant");
  });
});

describe("usage api", () => {
  test("parses defensively", () => {
    const u = parseUsageBody({ five_hour: { utilization: 42.5, resets_at: "2026-10-09T12:00:00Z" }, seven_day: { utilization: "80" } });
    expect(u).toMatchObject({ status: "live", maxUtilization: 80, fiveHour: { utilization: 42.5, resetsAt: "2026-10-09T12:00:00.000Z" } });
    expect(parseUsageBody({ five_hour: null }).status).toBe("unavailable");
    expect(parseUsageBody("junk").status).toBe("unavailable");
  });

  test("sends the bearer and beta header; 429 is reported", async () => {
    await writeRegistry();
    const b = (await loadIdentitiesFile(registry)).identities.find((i) => i.name === "b")!;
    let headers: Record<string, string> = {};
    const ok = (async (_u: unknown, init?: { headers?: Record<string, string> }) => {
      headers = init?.headers ?? {};
      return new Response(JSON.stringify({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const u = await fetchMemberUsage(b, { fetchImpl: ok, claudeRegistryPath: registry, now: () => NOW_S * 1000 });
    expect(u.maxUtilization).toBe(20);
    expect(headers.Authorization).toBe("Bearer at-b1");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    const limited = (async () => new Response("", { status: 429, headers: { "retry-after": "30" } })) as unknown as typeof fetch;
    expect(await fetchMemberUsage(b, { fetchImpl: limited, claudeRegistryPath: registry, now: () => NOW_S * 1000 })).toMatchObject({ status: "rate-limited", retryAfterSeconds: 30 });
  });

  test("an expired token is refreshed first", async () => {
    await writeRegistry();
    await writeFile(join(root, "b", ".credentials.json"), cred("at-old", "rt-b1", NOW_S - 10));
    const b = (await loadIdentitiesFile(registry)).identities.find((i) => i.name === "b")!;
    let auth = "";
    const fetchImpl = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      if (String(url).includes("/oauth/token")) return new Response(JSON.stringify({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }), { status: 200 });
      auth = init?.headers?.Authorization ?? "";
      return new Response(JSON.stringify({ five_hour: { utilization: 1 } }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchMemberUsage(b, { fetchImpl, claudeRegistryPath: registry, now: () => NOW_S * 1000 });
    expect(auth).toBe("Bearer at-new");
  });
});

describe("selection and auto swap", () => {
  const live = (u: number) => ({ status: "live" as const, maxUtilization: u, capturedAt: "x" });
  test("chooseBest picks most headroom under the threshold", () => {
    const rows = [{ name: "a", usage: live(97) }, { name: "b", usage: live(50) }, { name: "c", usage: live(10) }, { name: "d" }];
    expect(chooseBest(rows, { exclude: "a", belowPercent: 95, requireKnown: true })).toBe("c");
    expect(chooseBest([{ name: "a", usage: live(99) }], { belowPercent: 95, requireKnown: true })).toBeUndefined();
  });

  const usageMap = (m: { [k: string]: number }) => async (member: Identity) => live(m[member.name] ?? 0);

  test("swaps when the active member reaches the threshold, then honours the cooldown", async () => {
    await writeRegistry({ auto: true });
    const deps = { registryPath: registry, ledgerPath: ledger, fetchUsage: usageMap({ a: 96, b: 70, c: 20 }), now: () => NOW_S * 1000 };
    const first = await swapIfLimited(deps, "pool", "auto");
    expect(first.action).toBe("swapped");
    expect(first.action === "swapped" && first.result.to).toBe("c");
    const second = await swapIfLimited({ ...deps, fetchUsage: usageMap({ c: 99, a: 0 }) }, "pool", "auto");
    expect(second.action).toBe("cooldown");
  });

  test("below threshold does nothing; no qualifying member does nothing", async () => {
    await writeRegistry({ auto: true });
    const deps = { registryPath: registry, ledgerPath: ledger, now: () => NOW_S * 1000 };
    expect((await swapIfLimited({ ...deps, fetchUsage: usageMap({ a: 50 }) }, "pool", "auto")).action).toBe("not-limited");
    expect((await swapIfLimited({ ...deps, fetchUsage: usageMap({ a: 96, b: 96, c: 99 }) }, "pool", "auto")).action).toBe("no-candidate");
    expect(await readSwapEvents(ledger)).toHaveLength(0);
  });

  test("disallowed members are never chosen", async () => {
    await writeRegistry({ auto: true, disallowed: ["c"] });
    const r = await swapIfLimited({ registryPath: registry, ledgerPath: ledger, fetchUsage: usageMap({ a: 99, b: 80, c: 1 }), now: () => NOW_S * 1000 }, "pool", "auto");
    expect(r.action === "swapped" && r.result.to).toBe("b");
  });

  test("the scheduler skips non-auto pools and backs off with no candidate", async () => {
    await writeRegistry({ auto: true });
    const calls: string[] = [];
    const sched = new ClaudeSwapScheduler({
      registryPath: registry,
      random: () => 0,
      log: () => {},
      check: async (p) => { calls.push(p); return { action: "no-candidate" }; },
    });
    await sched.tick(1_000_000);
    await sched.tick(1_000_000 + 30_000);
    expect(calls).toEqual(["pool"]);
    await sched.tick(1_000_000 + 61_000);
    expect(calls).toEqual(["pool", "pool"]);
    const st = await sched.status();
    expect(st.pools[0]!.lastOutcome).toBe("no-candidate");
    expect(st.pools[0]!.backoffMs).toBeGreaterThanOrEqual(120_000);
    await writeRegistry({ auto: false });
    await sched.tick(9_000_000);
    expect(calls).toHaveLength(2);
  });
});

describe("launch check", () => {
  test("non-pools are ignored; an over-threshold pool swaps with reason launch; errors never throw", async () => {
    expect(await claudeSwapLaunchCheck({ name: "n", label: "n", configDir: join(root, "a") })).toBeUndefined();
    await writeRegistry({ auto: true });
    const pool = (await loadIdentitiesFile(registry)).identities.find((i) => i.name === "pool")!;
    const usage = async (m: Identity) => ({ status: "live" as const, maxUtilization: m.name === "a" ? 99 : 10, capturedAt: "x" });
    const note = await claudeSwapLaunchCheck(pool, { registryPath: registry, ledgerPath: ledger, fetchUsage: usage });
    expect(note).toMatch(/switched a -> /);
    expect((await readSwapEvents(ledger))[0]!.reason).toBe("launch");
    const boom = async () => { throw new Error("boom"); };
    const fresh = (await loadIdentitiesFile(registry)).identities.find((i) => i.name === "pool")!;
    expect(await claudeSwapLaunchCheck(fresh, { registryPath: registry, ledgerPath: ledger, fetchUsage: boom, now: () => NOW_S * 1000 + 99_999_999 })).toBeUndefined();
  });
});
