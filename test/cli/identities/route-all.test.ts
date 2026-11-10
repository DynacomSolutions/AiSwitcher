import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupUnique, classifyLogin, codexConfigRouted, codexKeyHelperPath, heldProblem, routeAllViaGateway, routeCodexConfigText, runRouteAllViaGateway, type RouteAllOptions } from "../../../src/cli/identities/route-all.ts";
import { writeHeartbeat } from "../../../src/identities/gateway-heartbeat.ts";
import { hasMemberCopy, memberDir } from "../../../src/identities/gateway-members.ts";
import { refreshFingerprint, routingOf } from "../../../src/identities/gateway-routed.ts";
import { loadIdentitiesFile, saveIdentitiesFile } from "../../../src/identities/store.ts";

const CLAUDE_KEY = "aisg_SYNTHETIC_FIXTURE_claude_key";
const CODEX_KEY = "aisg_SYNTHETIC_FIXTURE_codex_key";
const NOW = Date.parse("2030-01-01T12:00:00Z");

const claudeLogin = (n: string, expiresAt = 1) => JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-SYNTHETIC_FIXTURE-${n}`, refreshToken: `rt-SYNTHETIC_FIXTURE-${n}`, expiresAt, scopes: ["user:inference"] } });
const codexLogin = (n: string, over: { account?: string; lastRefresh?: string } = {}) =>
  JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "x", access_token: `at-SYNTHETIC_FIXTURE-${n}`, refresh_token: `rt-SYNTHETIC_FIXTURE-${n}`, account_id: over.account ?? `acct-${n}` }, ...(over.lastRefresh ? { last_refresh: over.lastRefresh } : {}) });

let home: string;
let opts: RouteAllOptions;
let hbPath: string;

async function registry(tool: string, dirName: string, names: string[], extra: Record<string, unknown> = {}): Promise<void> {
  const base = join(home, dirName);
  await mkdir(base, { recursive: true });
  await writeFile(join(base, "identities.json"), JSON.stringify({ version: 1, identities: names.map((name) => ({ name, label: name, configDir: join(base, "identities", name), ...(extra[name] as object | undefined) })) }));
  for (const name of names) await mkdir(join(base, "identities", name), { recursive: true });
}

const dirOf = (dirName: string, name: string) => join(home, dirName, "identities", name);

const ALL = ["claude/alpha", "claude/beta", "codex/alpha"];

async function heartbeat(keys: readonly string[] = ALL, opt: { ageMs?: number; memberStore?: boolean; unrenewed?: readonly string[]; keys?: readonly string[] } = {}) {
  const held = Object.fromEntries(keys.map((k) => [k, opt.unrenewed?.includes(k) ? {} : { lastSuccessAt: new Date(NOW - 60_000).toISOString() }]));
  await writeHeartbeat({ version: 1, passAt: new Date(NOW - (opt.ageMs ?? 1000)).toISOString(), held, ...(opt.memberStore === false ? {} : { memberStore: true }) }, hbPath);
}

const claudeLine = (r: Awaited<ReturnType<typeof routeAllViaGateway>>, id: string) => r.lines.find((l) => l.tool === "claude" && l.identity === id);
const storeOf = (tool: string, id: string) => memberDir(tool, id, opts.memberRoot);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ais-route-all-"));
  hbPath = join(home, "heartbeat.json");
  await writeFile(join(home, "secrets"), `AIS_GATEWAY_APP_AGENTS_CLAUDE_TOKEN=${CLAUDE_KEY}\nAIS_GATEWAY_APP_AGENTS_CODEX_TOKEN=${CODEX_KEY}\n`);
  await registry("claude", ".claude", ["alpha", "beta"]);
  await registry("codex", ".codex", ["alpha"]);
  await registry("grok", ".grok", ["alpha"]);
  await registry("kimi", ".kimi-code", ["alpha"]);
  await registry("pi", ".pi", ["alpha"]);
  for (const n of ["alpha", "beta"]) {
    await writeFile(join(dirOf(".claude", n), ".credentials.json"), claudeLogin(n));
    await writeFile(join(dirOf(".claude", n), ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: `u-${n}` }, projects: { big: "x" } }));
    await writeFile(join(dirOf(".claude", n), "settings.json"), JSON.stringify({ env: { KEEP: "1" }, apiKeyHelper: "x" }));
  }
  await writeFile(join(dirOf(".codex", "alpha"), "auth.json"), codexLogin("alpha"));
  await writeFile(join(dirOf(".codex", "alpha"), "config.toml"), '# my config\nmodel = "m"\n\n[projects."/x"]\ntrust_level = "trusted"\n');
  await writeFile(join(dirOf(".grok", "alpha"), "auth.json"), "GROK-LOGIN");
  await mkdir(join(home, "proc"), { recursive: true });
  opts = {
    registries: { claude: join(home, ".claude", "identities.json"), codex: join(home, ".codex", "identities.json"), grok: join(home, ".grok", "identities.json"), kimi: join(home, ".kimi-code", "identities.json"), pi: join(home, ".pi", "identities.json") },
    secretsPath: join(home, "secrets"),
    memberRoot: join(home, "members"),
    heartbeatPath: hbPath,
    home,
    procRoot: join(home, "proc"),
    port: 47140,
    now: () => NOW,
    hostname: "routing-host-SYNTHETIC",
    out: () => {},
  };
});
afterEach(() => rm(home, { recursive: true, force: true }));

const statusOf = (r: Awaited<ReturnType<typeof routeAllViaGateway>>, id: string) => r.lines.find((l) => l.identity === id)?.status;
const files = async (dir: string) => (await readdir(dir)).sort();

describe("route-all-via-gateway: refuses what the gateway does not hold", () => {
  for (const [label, hb, expected] of [
    ["no heartbeat", undefined, "no gateway heartbeat"],
    ["stale heartbeat", { keys: ALL, ageMs: 3 * 3_600_000 }, "stale"],
    ["gateway built before the member store", { keys: ALL, memberStore: false }, "predates the member store"],
    ["account not a gateway member", { keys: ["claude/beta", "codex/alpha"] }, "does not hold this account"],
    ["account never renewed by the gateway", { keys: ALL, unrenewed: ["claude/alpha"] }, "not yet renewed"],
  ] as const) {
    test(label, async () => {
      if (hb) await heartbeat(hb.keys, hb);
      const r = await routeAllViaGateway(opts);
      expect(claudeLine(r, "alpha")?.status).toBe("refused");
      expect(claudeLine(r, "alpha")?.detail).toContain(expected);
      expect(r.incomplete).toBe(true);
      // nothing written: no store copy, no backup, the login is where it was
      expect(hasMemberCopy("claude", "alpha", opts.memberRoot)).toBe(false);
      expect(await readFile(join(dirOf(".claude", "alpha"), ".credentials.json"), "utf8")).toBe(claudeLogin("alpha"));
      expect((await files(dirOf(".claude", "alpha"))).some((f) => f.includes(".pre-gateway."))).toBe(false);
    });
  }

  test("the report and exit code name every refused identity", async () => {
    await heartbeat(["claude/beta", "codex/alpha"]);
    const out: string[] = [];
    const saved = process.exitCode;
    await runRouteAllViaGateway({}, { ...opts, out: (l) => out.push(l) });
    expect(process.exitCode).toBe(1);
    process.exitCode = saved;
    expect(out.some((l) => l.startsWith("  claude/alpha: refused"))).toBe(true);
    expect(out.some((l) => l.includes("grok: NOT ROUTED"))).toBe(true);
    // never a secret value in the output
    expect(out.join("\n")).not.toContain("SYNTHETIC_FIXTURE");
  });

  test("heldProblem accepts a fresh heartbeat naming a renewed account", () => {
    const hb = { version: 1 as const, passAt: new Date(NOW).toISOString(), held: { "codex/x": { lastSuccessAt: "2030-01-01T00:00:00Z" } }, memberStore: true };
    expect(heldProblem("codex", "x", hb, NOW)).toBeUndefined();
    expect(heldProblem("codex", "y", hb, NOW)).toContain("does not hold");
  });
});

describe("route-all-via-gateway: routing", () => {
  test("dry run reports and writes nothing", async () => {
    await heartbeat();
    const r = await routeAllViaGateway({ ...opts, dryRun: true });
    expect(r.lines.filter((l) => l.status === "would-route").length).toBe(3);
    expect(await readFile(join(dirOf(".claude", "alpha"), ".credentials.json"), "utf8")).toBe(claudeLogin("alpha"));
    expect(await files(dirOf(".claude", "alpha"))).toEqual([".claude.json", ".credentials.json", "settings.json"]);
    await expect(stat(opts.memberRoot!)).rejects.toThrow();
    await expect(stat(codexKeyHelperPath(home))).rejects.toThrow();
  });

  test("moves the login to the member store, backs up, writes the gateway entry; a second run changes nothing", async () => {
    await heartbeat();
    const r = await routeAllViaGateway(opts);
    expect(r.lines.filter((l) => l.status === "routed").length).toBe(3);

    // the store gets the fixture login (0600, folder 0700); of .claude.json only the oauthAccount record goes along
    const store = storeOf("claude", "alpha");
    expect(await readFile(join(store, ".credentials.json"), "utf8")).toBe(claudeLogin("alpha"));
    expect((await stat(join(store, ".credentials.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(store)).mode & 0o777).toBe(0o700);
    expect((await stat(opts.memberRoot!)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(join(store, ".claude.json"), "utf8"))).toEqual({ oauthAccount: { accountUuid: "u-alpha" } });
    expect(await readFile(join(storeOf("codex", "alpha"), "auth.json"), "utf8")).toBe(codexLogin("alpha"));

    const dir = dirOf(".claude", "alpha");
    const backups = (await files(dir)).filter((f) => f.startsWith(".credentials.json.pre-gateway."));
    expect(backups.length).toBe(1);
    expect(await readFile(join(dir, backups[0]!), "utf8")).toBe(claudeLogin("alpha"));
    expect((await stat(join(dir, backups[0]!))).mode & 0o777).toBe(0o600);
    expect((await files(dir)).filter((f) => f.startsWith("settings.json.pre-gateway.")).length).toBe(1);
    const entry = JSON.parse(await readFile(join(dir, ".credentials.json"), "utf8")).claudeAiOauth;
    expect(entry.accessToken).toBe(CLAUDE_KEY);
    expect(entry.refreshToken).toBeNull();
    // the routing record lets other hosts tell their copy of this login from a later sign-in there; nothing secret in it
    expect(routingOf(await readFile(join(dir, ".credentials.json"), "utf8"))).toEqual({ host: "routing-host-SYNTHETIC", at: NOW, fingerprints: [refreshFingerprint("rt-SYNTHETIC_FIXTURE-alpha")], freshness: 1, account: "u-alpha" });
    expect(await readFile(join(dir, ".credentials.json"), "utf8")).not.toContain("rt-SYNTHETIC_FIXTURE");
    const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    expect(settings.env).toEqual({ KEEP: "1", ANTHROPIC_BASE_URL: "http://127.0.0.1:47140/claude" });
    expect(settings.apiKeyHelper).toBeUndefined();

    const cdir = dirOf(".codex", "alpha");
    expect(JSON.parse(await readFile(join(cdir, "auth.json"), "utf8"))).toEqual({
      auth_mode: "apikey",
      OPENAI_API_KEY: CODEX_KEY,
      aisGatewayRouting: { host: "routing-host-SYNTHETIC", at: NOW, fingerprints: [refreshFingerprint("rt-SYNTHETIC_FIXTURE-alpha")], account: "acct-alpha" },
    });
    const toml = await readFile(join(cdir, "config.toml"), "utf8");
    expect(toml).toContain("# my config");
    expect(toml).toContain('[projects."/x"]');
    expect(codexConfigRouted(toml, "http://127.0.0.1:47140/codex", codexKeyHelperPath(home))).toBe(true);
    expect((await stat(codexKeyHelperPath(home))).mode & 0o777).toBe(0o755);
    expect(await readFile(codexKeyHelperPath(home), "utf8")).not.toContain(CODEX_KEY);

    const snapshot = [await files(dir), await files(cdir), await files(store)];
    const again = await routeAllViaGateway(opts);
    expect(again.lines.every((l) => l.status === "already-routed" && l.detail === undefined)).toBe(true);
    expect([await files(dir), await files(cdir), await files(store)]).toEqual(snapshot);
  });

  test("a re-run adds the routing record to an entry written without one, and changes nothing else", async () => {
    await heartbeat();
    await routeAllViaGateway(opts);
    const path = join(dirOf(".claude", "alpha"), ".credentials.json");
    const legacy = JSON.parse(await readFile(path, "utf8"));
    delete legacy.aisGatewayRouting;
    await writeFile(path, JSON.stringify(legacy));
    const again = await routeAllViaGateway({ ...opts, now: () => NOW + 1000 });
    expect(claudeLine(again, "alpha")?.detail).toContain("added the routing record");
    const text = await readFile(path, "utf8");
    expect(JSON.parse(text).claudeAiOauth).toEqual(legacy.claudeAiOauth);
    expect(routingOf(text)).toEqual({ host: "routing-host-SYNTHETIC", at: NOW + 1000, fingerprints: [refreshFingerprint("rt-SYNTHETIC_FIXTURE-alpha")], freshness: 1, account: "u-alpha" });
    expect(claudeLine(await routeAllViaGateway(opts), "alpha")?.detail).toBeUndefined();
  });

  test("an existing key helper is kept", async () => {
    await mkdir(join(home, ".local", "bin"), { recursive: true });
    await writeFile(codexKeyHelperPath(home), "#!/bin/sh\necho mine\n", { mode: 0o700 });
    await heartbeat();
    await routeAllViaGateway(opts);
    expect(await readFile(codexKeyHelperPath(home), "utf8")).toBe("#!/bin/sh\necho mine\n");
  });

  test("a store copy the gateway renewed since is kept; a fresher sign-in of the same account replaces it after a backup", async () => {
    await heartbeat();
    // the gateway already holds a fresher copy (it renewed it after an earlier, interrupted run); the folder was touched since
    await mkdir(storeOf("claude", "alpha"), { recursive: true });
    await writeFile(join(storeOf("claude", "alpha"), ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "u-alpha" } }));
    await writeFile(join(storeOf("claude", "alpha"), ".credentials.json"), claudeLogin("alpha-renewed", 2_000));
    await writeFile(join(dirOf(".claude", "alpha"), ".credentials.json"), claudeLogin("alpha", 1_000));
    // beta signed in again locally after its store copy was written
    await mkdir(storeOf("claude", "beta"), { recursive: true });
    await writeFile(join(storeOf("claude", "beta"), ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "u-beta" } }));
    await writeFile(join(storeOf("claude", "beta"), ".credentials.json"), claudeLogin("beta-old", 1_000));
    await writeFile(join(dirOf(".claude", "beta"), ".credentials.json"), claudeLogin("beta", 2_000));

    const r = await routeAllViaGateway(opts);
    expect(claudeLine(r, "alpha")?.status).toBe("routed");
    expect(claudeLine(r, "alpha")?.detail).toContain("kept it");
    expect(await readFile(join(storeOf("claude", "alpha"), ".credentials.json"), "utf8")).toBe(claudeLogin("alpha-renewed", 2_000));
    expect(claudeLine(r, "beta")?.status).toBe("routed");
    expect(await readFile(join(storeOf("claude", "beta"), ".credentials.json"), "utf8")).toBe(claudeLogin("beta", 2_000));
    const kept = (await files(storeOf("claude", "beta"))).filter((f) => f.startsWith(".credentials.json.pre-gateway."));
    expect(kept.length).toBe(1);
    expect(await readFile(join(storeOf("claude", "beta"), kept[0]!), "utf8")).toBe(claudeLogin("beta-old", 1_000));
  });

  test("a restored codex folder with an older login never overwrites the store copy, whatever its mtime", async () => {
    await heartbeat();
    await mkdir(storeOf("codex", "alpha"), { recursive: true });
    const live = codexLogin("alpha-live", { account: "acct-alpha", lastRefresh: "2030-01-01T10:00:00Z" });
    await writeFile(join(storeOf("codex", "alpha"), "auth.json"), live);
    // written after the store copy (newer mtime), but its refresh token was spent long ago
    await writeFile(join(dirOf(".codex", "alpha"), "auth.json"), codexLogin("alpha", { lastRefresh: "2029-12-01T10:00:00Z" }));
    const r = await routeAllViaGateway(opts);
    expect(r.lines.find((l) => l.tool === "codex")?.status).toBe("routed");
    expect(await readFile(join(storeOf("codex", "alpha"), "auth.json"), "utf8")).toBe(live);
  });

  test("a folder holding a different account than its store copy is refused and nothing changes", async () => {
    await heartbeat();
    await mkdir(storeOf("codex", "alpha"), { recursive: true });
    const live = codexLogin("alpha-live", { lastRefresh: "2030-01-01T10:00:00Z" });
    await writeFile(join(storeOf("codex", "alpha"), "auth.json"), live);
    const other = codexLogin("other", { account: "acct-other", lastRefresh: "2030-01-01T11:00:00Z" });
    await writeFile(join(dirOf(".codex", "alpha"), "auth.json"), other);
    await mkdir(storeOf("claude", "alpha"), { recursive: true });
    await writeFile(join(storeOf("claude", "alpha"), ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "u-someone-else" } }));
    await writeFile(join(storeOf("claude", "alpha"), ".credentials.json"), claudeLogin("someone-else", 1));
    await writeFile(join(dirOf(".claude", "alpha"), ".credentials.json"), claudeLogin("alpha", 5_000));

    const r = await routeAllViaGateway(opts);
    for (const tool of ["codex", "claude"]) {
      const l = r.lines.find((x) => x.tool === tool && x.identity === "alpha");
      expect(l?.status).toBe("refused");
      expect(l?.detail).toContain("different account");
    }
    expect(await readFile(join(storeOf("codex", "alpha"), "auth.json"), "utf8")).toBe(live);
    expect(await readFile(join(dirOf(".codex", "alpha"), "auth.json"), "utf8")).toBe(other);
    expect((await files(dirOf(".codex", "alpha"))).some((f) => f.includes(".pre-gateway."))).toBe(false);
    expect(await readFile(join(dirOf(".claude", "alpha"), ".credentials.json"), "utf8")).toBe(claudeLogin("alpha", 5_000));
  });

  test("an empty store login file left by a crash is not a store copy: the folder's login is written over it", async () => {
    await heartbeat();
    await mkdir(storeOf("codex", "alpha"), { recursive: true });
    await writeFile(join(storeOf("codex", "alpha"), "auth.json"), "");
    expect(hasMemberCopy("codex", "alpha", opts.memberRoot)).toBe(false);
    const r = await routeAllViaGateway(opts);
    expect(r.lines.find((l) => l.tool === "codex")?.status).toBe("routed");
    expect(await readFile(join(storeOf("codex", "alpha"), "auth.json"), "utf8")).toBe(codexLogin("alpha"));
    expect(hasMemberCopy("codex", "alpha", opts.memberRoot)).toBe(true);
  });

  test("an empty store file with the folder already on the gateway entry is refused (no usable login anywhere)", async () => {
    await heartbeat();
    await routeAllViaGateway(opts);
    await writeFile(join(storeOf("codex", "alpha"), "auth.json"), "");
    await writeFile(join(dirOf(".codex", "alpha"), "config.toml"), "");
    const r = await routeAllViaGateway(opts);
    expect(r.lines.find((l) => l.tool === "codex")?.status).toBe("refused");
    expect(r.lines.find((l) => l.tool === "codex")?.detail).toContain("member store has no login");
  });

  test("a half-finished folder (entry written, settings not) is completed without a heartbeat", async () => {
    await heartbeat();
    await routeAllViaGateway(opts);
    await writeFile(join(dirOf(".claude", "alpha"), "settings.json"), JSON.stringify({ env: {} }));
    await rm(hbPath);
    const r = await routeAllViaGateway(opts);
    expect(claudeLine(r, "alpha")?.status).toBe("routed");
    expect(JSON.parse(await readFile(join(dirOf(".claude", "alpha"), "settings.json"), "utf8")).env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:47140/claude");
  });

  test("a folder with the gateway entry but no store copy is refused (the login would be lost)", async () => {
    await writeFile(join(dirOf(".claude", "alpha"), ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "aisg_other", refreshToken: null } }));
    await heartbeat();
    const r = await routeAllViaGateway(opts);
    expect(claudeLine(r, "alpha")?.status).toBe("refused");
    expect(claudeLine(r, "alpha")?.detail).toContain("member store has no login");
  });

  test("grok, kimi and pi have no route: reported with their identities, left alone", async () => {
    await heartbeat();
    const r = await routeAllViaGateway(opts);
    expect(r.unroutedTools.map((t) => t.tool)).toEqual(["grok", "kimi", "pi"]);
    expect(r.unroutedTools[0]?.reason).toContain("alpha");
    expect(r.incomplete).toBe(true);
    expect(await readFile(join(dirOf(".grok", "alpha"), "auth.json"), "utf8")).toBe("GROK-LOGIN");
  });

  test("a tool without its key is reported and untouched", async () => {
    await heartbeat();
    await writeFile(join(home, "secrets"), `AIS_GATEWAY_APP_AGENTS_CLAUDE_TOKEN=${CLAUDE_KEY}\n`);
    const r = await routeAllViaGateway(opts);
    expect(r.unroutedTools.find((t) => t.tool === "codex")?.reason).toContain("AIS_GATEWAY_APP_AGENTS_CODEX_TOKEN");
    expect(await readFile(join(dirOf(".codex", "alpha"), "auth.json"), "utf8")).toBe(codexLogin("alpha"));
    expect(hasMemberCopy("codex", "alpha", opts.memberRoot)).toBe(false);
  });

  test("a logged-out or API-key identity is refused, never given an entry", async () => {
    await writeFile(join(dirOf(".codex", "alpha"), "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-SYNTHETIC_FIXTURE" }));
    await heartbeat();
    const r = await routeAllViaGateway(opts);
    expect(r.lines.find((l) => l.tool === "codex")?.status).toBe("refused");
    expect(JSON.parse(await readFile(join(dirOf(".codex", "alpha"), "auth.json"), "utf8")).OPENAI_API_KEY).toBe("sk-SYNTHETIC_FIXTURE");
  });

  test("a symlinked settings file is refused, not written through", async () => {
    const shared = join(home, "shared-settings.json");
    await writeFile(shared, "{}");
    await rm(join(dirOf(".claude", "alpha"), "settings.json"));
    await symlink(shared, join(dirOf(".claude", "alpha"), "settings.json"));
    await heartbeat();
    const r = await routeAllViaGateway(opts);
    expect(claudeLine(r, "alpha")?.status).toBe("refused");
    expect(await readFile(shared, "utf8")).toBe("{}");
    expect(hasMemberCopy("claude", "alpha", opts.memberRoot)).toBe(false);
  });

  test("a swap pool folder is routed before its members: the gateway entry, never a store copy, and its active member is routed too", async () => {
    await registry("claude", ".claude", ["alpha", "beta", "pool"], { pool: { swapPool: { accounts: ["alpha", "beta"], active: "alpha" } } });
    await writeFile(join(dirOf(".claude", "pool"), ".credentials.json"), claudeLogin("alpha"));
    await writeFile(join(dirOf(".claude", "pool"), ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "u-alpha" } }));
    await heartbeat();
    const dry = await routeAllViaGateway({ ...opts, dryRun: true });
    expect(claudeLine(dry, "pool")?.status).toBe("would-route");
    // the dry run knows the pool goes first: alpha is not reported as held by it
    expect(claudeLine(dry, "alpha")?.status).toBe("would-route");
    expect(await readFile(join(dirOf(".claude", "pool"), ".credentials.json"), "utf8")).toBe(claudeLogin("alpha"));

    let r = await routeAllViaGateway(opts);
    expect(r.lines[0]?.identity).toBe("pool");
    expect(claudeLine(r, "pool")?.status).toBe("routed");
    expect(claudeLine(r, "pool")?.detail).toContain("the gateway now picks this pool's member");
    const entry = JSON.parse(await readFile(join(dirOf(".claude", "pool"), ".credentials.json"), "utf8"));
    expect(entry.claudeAiOauth.accessToken).toBe(CLAUDE_KEY);
    expect(entry.claudeAiOauth.refreshToken).toBeNull();
    expect(JSON.parse(await readFile(join(dirOf(".claude", "pool"), "settings.json"), "utf8")).env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:47140/claude");
    // the pool's copy was the same login as alpha's: nothing written back, the old pool file kept in a backup
    expect((await files(dirOf(".claude", "pool"))).some((f) => f.startsWith(".credentials.json.pre-gateway."))).toBe(true);
    expect(hasMemberCopy("claude", "pool", opts.memberRoot)).toBe(false);
    // alpha (the active member) is routed in the same run, with no pool warning
    expect(claudeLine(r, "alpha")?.status).toBe("routed");
    expect(claudeLine(r, "alpha")?.detail ?? "").not.toContain("swap pool");
    expect(await readFile(join(storeOf("claude", "alpha"), ".credentials.json"), "utf8")).toBe(claudeLogin("alpha"));

    r = await routeAllViaGateway(opts);
    expect(claudeLine(r, "pool")?.status).toBe("already-routed");
    expect(claudeLine(r, "alpha")?.status).toBe("already-routed");
    expect(r.lines.some((l) => l.status === "refused" || l.attention)).toBe(false);
  });

  test("a pool login fresher than its owner's copy goes back to the owner (folder, or member store) before the entry replaces it", async () => {
    await registry("codex", ".codex", ["alpha", "beta", "pool"], { pool: { swapPool: { accounts: ["alpha", "beta"], active: "alpha" } } });
    await writeFile(join(dirOf(".codex", "beta"), "auth.json"), codexLogin("beta"));
    // a session in the pool refreshed alpha's login: same account, newer refresh token
    const fresher = codexLogin("alpha2", { account: "acct-alpha", lastRefresh: "2029-12-31T00:00:00Z" });
    await writeFile(join(dirOf(".codex", "alpha"), "auth.json"), codexLogin("alpha", { lastRefresh: "2029-12-01T00:00:00Z" }));
    await writeFile(join(dirOf(".codex", "pool"), "auth.json"), fresher);
    await heartbeat([...ALL, "codex/beta"]);
    const r = await routeAllViaGateway(opts);
    expect(r.lines.find((l) => l.tool === "codex" && l.identity === "pool")?.detail).toContain("went back to its folder");
    // alpha then moved the fresher login into the store
    expect(await readFile(join(storeOf("codex", "alpha"), "auth.json"), "utf8")).toBe(fresher);
    expect(JSON.parse(await readFile(join(dirOf(".codex", "pool"), "auth.json"), "utf8"))).toMatchObject({ auth_mode: "apikey", OPENAI_API_KEY: CODEX_KEY });
    expect(codexConfigRouted(await readFile(join(dirOf(".codex", "pool"), "config.toml"), "utf8"), "http://127.0.0.1:47140/codex", codexKeyHelperPath(home))).toBe(true);

    // the members are routed now; a pool that holds a fresher login again sends it to the member store copy
    const newest = codexLogin("alpha3", { account: "acct-alpha", lastRefresh: "2030-01-01T00:00:00Z" });
    await writeFile(join(dirOf(".codex", "pool"), "auth.json"), newest);
    const again = await routeAllViaGateway(opts);
    expect(again.lines.find((l) => l.tool === "codex" && l.identity === "pool")?.detail).toContain("went back to the member store");
    expect(await readFile(join(storeOf("codex", "alpha"), "auth.json"), "utf8")).toBe(newest);
    expect(classifyLogin("codex", await readFile(join(dirOf(".codex", "pool"), "auth.json"), "utf8"))).toBe("gateway");
  });

  test("a pool whose members the gateway does not hold is refused and left as it was", async () => {
    await registry("claude", ".claude", ["alpha", "beta", "pool"], { pool: { swapPool: { accounts: ["alpha", "beta"], active: "alpha" } } });
    await writeFile(join(dirOf(".claude", "pool"), ".credentials.json"), claudeLogin("alpha"));
    await heartbeat(["codex/alpha"]);
    const r = await routeAllViaGateway(opts);
    expect(claudeLine(r, "pool")?.status).toBe("refused");
    expect(claudeLine(r, "pool")?.detail).toContain("the gateway holds none of its members");
    expect(await readFile(join(dirOf(".claude", "pool"), ".credentials.json"), "utf8")).toBe(claudeLogin("alpha"));
  });

  test("retired identities are skipped", async () => {
    await registry("codex", ".codex", ["alpha"], { alpha: { retired: true } });
    await writeFile(join(dirOf(".codex", "alpha"), "auth.json"), codexLogin("alpha"));
    await heartbeat();
    const r = await routeAllViaGateway(opts);
    expect(r.lines.some((l) => l.tool === "codex")).toBe(false);
    expect(await readFile(join(dirOf(".codex", "alpha"), "auth.json"), "utf8")).toBe(codexLogin("alpha"));
  });
});

describe("route-all-via-gateway: running sessions", () => {
  const fakeProc = async (pid: number, argv: string[], env: Record<string, string>) => {
    const dir = join(opts.procRoot!, String(pid));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "cmdline"), `${argv.join("\0")}\0`);
    await writeFile(join(dir, "environ"), Object.entries({ PATH: "/x", ...env }).map(([k, v]) => `${k}=${v}`).join("\0"));
  };

  test("a folder with a running Claude Code or Codex session is refused, listing the pids; nothing written", async () => {
    await heartbeat();
    await fakeProc(4101, ["/opt/bin/claude", "--model", "x"], { CLAUDE_CONFIG_DIR: dirOf(".claude", "alpha") });
    await fakeProc(4102, ["node", "/usr/lib/node_modules/@openai/codex/bin/codex"], { CODEX_HOME: `${dirOf(".codex", "alpha")}/` });
    await fakeProc(4103, ["/usr/bin/codex", "resume"], { CODEX_HOME: dirOf(".codex", "alpha") });
    // not sessions of these folders: another folder, an AIS helper subcommand, a shell carrying the variable
    await fakeProc(4104, ["claude"], { CLAUDE_CONFIG_DIR: dirOf(".claude", "beta-elsewhere") });
    await fakeProc(4105, ["/opt/bin/claude", "__session-sidecar"], { CLAUDE_CONFIG_DIR: dirOf(".claude", "beta") });
    await fakeProc(4106, ["/usr/bin/zsh"], { CLAUDE_CONFIG_DIR: dirOf(".claude", "beta") });

    const dry = await routeAllViaGateway({ ...opts, dryRun: true });
    expect(claudeLine(dry, "alpha")?.status).toBe("refused");
    const r = await routeAllViaGateway(opts);
    const alpha = claudeLine(r, "alpha");
    expect(alpha?.status).toBe("refused");
    expect(alpha?.detail).toContain("1 running Claude Code session uses this folder (pid 4101)");
    const codex = r.lines.find((l) => l.tool === "codex");
    expect(codex?.status).toBe("refused");
    expect(codex?.detail).toContain("2 running Codex sessions use this folder (pid 4102, 4103)");
    expect(codex?.detail).toContain("write that login back");
    expect(claudeLine(r, "beta")?.status).toBe("routed");
    expect(r.incomplete).toBe(true);
    expect(hasMemberCopy("claude", "alpha", opts.memberRoot)).toBe(false);
    expect(hasMemberCopy("codex", "alpha", opts.memberRoot)).toBe(false);
    expect(await readFile(join(dirOf(".claude", "alpha"), ".credentials.json"), "utf8")).toBe(claudeLogin("alpha"));
    expect(await readFile(join(dirOf(".codex", "alpha"), "auth.json"), "utf8")).toBe(codexLogin("alpha"));
    expect((await files(dirOf(".codex", "alpha"))).some((f) => f.includes(".pre-gateway."))).toBe(false);

    // once the sessions end the same run goes through
    await rm(opts.procRoot!, { recursive: true, force: true });
    await mkdir(opts.procRoot!, { recursive: true });
    const after = await routeAllViaGateway(opts);
    expect(claudeLine(after, "alpha")?.status).toBe("routed");
    expect(after.lines.find((l) => l.tool === "codex")?.status).toBe("routed");
  });

  test("a session without the folder variable counts for the tool's default folder", async () => {
    // an identity whose folder is the default ~/.codex of this (scratch) home
    await writeFile(join(home, ".codex", "identities.json"), JSON.stringify({ version: 1, identities: [{ name: "main", label: "main", configDir: join(home, ".codex") }] }));
    await writeFile(join(home, ".codex", "auth.json"), codexLogin("main"));
    await heartbeat([...ALL, "codex/main"]);
    await fakeProc(4201, ["codex"], {});
    const r = await routeAllViaGateway(opts);
    expect(r.lines.find((l) => l.tool === "codex" && l.identity === "main")?.detail).toContain("pid 4201");
  });

  test("a pool with a running session is refused; then its active member is refused and routed members carry the warning", async () => {
    await registry("codex", ".codex", ["alpha", "beta", "pool"], { pool: { swapPool: { accounts: ["alpha", "beta"], active: "alpha" } } });
    await writeFile(join(dirOf(".codex", "alpha"), "auth.json"), codexLogin("alpha"));
    await writeFile(join(dirOf(".codex", "beta"), "auth.json"), codexLogin("beta"));
    await writeFile(join(dirOf(".codex", "pool"), "auth.json"), codexLogin("alpha"));
    await heartbeat([...ALL, "codex/beta"]);
    await fakeProc(4301, ["codex"], { CODEX_HOME: dirOf(".codex", "pool") });
    const run = async () => {
      const out: string[] = [];
      const saved = process.exitCode;
      await runRouteAllViaGateway({}, { ...opts, out: (l) => out.push(l) });
      process.exitCode = saved;
      return out;
    };
    // the pool's active member: every session of the pool holds that login
    let out = await run();
    expect(out.find((l) => l.startsWith("  codex/alpha: refused"))).toContain("swap pool pool holds a copy of this login (this identity is its active member)");
    expect(out.find((l) => l.startsWith("  codex/alpha: refused"))).toContain("ais swap codex to beta --pool=pool");
    expect(await readFile(join(dirOf(".codex", "alpha"), "auth.json"), "utf8")).toBe(codexLogin("alpha"));
    expect(hasMemberCopy("codex", "alpha", opts.memberRoot)).toBe(false);
    expect(out.find((l) => l.startsWith("  codex/pool: refused"))).toContain("1 running Codex session uses this folder (pid 4301)");
    expect(await readFile(join(dirOf(".codex", "pool"), "auth.json"), "utf8")).toBe(codexLogin("alpha"));
    // beta is not what the pool holds: routed, with the warning that the unrouted pool cannot swap to it
    expect(out.find((l) => l.startsWith("  codex/beta: routed"))).toContain("member of swap pool pool, which is not routed");

    // the registry says another member is active, but the pool file still holds alpha's refresh token
    await registry("codex", ".codex", ["alpha", "beta", "pool"], { pool: { swapPool: { accounts: ["alpha", "beta"], active: "beta" } } });
    await writeFile(join(dirOf(".codex", "alpha"), "auth.json"), codexLogin("alpha", { account: "acct-x" }));
    await writeFile(join(dirOf(".codex", "pool"), "auth.json"), codexLogin("alpha"));
    out = await run();
    expect(out.find((l) => l.startsWith("  codex/alpha: refused"))).toContain("it holds the same refresh token");

    // swapped away: alpha goes through
    await writeFile(join(dirOf(".codex", "pool"), "auth.json"), codexLogin("other", { account: "acct-other" }));
    out = await run();
    expect(out.find((l) => l.startsWith("  codex/alpha: routed"))).toContain("member of swap pool pool, which is not routed");

    // the session ended: the pool is routed and its members lose the warning
    await rm(join(opts.procRoot!, "4301"), { recursive: true, force: true });
    out = await run();
    expect(out.find((l) => l.startsWith("  codex/pool: routed"))).toContain("matches none of its members");
    expect(out.find((l) => l.startsWith("  codex/alpha: already-routed"))).not.toContain("swap pool");
  });

  test("a scan that cannot run (no /proc) refuses and writes nothing", async () => {
    await heartbeat();
    const r = await routeAllViaGateway({ ...opts, procRoot: join(home, "no-proc") });
    expect(claudeLine(r, "alpha")?.status).toBe("refused");
    expect(claudeLine(r, "alpha")?.detail).toContain("cannot check for running sessions");
    expect(r.lines.every((l) => l.status === "refused")).toBe(true);
    expect(hasMemberCopy("claude", "alpha", opts.memberRoot)).toBe(false);
    expect(await readFile(join(dirOf(".claude", "alpha"), ".credentials.json"), "utf8")).toBe(claudeLogin("alpha"));
  });
});

describe("route-all-via-gateway: pi's copy of the login", () => {
  const piAuth = (dirName: string) => join(dirOf(".pi", dirName), "auth.json");
  const piEntry = (refresh: string, expires: number) => ({ type: "oauth", access: `pi-at-SYNTHETIC_FIXTURE-${refresh}`, refresh, expires });
  const fakeProc = async (pid: number, argv: string[], env: Record<string, string>) => {
    const dir = join(opts.procRoot!, String(pid));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "cmdline"), `${argv.join("\0")}\0`);
    await writeFile(join(dir, "environ"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\0"));
  };

  test("the same-named pi identity's entry for the same login is removed after a backup; its other providers stay", async () => {
    await writeFile(piAuth("alpha"), JSON.stringify({ anthropic: piEntry("rt-SYNTHETIC_FIXTURE-alpha", 1), "kimi-coding": { type: "oauth", access: "k", refresh: "kr" } }));
    await heartbeat();
    const dry = await routeAllViaGateway({ ...opts, dryRun: true });
    expect(claudeLine(dry, "alpha")?.detail).toContain("pi identity alpha's anthropic entry would be removed");
    expect(JSON.parse(await readFile(piAuth("alpha"), "utf8")).anthropic).toBeDefined();

    const r = await routeAllViaGateway(opts);
    expect(claudeLine(r, "alpha")?.status).toBe("routed");
    expect(claudeLine(r, "alpha")?.detail).toContain("removed its anthropic entry (the same login");
    const after = JSON.parse(await readFile(piAuth("alpha"), "utf8"));
    expect(after.anthropic).toBeUndefined();
    expect(after["kimi-coding"]).toEqual({ type: "oauth", access: "k", refresh: "kr" });
    const backups = (await files(dirOf(".pi", "alpha"))).filter((f) => f.startsWith("auth.json.pre-gateway."));
    expect(backups.length).toBe(1);
    expect(JSON.parse(await readFile(join(dirOf(".pi", "alpha"), backups[0]!), "utf8")).anthropic.refresh).toBe("rt-SYNTHETIC_FIXTURE-alpha");
  });

  test("an older pi copy is removed; a pi copy that may be fresher is refused", async () => {
    await writeFile(join(dirOf(".claude", "alpha"), ".credentials.json"), claudeLogin("alpha", NOW + 3_600_000));
    await writeFile(piAuth("alpha"), JSON.stringify({ anthropic: piEntry("rt-pi-old", NOW - 86_400_000), "openai-codex": piEntry("rt-pi-codex", 1) }));
    await heartbeat();
    const r = await routeAllViaGateway(opts);
    expect(claudeLine(r, "alpha")?.detail).toContain("an older copy");
    expect(claudeLine(r, "alpha")?.status).toBe("routed");
    // the codex fixture login carries no timestamp: pi's different copy cannot be proven older
    const codex = r.lines.find((l) => l.tool === "codex");
    expect(codex?.status).toBe("refused");
    expect(codex?.detail).toContain("ais auth sync --tool=pi");
    expect(hasMemberCopy("codex", "alpha", opts.memberRoot)).toBe(false);
    expect(JSON.parse(await readFile(piAuth("alpha"), "utf8"))["openai-codex"].refresh).toBe("rt-pi-codex");
  });

  test("a running pi session, a pi pool on this identity or another pi identity holding the token is refused", async () => {
    await writeFile(piAuth("alpha"), JSON.stringify({ anthropic: piEntry("rt-SYNTHETIC_FIXTURE-alpha", 1) }));
    await heartbeat();
    await fakeProc(4301, ["node", "/usr/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js"], { PI_CODING_AGENT_DIR: join(home, "somewhere-else") });
    let r = await routeAllViaGateway(opts);
    expect(claudeLine(r, "alpha")?.status).toBe("refused");
    expect(claudeLine(r, "alpha")?.detail).toContain("1 running pi session (pid 4301)");
    expect(JSON.parse(await readFile(piAuth("alpha"), "utf8")).anthropic).toBeDefined();
    await rm(join(opts.procRoot!, "4301"), { recursive: true });

    await registry("pi", ".pi", ["alpha", "pipool"], { pipool: { swapPool: { accounts: ["alpha"], active: "alpha" } } });
    await writeFile(piAuth("pipool"), JSON.stringify({ anthropic: piEntry("rt-SYNTHETIC_FIXTURE-alpha", 1) }));
    r = await routeAllViaGateway(opts);
    expect(claudeLine(r, "alpha")?.detail).toContain("pi swap pool pipool holds a copy");

    await registry("pi", ".pi", ["alpha", "other"]);
    await writeFile(piAuth("other"), JSON.stringify({ anthropic: piEntry("rt-SYNTHETIC_FIXTURE-alpha", 1) }));
    r = await routeAllViaGateway(opts);
    expect(claudeLine(r, "alpha")?.detail).toContain("pi identity other holds this login's refresh token");
    expect(hasMemberCopy("claude", "alpha", opts.memberRoot)).toBe(false);
  });
});

describe("route-all-via-gateway: a failure after the store write rolls back to one holder", () => {
  const storeFiles = async (tool: string, id: string) => (await files(storeOf(tool, id))).filter((f) => f.includes(".rolled-back."));
  test("the entry written, then the settings write fails: the folder gets its login back, the store copy is set aside", async () => {
    await heartbeat();
    await rm(join(dirOf(".claude", "alpha"), "settings.json"));
    await mkdir(join(dirOf(".claude", "alpha"), "settings.json"));
    await rm(join(dirOf(".codex", "alpha"), "config.toml"));
    await mkdir(join(dirOf(".codex", "alpha"), "config.toml"));
    const r = await routeAllViaGateway(opts);
    for (const [tool, dirName, file, login] of [["claude", ".claude", ".credentials.json", claudeLogin("alpha")], ["codex", ".codex", "auth.json", codexLogin("alpha")]] as const) {
      const l = r.lines.find((x) => x.tool === tool && x.identity === "alpha");
      expect(l?.status).toBe("refused");
      expect(l?.detail).toContain("the folder holds its login again and the gateway reads it from there");
      expect(hasMemberCopy(tool, "alpha", opts.memberRoot)).toBe(false);
      expect((await storeFiles(tool, "alpha")).length).toBe(1);
      expect(await readFile(join(dirOf(dirName, "alpha"), file), "utf8")).toBe(login);
    }
    // beta was not affected
    expect(claudeLine(r, "beta")?.status).toBe("routed");
  });

  test("pi's copy is removed before the store write", async () => {
    await writeFile(join(dirOf(".pi", "alpha"), "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "rt-SYNTHETIC_FIXTURE-alpha", expires: 1 } }));
    await heartbeat();
    await chmod(dirOf(".pi", "alpha"), 0o500);
    try {
      const r = await routeAllViaGateway(opts);
      expect(claudeLine(r, "alpha")?.status).toBe("refused");
    } finally {
      await chmod(dirOf(".pi", "alpha"), 0o700);
    }
    // nothing reached the store: the folder alone (and pi's untouched copy) hold the login, as before
    expect(hasMemberCopy("claude", "alpha", opts.memberRoot)).toBe(false);
    expect(await readFile(join(dirOf(".claude", "alpha"), ".credentials.json"), "utf8")).toBe(claudeLogin("alpha"));
  });
});

describe("route-all-via-gateway: already routed identities are checked again", () => {
  test("a pi copy that appeared since is removed; a swap pool holding the login is reported with attention", async () => {
    await heartbeat();
    expect(claudeLine(await routeAllViaGateway(opts), "alpha")?.status).toBe("routed");
    // pi got a copy of the store's login again (an older build, a restore)
    await writeFile(join(dirOf(".pi", "alpha"), "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "rt-SYNTHETIC_FIXTURE-alpha", expires: 1 } }));
    let r = await routeAllViaGateway(opts);
    expect(claudeLine(r, "alpha")?.status).toBe("already-routed");
    expect(claudeLine(r, "alpha")?.detail).toContain("removed its anthropic entry");
    expect(JSON.parse(await readFile(join(dirOf(".pi", "alpha"), "auth.json"), "utf8")).anthropic).toBeUndefined();

    await registry("claude", ".claude", ["alpha", "beta", "pool"], { pool: { swapPool: { accounts: ["alpha", "beta"], active: "alpha" } } });
    await writeFile(join(dirOf(".claude", "pool"), ".credentials.json"), claudeLogin("alpha"));
    // a session in the pool keeps it from being routed, so it still holds alpha's login
    const proc = join(opts.procRoot!, "4401");
    await mkdir(proc, { recursive: true });
    await writeFile(join(proc, "cmdline"), "claude\0");
    await writeFile(join(proc, "environ"), `CLAUDE_CONFIG_DIR=${dirOf(".claude", "pool")}`);
    r = await routeAllViaGateway(opts);
    expect(claudeLine(r, "pool")?.status).toBe("refused");
    expect(claudeLine(r, "alpha")?.status).toBe("already-routed");
    expect(claudeLine(r, "alpha")?.attention).toBe(true);
    expect(claudeLine(r, "alpha")?.detail).toContain("swap pool pool holds a copy of this login");
    expect(r.incomplete).toBe(true);
  });
});

describe("route-all-via-gateway: AIS sync remotes", () => {
  test("the report names the sync remotes and says to stop sessions there first; no remotes, no warning", async () => {
    await heartbeat();
    const syncConfig = join(home, "sync-v2.json");
    const report = async () => {
      const out: string[] = [];
      const saved = process.exitCode;
      await runRouteAllViaGateway({ "dry-run": true }, { ...opts, syncConfigPath: syncConfig, out: (l) => out.push(l) });
      process.exitCode = saved;
      return out.join("\n");
    };
    expect(await report()).not.toContain("WARNING: AIS sync");
    await writeFile(syncConfig, JSON.stringify({ version: 2, remotes: ["hq1"] }));
    const text = await report();
    expect(text).toContain("WARNING: AIS sync copies the folders of claude/alpha, claude/beta, codex/alpha to hq1");
    expect(text).toContain("stop every Claude Code, Codex and pi session");
    expect(text).toContain("These identities then STOP WORKING on that host");
    expect(text).toContain("sync keeps that new sign-in");
    await writeFile(syncConfig, "{ not json");
    expect(await report()).toContain("the AIS sync config could not be read");
  });
});

describe("helpers", () => {
  test("the command does not start the background sync (it could race the rewrite)", async () => {
    const { wantsAutoBackgroundSync } = await import("../../../src/cli/dispatch.ts");
    expect(wantsAutoBackgroundSync("identities", ["route-all-via-gateway"])).toBe(false);
  });

  test("backups never overwrite", async () => {
    const f = join(home, "x.json");
    await writeFile(f, "one");
    const a = await backupUnique(f, () => NOW);
    await writeFile(f, "two");
    const b = await backupUnique(f, () => NOW);
    expect(a).not.toBe(b);
    expect(await readFile(a!, "utf8")).toBe("one");
    expect(await readFile(b!, "utf8")).toBe("two");
    expect(await backupUnique(join(home, "missing"), () => NOW)).toBeUndefined();
  });

  test("classifyLogin", () => {
    expect(classifyLogin("claude", claudeLogin("a"))).toBe("login");
    expect(classifyLogin("claude", JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE_KEY, refreshToken: null } }))).toBe("gateway");
    expect(classifyLogin("codex", JSON.stringify({ OPENAI_API_KEY: CODEX_KEY }))).toBe("gateway");
    expect(classifyLogin("codex", "garbage")).toBe("none");
  });

  test("codex config text: replaces an existing provider, keeps the rest, is stable", () => {
    const base = "http://127.0.0.1:47140/codex";
    const old = `model_provider = "openai"\nmodel = "m"\n\n# keep me\n[model_providers.ais-gateway]\nbase_url = "http://old"\n\n[model_providers.ais-gateway.auth]\ncommand = "/old"\n\n[projects."/x"]\ntrust_level = "trusted"\n`;
    const out = routeCodexConfigText(old, base, "/bin/key");
    expect(out).toContain("# keep me");
    expect(out).toContain('[projects."/x"]');
    expect(out).not.toContain("http://old");
    expect(out.match(/model_provider\s*=/g)?.length).toBe(1);
    expect(codexConfigRouted(out, base, "/bin/key")).toBe(true);
    expect(routeCodexConfigText(out, base, "/bin/key")).toBe(out);
  });
});

