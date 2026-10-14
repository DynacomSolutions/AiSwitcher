import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAdapter, codexMemberProblem, codexTuning, countCodexSessions } from "../../../src/identities/pool/codex-adapter.ts";
import { readSwapEvents } from "../../../src/identities/pool/ledger.ts";
import { adapterFor } from "../../../src/identities/pool/registry.ts";
import { PoolSwapScheduler } from "../../../src/identities/pool/scheduler.ts";
import { performPoolSwap } from "../../../src/identities/pool/swap.ts";
import { requirePool } from "../../../src/identities/pool/swap-pool.ts";
import { convergeClaudePoolStores, refreshIdentityOAuthGrant } from "../../../src/identities/oauth-refresh.ts";
import { writeProviderGrantCopy } from "../../../src/identities/oauth-reconcile.ts";
import { withPoolLock } from "../../../src/identities/pool/lock.ts";
import { loadIdentitiesFile } from "../../../src/identities/store.ts";
import type { Identity } from "../../../src/identities/types.ts";

let root: string;
let registry: string;
let ledger: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-codex-pool-"));
  registry = join(root, "codex-identities.json");
  ledger = join(root, "codex-swap.jsonl");
  codexTuning.healRetryMs = 0;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** Runtime-built fake JWT carrying the chatgpt account claim. */
const jwt = (account: string, iat: number) => `${b64({ alg: "none" })}.${b64({ iat, exp: iat + 3600, "https://api.openai.com/auth": { chatgpt_account_id: account } })}.SYNTHETIC_FIXTURE`;

interface AuthOptions { fileAccount?: string; tag?: string; extra?: Record<string, unknown> }
/** Fake auth.json text for `account`, minted at epoch second `iat`. */
function auth(account: string, iat: number, options: AuthOptions = {}): string {
  const tag = options.tag ?? `${account}-${iat}`;
  return JSON.stringify({
    OPENAI_API_KEY: null,
    ...options.extra,
    tokens: { id_token: jwt(account, iat), access_token: jwt(account, iat), refresh_token: `SYNTHETIC_FIXTURE-rt-${tag}`, account_id: options.fileAccount ?? account },
    last_refresh: new Date(iat * 1000).toISOString(),
  }, null, 2);
}

const dirOf = (name: string) => join(root, name);
const put = async (name: string, text: string) => { await mkdir(dirOf(name), { recursive: true }); await writeFile(join(dirOf(name), "auth.json"), text); };
const read = (name: string) => readFile(join(dirOf(name), "auth.json"), "utf8");
const refreshToken = async (name: string) => (JSON.parse(await read(name)) as { tokens: { refresh_token: string } }).tokens.refresh_token;
const T0 = 1_789_200_000;

async function setup(active: string | undefined = "a"): Promise<void> {
  const member = (name: string) => ({ name, label: name, configDir: dirOf(name) });
  await writeFile(registry, JSON.stringify({ version: 1, identities: [member("a"), member("b"), { ...member("pool"), swapPool: { accounts: ["a", "b"], ...(active ? { active } : {}) } }] }));
  await put("a", auth("acct-a", T0));
  await put("b", auth("acct-b", T0));
  await put("pool", auth("acct-a", T0));
}

const swap = (target: string) => performPoolSwap(codexAdapter, { registryPath: registry, ledgerPath: ledger, pool: "pool", target, reason: "manual" });

async function healPool() {
  const file = await loadIdentitiesFile(registry);
  const pool = requirePool(file, "pool", "codex");
  const members = pool.swapPool.accounts.map((n) => file.identities.find((i) => i.name === n)!);
  return codexAdapter.heal!(pool, members);
}

describe("codex adapter registration", () => {
  test("is registered, not live, with heal and notify hooks", () => {
    expect(adapterFor("codex")).toBe(codexAdapter);
    expect(codexAdapter.liveSwap).toBe(false);
    expect(typeof codexAdapter.heal).toBe("function");
    expect(typeof codexAdapter.notifySwapped).toBe("function");
  });
});

