import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistKimiCredentials } from "../../../src/cli/limits/kimi-store.ts";
import { refreshIdentityOAuthGrant } from "../../../src/identities/oauth-refresh.ts";
import { grantFileTuning, withToolLock, type GrantFileSpec } from "../../../src/identities/pool/grant-file-adapter.ts";
import { kimiAdapter } from "../../../src/identities/pool/kimi-adapter.ts";
import { readSwapEvents } from "../../../src/identities/pool/ledger.ts";
import { adapterFor } from "../../../src/identities/pool/registry.ts";
import { PoolSwapScheduler } from "../../../src/identities/pool/scheduler.ts";
import { performPoolSwap } from "../../../src/identities/pool/swap.ts";
import { requirePool } from "../../../src/identities/pool/swap-pool.ts";
import { KIMI_CONFIG, PI_CONFIG } from "../../../src/identities/tool-configs.ts";
import { loadIdentitiesFile } from "../../../src/identities/store.ts";
import type { Identity } from "../../../src/identities/types.ts";

let root: string;
let registry: string;
let ledger: string;
const saved = { kimi: KIMI_CONFIG.identitiesJsonPath, pi: PI_CONFIG.identitiesJsonPath };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-kimi-pool-"));
  registry = join(root, "kimi-identities.json");
  ledger = join(root, "kimi-swap.jsonl");
  grantFileTuning.healRetryMs = 0;
  // kimi-store resolves both registries by name: keep every lookup inside the temp dir.
  (KIMI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = registry;
  (PI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = join(root, "pi-identities.json");
});
afterEach(async () => {
  (KIMI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = saved.kimi;
  (PI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = saved.pi;
  await rm(root, { recursive: true, force: true });
});

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** Runtime-built fake JWT carrying a user_id claim. */
const jwt = (user: string, iat: number, claim = "user_id") => `${b64({ alg: "none" })}.${b64({ [claim]: user, iat, exp: iat + 900 })}.SYNTHETIC_FIXTURE`;

/** Fake kimi-code.json text for `user`, expiring at epoch second `exp`. */
function creds(user: string, exp: number, options: { tag?: string; refreshUser?: string; extra?: Record<string, unknown> } = {}): string {
  const tag = options.tag ?? `${user}-${exp}`;
  return JSON.stringify({
    access_token: jwt(user, exp - 900),
    refresh_token: options.refreshUser ? jwt(options.refreshUser, exp - 900) : `SYNTHETIC_FIXTURE-rt-${tag}`,
    expires_at: exp,
    scope: "kimi-code",
    token_type: "Bearer",
    ...options.extra,
  }, null, 2);
}

const dirOf = (name: string) => join(root, name);
const credPath = (name: string) => join(dirOf(name), "credentials", "kimi-code.json");
const put = async (name: string, text: string) => { await mkdir(join(dirOf(name), "credentials"), { recursive: true }); await writeFile(credPath(name), text); };
const read = (name: string) => readFile(credPath(name), "utf8");
const refreshToken = async (name: string) => (JSON.parse(await read(name)) as { refresh_token: string }).refresh_token;
const T0 = 1_789_200_000;

async function setup(active: string | undefined = "a"): Promise<void> {
  const member = (name: string) => ({ name, label: name, configDir: dirOf(name) });
  await writeFile(registry, JSON.stringify({ version: 1, identities: [member("a"), member("b"), { ...member("pool"), swapPool: { accounts: ["a", "b"], ...(active ? { active } : {}) } }] }));
  await put("a", creds("user-a", T0));
  await put("b", creds("user-b", T0));
  await put("pool", creds("user-a", T0));
}

const swap = (target: string) => performPoolSwap(kimiAdapter, { registryPath: registry, ledgerPath: ledger, pool: "pool", target, reason: "manual" });

async function healPool() {
  const file = await loadIdentitiesFile(registry);
  const pool = requirePool(file, "pool", "kimi");
  const members = pool.swapPool.accounts.map((n) => file.identities.find((i) => i.name === n)!);
  return kimiAdapter.heal!(pool, members);
}

const member = (name: string): Identity => ({ name, label: name, configDir: dirOf(name) });

describe("kimi adapter identity and registration", () => {
  test("is registered, live-swap, with heal and a member rule", () => {
    expect(adapterFor("kimi")).toBe(kimiAdapter);
    expect(kimiAdapter.liveSwap).toBe(true);
    expect(typeof kimiAdapter.heal).toBe("function");
    expect(kimiAdapter.notifySwapped).toBeUndefined();
  });

  test("member validation needs an OAuth login whose token names an account", async () => {
    await setup();
    expect(kimiAdapter.memberProblem!(member("a"))).toBeUndefined();
    await put("none", JSON.stringify({ access_token: "", refresh_token: "", expires_at: 0 })); // revoked tombstone
    expect(kimiAdapter.memberProblem!(member("none"))).toContain("no Kimi OAuth login");
    expect(kimiAdapter.memberProblem!(member("missing"))).toContain("no Kimi OAuth login");
    await put("opaque", JSON.stringify({ access_token: "SYNTHETIC_FIXTURE-opaque", refresh_token: "SYNTHETIC_FIXTURE-rt", expires_at: T0 }));
    expect(kimiAdapter.memberProblem!(member("opaque"))).toContain("unattributable");
    await put("hyb", creds("user-a", T0, { refreshUser: "user-b" }));
    expect(kimiAdapter.memberProblem!(member("hyb"))).toContain("unattributable");
  });

  test("fetchUsage maps the limits windows", async () => {
    const m = member("a");
    const win = (usedPercent: number) => ({ label: "w", category: "session" as const, usedPercent });
    const base = { toolName: "kimi" as const, identity: m };
    const usage = (windows: ReturnType<typeof win>[], status: "live" | "unavailable" = "live") => kimiAdapter.fetchUsage(m, { fetchKimiLimits: async () => ({ ...base, windows, status, ...(status === "unavailable" ? { error: "nope" } : {}) }) });
    expect(await usage([win(10), win(42)])).toMatchObject({ status: "live", maxUtilization: 42 });
    expect(await usage([win(100)])).toMatchObject({ status: "rate-limited", maxUtilization: 100 });
    expect(await usage([], "unavailable")).toMatchObject({ status: "unavailable", error: "nope" });
  });
});

describe("kimi swapCredentials write and verify", () => {
  test("swaps A to B to A, writing A's newer pool grant back to A's vault at 0600", async () => {
    await setup();
    await put("pool", creds("user-a", T0 + 100, { tag: "a-refreshed", extra: { scope: "kept" } })); // a session refreshed A in the pool
    const toB = await swap("b");
    expect(toB).toMatchObject({ from: "a", to: "b", writeBack: "written", noop: false });
    expect(await refreshToken("a")).toBe("SYNTHETIC_FIXTURE-rt-a-refreshed");
    expect(await read("pool")).toBe(await read("b"));
    expect((await stat(credPath("pool"))).mode & 0o777).toBe(0o600);

    const back = await swap("a");
    expect(back).toMatchObject({ from: "b", to: "a", writeBack: "none-identical" });
    expect(await refreshToken("pool")).toBe("SYNTHETIC_FIXTURE-rt-a-refreshed");
    expect((await readSwapEvents(ledger)).map(({ from, to }) => `${from}>${to}`)).toEqual(["a>b", "b>a"]);
    expect(requirePool(await loadIdentitiesFile(registry), "pool", "kimi").swapPool.active).toBe("a");
  });

  test("a pool grant older than its vault is not written back", async () => {
    await setup();
    await put("pool", creds("user-a", T0 - 100, { tag: "a-old" }));
    expect((await swap("b")).writeBack).toBe("none-member-newer");
    expect(await refreshToken("a")).toBe(`SYNTHETIC_FIXTURE-rt-user-a-${T0}`);
  });

  test("never writes the pool grant to a member holding a different account; keeps a 0600 backup", async () => {
    await setup();
    await put("pool", creds("user-c", T0 + 500));
    const before = { a: await read("a"), b: await read("b") };
    expect((await swap("b")).writeBack).toBe("none-unknown-owner");
    expect(await read("a")).toBe(before.a);
    expect(await read("b")).toBe(before.b);
    const bak = `${credPath("pool")}.pre-swap.bak`;
    expect(await readFile(bak, "utf8")).toContain("SYNTHETIC_FIXTURE-rt-user-c-");
    expect((await stat(bak)).mode & 0o777).toBe(0o600);
  });

  test("a hybrid pool file is backed up and never attributed", async () => {
    await setup();
    await put("pool", creds("user-a", T0 + 500, { refreshUser: "user-b" }));
    expect((await swap("b")).writeBack).toBe("none-account-mismatch");
    expect(await refreshToken("a")).toBe(`SYNTHETIC_FIXTURE-rt-user-a-${T0}`);
  });

  test("rejects a target without a login and leaves the pool alone", async () => {
    await setup();
    await put("b", JSON.stringify({ access_token: "", refresh_token: "" }));
    await expect(swap("b")).rejects.toThrow(/no usable Kimi login/);
    expect(await read("pool")).toBe(await read("a"));
  });

  test("bootstraps an empty pool, swapping to the pool's own account does not deadlock", async () => {
    await setup(undefined);
    await rm(join(dirOf("pool"), "credentials"), { recursive: true });
    expect(kimiAdapter.hasCredentials(dirOf("pool"))).toBe(false);
    expect((await swap("a")).writeBack).toBe("none-no-live-credentials");
    expect(kimiAdapter.hasCredentials(dirOf("pool"))).toBe(true);
    await put("pool", creds("user-a", T0 + 100, { tag: "a-pool" }));
    expect((await swap("a")).writeBack).toBe("written");
  });

  test("a stale tool lock is broken, a fresh one blocks the swap", async () => {
    await setup();
    const lock = join(dirOf("pool"), "oauth", "kimi-code.lock");
    await mkdir(lock, { recursive: true });
    grantFileTuning.toolLockWaitMs = 200;
    await expect(swap("b")).rejects.toThrow(/lock .* busy/);
    expect(await read("pool")).toBe(await read("a"));
    const old = new Date(Date.now() - 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(lock, old, old);
    expect((await swap("b")).noop).toBe(false);
    grantFileTuning.toolLockWaitMs = 3_000;
  });
});

describe("kimi swap to the account the pool holds", () => {
  test("a newer pool grant written back to the vault is what ends up in the pool (no spent refresh token)", async () => {
    await setup();
    await put("pool", creds("user-a", T0 + 100, { tag: "a-rt2" }));
    expect((await swap("a")).writeBack).toBe("written");
    expect(await refreshToken("a")).toBe("SYNTHETIC_FIXTURE-rt-a-rt2");
    expect(await refreshToken("pool")).toBe("SYNTHETIC_FIXTURE-rt-a-rt2");
  });
});

describe("tool lock upkeep", () => {
  const fake = { label: "T", toolLock: (dir: string) => ({ path: join(dir, "x.lock"), staleMs: 5_000 }) } as unknown as GrantFileSpec;
  const mtime = async (path: string) => (await stat(path)).mtimeMs;

  test("the held lock's mtime is refreshed so the CLI never sees it as stale", async () => {
    grantFileTuning.toolLockUpdateMs = 30;
    const lock = join(root, "x.lock");
    await withToolLock(fake, root, async () => {
      const first = await mtime(lock);
      await new Promise((r) => setTimeout(r, 250));
      expect(await mtime(lock)).toBeGreaterThan(first + 60);
    });
    grantFileTuning.toolLockUpdateMs = undefined;
    await expect(stat(lock)).rejects.toThrow();
  });

  test("a lock that now belongs to someone else is not removed on release", async () => {
    grantFileTuning.toolLockUpdateMs = 30;
    const lock = join(root, "x.lock");
    await withToolLock(fake, root, async () => {
      await rm(lock, { recursive: true });
      await mkdir(lock);
      const theirs = new Date(Date.now() - 2_000);
      await utimes(lock, theirs, theirs);
      await new Promise((r) => setTimeout(r, 100));
    });
    grantFileTuning.toolLockUpdateMs = undefined;
    expect((await stat(lock)).isDirectory()).toBe(true);
  });
});

describe("kimi heal", () => {
  test("restores an empty or partial file from the active vault", async () => {
    await setup();
    for (const broken of ["", '{"access_tok']) {
      await put("pool", broken);
      expect((await healPool()).join(" ")).toContain('restored "a"');
      expect(await read("pool")).toBe(await read("a"));
    }
    expect(await healPool()).toEqual([]);
  });

  test("a foreign account is captured into its member vault when newer, then the active one is restored", async () => {
    await setup();
    await put("pool", creds("user-b", T0 + 300, { tag: "b-newer" }));
    expect((await healPool()).join(" ")).toContain('captured it into "b"');
    expect(await refreshToken("b")).toBe("SYNTHETIC_FIXTURE-rt-b-newer");
    expect(await read("pool")).toBe(await read("a"));
  });

  test("an older foreign grant leaves the vault alone; a non-member account is kept as a 0600 backup", async () => {
    await setup();
    await put("pool", creds("user-b", T0 - 300, { tag: "b-older" }));
    await healPool();
    expect(await refreshToken("b")).toBe(`SYNTHETIC_FIXTURE-rt-user-b-${T0}`);
    await put("pool", creds("user-c", T0 + 1, { tag: "c1" }));
    expect((await healPool()).join(" ")).toContain("not a member");
    const bak = `${credPath("pool")}.pre-heal.bak`;
    expect(await readFile(bak, "utf8")).toContain("SYNTHETIC_FIXTURE-rt-c1");
    expect((await stat(bak)).mode & 0o777).toBe(0o600);
    expect(await read("pool")).toBe(await read("a"));
  });

  test("a hybrid file (access and refresh name different accounts) is backed up at 0600 and restored", async () => {
    await setup();
    await put("pool", creds("user-b", T0 + 50, { refreshUser: "user-a" }));
    expect((await healPool()).join(" ")).toContain("hybrid");
    const bak = `${credPath("pool")}.pre-heal.bak`;
    expect((await stat(bak)).mode & 0o777).toBe(0o600);
    expect(await read("pool")).toBe(await read("a"));
  });

  test("a revoked tombstone written by the CLI is restored from the vault", async () => {
    await setup();
    await put("pool", JSON.stringify({ access_token: "", refresh_token: "", expires_at: 0, scope: "kimi-code" }));
    expect((await healPool()).join(" ")).toContain('restored "a"');
    expect(await read("pool")).toBe(await read("a"));
  });

  test("same account, pool newer: written back to the vault, never restored over; vault newer: pool caught up", async () => {
    await setup();
    await put("pool", creds("user-a", T0 + 400, { tag: "a-rotated" }));
    expect((await healPool()).join(" ")).toContain("write-back: written");
    expect(await refreshToken("a")).toBe("SYNTHETIC_FIXTURE-rt-a-rotated");
    expect(await healPool()).toEqual([]);
    await put("a", creds("user-a", T0 + 900, { tag: "a-member-refresh" })); // a member refresh that missed the pool
    expect((await healPool()).join(" ")).toContain("behind");
    expect(await read("pool")).toBe(await read("a"));
  });

  test("refresh-during-swap race: A's in-flight refresh lands after the swap to B; it is captured into A and B restored", async () => {
    await setup();
    await swap("b");
    await put("pool", creds("user-a", T0 + 900, { tag: "a-late" })); // the old session saves its rotated tokens
    expect((await healPool()).join(" ")).toContain('captured it into "a"');
    expect(await refreshToken("a")).toBe("SYNTHETIC_FIXTURE-rt-a-late");
    expect(await read("pool")).toBe(await read("b"));
  });

  test("heal re-reads a damaged file after a delay before restoring (mid-write)", async () => {
    await setup();
    await put("pool", "");
    grantFileTuning.healRetryMs = 150;
    const rotated = creds("user-a", T0 + 700, { tag: "a-rotated" });
    setTimeout(() => { void writeFile(credPath("pool"), rotated); }, 100);
    expect((await healPool()).join(" ")).toContain("write-back: written");
    expect(await refreshToken("a")).toBe("SYNTHETIC_FIXTURE-rt-a-rotated");
  });

  test("the scheduler heals live-swap pools every tick, even with auto off", async () => {
    await setup();
    await put("pool", "");
    const logs: string[] = [];
    const sched = new PoolSwapScheduler({ adapters: () => [kimiAdapter], perTool: { kimi: { registryPath: registry, ledgerPath: ledger } }, log: (m) => logs.push(m) });
    await sched.tick(1_000_000);
    expect(await read("pool")).toBe(await read("a"));
    expect(logs.join("\n")).toContain("kimi-swap: pool pool credentials were empty or partial");
  });
});

describe("kimi pool refresh integration", () => {
  const NOW = T0 + 10;

  test("the pool identity is never refreshed itself", async () => {
    await setup();
    const pool = (await loadIdentitiesFile(registry)).identities.find((i) => i.name === "pool")!;
    const r = await refreshIdentityOAuthGrant("kimi", pool, { force: true, fetchImpl: (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch, now: () => NOW * 1000 });
    expect(r.outcome).toBe("no-grant");
    expect(r.detail).toContain("refreshed through that member");
  });

  test("a member refresh is written through to the pool only while that member is active and the pool holds its account", async () => {
    await setup();
    const rotated = (user: string, tag: string) => ({ access_token: jwt(user, NOW), refresh_token: `SYNTHETIC_FIXTURE-rt-${tag}`, expires_at: NOW + 900 });
    await persistKimiCredentials(member("a"), "kimi", rotated("user-a", "a-rot1"));
    expect(await refreshToken("a")).toBe("SYNTHETIC_FIXTURE-rt-a-rot1");
    expect(await refreshToken("pool")).toBe("SYNTHETIC_FIXTURE-rt-a-rot1");
    // b is not the active member: its refresh must leave the pool alone.
    await persistKimiCredentials(member("b"), "kimi", rotated("user-b", "b-rot1"));
    expect(await refreshToken("pool")).toBe("SYNTHETIC_FIXTURE-rt-a-rot1");
    // The pool holds another account than the active member's (a swap landed meanwhile): not overwritten.
    await put("pool", creds("user-b", T0 + 50, { tag: "b-in-pool" }));
    await persistKimiCredentials(member("a"), "kimi", rotated("user-a", "a-rot2"));
    expect(await refreshToken("pool")).toBe("SYNTHETIC_FIXTURE-rt-b-in-pool");
  });
});
