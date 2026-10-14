import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPiLimits } from "../../../src/cli/limits/pi-limits.ts";
import { persistKimiCredentials } from "../../../src/cli/limits/kimi-store.ts";
import { grantFileTuning } from "../../../src/identities/pool/grant-file-adapter.ts";
import { readSwapEvents } from "../../../src/identities/pool/ledger.ts";
import { piAdapter } from "../../../src/identities/pool/pi-adapter.ts";
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
  root = await mkdtemp(join(tmpdir(), "ais-pi-pool-"));
  registry = join(root, "pi-identities.json");
  ledger = join(root, "pi-swap.jsonl");
  grantFileTuning.healRetryMs = 0;
  (PI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = registry;
  (KIMI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = join(root, "kimi-identities.json");
});
afterEach(async () => {
  (KIMI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = saved.kimi;
  (PI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = saved.pi;
  await rm(root, { recursive: true, force: true });
});

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (user: string, iat: number) => `${b64({ alg: "none" })}.${b64({ user_id: user, iat, exp: iat + 900 })}.SYNTHETIC_FIXTURE`;

interface PiOptions { tag?: string; refreshUser?: string; codexExpires?: number; codexTag?: string; extra?: Record<string, unknown> }
/** Fake Pi auth.json: a Kimi OAuth entry for `user` (expires in ms), a second OAuth provider and static keys. */
function auth(user: string, exp: number, options: PiOptions = {}): string {
  const tag = options.tag ?? `${user}-${exp}`;
  return JSON.stringify({
    "kimi-coding": { type: "oauth", access: jwt(user, exp - 900), refresh: options.refreshUser ? jwt(options.refreshUser, exp - 900) : `SYNTHETIC_FIXTURE-rt-${tag}`, expires: exp * 1000 },
    "openai-codex": { type: "oauth", access: `SYNTHETIC_FIXTURE-cx-access-${options.codexTag ?? user}`, refresh: `SYNTHETIC_FIXTURE-cx-rt-${options.codexTag ?? user}`, expires: (options.codexExpires ?? exp) * 1000 },
    zai: { type: "api_key", key: `SYNTHETIC_FIXTURE-key-${user}` },
    ...options.extra,
  }, null, 2);
}

const dirOf = (name: string) => join(root, name);
const put = async (name: string, text: string) => { await mkdir(dirOf(name), { recursive: true }); await writeFile(join(dirOf(name), "auth.json"), text); };
const read = (name: string) => readFile(join(dirOf(name), "auth.json"), "utf8");
const parsed = async (name: string) => JSON.parse(await read(name)) as Record<string, Record<string, string>>;
const kimiRefresh = async (name: string) => (await parsed(name))["kimi-coding"]!.refresh;
const T0 = 1_789_200_000;

async function setup(active: string | undefined = "a"): Promise<void> {
  const member = (name: string) => ({ name, label: name, configDir: dirOf(name) });
  await writeFile(registry, JSON.stringify({ version: 1, identities: [member("a"), member("b"), { ...member("pool"), swapPool: { accounts: ["a", "b"], ...(active ? { active } : {}) } }] }));
  await put("a", auth("user-a", T0));
  await put("b", auth("user-b", T0));
  await put("pool", auth("user-a", T0));
}

const swap = (target: string) => performPoolSwap(piAdapter, { registryPath: registry, ledgerPath: ledger, pool: "pool", target, reason: "manual" });

async function healPool() {
  const file = await loadIdentitiesFile(registry);
  const pool = requirePool(file, "pool", "pi");
  const members = pool.swapPool.accounts.map((n) => file.identities.find((i) => i.name === n)!);
  return piAdapter.heal!(pool, members);
}

const member = (name: string): Identity => ({ name, label: name, configDir: dirOf(name) });

describe("pi adapter identity and registration", () => {
  test("is registered, live-swap, with heal and a member rule", () => {
    expect(adapterFor("pi")).toBe(piAdapter);
    expect(piAdapter.liveSwap).toBe(true);
    expect(typeof piAdapter.heal).toBe("function");
  });

  test("member validation needs a kimi-coding OAuth entry that names an account", async () => {
    await setup();
    expect(piAdapter.memberProblem!(member("a"))).toBeUndefined();
    await put("keys", JSON.stringify({ zai: { type: "api_key", key: "SYNTHETIC_FIXTURE-key" } }));
    expect(piAdapter.memberProblem!(member("keys"))).toContain("no Pi OAuth login");
    await put("opaque", JSON.stringify({ "kimi-coding": { type: "oauth", access: "SYNTHETIC_FIXTURE-opaque", refresh: "SYNTHETIC_FIXTURE-rt", expires: T0 * 1000 } }));
    expect(piAdapter.memberProblem!(member("opaque"))).toContain("unattributable");
    await put("hyb", auth("user-a", T0, { refreshUser: "user-b" }));
    expect(piAdapter.memberProblem!(member("hyb"))).toContain("unattributable");
    expect(piAdapter.memberProblem!(member("missing"))).toContain("no Pi OAuth login");
  });

  test("fetchUsage takes the worst window across the live Pi providers", async () => {
    const m = member("a");
    const row = (usedPercent: number, status: "live" | "unavailable" = "live") => ({ toolName: "pi" as const, provider: "kimi", identity: m, status, windows: status === "live" ? [{ label: "w", category: "session" as const, usedPercent }] : [], ...(status === "unavailable" ? { error: "nope" } : {}) });
    const usage = (rows: ReturnType<typeof row>[]) => piAdapter.fetchUsage(m, { fetchPiLimits: async () => rows });
    expect(await usage([row(10), row(42)])).toMatchObject({ status: "live", maxUtilization: 42 });
    expect(await usage([row(100)])).toMatchObject({ status: "rate-limited" });
    expect(await usage([row(0, "unavailable")])).toMatchObject({ status: "unavailable", error: "nope" });
    expect(await usage([])).toMatchObject({ status: "unavailable" });
  });

  test("limits never fetch (or refresh) a swap pool itself", async () => {
    await setup();
    const pool = (await loadIdentitiesFile(registry)).identities.find((i) => i.name === "pool")!;
    expect(await fetchPiLimits(pool)).toEqual([]);
    const [explicit] = await fetchPiLimits(pool, true);
    expect(explicit).toMatchObject({ status: "unavailable" });
    expect(await read("pool")).toBe(auth("user-a", T0));
  });
});

describe("pi swapCredentials write and verify", () => {
  test("swaps A to B to A; A's newer pool OAuth entries are written back per provider, other keys kept", async () => {
    await setup();
    // a session refreshed A's kimi-coding and openai-codex entries in the pool; the zai key in the pool is untouched
    await put("pool", auth("user-a", T0 + 100, { tag: "a-refreshed", codexTag: "a-cx2", codexExpires: T0 + 100 }));
    const toB = await swap("b");
    expect(toB).toMatchObject({ from: "a", to: "b", writeBack: "written", noop: false });
    const a = await parsed("a");
    expect(a["kimi-coding"]!.refresh).toBe("SYNTHETIC_FIXTURE-rt-a-refreshed");
    expect(a["openai-codex"]!.refresh).toBe("SYNTHETIC_FIXTURE-cx-rt-a-cx2");
    expect(a.zai!.key).toBe("SYNTHETIC_FIXTURE-key-user-a");
    expect(await read("pool")).toBe(await read("b"));
    expect((await stat(join(dirOf("pool"), "auth.json"))).mode & 0o777).toBe(0o600);

    expect(await swap("a")).toMatchObject({ from: "b", to: "a", writeBack: "none-identical" });
    expect(await kimiRefresh("pool")).toBe("SYNTHETIC_FIXTURE-rt-a-refreshed");
    expect((await readSwapEvents(ledger)).map(({ from, to }) => `${from}>${to}`)).toEqual(["a>b", "b>a"]);
  });

  test("an older pool entry never replaces a newer vault entry, and a login made inside the pool is not attributed", async () => {
    await setup();
    await put("a", auth("user-a", T0 + 500, { tag: "a-vault-newer" }));
    await put("pool", auth("user-a", T0 + 100, { tag: "a-old", extra: { opencode: { type: "oauth", access: "SYNTHETIC_FIXTURE-x", refresh: "SYNTHETIC_FIXTURE-y", expires: 1 } } }));
    expect((await swap("b")).writeBack).toBe("none-member-newer");
    expect(await kimiRefresh("a")).toBe("SYNTHETIC_FIXTURE-rt-a-vault-newer");
    expect((await parsed("a")).opencode).toBeUndefined();
  });

  test("never writes the pool grant to a member holding a different account; keeps a 0600 backup", async () => {
    await setup();
    await put("pool", auth("user-c", T0 + 500));
    const before = { a: await read("a"), b: await read("b") };
    expect((await swap("b")).writeBack).toBe("none-unknown-owner");
    expect(await read("a")).toBe(before.a);
    expect(await read("b")).toBe(before.b);
    const bak = join(dirOf("pool"), "auth.json.pre-swap.bak");
    expect(await readFile(bak, "utf8")).toContain("SYNTHETIC_FIXTURE-rt-user-c-");
    expect((await stat(bak)).mode & 0o777).toBe(0o600);
  });

  test("a hybrid pool file is never attributed", async () => {
    await setup();
    await put("pool", auth("user-a", T0 + 500, { refreshUser: "user-b" }));
    expect((await swap("b")).writeBack).toBe("none-account-mismatch");
    expect(await kimiRefresh("a")).toBe(`SYNTHETIC_FIXTURE-rt-user-a-${T0}`);
  });

  test("rejects a target without a Kimi login; bootstraps an empty pool", async () => {
    await setup(undefined);
    await put("b", JSON.stringify({ zai: { type: "api_key", key: "SYNTHETIC_FIXTURE-key" } }));
    await expect(swap("b")).rejects.toThrow(/no usable Pi login/);
    await rm(join(dirOf("pool"), "auth.json"));
    expect(piAdapter.hasCredentials(dirOf("pool"))).toBe(false);
    expect((await swap("a")).writeBack).toBe("none-no-live-credentials");
    expect(piAdapter.hasCredentials(dirOf("pool"))).toBe(true);
  });

  test("Pi's own auth.json.lock blocks the swap while held", async () => {
    await setup();
    await mkdir(join(dirOf("pool"), "auth.json.lock"));
    grantFileTuning.toolLockWaitMs = 200;
    await expect(swap("b")).rejects.toThrow(/auth\.json\.lock.* busy/);
    expect(await read("pool")).toBe(await read("a"));
    grantFileTuning.toolLockWaitMs = 3_000;
  });
});

describe("pi heal", () => {
  test("restores an empty, partial or structurally invalid file from the active vault", async () => {
    await setup();
    for (const broken of ["", '{"kimi-coding": {"type": "oau', JSON.stringify({ "kimi-coding": { type: "oauth", access: jwt("user-a", T0) } })]) {
      await put("pool", broken);
      expect((await healPool()).join(" ")).toContain('restored "a"');
      expect(await read("pool")).toBe(await read("a"));
    }
    expect(await healPool()).toEqual([]);
  });

  test("a foreign account is captured into its member vault when newer, then the active one is restored", async () => {
    await setup();
    await put("pool", auth("user-b", T0 + 300, { tag: "b-newer" }));
    expect((await healPool()).join(" ")).toContain('captured it into "b"');
    expect(await kimiRefresh("b")).toBe("SYNTHETIC_FIXTURE-rt-b-newer");
    expect(await read("pool")).toBe(await read("a"));
  });

  test("a non-member account is kept as a 0600 backup", async () => {
    await setup();
    await put("pool", auth("user-c", T0 + 1, { tag: "c1" }));
    expect((await healPool()).join(" ")).toContain("not a member");
    const bak = join(dirOf("pool"), "auth.json.pre-heal.bak");
    expect(await readFile(bak, "utf8")).toContain("SYNTHETIC_FIXTURE-rt-c1");
    expect((await stat(bak)).mode & 0o777).toBe(0o600);
    expect(await read("pool")).toBe(await read("a"));
  });

  test("a hybrid file is backed up at 0600 and restored", async () => {
    await setup();
    await put("pool", auth("user-b", T0 + 50, { refreshUser: "user-a" }));
    expect((await healPool()).join(" ")).toContain("hybrid");
    const bak = join(dirOf("pool"), "auth.json.pre-heal.bak");
    expect((await stat(bak)).mode & 0o777).toBe(0o600);
    expect(await read("pool")).toBe(await read("a"));
  });

  test("same account: a newer pool entry goes to the vault, a newer vault entry catches the pool up", async () => {
    await setup();
    await put("pool", auth("user-a", T0 + 400, { tag: "a-rotated" }));
    expect((await healPool()).join(" ")).toContain("write-back: written");
    expect(await kimiRefresh("a")).toBe("SYNTHETIC_FIXTURE-rt-a-rotated");
    expect(await healPool()).toEqual([]);
    await put("a", auth("user-a", T0 + 900, { tag: "a-member-refresh" }));
    expect((await healPool()).join(" ")).toContain("behind");
    expect(await read("pool")).toBe(await read("a"));
  });

  test("refresh-during-swap race: A's in-flight refresh is written after the swap to B; captured into A, B restored", async () => {
    await setup();
    await swap("b");
    await put("pool", auth("user-a", T0 + 900, { tag: "a-late" })); // pi's modify() writes {...snapshot, [provider]: refreshed}
    expect((await healPool()).join(" ")).toContain('captured it into "a"');
    expect(await kimiRefresh("a")).toBe("SYNTHETIC_FIXTURE-rt-a-late");
    expect(await read("pool")).toBe(await read("b"));
  });

  test("the scheduler heals live-swap pools every tick, even with auto off", async () => {
    await setup();
    await put("pool", "");
    const logs: string[] = [];
    const sched = new PoolSwapScheduler({ adapters: () => [piAdapter], perTool: { pi: { registryPath: registry, ledgerPath: ledger } }, log: (m) => logs.push(m) });
    await sched.tick(1_000_000);
    expect(await read("pool")).toBe(await read("a"));
    expect(logs.join("\n")).toContain("pi-swap: pool pool credentials were empty or partial");
  });
});

describe("pi pool write-through", () => {
  test("a member's kimi refresh reaches the pool only while that member is active and the pool holds its account", async () => {
    await setup();
    const rotated = (user: string, tag: string) => ({ access_token: jwt(user, T0 + 20), refresh_token: `SYNTHETIC_FIXTURE-rt-${tag}`, expires_at: T0 + 920 });
    await persistKimiCredentials(member("a"), "pi", rotated("user-a", "a-rot1"));
    expect(await kimiRefresh("a")).toBe("SYNTHETIC_FIXTURE-rt-a-rot1");
    expect(await kimiRefresh("pool")).toBe("SYNTHETIC_FIXTURE-rt-a-rot1");
    expect((await parsed("pool")).zai!.key).toBe("SYNTHETIC_FIXTURE-key-user-a");
    await persistKimiCredentials(member("b"), "pi", rotated("user-b", "b-rot1"));
    expect(await kimiRefresh("pool")).toBe("SYNTHETIC_FIXTURE-rt-a-rot1");
    await put("pool", auth("user-b", T0 + 50, { tag: "b-in-pool" }));
    await persistKimiCredentials(member("a"), "pi", rotated("user-a", "a-rot2"));
    expect(await kimiRefresh("pool")).toBe("SYNTHETIC_FIXTURE-rt-b-in-pool");
  });
});