describe("codex swapCredentials", () => {
  test("swaps A to B to A, writing A's newer pool grant back to A's vault", async () => {
    await setup();
    await put("pool", auth("acct-a", T0 + 100, { tag: "a-refreshed" })); // a running session refreshed A in the pool
    const toB = await swap("b");
    expect(toB).toMatchObject({ from: "a", to: "b", writeBack: "written", noop: false });
    expect(await refreshToken("a")).toBe("SYNTHETIC_FIXTURE-rt-a-refreshed");
    expect(await read("pool")).toBe(await read("b"));
    expect((await stat(join(dirOf("pool"), "auth.json"))).mode & 0o777).toBe(0o600);

    const back = await swap("a");
    expect(back).toMatchObject({ from: "b", to: "a", writeBack: "none-identical" });
    expect(await refreshToken("pool")).toBe("SYNTHETIC_FIXTURE-rt-a-refreshed");
    expect((await readSwapEvents(ledger)).map(({ from, to }) => `${from}>${to}`)).toEqual(["a>b", "b>a"]);
    const registryAfter = await loadIdentitiesFile(registry);
    expect(requirePool(registryAfter, "pool", "codex").swapPool.active).toBe("a");
  });

  test("never writes the pool grant to a member holding a different account", async () => {
    await setup();
    await put("pool", auth("acct-c", T0 + 500)); // a non-member account in the pool
    const before = { a: await read("a"), b: await read("b") };
    const r = await swap("b");
    expect(r.writeBack).toBe("none-unknown-owner");
    expect(await read("a")).toBe(before.a);
    expect(await read("b")).toBe(before.b);
    expect(await readFile(join(dirOf("pool"), "auth.json.pre-swap.bak"), "utf8")).toContain("SYNTHETIC_FIXTURE-rt-acct-c-");
    expect((await stat(join(dirOf("pool"), "auth.json.pre-swap.bak"))).mode & 0o777).toBe(0o600);
  });

  test("a hybrid pool file is kept as a backup and never attributed", async () => {
    await setup();
    await put("pool", auth("acct-a", T0 + 500, { fileAccount: "acct-b" }));
    const r = await swap("b");
    expect(r.writeBack).toBe("none-account-mismatch");
    expect(await refreshToken("a")).toBe(`SYNTHETIC_FIXTURE-rt-acct-a-${T0}`);
  });

  test("preserves the target's non-token keys and rejects a target without a login", async () => {
    await setup();
    await put("b", auth("acct-b", T0, { extra: { auth_mode: "chatgpt" } }));
    await swap("b");
    expect((JSON.parse(await read("pool")) as { auth_mode: string }).auth_mode).toBe("chatgpt");
    await put("a", JSON.stringify({ OPENAI_API_KEY: "SYNTHETIC_FIXTURE-key" }));
    await expect(swap("a")).rejects.toThrow(/no usable Codex login/);
  });

  test("bootstraps an empty pool and reports hasCredentials", async () => {
    await setup(undefined);
    await rm(join(dirOf("pool"), "auth.json"));
    expect(codexAdapter.hasCredentials(dirOf("pool"))).toBe(false);
    const r = await swap("a");
    expect(r.writeBack).toBe("none-no-live-credentials");
    expect(codexAdapter.hasCredentials(dirOf("pool"))).toBe(true);
  });
});