describe("member store in the gateway process", () => {
  let savedFlag: string | undefined;
  let savedDir: string | undefined;
  beforeEach(() => {
    savedFlag = process.env.AIS_GATEWAY_MEMBER_STORE;
    savedDir = process.env.AIS_GATEWAY_MEMBERS_DIR;
  });
  afterEach(() => {
    if (savedFlag === undefined) process.env.AIS_GATEWAY_MEMBER_STORE = "0";
    else process.env.AIS_GATEWAY_MEMBER_STORE = savedFlag;
    if (savedDir === undefined) delete process.env.AIS_GATEWAY_MEMBERS_DIR;
    else process.env.AIS_GATEWAY_MEMBERS_DIR = savedDir;
  });

  test("a gateway process reads the store copy; everyone else and the save path keep the identity folder", async () => {
    const reg = opts.registries!.claude!;
    process.env.AIS_GATEWAY_MEMBERS_DIR = opts.memberRoot!;
    process.env.AIS_GATEWAY_MEMBER_STORE = "1";
    // before any move there is no store copy: the gateway reads the identity folder as it always did
    expect((await loadIdentitiesFile(reg)).identities.find((i) => i.name === "alpha")?.configDir).toBe(dirOf(".claude", "alpha"));
    await heartbeat();
    await expect(routeAllViaGateway(opts)).rejects.toThrow("host CLI");

    process.env.AIS_GATEWAY_MEMBER_STORE = "0";
    await routeAllViaGateway(opts);
    expect((await loadIdentitiesFile(reg)).identities.find((i) => i.name === "alpha")?.configDir).toBe(dirOf(".claude", "alpha"));

    process.env.AIS_GATEWAY_MEMBER_STORE = "1";
    const loaded = await loadIdentitiesFile(reg);
    const dir = loaded.identities.find((i) => i.name === "alpha")!.configDir;
    expect(dir).toBe(memberDir("claude", "alpha", opts.memberRoot));
    // the gateway still sees the real login while the identity folder holds the gateway entry
    expect(classifyLogin("claude", await readFile(join(dir, ".credentials.json"), "utf8"))).toBe("login");
    expect(classifyLogin("claude", await readFile(join(dirOf(".claude", "alpha"), ".credentials.json"), "utf8"))).toBe("gateway");
    // a registry that is not a tool's own identities.json is never remapped
    const other = join(home, "other", "list.json");
    await mkdir(join(home, "other"), { recursive: true });
    await writeFile(other, JSON.stringify({ version: 1, identities: [{ name: "alpha", label: "a", configDir: dirOf(".claude", "alpha") }] }));
    expect((await loadIdentitiesFile(other)).identities[0]?.configDir).toBe(dirOf(".claude", "alpha"));
    await expect(saveIdentitiesFile(reg, loaded)).rejects.toThrow("member store");
  });

  test("a store folder without its login file is not used", async () => {
    process.env.AIS_GATEWAY_MEMBERS_DIR = opts.memberRoot!;
    process.env.AIS_GATEWAY_MEMBER_STORE = "1";
    await mkdir(storeOf("claude", "alpha"), { recursive: true });
    await writeFile(join(storeOf("claude", "alpha"), ".claude.json"), "{}");
    expect((await loadIdentitiesFile(opts.registries!.claude!)).identities.find((i) => i.name === "alpha")?.configDir).toBe(dirOf(".claude", "alpha"));
  });
});
