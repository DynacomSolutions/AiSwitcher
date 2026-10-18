import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsp from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeMemberAt, decideWriteBack, performSwap, readSwapEvents } from "../../src/identities/claude-swap.ts";
import { withClaudeLocks, withOauthRefreshLock, SwapLockError } from "../../src/identities/claude-swap-lock.ts";
import { chooseBest, swapIfLimited } from "../../src/identities/claude-swap-ops.ts";
import { parseUsageBody, fetchMemberUsage, fetchMemberResets, fetchUsageBodyWithResets, manualResetFromCedarEmber, extraUsageFromBody, CLAUDE_RESETS_USER_AGENT } from "../../src/identities/claude-usage-api.ts";
import { refreshIdentityOAuthGrant, writeGrantThroughStores, convergeClaudePoolStores } from "../../src/identities/oauth-refresh.ts";
import { PI_CONFIG } from "../../src/identities/tool-configs.ts";
import { chmod, utimes } from "node:fs/promises";
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
  test("a target without oauthAccount removes the pool's previous one", async () => {
    await writeRegistry();
    await writeFile(join(root, "b", ".claude.json"), JSON.stringify({ theme: "light" }));
    const r = await performSwap({ registryPath: registry, ledgerPath: ledger, target: "b", reason: "manual" });
    expect(r.notes.join(" ")).toContain("previous oauthAccount was removed");
    const cj = await read(join(root, "pool", ".claude.json"));
    expect(cj.oauthAccount).toBeUndefined();
    expect(cj.theme).toBe("dark");
    expect((await read(join(root, "pool", ".credentials.json"))).claudeAiOauth.accessToken).toBe("at-b1");
  });

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