describe("codex heal", () => {
  test("restores an empty or partial file from the active vault", async () => {
    await setup();
    for (const broken of ["", '{"tokens": {"access_tok']) {
      await put("pool", broken);
      const notes = await healPool();
      expect(notes.join(" ")).toContain('restored "a"');
      expect(await read("pool")).toBe(await read("a"));
    }
    expect(await healPool()).toEqual([]);
  });

  test("a foreign account is captured into its member vault when newer, then the active one is restored", async () => {
    await setup();
    await put("pool", auth("acct-b", T0 + 300, { tag: "b-newer" }));
    const notes = await healPool();
    expect(notes.join(" ")).toContain('captured it into "b"');
    expect(await refreshToken("b")).toBe("SYNTHETIC_FIXTURE-rt-b-newer");
    expect(await read("pool")).toBe(await read("a"));
  });

  test("an older foreign grant leaves the vault alone; a non-member account is kept as a backup", async () => {
    await setup();
    await put("pool", auth("acct-b", T0 - 300, { tag: "b-older" }));
    await healPool();
    expect(await refreshToken("b")).toBe(`SYNTHETIC_FIXTURE-rt-acct-b-${T0}`);
    await put("pool", auth("acct-c", T0 + 1, { tag: "c1" }));
    const notes = await healPool();
    expect(notes.join(" ")).toContain("not a member");
    expect(await readFile(join(dirOf("pool"), "auth.json.pre-heal.bak"), "utf8")).toContain("SYNTHETIC_FIXTURE-rt-c1");
    expect(await read("pool")).toBe(await read("a"));
    expect(await refreshToken("a")).toBe(`SYNTHETIC_FIXTURE-rt-acct-a-${T0}`);
  });

  test("a hybrid file (account_id vs JWT) is backed up at 0600 and restored", async () => {
    await setup();
    await put("pool", auth("acct-b", T0 + 50, { fileAccount: "acct-a", tag: "hybrid" }));
    const notes = await healPool();
    expect(notes.join(" ")).toContain("hybrid");
    const bak = join(dirOf("pool"), "auth.json.pre-heal.bak");
    expect(await readFile(bak, "utf8")).toContain("SYNTHETIC_FIXTURE-rt-hybrid");
    expect((await stat(bak)).mode & 0o777).toBe(0o600);
    expect(await read("pool")).toBe(await read("a"));
  });

  test("refresh-during-swap race: A's newer tokens rewritten after the swap to B are captured and B restored", async () => {
    await setup();
    await swap("b");
    await put("pool", auth("acct-a", T0 + 900, { tag: "a-late" })); // the old session A refreshes and writes its file
    const notes = await healPool();
    expect(notes.join(" ")).toContain('captured it into "a"');
    expect(await refreshToken("a")).toBe("SYNTHETIC_FIXTURE-rt-a-late");
    expect(await read("pool")).toBe(await read("b"));
  });

  test("the scheduler heals liveSwap:false pools every tick, even with auto off", async () => {
    await setup();
    await put("pool", "");
    const logs: string[] = [];
    const sched = new PoolSwapScheduler({ adapters: () => [codexAdapter], perTool: { codex: { registryPath: registry, ledgerPath: ledger } }, log: (m) => logs.push(m) });
    await sched.tick(1_000_000);
    expect(await read("pool")).toBe(await read("a"));
    expect(logs.join("\n")).toContain("codex-swap: pool pool auth.json was empty or partial");
  });
});

describe("codex helpers", () => {
  test("member validation rejects API-key and Bedrock members", async () => {
    await setup();
    const id = (name: string, env?: Record<string, string>): Identity => ({ name, label: name, configDir: dirOf(name), ...(env ? { env } : {}) });
    expect(codexMemberProblem(id("a"))).toBeUndefined();
    await put("k", JSON.stringify({ OPENAI_API_KEY: "SYNTHETIC_FIXTURE-key" }));
    expect(codexMemberProblem(id("k"))).toContain("no ChatGPT login");
    await put("h", auth("acct-h", T0, { fileAccount: "acct-x" }));
    expect(codexMemberProblem(id("h"))).toContain("inconsistent");
    await put("bed", auth("acct-bed", T0));
    await writeFile(join(dirOf("bed"), "config.toml"), 'model_provider = "amazon-bedrock"\n');
    expect(codexMemberProblem(id("bed"))).toContain("Bedrock");
  });

  test("fetchUsage maps the limits windows", async () => {
    const member: Identity = { name: "a", label: "a", configDir: dirOf("a") };
    const win = (usedPercent: number) => ({ label: "w", category: "session" as const, usedPercent });
    const base = { toolName: "codex" as const, identity: member };
    const usage = (windows: ReturnType<typeof win>[], status: "live" | "unavailable" = "live") => codexAdapter.fetchUsage(member, { fetchCodexLimits: async () => ({ ...base, windows, status, ...(status === "unavailable" ? { error: "nope" } : {}) }) });
    expect(await usage([win(10), win(42)])).toMatchObject({ status: "live", maxUtilization: 42 });
    expect(await usage([win(100)])).toMatchObject({ status: "rate-limited", maxUtilization: 100 });
    expect(await usage([], "unavailable")).toMatchObject({ status: "unavailable", error: "nope" });
  });

  test("countCodexSessions matches codex processes by CODEX_HOME from /proc", async () => {
    const proc = join(root, "proc");
    const fake = async (pid: string, argv: string[], home: string | undefined) => {
      await mkdir(join(proc, pid), { recursive: true });
      await writeFile(join(proc, pid, "cmdline"), argv.join("\0"));
      await writeFile(join(proc, pid, "environ"), ["PATH=/x", ...(home ? [`CODEX_HOME=${home}`] : [])].join("\0"));
    };
    await fake("101", ["/usr/bin/codex", "resume"], dirOf("pool"));
    await fake("102", ["node", "/lib/bin/codex"], `${dirOf("pool")}/`);
    await fake("103", ["/usr/bin/codex"], dirOf("a"));
    await fake("104", ["/usr/bin/vim"], dirOf("pool"));
    await fake("105", ["/usr/bin/codex"], undefined);
    expect(await countCodexSessions(dirOf("pool"), proc)).toBe(2);
    expect(await countCodexSessions(dirOf("pool"), join(root, "missing"))).toBe(0);
  });
});

