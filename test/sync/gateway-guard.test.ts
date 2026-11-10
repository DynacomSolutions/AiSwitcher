import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gatewayEntryText } from "../../src/identities/claude-gateway-entry.ts";
import { isGatewayManagedHere } from "../../src/identities/gateway-managed.ts";
import { refreshFingerprint, withRouting, type GatewayRouting } from "../../src/identities/gateway-routed.ts";
import { decideCredentialMerge, planCredentialMerge, withoutProviders } from "../../src/sync/gateway-guard.ts";
import { mergeIncomingProfileTree, setDirectOwnerProbe } from "../../src/sync/tree-merge.ts";

const KEY = "aisg_SYNTHETIC_FIXTURE_key";
const T = 1_700_000_000;
const all = { kind: "all" } as const;
const noPurge = async () => ({ removed: [], warnings: [] });
const claudeLogin = (n: string, expiresAt = 1) => JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-SYNTHETIC_FIXTURE-${n}`, refreshToken: `rt-SYNTHETIC_FIXTURE-${n}`, expiresAt } });
const codexLogin = (n: string) => JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: `at-SYNTHETIC_FIXTURE-${n}`, refresh_token: `rt-SYNTHETIC_FIXTURE-${n}` } });
const codexEntry = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: KEY });
const ROUTER = "routing-host-SYNTHETIC";
/** The record route-all writes when it routes login `n` (fresh until `freshness`) on `host`. */
const routing = (n: string, freshness = 1000, host = ROUTER, account?: string): GatewayRouting => ({ host, at: 5, fingerprints: [refreshFingerprint(`rt-SYNTHETIC_FIXTURE-${n}`)], freshness, ...(account ? { account } : {}) });
const claudeEntry = (r: GatewayRouting) => withRouting(gatewayEntryText(KEY), r);
const codexEntryOf = (r: GatewayRouting) => withRouting(codexEntry, r);
const claudeJson = (uuid: string) => JSON.stringify({ oauthAccount: { accountUuid: uuid } });
const piAuth = JSON.stringify({ anthropic: { type: "oauth", access: "pi-a", refresh: "pi-rt-a" }, "openai-codex": { type: "oauth", access: "pi-c", refresh: "pi-rt-c" } });

const dirs: string[] = [];
let savedOwner: string | undefined;
// Another test file may have marked this process as the gateway owner: these checks are for every other process.
beforeEach(() => {
  savedOwner = process.env.AIS_GATEWAY_OWNER;
  process.env.AIS_GATEWAY_OWNER = "0";
});
afterEach(async () => {
  if (savedOwner === undefined) delete process.env.AIS_GATEWAY_OWNER;
  else process.env.AIS_GATEWAY_OWNER = savedOwner;
  setDirectOwnerProbe();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ais-gateway-guard-"));
  dirs.push(root);
  const [home, incoming] = [join(root, "home"), join(root, "incoming")];
  setDirectOwnerProbe(async () => false);
  for (const base of [".claude", ".codex", ".pi"]) {
    await mkdir(join(home, base, "identities", "alpha"), { recursive: true });
    await writeFile(join(home, base, "identities.json"), JSON.stringify({ version: 1, identities: [{ name: "alpha", label: "alpha", configDir: join(home, base, "identities", "alpha") }] }));
  }
  const put = async (base: string, rel: string, content: string, mtime: number) => {
    await mkdir(dirname(join(base, rel)), { recursive: true });
    await writeFile(join(base, rel), content);
    await utimes(join(base, rel), mtime, mtime);
  };
  const memberCopy = async (tool: string, file: string, content: string) => put(join(home, ".ais", "gateway-members", tool, "alpha"), file, content, T);
  const merge = () => mergeIncomingProfileTree(incoming, all, { home, purgeRetired: noPurge });
  const read = (rel: string) => readFile(join(home, rel), "utf8");
  return { home, incoming, put, memberCopy, merge, read };
}

function captureWarnings() {
  const lines: string[] = [];
  const saved = console.warn;
  console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  return { lines, restore: () => void (console.warn = saved) };
}

const CLAUDE = ".claude/identities/alpha/.credentials.json";
const CODEX = ".codex/identities/alpha/auth.json";
const PI = ".pi/identities/alpha/auth.json";

describe("decideCredentialMerge", () => {
  test("a member store copy here keeps the local file whatever arrives", () => {
    expect(decideCredentialMerge("claude", claudeLogin("a"), gatewayEntryText(KEY), true)).toBe("keep-local");
    expect(decideCredentialMerge("claude", gatewayEntryText(KEY), claudeLogin("a"), true)).toBe("keep-local");
  });
  test("an entry replaces this host's copy of the routed login, never a later sign-in here", () => {
    const plan = (local: string | undefined, incoming: string, claudeJsonText?: string) => planCredentialMerge("claude", local, incoming, { memberHere: false, host: "this-host", ...(claudeJsonText ? { claudeJsonText } : {}) });
    // the routed refresh token itself
    expect(plan(claudeLogin("a", 5000), claudeEntry(routing("a")))).toEqual({ action: "take-incoming", reason: "entry-replaces-login", routedBy: ROUTER });
    // an older login of the same account (a rotated-away copy)
    expect(plan(claudeLogin("old", 900), claudeEntry(routing("a", 1000, ROUTER, "u-a")), claudeJson("u-a")).reason).toBe("entry-replaces-login");
    // a sign-in made here after the routing: fresher, a refresh token the gateway never held
    expect(plan(claudeLogin("new", 2000), claudeEntry(routing("a")))).toEqual({ action: "keep-local", reason: "kept-fresh-login", routedBy: ROUTER });
    // another account
    expect(plan(claudeLogin("other", 900), claudeEntry(routing("a", 1000, ROUTER, "u-a")), claudeJson("u-b")).reason).toBe("kept-fresh-login");
    // an entry without the routing record (an earlier build) cannot tell: the login stays
    expect(plan(claudeLogin("a"), gatewayEntryText(KEY))).toEqual({ action: "keep-local", reason: "kept-unknown-login" });
    // an undatable login of another refresh token stays
    expect(plan(JSON.stringify({ claudeAiOauth: { accessToken: "x", refreshToken: "rt-SYNTHETIC_FIXTURE-undated" } }), claudeEntry(routing("a"))).reason).toBe("kept-unknown-login");
    // the routing host, un-routed since (no member copy), keeps its login even when it is the routed one
    expect(planCredentialMerge("claude", claudeLogin("a"), claudeEntry(routing("a", 1000, "this-host")), { memberHere: false, host: "this-host" }).reason).toBe("kept-routing-host");
    // a folder without a login takes the entry
    expect(decideCredentialMerge("codex", undefined, codexEntry, false)).toBe("take-incoming");
    expect(decideCredentialMerge("claude", claudeLogin("a"), claudeLogin("b"), false)).toBe("merge");
  });

  test("a login replaces a gateway entry only when it is provably a separate login", () => {
    const plan = (local: string, incoming: string) => planCredentialMerge("claude", local, incoming, { memberHere: false, host: "this-host" });
    // a host that has not seen the routing sends its copy of the routed login, or an older one: the entry stays
    expect(plan(claudeEntry(routing("a")), claudeLogin("a", 5000))).toEqual({ action: "keep-local", reason: "kept-entry" });
    expect(plan(claudeEntry(routing("a")), claudeLogin("older", 900)).action).toBe("keep-local");
    expect(plan(gatewayEntryText(KEY), claudeLogin("b", 9000)).action).toBe("keep-local");
    expect(decideCredentialMerge("codex", codexEntry, codexLogin("a"), false)).toBe("keep-local");
    // a later sign-in (or the login the routing host restored, renewed since) replaces it
    expect(plan(claudeEntry(routing("a")), claudeLogin("renewed", 2000))).toEqual({ action: "take-incoming", reason: "login-replaces-entry", routedBy: ROUTER });
  });
  test("withoutProviders drops only the named providers", () => {
    expect(JSON.parse(withoutProviders(piAuth, ["anthropic"])!)).toEqual({ "openai-codex": { type: "oauth", access: "pi-c", refresh: "pi-rt-c" } });
    expect(withoutProviders(JSON.stringify({ x: 1 }), ["anthropic"])).toBeUndefined();
    expect(withoutProviders("not json", ["anthropic"])).toBeUndefined();
  });
});

describe("sync merge of gateway-routed logins", () => {
  test("the routing host never takes a newer real login over its gateway entry", async () => {
    const f = await fixture();
    await f.memberCopy("claude", ".credentials.json", claudeLogin("store"));
    await f.put(f.home, CLAUDE, gatewayEntryText(KEY), T);
    await f.put(f.incoming, CLAUDE, claudeLogin("remote"), T + 100);
    await f.merge();
    expect(await f.read(CLAUDE)).toBe(gatewayEntryText(KEY));
  });

  test("a member store copy here keeps the folder even before it holds the entry (mid-routing)", async () => {
    const f = await fixture();
    await f.memberCopy("codex", "auth.json", codexLogin("store"));
    await f.put(f.home, CODEX, codexLogin("local"), T);
    await f.put(f.incoming, CODEX, codexLogin("remote"), T + 100);
    await f.merge();
    expect(await f.read(CODEX)).toBe(codexLogin("local"));
  });

  test("a host without the store copy takes an arriving gateway entry over its copy of the routed login (newer file or not), and keeps it after", async () => {
    const f = await fixture();
    const warnings = captureWarnings();
    await f.put(f.home, CODEX, codexLogin("local"), T + 100);
    await f.put(f.incoming, CODEX, codexEntryOf(routing("local")), T);
    await f.merge();
    warnings.restore();
    expect(await f.read(CODEX)).toBe(codexEntryOf(routing("local")));
    // the replaced login is backed up (0600) where sync never carries it, and the log names the identity
    const backupDir = join(f.home, ".ais", "gateway-replaced");
    const backups = await readdir(backupDir);
    expect(backups.length).toBe(1);
    expect(backups[0]).toStartWith("codex-alpha-auth.json.");
    expect(await readFile(join(backupDir, backups[0]!), "utf8")).toBe(codexLogin("local"));
    expect((await stat(join(backupDir, backups[0]!))).mode & 0o777).toBe(0o600);
    expect(warnings.lines.some((l) => l.includes("codex identity alpha: the gateway entry (routed on routing-host-SYNTHETIC) replaced") && l.includes("sign in again"))).toBe(true);
    // the identity is now the gateway's on this host: nothing here refreshes or reconciles it
    expect(await isGatewayManagedHere("codex", "alpha", join(f.home, ".codex", "identities.json"))).toBe(true);
    // a third host that has not seen the routing yet cannot undo it
    await rm(f.incoming, { recursive: true, force: true });
    await f.put(f.incoming, CODEX, codexLogin("local"), T + 500);
    await f.merge();
    expect(await f.read(CODEX)).toBe(codexEntryOf(routing("local")));
  });

  test("a sign-in made on this host after the routing is kept (logged), refreshed as usual, and not undone by later syncs", async () => {
    const f = await fixture();
    await f.put(f.home, CLAUDE, claudeLogin("signed-in-here", 5000), T);
    const warnings = captureWarnings();
    for (let i = 0; i < 2; i++) {
      await rm(f.incoming, { recursive: true, force: true });
      await f.put(f.incoming, CLAUDE, claudeEntry(routing("routed", 1000)), T + 100 + i);
      await f.merge();
    }
    warnings.restore();
    expect(await f.read(CLAUDE)).toBe(claudeLogin("signed-in-here", 5000));
    expect(warnings.lines.filter((l) => l.includes("claude identity alpha: kept this host's login, a sign-in made after the identity was routed")).length).toBe(2);
    // this host refreshes its own login normally: it is not the gateway's here
    expect(await isGatewayManagedHere("claude", "alpha", join(f.home, ".claude", "identities.json"))).toBe(false);
    await expect(stat(join(f.home, ".ais", "gateway-replaced"))).rejects.toThrow();
  });

  test("the routing host keeps its gateway entry when the other host's fresh sign-in arrives", async () => {
    const f = await fixture();
    await f.memberCopy("claude", ".credentials.json", claudeLogin("store", 1500));
    await f.put(f.home, CLAUDE, claudeEntry(routing("routed", 1000)), T);
    await f.put(f.incoming, CLAUDE, claudeLogin("signed-in-there", 5000), T + 100);
    await f.merge();
    expect(await f.read(CLAUDE)).toBe(claudeEntry(routing("routed", 1000)));
  });

  test("un-routing: the routing host keeps its restored login; the other host takes it once it is fresher than the routing", async () => {
    // routing host, un-routed: member copy moved aside, the folder holds the login copied back from the store
    const routerHost = await fixture();
    const here = hostname();
    await routerHost.put(routerHost.home, CLAUDE, claudeLogin("routed", 1000), T + 200);
    const entryFromHere = claudeEntry(routing("routed", 1000, here));
    // the other host still sends the entry: even the very login that was routed (not renewed since) stays here
    await routerHost.put(routerHost.incoming, CLAUDE, entryFromHere, T + 300);
    await routerHost.merge();
    expect(await routerHost.read(CLAUDE)).toBe(claudeLogin("routed", 1000));
    expect(await isGatewayManagedHere("claude", "alpha", join(routerHost.home, ".claude", "identities.json"))).toBe(false);

    // the other host: its entry is replaced by the restored login the gateway renewed since the routing
    const otherHost = await fixture();
    await otherHost.put(otherHost.home, CLAUDE, entryFromHere, T);
    await otherHost.put(otherHost.incoming, CLAUDE, claudeLogin("renewed", 3000), T + 100);
    await otherHost.merge();
    expect(await otherHost.read(CLAUDE)).toBe(claudeLogin("renewed", 3000));

    // not renewed since the routing: the entry stays until the user moves it aside, then the login arrives as usual
    const thirdHost = await fixture();
    await thirdHost.put(thirdHost.home, CLAUDE, entryFromHere, T);
    await thirdHost.put(thirdHost.incoming, CLAUDE, claudeLogin("routed", 1000), T + 100);
    await thirdHost.merge();
    expect(await thirdHost.read(CLAUDE)).toBe(entryFromHere);
    await rename(join(thirdHost.home, CLAUDE), join(thirdHost.home, `${CLAUDE}.aside`));
    await thirdHost.merge();
    expect(await thirdHost.read(CLAUDE)).toBe(claudeLogin("routed", 1000));
  });

  test("other logins still merge by time", async () => {
    const f = await fixture();
    await f.put(f.home, CLAUDE, claudeLogin("local"), T);
    await f.put(f.incoming, CLAUDE, claudeLogin("remote"), T + 100);
    await f.merge();
    expect(await f.read(CLAUDE)).toBe(claudeLogin("remote"));
    expect(await isGatewayManagedHere("claude", "alpha", join(f.home, ".claude", "identities.json"))).toBe(false);
  });

  test("pi's copy of a routed login is dropped from what arrives and from the live file, other providers kept", async () => {
    const f = await fixture();
    await f.memberCopy("claude", ".credentials.json", claudeLogin("store"));
    await f.put(f.home, CLAUDE, gatewayEntryText(KEY), T);
    await f.put(f.home, PI, JSON.stringify({ "openai-codex": { type: "oauth", access: "old" } }), T);
    await f.put(f.incoming, PI, piAuth, T + 100);
    await f.merge();
    const live = JSON.parse(await f.read(PI));
    expect(live.anthropic).toBeUndefined();
    expect(live["openai-codex"].access).toBe("pi-c");
  });

  test("a gateway entry that arrives strips the receiving host's own pi copy (after a backup)", async () => {
    const f = await fixture();
    await f.put(f.home, CLAUDE, claudeLogin("local"), T + 100);
    await f.put(f.home, PI, piAuth, T + 100);
    await f.put(f.incoming, CLAUDE, claudeEntry(routing("local")), T);
    await f.merge();
    expect(await f.read(CLAUDE)).toBe(claudeEntry(routing("local")));
    const live = JSON.parse(await f.read(PI));
    expect(live.anthropic).toBeUndefined();
    expect(live["openai-codex"].refresh).toBe("pi-rt-c");
    const backups = (await readdir(join(f.home, ".pi", "identities", "alpha"))).filter((n) => n.includes(".pre-gateway."));
    expect(backups.length).toBe(1);
  });
});

describe("sync merge of gateway-routed swap pool folders", () => {
  const POOL_CODEX = ".codex/identities/pool/auth.json";
  const POOL_CLAUDE = ".claude/identities/pool/.credentials.json";
  async function withPools(f: Awaited<ReturnType<typeof fixture>>) {
    for (const base of [".claude", ".codex"]) {
      const id = (name: string) => ({ name, label: name, configDir: join(f.home, base, "identities", name) });
      await writeFile(join(f.home, base, "identities.json"), JSON.stringify({ version: 1, identities: [id("alpha"), { ...id("pool"), swapPool: { accounts: ["alpha"], active: "alpha" } }] }));
    }
  }

  test("planCredentialMerge keeps a pool's gateway entry against an arriving login; other pool files merge as before", () => {
    expect(planCredentialMerge("codex", codexEntry, codexLogin("remote"), { memberHere: false, pool: true })).toEqual({ action: "keep-local", reason: "kept-pool-entry" });
    expect(planCredentialMerge("codex", codexLogin("local"), codexLogin("remote"), { memberHere: false, pool: true }).action).toBe("merge");
    expect(planCredentialMerge("codex", codexLogin("local"), codexEntry, { memberHere: false, pool: true }).action).toBe("merge");
  });

  test("a newer member login from another host never lands over a routed pool's entry (codex and claude), logged", async () => {
    const f = await fixture();
    await withPools(f);
    const warnings = captureWarnings();
    try {
      await f.put(f.home, POOL_CODEX, codexEntry, T);
      await f.put(f.incoming, POOL_CODEX, codexLogin("remote"), T + 100);
      await f.put(f.home, POOL_CLAUDE, gatewayEntryText(KEY), T);
      await f.put(f.incoming, POOL_CLAUDE, claudeLogin("remote"), T + 100);
      await f.merge();
    } finally {
      warnings.restore();
    }
    expect(await f.read(POOL_CODEX)).toBe(codexEntry);
    expect(await f.read(POOL_CLAUDE)).toBe(gatewayEntryText(KEY));
    expect(warnings.lines.some((l) => l.includes("codex swap pool pool: kept its gateway entry"))).toBe(true);
  });

  test("an unrouted pool's login still merges by time", async () => {
    const f = await fixture();
    await withPools(f);
    await f.put(f.home, POOL_CODEX, codexLogin("local"), T);
    await f.put(f.incoming, POOL_CODEX, codexLogin("remote"), T + 100);
    await f.merge();
    expect(await f.read(POOL_CODEX)).toBe(codexLogin("remote"));
  });
});