describe("held lock vs Claude Code's stale rule", () => {
  const waitFor = async (cond: () => Promise<boolean>, ms = 3000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) if (await cond()) return true;
    return false;
  };

  test("mtime is refreshed while held, so it never looks stale", async () => {
    const dir = join(root, "held");
    const lock = join(dir, ".oauth_refresh.lock");
    await withOauthRefreshLock(dir, async () => {
      const first = (await stat(lock)).mtimeMs;
      expect(await waitFor(async () => (await stat(lock)).mtimeMs > first)).toBe(true);
    }, { updateMs: 20 });
    await expect(stat(lock)).rejects.toThrow();
  });

  test("release never races an in-flight touch: no leaked lock dir", async () => {
    const dir = join(root, "race");
    const lock = join(dir, ".oauth_refresh.lock");
    for (let i = 0; i < 500; i++) {
      await withOauthRefreshLock(dir, () => new Promise<void>((r) => setTimeout(r, Math.random() * 3)), { updateMs: 1 });
      await expect(stat(lock)).rejects.toThrow();
    }
  });

  test("release leaves a lock that Claude Code broke and re-took, and the caller sees the loss", async () => {
    const dir = join(root, "stolen");
    const lock = join(dir, ".oauth_refresh.lock");
    let lost = false;
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      await withOauthRefreshLock(dir, async (handle) => {
        await rm(lock, { recursive: true });
        await mkdir(lock); // Claude Code's re-acquired lock
        // Coarse-mtime filesystems may reuse the inode and the mtime: make the replacement distinguishable.
        const later = new Date(Date.now() + 2000);
        await utimes(lock, later, later);
        lost = await waitFor(async () => handle.isLost());
      }, { updateMs: 10 });
    } finally {
      console.warn = warn;
    }
    expect(lost).toBe(true);
    expect((await stat(lock)).isDirectory()).toBe(true);
  });

  test("a transient stat failure after a touch does not mark the lock lost", async () => {
    const dir = join(root, "flaky-stat");
    const lock = join(dir, ".oauth_refresh.lock");
    const real = fsp.stat;
    let calls = 0;
    let failed = false;
    const spy = spyOn(fsp, "stat").mockImplementation((async (...args: Parameters<typeof real>) => {
      calls++;
      // 1: acquire, 2: tick compare, 3: tick read-back after utimes -> fail once
      if (calls === 3 && !failed) { failed = true; throw Object.assign(new Error("EIO"), { code: "EIO" }); }
      return real(...args);
    }) as typeof real);
    try {
      await withOauthRefreshLock(dir, async (handle) => {
        await new Promise((r) => setTimeout(r, 150));
        expect(failed).toBe(true);
        expect(handle.isLost()).toBe(false);
      }, { updateMs: 20 });
    } finally {
      spy.mockRestore();
    }
    await expect(real(lock)).rejects.toThrow();
  });

  test("a 30s-old .oauth_refresh.lock is fresh (Claude Code 2.1.295 stale is 60s)", async () => {
    const dir = join(root, "fresh-refresh");
    const lock = join(dir, ".oauth_refresh.lock");
    await mkdir(lock, { recursive: true });
    const old = new Date(Date.now() - 30_000);
    await utimes(lock, old, old);
    const err = await withOauthRefreshLock(dir, async () => undefined, { timeoutMs: 200 }).catch((e) => e);
    expect(err).toBeInstanceOf(SwapLockError);
    expect((err as SwapLockError).timedOut).toBe(true);
    expect((await stat(lock)).isDirectory()).toBe(true);
  });

  test("a 15s-old .claude.json.lock is stale (10s) and broken", async () => {
    const dir = join(root, "stale-json");
    await mkdir(join(dir, ".claude.json.lock"), { recursive: true });
    const old = new Date(Date.now() - 15_000);
    await utimes(join(dir, ".claude.json.lock"), old, old);
    let ran = false;
    await withClaudeLocks(dir, async () => { ran = true; }, { timeoutMs: 500 });
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

  test("a swap landing while refresh waits for the pool lock never copies the other account into the member", async () => {
    await writeRegistry();
    const a = (await loadIdentitiesFile(registry)).identities.find((i) => i.name === "a")!;
    const seen: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: { body?: URLSearchParams }) => {
      seen.push(String(init?.body?.get("refresh_token")));
      return new Response(JSON.stringify({ access_token: "at-a3", refresh_token: "rt-a3", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    let pending: Promise<{ outcome: string }> | undefined;
    // Simulate `ais claude-swap` a -> b: pool lock held, b's grant + account written, registry saved afterwards.
    await withOauthRefreshLock(join(root, "pool"), async () => {
      pending = refreshIdentityOAuthGrant("claude", a, { fetchImpl, claudeRegistryPath: registry, now: () => NOW_S * 1000 });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await writeFile(join(root, "pool", ".credentials.json"), cred("at-b2", "rt-b2", NOW_S + 8 * 3600));
      await writeFile(join(root, "pool", ".claude.json"), claudeJson("uuid-b"));
    });
    await writeRegistry({ active: "b" });
    const out = await pending!;
    expect(out.outcome).toBe("refreshed");
    expect(seen).toEqual(["rt-a1"]);
    expect((await read(join(root, "a", ".credentials.json"))).claudeAiOauth.refreshToken).toBe("rt-a3");
    expect((await read(join(root, "pool", ".credentials.json"))).claudeAiOauth.refreshToken).toBe("rt-b2");
  });

  test("lock timeout is timedOut; a mkdir failure is not and still throws out of refresh", async () => {
    await writeRegistry();
    await withOauthRefreshLock(join(root, "a"), async () => {
      const err = await withOauthRefreshLock(join(root, "a"), async () => undefined, { timeoutMs: 100 }).catch((e) => e);
      expect(err).toBeInstanceOf(SwapLockError);
      expect(err.timedOut).toBe(true);
    });
    if (process.getuid?.() === 0) return; // root ignores directory permissions
    const a = (await loadIdentitiesFile(registry)).identities.find((i) => i.name === "a")!;
    await chmod(join(root, "pool"), 0o500);
    try {
      const err = await refreshIdentityOAuthGrant("claude", a, { claudeRegistryPath: registry, now: () => NOW_S * 1000, fetchImpl: (async () => { throw new Error("must not call"); }) as unknown as typeof fetch }).catch((e) => e);
      expect(err).toBeInstanceOf(SwapLockError);
      expect(err.timedOut).toBe(false);
    } finally {
      await chmod(join(root, "pool"), 0o700);
    }
  });

  test("unlocked convergence re-checks the account under the locks (mid-swap pool is never copied into the member)", async () => {
    await writeRegistry();
    // Mid-swap: pool credentials already b's and fresher, pool .claude.json still names a.
    await writeFile(join(root, "pool", ".credentials.json"), cred("at-b2", "rt-b2", NOW_S + 8 * 3600));
    const a = (await loadIdentitiesFile(registry)).identities.find((i) => i.name === "a")!;
    // The swap holds the pool lock and finishes its .claude.json write before releasing.
    let pending: ReturnType<typeof convergeClaudePoolStores> | undefined;
    await withOauthRefreshLock(join(root, "pool"), async () => {
      pending = convergeClaudePoolStores(a, registry);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await writeFile(join(root, "pool", ".claude.json"), claudeJson("uuid-b"));
    });
    expect((await pending!).written).toEqual([]);
    expect((await read(join(root, "a", ".credentials.json"))).claudeAiOauth.refreshToken).toBe("rt-a1");
    expect((await read(join(root, "pool", ".credentials.json"))).claudeAiOauth.refreshToken).toBe("rt-b2");
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

  test("extraUsageFromBody maps the extra_usage block", () => {
    const body = (x: object) => ({ extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 500, disabled_reason: null, spend_limit_reached: false, ...x } });
    expect(extraUsageFromBody({})).toBeUndefined();
    expect(extraUsageFromBody({ extra_usage: "x" })).toBeUndefined();
    expect(extraUsageFromBody(null)).toBeUndefined();
    expect(extraUsageFromBody(body({}))).toEqual({ enabled: true, available: true, usedPercent: 25, label: "extra usage" });
    expect(extraUsageFromBody(body({ utilization: 40 }))?.usedPercent).toBe(40);
    expect(extraUsageFromBody(body({ is_enabled: false }))).toMatchObject({ enabled: false, available: false, label: "extra usage off" });
    expect(extraUsageFromBody(body({ spend_limit_reached: true }))).toMatchObject({ enabled: true, available: false, label: "out of extra usage" });
    expect(extraUsageFromBody(body({ used_credits: 2500 }))).toMatchObject({ usedPercent: 100, available: false });
    const unknown = extraUsageFromBody(body({ monthly_limit: null }));
    expect(unknown?.available).toBe(true);
    expect(unknown && "usedPercent" in unknown).toBe(false);
  });

  test("sends the bearer and beta header; 429 is reported", async () => {
    await writeRegistry();
    const b = (await loadIdentitiesFile(registry)).identities.find((i) => i.name === "b")!;
    let headers: Record<string, string> = {};
    const ok = (async (_u: unknown, init?: { headers?: Record<string, string> }) => {
      headers = init?.headers ?? {};
      return new Response(JSON.stringify({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const u = await fetchMemberUsage(b, { fetchImpl: ok, claudeRegistryPath: registry, cacheDir: join(root, "cache"), now: () => NOW_S * 1000 });
    expect(u.maxUtilization).toBe(20);
    expect(headers.Authorization).toBe("Bearer at-b1");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    const limited = (async () => new Response("", { status: 429, headers: { "retry-after": "30" } })) as unknown as typeof fetch;
    expect(await fetchMemberUsage(b, { fetchImpl: limited, claudeRegistryPath: registry, cacheDir: join(root, "cache"), now: () => NOW_S * 1000 })).toMatchObject({ status: "rate-limited", retryAfterSeconds: 30 });
  });

  test("a 429 inherits extra usage from the last good read only within 6 hours", async () => {
    await writeRegistry();
    const b = (await loadIdentitiesFile(registry)).identities.find((i) => i.name === "b")!;
    const cacheDir = join(root, "cache");
    const good = (async () =>
      new Response(JSON.stringify({ five_hour: { utilization: 100 }, seven_day: { utilization: 20 }, extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 500 } }), { status: 200 })) as unknown as typeof fetch;
    const limited = (async () => new Response("", { status: 429 })) as unknown as typeof fetch;
    const deps = { claudeRegistryPath: registry, cacheDir, now: () => NOW_S * 1000 };
    await fetchMemberUsage(b, { ...deps, fetchImpl: good });
    // Age the stored read (the token clock stays fixed so no refresh interferes).
    const file = join(cacheDir, "claude-limits", "b.json");
    const ageTo = async (hours: number) => {
      const saved = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify({ ...saved, capturedAt: new Date(NOW_S * 1000 - hours * 3600_000).toISOString() }));
    };
    await ageTo(5);
    const fresh = await fetchMemberUsage(b, { ...deps, fetchImpl: limited });
    expect(fresh).toMatchObject({ status: "rate-limited", extraUsage: { available: true, stale: true, capturedAt: new Date(NOW_S * 1000 - 5 * 3600_000).toISOString() } });
    expect(fresh.maxUtilization).toBeUndefined();
    await ageTo(7);
    const old = await fetchMemberUsage(b, { ...deps, fetchImpl: limited });
    expect(old.status).toBe("rate-limited");
    expect(old.extraUsage).toBeUndefined();
  });

  describe("cedar_ember reset grants", () => {
    const NOW = Date.parse("2026-10-11T12:00:00Z");
    const grant = {
      id: "opus55-launch-promax-20260921",
      label: "Claude Opus 5.5 launch: one usage-limit reset for Pro and Max",
      resets_total: 1,
      resets_left: 0,
      starts_at: "2026-09-22T16:00:00+00:00",
      ends_at: "2026-10-22T16:00:00+00:00",
      paused: false,
    };
    const block = (g: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ eligible: true, grants: [{ ...grant, ...g }], ...extra });

    test("maps usable grants only", () => {
      expect(manualResetFromCedarEmber(block({}), NOW)).toBeUndefined();
      const one = manualResetFromCedarEmber(block({ resets_left: 1 }), NOW);
      expect(one).toMatchObject({ availableCount: 1, label: grant.label });
      expect(one?.expiresAt).toBeTruthy();
      expect(manualResetFromCedarEmber(block({ resets_left: 1 }, { eligible: false }), NOW)).toBeUndefined();
      expect(manualResetFromCedarEmber(block({ resets_left: 1, paused: true }), NOW)).toBeUndefined();
      expect(manualResetFromCedarEmber(block({ resets_left: 1, ends_at: "2026-10-01T00:00:00Z" }), NOW)).toBeUndefined();
      for (const junk of [undefined, null, "x", {}, { eligible: true, grants: "x" }, { eligible: true, grants: [null, { resets_left: "x" }] }]) {
        expect(manualResetFromCedarEmber(junk, NOW)).toBeUndefined();
      }
    });

    test("fetchMemberResets sends the claude-cli user agent and never throws", async () => {
      await writeRegistry();
      const b = (await loadIdentitiesFile(registry)).identities.find((i) => i.name === "b")!;
      let headers: Record<string, string> = {};
      const ok = (async (_u: unknown, init?: { headers?: Record<string, string> }) => {
        headers = init?.headers ?? {};
        return new Response(JSON.stringify({ cedar_ember: block({ resets_left: 1, ends_at: "2099-01-01T00:00:00Z" }) }), { status: 200 });
      }) as unknown as typeof fetch;
      const deps = { claudeRegistryPath: registry, cacheDir: join(root, "cache"), now: () => NOW_S * 1000 };
      expect(await fetchMemberResets(b, { ...deps, fetchImpl: ok })).toMatchObject({ availableCount: 1 });
      expect(headers["User-Agent"]).toBe(CLAUDE_RESETS_USER_AGENT);
      expect(headers.Authorization).toBe("Bearer at-b1");
      const boom = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
      expect(await fetchMemberResets(b, { ...deps, fetchImpl: boom })).toBeUndefined();
    });
  });

  test("the resets request keeps the spend block (no skip_spend)", async () => {
    await writeRegistry();
    const b = (await loadIdentitiesFile(registry)).identities.find((i) => i.name === "b")!;
    let url = "";
    const fetchImpl = (async (u: unknown) => {
      url = String(u);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await fetchUsageBodyWithResets(b, { fetchImpl, claudeRegistryPath: registry, cacheDir: join(root, "cache"), now: () => NOW_S * 1000 });
    expect(url).toContain("cedar_ember=1");
    expect(url).not.toContain("skip_spend");
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
    await fetchMemberUsage(b, { fetchImpl, claudeRegistryPath: registry, cacheDir: join(root, "cache"), now: () => NOW_S * 1000 });
    expect(auth).toBe("Bearer at-new");
  });
});

describe("usage api: skipped refresh with a still-expired native store", () => {
  test("falls back to a forced refresh instead of sending the expired token", async () => {
    await writeRegistry();
    const piDir = join(root, "pi-b");
    await mkdir(piDir, { recursive: true });
    // pi holds a non-expired copy, so the unforced refresh skips; the native store stays expired.
    await writeFile(join(piDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "at-pi", refresh: "rt-b1", expires: (NOW_S + 3600) * 1000 } }));
    const piRegistry = join(root, "pi.json");
    await writeFile(piRegistry, JSON.stringify({ version: 1, identities: [{ name: "b", label: "b", configDir: piDir }] }));
    const saved = PI_CONFIG.identitiesJsonPath;
    (PI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = piRegistry;
    try {
      await writeFile(join(root, "b", ".credentials.json"), cred("at-old", "rt-b1", NOW_S - 10));
      const b = (await loadIdentitiesFile(registry)).identities.find((i) => i.name === "b")!;
      let auth = "";
      let tokenCalls = 0;
      const fetchImpl = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
        if (String(url).includes("/oauth/token")) {
          tokenCalls++;
          return new Response(JSON.stringify({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }), { status: 200 });
        }
        auth = init?.headers?.Authorization ?? "";
        return new Response(JSON.stringify({ five_hour: { utilization: 1 } }), { status: 200 });
      }) as unknown as typeof fetch;
      await fetchMemberUsage(b, { fetchImpl, claudeRegistryPath: registry, cacheDir: join(root, "cache"), now: () => NOW_S * 1000 });
      expect(tokenCalls).toBe(1);
      expect(auth).toBe("Bearer at-new");
    } finally {
      (PI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = saved;
    }
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

  test("a ledger event under the pool's former name still blocks the auto swap", async () => {
    // Pool renamed: configDir basename ("pool") is the name the ledger recorded.
    await writeRegistry({ auto: true });
    const file = await read(registry);
    file.identities.find((i: Identity) => i.name === "pool").name = "renamed-pool";
    await writeFile(registry, JSON.stringify(file));
    await writeFile(ledger, `${JSON.stringify({ ts: new Date((NOW_S - 60) * 1000).toISOString(), pool: "pool", from: "a", to: "b", reason: "auto" })}\n`);
    const deps = { registryPath: registry, ledgerPath: ledger, fetchUsage: usageMap({ a: 99, b: 0, c: 0 }), now: () => NOW_S * 1000 };
    expect((await swapIfLimited(deps, "renamed-pool", "auto")).action).toBe("cooldown");
  });

  test("below threshold does nothing; no qualifying member does nothing", async () => {
    await writeRegistry({ auto: true });
    const deps = { registryPath: registry, ledgerPath: ledger, now: () => NOW_S * 1000 };
    expect((await swapIfLimited({ ...deps, fetchUsage: usageMap({ a: 50 }) }, "pool", "auto")).action).toBe("not-limited");
    expect((await swapIfLimited({ ...deps, fetchUsage: usageMap({ a: 96, b: 96, c: 99 }) }, "pool", "auto")).action).toBe("no-candidate");
    expect(await readSwapEvents(ledger)).toHaveLength(0);
  });

  test("falls back to the least-used member when none is below the threshold", async () => {
    await writeRegistry({ auto: true });
    const deps = { registryPath: registry, ledgerPath: ledger, now: () => NOW_S * 1000 };
    // Reported scenario: active at 100, one member at 95 (5% headroom), rest at 100.
    const r = await swapIfLimited({ ...deps, fetchUsage: usageMap({ a: 100, b: 95, c: 100 }) }, "pool", "auto");
    expect(r.action === "swapped" && r.result.to).toBe("b");
  });

  test("no fallback swap when every other member is at 100 or not better than the active one", async () => {
    await writeRegistry({ auto: true });
    const deps = { registryPath: registry, ledgerPath: ledger, now: () => NOW_S * 1000 };
    expect((await swapIfLimited({ ...deps, fetchUsage: usageMap({ a: 100, b: 100, c: 100 }) }, "pool", "auto")).action).toBe("no-candidate");
    expect((await swapIfLimited({ ...deps, fetchUsage: usageMap({ a: 96, b: 97, c: 99 }) }, "pool", "auto")).action).toBe("no-candidate");
    expect((await swapIfLimited({ ...deps, fetchUsage: usageMap({ a: 96, b: 96, c: 100 }) }, "pool", "auto")).action).toBe("no-candidate");
    expect(await readSwapEvents(ledger)).toHaveLength(0);
  });

  describe("assume-limited with unknown usage", () => {
    const limited = (name: string) => name === "a" ? live(100) : { status: "rate-limited" as const, capturedAt: "x" };
    const base = () => ({ registryPath: registry, ledgerPath: ledger, now: () => NOW_S * 1000 });

    test("swaps to an unknown member when every other usage is rate-limited", async () => {
      await writeRegistry({ auto: true });
      const r = await swapIfLimited({ ...base(), fetchUsage: async (m: Identity) => limited(m.name) }, "pool", "auto", { assumeLimited: true });
      expect(r.action).toBe("swapped");
    });

    test("skips an unknown member blocked by a ledger hard limit", async () => {
      await writeRegistry({ auto: true });
      await writeFile(ledger, `${JSON.stringify({ ts: new Date((NOW_S - 600) * 1000).toISOString(), pool: "pool", from: "b", to: "a", reason: "auto", hardLimitUntilMs: (NOW_S + 3600) * 1000 })}\n`);
      const r = await swapIfLimited({ ...base(), fetchUsage: async (m: Identity) => limited(m.name) }, "pool", "auto", { assumeLimited: true });
      expect(r.action === "swapped" && r.result.to).toBe("c");
    });

    test("still no-candidate when every other member is live at 100", async () => {
      await writeRegistry({ auto: true });
      const r = await swapIfLimited({ ...base(), fetchUsage: usageMap({ a: 100, b: 100, c: 100 }) }, "pool", "auto", { assumeLimited: true });
      expect(r.action).toBe("no-candidate");
    });

    test("without assumeLimited unknown members are not chosen", async () => {
      await writeRegistry({ auto: true });
      const r = await swapIfLimited({ ...base(), fetchUsage: async (m: Identity) => limited(m.name) }, "pool", "auto");
      expect(r.action).not.toBe("swapped");
    });
  });

  test("a below-threshold member is preferred over the fallback", async () => {
    await writeRegistry({ auto: true });
    const r = await swapIfLimited({ registryPath: registry, ledgerPath: ledger, fetchUsage: usageMap({ a: 100, b: 99, c: 94 }), now: () => NOW_S * 1000 }, "pool", "auto");
    expect(r.action === "swapped" && r.result.to).toBe("c");
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