describe("codex pool refresh integration", () => {
  const NOW = T0 + 10;
  const member = (name: string): Identity => ({ name, label: name, configDir: dirOf(name) });

  test("the pool identity is never refreshed itself", async () => {
    await setup();
    const pool = (await loadIdentitiesFile(registry)).identities.find((i) => i.name === "pool")!;
    const fetchImpl = (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch;
    const r = await refreshIdentityOAuthGrant("codex", pool, { force: true, fetchImpl, poolRegistryPath: registry, now: () => NOW * 1000 });
    expect(r.outcome).toBe("no-grant");
    expect(r.detail).toContain("refreshed through that member");
  });

  test("an active member's refresh writes through to the pool copy; an inactive member's does not", async () => {
    await setup();
    const respond = (refresh: string) => (async () => new Response(JSON.stringify({ access_token: jwt("acct-a", NOW), refresh_token: refresh, expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const opts = { force: true, poolRegistryPath: registry, now: () => NOW * 1000 };
    const r = await refreshIdentityOAuthGrant("codex", member("a"), { ...opts, fetchImpl: respond("SYNTHETIC_FIXTURE-rt-a-rot1") });
    expect(r.outcome).toBe("refreshed");
    expect(r.written.some((w) => w.startsWith("pool:"))).toBe(true);
    expect(await refreshToken("pool")).toBe("SYNTHETIC_FIXTURE-rt-a-rot1");
    // b is not the active member: its refresh must leave the pool alone.
    await put("b", auth("acct-b", T0));
    const rb = await refreshIdentityOAuthGrant("codex", member("b"), { ...opts, fetchImpl: respond("SYNTHETIC_FIXTURE-rt-b-rot1") });
    expect(rb.written.some((w) => w.startsWith("pool:"))).toBe(false);
    expect(await refreshToken("pool")).toBe("SYNTHETIC_FIXTURE-rt-a-rot1");
  });
});

describe("review fixes", () => {
  const member = (name: string): Identity => ({ name, label: name, configDir: dirOf(name) });

  test("a hybrid or partial pool file is never a converge source or target", async () => {
    await setup();
    const before = await read("a");
    await put("pool", auth("acct-b", T0 + 50, { fileAccount: "acct-a", tag: "hybrid" }));
    await convergeClaudePoolStores(member("a"), registry, false, undefined, "codex");
    expect(await read("a")).toBe(before);
    await put("pool", '{"tokens": {"access_tok');
    await convergeClaudePoolStores(member("a"), registry, false, undefined, "codex");
    expect(await read("a")).toBe(before);
    expect(await read("pool")).toBe('{"tokens": {"access_tok');
  });

  test("writing a grant into an unparsable codex file is refused", async () => {
    await put("x", '{"tokens": {"acc');
    const grant = { access_token: jwt("acct-a", T0), refresh_token: "SYNTHETIC_FIXTURE-rt-z" };
    await expect(writeProviderGrantCopy("codex", dirOf("x"), grant)).rejects.toThrow(/unparsable/);
    expect(await read("x")).toBe('{"tokens": {"acc');
  });

  test("heal treats a file without id_token or account_id as damaged", async () => {
    await setup();
    const t = JSON.parse(await read("a")) as { tokens: Record<string, unknown> };
    delete t.tokens.id_token;
    await put("pool", JSON.stringify(t));
    expect((await healPool()).join(" ")).toContain('restored "a"');
    expect(await read("pool")).toBe(await read("a"));
  });

  test("heal re-reads the registry under the pool lock, so a concurrent swap is not undone", async () => {
    await setup("a");
    const logs: string[] = [];
    const sched = new PoolSwapScheduler({ adapters: () => [codexAdapter], perTool: { codex: { registryPath: registry, ledgerPath: ledger } }, log: (m) => logs.push(m) });
    const poolDir = dirOf("pool");
    await withPoolLock(poolDir, async () => {
      const tick = sched.tick(1_000_000); // loaded active=a, now waits on the lock
      await new Promise((r) => setTimeout(r, 100));
      const file = JSON.parse(await readFile(registry, "utf8"));
      file.identities.find((i: { name: string }) => i.name === "pool").swapPool.active = "b";
      await writeFile(registry, JSON.stringify(file));
      await put("pool", await read("b"));
      (globalThis as { __tick?: Promise<void> }).__tick = tick;
    });
    await (globalThis as { __tick?: Promise<void> }).__tick;
    expect(await read("pool")).toBe(await read("b"));
    expect(logs).toEqual([]);
  });

  test("swap reads the owner and target vaults under their locks (no stale write-back over a newer vault)", async () => {
    await setup();
    await put("pool", auth("acct-a", T0 + 100, { tag: "a-pool" }));
    await put("a", auth("acct-a", T0 + 200, { tag: "a-vault-newer" }));
    await swap("b");
    expect(await refreshToken("a")).toBe("SYNTHETIC_FIXTURE-rt-a-vault-newer");
  });

  test("heal re-reads a damaged file after a delay before restoring (mid-truncate)", async () => {
    await setup();
    await put("pool", "");
    codexTuning.healRetryMs = 150;
    const rotated = auth("acct-a", T0 + 700, { tag: "a-rotated" });
    setTimeout(() => { void writeFile(join(dirOf("pool"), "auth.json"), rotated); }, 100);
    const notes = await healPool();
    expect(await read("pool")).toBe(rotated);
    expect(notes.join(" ")).toContain("write-back: written");
    expect(await refreshToken("a")).toBe("SYNTHETIC_FIXTURE-rt-a-rotated");
  });

  test("member validation requires tokens.account_id", async () => {
    const t = JSON.parse(auth("acct-n", T0)) as { tokens: Record<string, unknown> };
    delete t.tokens.account_id;
    await put("n", JSON.stringify(t));
    expect(codexMemberProblem(member("n"))).toContain("missing account id");
  });

  test("heal writes a newer same-account pool grant back to the vault instead of restoring over it", async () => {
    await setup();
    const strip = (text: string) => { const t = JSON.parse(text) as { tokens: Record<string, unknown> }; delete t.tokens.account_id; return JSON.stringify(t); };
    await put("pool", strip(auth("acct-a", T0 + 400, { tag: "a-rotated" })));
    const notes = await healPool();
    expect(notes.join(" ")).toContain("write-back: written");
    expect(await refreshToken("a")).toBe("SYNTHETIC_FIXTURE-rt-a-rotated");
    expect((JSON.parse(await read("a")) as { tokens: { account_id: string } }).tokens.account_id).toBe("acct-a");
    expect(await healPool()).toEqual([]);
  });

  test("swapping to the account the pool holds does not deadlock on the target lock", async () => {
    await setup();
    await put("pool", auth("acct-a", T0 + 100, { tag: "a-pool" }));
    const r = await swap("a");
    expect(r.writeBack).toBe("written");
    expect(await refreshToken("pool")).toBe("SYNTHETIC_FIXTURE-rt-a-pool");
    expect(await refreshToken("a")).toBe("SYNTHETIC_FIXTURE-rt-a-pool");
  });

  test("the target vault lock is held until the pool write is done", async () => {
    await setup();
    const { withOauthRefreshLock } = await import("../../../src/identities/claude-swap-lock.ts");
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const gotLock = new Promise<void>((r) => { locked = r; });
    const holder = withOauthRefreshLock(dirOf("b"), async () => { locked(); await held; });
    await gotLock;
    const p = swap("b");
    await new Promise((r) => setTimeout(r, 200));
    expect(await read("pool")).toBe(await read("a")); // not written while b is locked
    release();
    await holder;
    await p;
    expect(await read("pool")).toBe(await read("b"));
  });
});
