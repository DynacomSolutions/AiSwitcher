import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyT3Instance } from "../../src/identities/t3-instance.ts";
import { composeT3ClaudePluginFiles, composeT3ClaudeSettings, diffT3ClaudeHome, hookKeys, isThirdPartySender, planT3ClaudeHome } from "../../src/identities/t3-claude-home.ts";
import { isNoThirdParty, noThirdPartyNames, t3ClaudeSource } from "../../src/shared/t3-claude-source.ts";
import { createClaudeCliRunner, localisePluginPaths, updateAllClaudePlugins, type ClaudeCliRunner } from "../../src/shared/claude-plugin-update.ts";
import { syncT3ClaudeHomes } from "../../src/shared/t3-claude-sync.ts";
import { runT3InstanceCommand } from "../../src/cli/gateway/t3-instance.ts";
import { createT3ClaudeTicker } from "../../src/sync/t3-claude-ticker.ts";

let home: string;
let source: string;
let secrets: string;
const GW = "https://gw.example/gateway/agents-claude";

const SOURCE_SETTINGS = {
  cleanupPeriodDays: 3650,
  env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "50", ANTHROPIC_BASE_URL: "https://old.example/x", HTTPS_PROXY: "http://p.example:1", JEV_TOKEN_PATH: "/x", NODE_EXTRA_CA_CERTS: "/ca.pem" },
  attribution: { commit: "Co-Authored-By: x", pr: "x" },
  includeCoAuthoredBy: true,
  permissions: { allow: ["Bash(ls)"], defaultMode: "auto" },
  autoMode: { allow: ["x"] },
  enabledPlugins: { "tasks-board@ai-tools": true, "jev-compaction@ai-tools": true, "typesafe@typesafe-ai": true, "superpowers@official": false },
  pluginConfigs: { "tasks-board@ai-tools": { a: 1 }, "jev-compaction@ai-tools": { b: 2 } },
  extraKnownMarketplaces: { "ai-tools": { source: {} }, "typesafe-ai": { source: {} } },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "${HOME}/.ais/hooks/block-secret-reads.sh" }, { type: "command", command: "/x/jev-hook.sh" }] }],
    StopFailure: [{ hooks: [{ type: "command", command: 'ais claude-swap next --if-limited --config-dir="$CLAUDE_CONFIG_DIR"' }] }],
  },
};
const INSTALLED = { version: 2, plugins: { "tasks-board@ai-tools": [{ installPath: "/src/plugins/cache/a" }], "jev-skills@ai-tools": [{ installPath: "/src/plugins/cache/b" }] } };
const MARKETS = { "ai-tools": { installLocation: "/src/plugins/marketplaces/ai-tools" }, "typesafe-ai": { installLocation: "/src/plugins/marketplaces/typesafe-ai" } };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "t3-claude-home-"));
  source = join(home, "ids", "swap");
  await mkdir(join(source, "plugins"), { recursive: true });
  await writeFile(join(source, "settings.json"), JSON.stringify(SOURCE_SETTINGS));
  await writeFile(join(source, "plugins", "installed_plugins.json"), JSON.stringify(INSTALLED));
  await writeFile(join(source, "plugins", "known_marketplaces.json"), JSON.stringify(MARKETS));
  secrets = join(home, "secrets");
  await writeFile(secrets, "AIS_GATEWAY_APP_AGENTS_CLAUDE_TOKEN=aisg_testtoken123\n");
  await mkdir(join(home, ".t3", "userdata"), { recursive: true });
  await writeFile(join(home, ".t3", "userdata", "settings.json"), "{}\n");
});
afterEach(() => rm(home, { recursive: true, force: true }));

const run = (id: string, src: { dir: string; noThirdParty: boolean; modelHome?: boolean } | "none", extra: object = {}) =>
  applyT3Instance({ id, driver: "claude", app: "agents-claude", gatewayUrl: GW, home, env: {}, secretsPath: secrets, source: src, models: ["m1", "m2"], ...extra });
const read = async (p: string) => JSON.parse(await readFile(p, "utf8"));

test("pool home is a full copy of the source with only gateway keys replaced", async () => {
  const r = await run("claude-team-pool", { dir: source, noThirdParty: false });
  expect(r.status).toBe("created");
  const folder = join(home, ".t3", "gateway", "claude-team-pool");
  const s = await read(join(folder, "settings.json"));
  expect(s.cleanupPeriodDays).toBe(3650);
  expect(s.permissions).toEqual(SOURCE_SETTINGS.permissions);
  expect(s.autoMode).toEqual(SOURCE_SETTINGS.autoMode);
  expect(s.enabledPlugins).toEqual(SOURCE_SETTINGS.enabledPlugins);
  expect(s.pluginConfigs).toEqual(SOURCE_SETTINGS.pluginConfigs);
  expect(s.extraKnownMarketplaces).toEqual(SOURCE_SETTINGS.extraKnownMarketplaces);
  expect(s.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe("50");
  expect(s.env.NODE_EXTRA_CA_CERTS).toBe("/ca.pem");
  // allowed differences
  expect(s.env.ANTHROPIC_BASE_URL).toBe(GW);
  expect(s.env.ANTHROPIC_MODEL).toBe("m1");
  expect(s.env.HTTPS_PROXY).toBeUndefined();
  expect(s.attribution).toEqual({ commit: "", pr: "" });
  expect(s.includeCoAuthoredBy).toBe(false);
  expect(s.gitAttribution).toBe(false);
  // hooks: the block-secret-reads hook stays, the swap hook goes
  expect(JSON.stringify(s.hooks)).toContain("block-secret-reads.sh");
  expect(s.hooks.StopFailure).toBeUndefined();
  // plugins files carry every plugin
  expect(Object.keys((await read(join(folder, "plugins", "installed_plugins.json"))).plugins)).toEqual(["tasks-board@ai-tools", "jev-skills@ai-tools"]);
  expect(Object.keys(await read(join(folder, "plugins", "known_marketplaces.json")))).toEqual(["ai-tools", "typesafe-ai"]);
  expect(await diffT3ClaudeHome(folder, source)).toEqual([]);
  expect((await run("claude-team-pool", { dir: source, noThirdParty: false })).status).toBe("current");
});

test("without a source the claude driver refuses to build a home", async () => {
  await expect(applyT3Instance({ id: "x", driver: "claude", app: "agents-claude", gatewayUrl: GW, home, env: {}, secretsPath: secrets })).rejects.toThrow(/No source identity/);
});

test("restricted source never gets Jev, typesafe or telemetry plugins, hooks or env", async () => {
  await run("t3-claude-restricted", { dir: source, noThirdParty: true });
  const folder = join(home, ".t3", "gateway", "t3-claude-restricted");
  const s = await read(join(folder, "settings.json"));
  expect(Object.keys(s.enabledPlugins).sort()).toEqual(["superpowers@official", "tasks-board@ai-tools"]);
  expect(Object.keys(s.pluginConfigs)).toEqual(["tasks-board@ai-tools"]);
  expect(Object.keys(s.extraKnownMarketplaces)).toEqual(["ai-tools"]);
  expect(s.env.JEV_TOKEN_PATH).toBeUndefined();
  expect(JSON.stringify(s.hooks)).not.toContain("jev");
  expect(JSON.stringify(s.hooks)).toContain("block-secret-reads.sh");
  expect(Object.keys((await read(join(folder, "plugins", "installed_plugins.json"))).plugins)).toEqual(["tasks-board@ai-tools"]);
  expect(Object.keys(await read(join(folder, "plugins", "known_marketplaces.json")))).toEqual(["ai-tools"]);
  expect(isThirdPartySender("telemetry-gateway@x")).toBe(true);
  expect(isThirdPartySender("tasks-board@ai-tools")).toBe(false);
});

test("composeT3ClaudeSettings keeps the home's own gateway env and drops nothing else", () => {
  const out = composeT3ClaudeSettings({ env: { A: "1", ANTHROPIC_BASE_URL: "src" }, theme: "dark" }, { env: { ANTHROPIC_BASE_URL: "own", ANTHROPIC_MODEL: "m" } });
  expect(out.env).toEqual({ A: "1", ANTHROPIC_BASE_URL: "own", ANTHROPIC_MODEL: "m" });
  expect(out.theme).toBe("dark");
});

test("drift check reports a plugin, a setting and a missing file, and ignores gateway keys", async () => {
  await run("claude-team-pool", { dir: source, noThirdParty: false });
  const folder = join(home, ".t3", "gateway", "claude-team-pool");
  const own = await read(join(folder, "settings.json"));
  own.env.ANTHROPIC_MODEL = "other"; // allowed
  own.cleanupPeriodDays = 30;
  delete own.enabledPlugins["tasks-board@ai-tools"];
  await writeFile(join(folder, "settings.json"), JSON.stringify(own));
  await rm(join(folder, "plugins", "known_marketplaces.json"));
  expect(await diffT3ClaudeHome(folder, source)).toEqual(["settings.json: cleanupPeriodDays, enabledPlugins", "plugins/known_marketplaces.json: missing"]);
});

test("sync maps homes to identities, repairs drift and skips unmapped homes", async () => {
  await run("claude-team-pool", { dir: source, noThirdParty: false });
  await run("t3-claude-other-pool", "none");
  const registry = join(home, "identities.json");
  await writeFile(registry, JSON.stringify({ version: 1, identities: [{ name: "swap", label: "swap", aliases: ["team-pool"], configDir: source, swapPool: { accounts: [], active: undefined } }] }));
  const folder = join(home, ".t3", "gateway", "claude-team-pool");
  await writeFile(join(source, "settings.json"), JSON.stringify({ ...SOURCE_SETTINGS, theme: "light" }));
  const checked = await syncT3ClaudeHomes({ home, env: {}, registryPath: registry, check: true });
  expect(checked.map((r) => [r.folder.split("/").pop(), r.status])).toEqual([["claude-team-pool", "drift"], ["t3-claude-other-pool", "skipped"]]);
  const fixed = await syncT3ClaudeHomes({ home, env: {}, registryPath: registry });
  expect(fixed[0]!.status).toBe("updated");
  expect((await read(join(folder, "settings.json"))).theme).toBe("light");
  expect((await syncT3ClaudeHomes({ home, env: {}, registryPath: registry, check: true }))[0]!.status).toBe("current");
});

test("ticker logs a drift once", async () => {
  const lines: string[] = [];
  let t = 0;
  const res = [{ folder: "/f", source: "swap", status: "drift" as const, changes: ["settings.json: theme"] }];
  const ticker = createT3ClaudeTicker({ check: async () => res, log: (m) => lines.push(m), now: () => (t += 1_000_000), intervalMs: 1 });
  await ticker.tick();
  await ticker.idle();
  await ticker.tick();
  await ticker.idle();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("settings.json: theme");
});

test("restricted identity names come from env and the host config file", async () => {
  await mkdir(join(home, ".ais", "config"), { recursive: true });
  await writeFile(join(home, ".ais", "config", "no-third-party-identities"), "# comment\nalpha\n\nbeta # inline\n");
  expect(noThirdPartyNames({ home, env: { AIS_NO_THIRD_PARTY_IDENTITIES: "gamma, delta" } })).toEqual(["gamma", "delta", "alpha", "beta"]);
  expect(isNoThirdParty({ name: "x", aliases: ["beta"] }, ["beta"])).toBe(true);
  expect(isNoThirdParty({ name: "x" }, ["beta"])).toBe(false);
});

test("sync applies the restriction to a listed source identity", async () => {
  await run("t3-claude-restricted", { dir: source, noThirdParty: false });
  const registry = join(home, "identities.json");
  await writeFile(registry, JSON.stringify({ version: 1, identities: [{ name: "restricted", label: "r", configDir: source }] }));
  const out = await syncT3ClaudeHomes({ home, env: { AIS_NO_THIRD_PARTY_IDENTITIES: "restricted" }, registryPath: registry });
  expect(out[0]!.status).toBe("updated");
  const folder = join(home, ".t3", "gateway", "t3-claude-restricted");
  expect(Object.keys((await read(join(folder, "settings.json"))).enabledPlugins).sort()).toEqual(["superpowers@official", "tasks-board@ai-tools"]);
});

test("drift check allows gateway env keys, reordered and extra hooks, and a home's own plugin cache", async () => {
  await run("claude-team-pool", { dir: source, noThirdParty: false });
  const folder = join(home, ".t3", "gateway", "claude-team-pool");
  const s = await read(join(folder, "settings.json"));
  s.env.ANTHROPIC_BASE_URL = "https://gw.example/gateway/other";
  s.env.NO_PROXY = "localhost";
  s.env.NODE_EXTRA_CA_CERTS = "/other-ca.pem";
  const pre = s.hooks.PreToolUse[0].hooks;
  s.hooks.PreToolUse = [{ matcher: "Bash", hooks: [...pre].reverse() }, { matcher: "Bash", hooks: [pre[0]] }]; // reordered, duplicated
  s.hooks.SessionStart = [{ hooks: [{ type: "command", command: "/guard/install.py" }] }]; // target-only
  await writeFile(join(folder, "settings.json"), JSON.stringify(s));
  const inst = await read(join(folder, "plugins", "installed_plugins.json"));
  for (const id of Object.keys(inst.plugins)) inst.plugins[id][0].installPath = `${folder}/plugins/cache/${id}`;
  await writeFile(join(folder, "plugins", "installed_plugins.json"), JSON.stringify(inst));
  const mk = await read(join(folder, "plugins", "known_marketplaces.json"));
  for (const n of Object.keys(mk)) mk[n].installLocation = `${folder}/plugins/marketplaces/${n}`;
  await writeFile(join(folder, "plugins", "known_marketplaces.json"), JSON.stringify(mk));
  expect(await diffT3ClaudeHome(folder, source)).toEqual([]);
});

test("drift check still flags a removed hook, a missing plugin and a changed marketplace source", async () => {
  await run("claude-team-pool", { dir: source, noThirdParty: false });
  const folder = join(home, ".t3", "gateway", "claude-team-pool");
  const s = await read(join(folder, "settings.json"));
  delete s.hooks.PreToolUse;
  await writeFile(join(folder, "settings.json"), JSON.stringify(s));
  const inst = await read(join(folder, "plugins", "installed_plugins.json"));
  delete inst.plugins["jev-skills@ai-tools"];
  await writeFile(join(folder, "plugins", "installed_plugins.json"), JSON.stringify(inst));
  const mk = await read(join(folder, "plugins", "known_marketplaces.json"));
  mk["ai-tools"].source = { source: "github", repo: "x/y" };
  await writeFile(join(folder, "plugins", "known_marketplaces.json"), JSON.stringify(mk));
  expect(await diffT3ClaudeHome(folder, source)).toEqual(["settings.json: hooks", "plugins/installed_plugins.json: missing jev-skills@ai-tools", "plugins/known_marketplaces.json: ai-tools"]);
});

test("repair leaves a home that is in step untouched", async () => {
  await run("claude-team-pool", { dir: source, noThirdParty: false });
  const folder = join(home, ".t3", "gateway", "claude-team-pool");
  const inst = await read(join(folder, "plugins", "installed_plugins.json"));
  inst.plugins["tasks-board@ai-tools"][0].installPath = `${folder}/plugins/cache/own`;
  const text = JSON.stringify(inst);
  await writeFile(join(folder, "plugins", "installed_plugins.json"), text);
  const registry = join(home, "identities.json");
  await writeFile(registry, JSON.stringify({ version: 1, identities: [{ name: "swap", label: "swap", aliases: ["team-pool"], configDir: source, swapPool: { accounts: [] } }] }));
  const before = await Bun.file(join(folder, "settings.json")).text();
  const out = await syncT3ClaudeHomes({ home, env: {}, registryPath: registry });
  expect(out[0]!.status).toBe("current");
  expect(await readFile(join(folder, "plugins", "installed_plugins.json"), "utf8")).toBe(text);
  expect(await Bun.file(join(folder, "settings.json")).text()).toBe(before);
});

test("a source directory marketplace missing on this host is skipped with an info line, not drift", async () => {
  const gone = join(home, "missing-dir");
  await writeFile(join(source, "plugins", "known_marketplaces.json"), JSON.stringify({ ...MARKETS, "local-skills": { source: { source: "directory", path: gone } } }));
  await run("claude-team-pool", { dir: source, noThirdParty: false });
  const folder = join(home, ".t3", "gateway", "claude-team-pool");
  expect(Object.keys(await read(join(folder, "plugins", "known_marketplaces.json")))).toEqual(["ai-tools", "typesafe-ai"]);
  expect(await diffT3ClaudeHome(folder, source)).toEqual([]);
  const registry = join(home, "identities.json");
  await writeFile(registry, JSON.stringify({ version: 1, identities: [{ name: "swap", label: "swap", aliases: ["team-pool"], configDir: source, swapPool: { accounts: [] } }] }));
  const out = await syncT3ClaudeHomes({ home, env: {}, registryPath: registry, check: true });
  expect(out[0]!.status).toBe("current");
  expect(out[0]!.notes?.join(" ")).toContain("local-skills");
  // an existing directory is still copied
  await mkdir(gone);
  expect(Object.keys(composeT3ClaudePluginFiles(undefined, { x: { source: { source: "directory", path: gone } } }).marketplaces ?? {})).toEqual(["x"]);
});

test("target-only plugins and marketplaces are allowed, except third-party senders in a restricted home", async () => {
  await run("claude-team-pool", { dir: source, noThirdParty: false });
  await run("t3-claude-restricted", { dir: source, noThirdParty: true });
  for (const [name, restricted] of [["claude-team-pool", false], ["t3-claude-restricted", true]] as const) {
    const folder = join(home, ".t3", "gateway", name);
    const inst = await read(join(folder, "plugins", "installed_plugins.json"));
    inst.plugins["cluster-art@cluster"] = [{ installPath: "/x" }];
    await writeFile(join(folder, "plugins", "installed_plugins.json"), JSON.stringify(inst));
    const mk = await read(join(folder, "plugins", "known_marketplaces.json"));
    mk["cluster"] = { source: { source: "directory", path: "/x" } };
    await writeFile(join(folder, "plugins", "known_marketplaces.json"), JSON.stringify(mk));
    expect(await diffT3ClaudeHome(folder, source, { noThirdParty: restricted })).toEqual([]);
    inst.plugins["jev-extra@x"] = [{ installPath: "/y" }];
    mk["jev-market"] = { source: {} };
    await writeFile(join(folder, "plugins", "installed_plugins.json"), JSON.stringify(inst));
    await writeFile(join(folder, "plugins", "known_marketplaces.json"), JSON.stringify(mk));
    expect(await diffT3ClaudeHome(folder, source, { noThirdParty: restricted })).toEqual(restricted ? ["plugins/installed_plugins.json: extra jev-extra@x", "plugins/known_marketplaces.json: jev-market"] : []);
  }
});

const RESTRICTED = { noThirdParty: true };
const base = (extra: object) => ({ theme: "dark", ...extra });

test("restricted filter checks env values, http hooks, status line and wide names", () => {
  const out = composeT3ClaudeSettings(
    base({
      env: { OK: "1", SNEAK: "https://api.typesafe.example/x", OTEL_EXPORTER_OTLP_ENDPOINT: "https://x" },
      hooks: { Stop: [{ hooks: [{ type: "http", url: "https://hook.jev.example/x" }, { type: "command", command: "/ok.sh" }] }] },
      statusLine: { type: "command", command: "/bin/jev-status" },
      enabledPlugins: { "myjev-compaction@m": true, "ok@m": true },
    }),
    {},
    RESTRICTED,
  );
  expect(out.env).toEqual({ OK: "1" });
  expect(hookKeys(out.hooks)).toEqual(["Stop\t\t/ok.sh"]);
  expect(out.statusLine).toBeUndefined();
  expect(Object.keys(out.enabledPlugins as object)).toEqual(["ok@m"]);
  expect(isThirdPartySender("some-compaction-service")).toBe(true);
});

test("hookKeys includes http hooks, so the check sees them", () => {
  expect(hookKeys({ Stop: [{ hooks: [{ type: "http", url: "https://h.example/x" }] }] })).toEqual(["Stop\t\thttps://h.example/x"]);
});

test("restricted drift: third-party env value, http hook and non-gateway base URL are flagged", async () => {
  await run("t3-claude-restricted", { dir: source, noThirdParty: true });
  const folder = join(home, ".t3", "gateway", "t3-claude-restricted");
  expect(await diffT3ClaudeHome(folder, source, RESTRICTED)).toEqual([]);
  const s = await read(join(folder, "settings.json"));
  s.env.X = "https://t.typesafe.example";
  s.hooks.Stop = [{ hooks: [{ type: "http", url: "https://x.jev.example" }] }];
  s.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
  await writeFile(join(folder, "settings.json"), JSON.stringify(s));
  expect(await diffT3ClaudeHome(folder, source, RESTRICTED)).toEqual(["settings.json: env, hooks"]);
});

test("source auth keys are never copied and the home keeps its own", () => {
  const out = composeT3ClaudeSettings(
    { apiKeyHelper: "/src/key.sh", env: { CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_OAUTH_TOKEN: "x", ANTHROPIC_API_KEY: "k", AWS_PROFILE: "p", KEEP: "1" } },
    { apiKeyHelper: "/own.sh", env: { ANTHROPIC_BASE_URL: "own" } },
  );
  expect(out.apiKeyHelper).toBe("/own.sh");
  expect(out.env).toEqual({ KEEP: "1", ANTHROPIC_BASE_URL: "own" });
});

test("home-only enabledPlugins stay and are allowed, except third-party senders when restricted", async () => {
  await run("claude-team-pool", { dir: source, noThirdParty: false });
  const folder = join(home, ".t3", "gateway", "claude-team-pool");
  const s = await read(join(folder, "settings.json"));
  s.enabledPlugins["home-only@m"] = true;
  await writeFile(join(folder, "settings.json"), JSON.stringify(s));
  expect(await diffT3ClaudeHome(folder, source)).toEqual([]);
  expect(composeT3ClaudeSettings({}, { enabledPlugins: { "home-only@m": true, "jev-x@m": true } }, RESTRICTED).enabledPlugins).toEqual({ "home-only@m": true });
  await run("t3-claude-restricted", { dir: source, noThirdParty: true });
  const rf = join(home, ".t3", "gateway", "t3-claude-restricted");
  const r = await read(join(rf, "settings.json"));
  r.enabledPlugins["home-only@m"] = true;
  await writeFile(join(rf, "settings.json"), JSON.stringify(r));
  expect(await diffT3ClaudeHome(rf, source, RESTRICTED)).toEqual([]);
  r.enabledPlugins["jev-x@m"] = true;
  await writeFile(join(rf, "settings.json"), JSON.stringify(r));
  expect(await diffT3ClaudeHome(rf, source, RESTRICTED)).toEqual(["settings.json: enabledPlugins"]);
});

test("repair aborts on a broken home file or a missing source settings and writes nothing", async () => {
  await run("claude-team-pool", { dir: source, noThirdParty: false });
  const folder = join(home, ".t3", "gateway", "claude-team-pool");
  await writeFile(join(folder, "settings.json"), "{ not json");
  await expect(planT3ClaudeHome(folder, source)).rejects.toThrow();
  expect(await readFile(join(folder, "settings.json"), "utf8")).toBe("{ not json");
  await run("claude-team-pool", { dir: source, noThirdParty: false }).catch(() => undefined);
  await rm(join(source, "settings.json"));
  await expect(planT3ClaudeHome(folder, source)).rejects.toThrow(/source settings.json is missing/);
});

test("the restriction list fails closed and matches case-insensitively", async () => {
  await mkdir(join(home, ".ais", "config"), { recursive: true });
  expect(isNoThirdParty({ name: "Alpha" }, ["alpha"])).toBe(true);
  expect(isNoThirdParty({ name: "x", aliases: ["BETA"] }, ["beta"])).toBe(true);
  expect(noThirdPartyNames({ home, env: { AIS_NO_THIRD_PARTY_IDENTITIES: "Gamma" } })).toEqual(["gamma"]);
  await mkdir(join(home, ".ais", "config", "no-third-party-identities")); // a directory: EISDIR, not ENOENT
  expect(() => noThirdPartyNames({ home, env: {} })).toThrow(/cannot read/);
});

test("--source=<other identity> on a restricted home still restricts it", async () => {
  const reg = join(home, ".claude", "identities.json");
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(reg, JSON.stringify({ version: 1, identities: [{ name: "dyn", label: "d", configDir: source }, { name: "restricted", label: "r", configDir: join(home, "ids", "r") }] }));
  const lines: string[] = [];
  await writeFile(secrets, "AIS_GATEWAY_APP_AGENTS_CLAUDE_TOKEN=aisg_testtoken123\nAIS_GATEWAY_PROXY_URL=https://gw.example/gateway\n");
  await runT3InstanceCommand(["t3-claude-restricted"], { driver: "claude", app: "agents-claude", source: "dyn" } as never, { out: (l: string) => lines.push(l), secretsPath: secrets } as never, { home, env: { AIS_NO_THIRD_PARTY_IDENTITIES: "restricted", AIS_GATEWAY_PROXY_URL: "https://gw.example/gateway" } }, { exists: () => false, log: () => {} });
  const s = await read(join(home, ".t3", "gateway", "t3-claude-restricted", "settings.json"));
  expect(Object.keys(s.enabledPlugins).sort()).toEqual(["superpowers@official", "tasks-board@ai-tools"]);
});

const registryWith = async (extra: object[] = []) => {
  const registry = join(home, "identities.json");
  await writeFile(registry, JSON.stringify({ version: 1, identities: [{ name: "swap", label: "swap", aliases: ["team-pool"], configDir: source, swapPool: { accounts: [], active: undefined } }, ...extra] }));
  return registry;
};

test("kimi and zai homes map to the swap pool and keep their own model keys", async () => {
  await writeFile(join(source, "settings.json"), JSON.stringify({ ...SOURCE_SETTINGS, model: "opus", effortLevel: "high", modelSettings: { a: 1 }, env: { ...SOURCE_SETTINGS.env, ANTHROPIC_MODEL: "src-model", CLAUDE_CODE_SUBAGENT_MODEL: "src-sub" } }));
  const registry = await registryWith();
  for (const id of ["t3-claude-kimi-pool", "t3-claude-zai-pool"]) {
    await run(id, { dir: source, noThirdParty: false, modelHome: true });
    const folder = join(home, ".t3", "gateway", id);
    const s = await read(join(folder, "settings.json"));
    expect(s.env.ANTHROPIC_MODEL).toBe("m1");
    expect(s.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("m1");
    expect(s.model).toBeUndefined();
    expect(s.effortLevel).toBeUndefined();
    expect(s.enabledPlugins).toEqual(SOURCE_SETTINGS.enabledPlugins);
    // the home's own model keys are allowed differences
    s.model = "kimi-k2";
    s.effortLevel = "low";
    s.switchModelsOnFlag = true;
    await writeFile(join(folder, "settings.json"), JSON.stringify(s));
  }
  const checked = await syncT3ClaudeHomes({ home, env: {}, registryPath: registry, check: true });
  expect(checked.map((r) => [r.folder.split("/").pop(), r.source, r.status])).toEqual([["t3-claude-kimi-pool", "swap", "current"], ["t3-claude-zai-pool", "swap", "current"]]);
  // other drift still shows, and the repair never copies the source model keys
  await writeFile(join(source, "settings.json"), JSON.stringify({ ...SOURCE_SETTINGS, model: "opus", theme: "light" }));
  expect((await syncT3ClaudeHomes({ home, env: {}, registryPath: registry, check: true })).map((r) => r.status)).toEqual(["drift", "drift"]);
  await syncT3ClaudeHomes({ home, env: {}, registryPath: registry });
  const fixed = await read(join(home, ".t3", "gateway", "t3-claude-kimi-pool", "settings.json"));
  expect(fixed.theme).toBe("light");
  expect(fixed.model).toBe("kimi-k2");
  expect(fixed.effortLevel).toBe("low");
});

test("without exactly one swap pool a kimi home stays unmapped", async () => {
  await run("t3-claude-kimi-pool", "none");
  const registry = join(home, "identities.json");
  await writeFile(registry, JSON.stringify({ version: 1, identities: [] }));
  expect((await syncT3ClaudeHomes({ home, env: {}, registryPath: registry, check: true }))[0]!.status).toBe("skipped");
});

const setVersions = async (dir: string, versions: Record<string, string>) => {
  const plugins = Object.fromEntries(Object.entries(versions).map(([id, version]) => [id, [{ installPath: `${dir}/cache/${id}`, version }]]));
  await writeFile(join(dir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
};

test("a plugin version that differs from the source is drift: older is repaired, newer says the source needs an update", async () => {
  const registry = await registryWith();
  await run("claude-team-pool", { dir: source, noThirdParty: false });
  const folder = join(home, ".t3", "gateway", "claude-team-pool");
  await setVersions(source, { "tasks-board@ai-tools": "1.2.0", "other@ai-tools": "2.0.0" });
  await setVersions(folder, { "tasks-board@ai-tools": "1.1.0", "other@ai-tools": "2.0.0" });
  const checked = await syncT3ClaudeHomes({ home, env: {}, registryPath: registry, check: true });
  expect(checked[0]!.status).toBe("drift");
  expect(checked[0]!.changes.join()).toContain("version tasks-board@ai-tools 1.1.0 -> 1.2.0");
  expect((await syncT3ClaudeHomes({ home, env: {}, registryPath: registry }))[0]!.status).toBe("updated");
  expect((await read(join(folder, "plugins", "installed_plugins.json"))).plugins["tasks-board@ai-tools"][0].version).toBe("1.2.0");
  expect((await syncT3ClaudeHomes({ home, env: {}, registryPath: registry, check: true }))[0]!.status).toBe("current");
  // the home is now ahead of the source
  await setVersions(folder, { "tasks-board@ai-tools": "1.3.0", "other@ai-tools": "2.0.0" });
  const ahead = await syncT3ClaudeHomes({ home, env: {}, registryPath: registry, check: true });
  expect(ahead[0]!.status).toBe("drift");
  expect(ahead[0]!.changes.join()).toContain("the source needs an update");
  const repaired = await syncT3ClaudeHomes({ home, env: {}, registryPath: registry });
  expect(repaired[0]!.status).toBe("current");
  expect(repaired[0]!.notes?.join()).toContain("source behind");
  expect((await read(join(folder, "plugins", "installed_plugins.json"))).plugins["tasks-board@ai-tools"][0].version).toBe("1.3.0");
});

const LOCAL_MARKETS = { "ai-tools": {}, "typesafe-ai": {} };
const LOCAL_INSTALLED = { version: 2, plugins: { "tasks-board@ai-tools": [], "jev-skills@ai-tools": [] } };

test("update runs marketplaces then plugins in every identity folder and T3 home, and skips third-party senders in a restricted one", async () => {
  const plain = join(home, "ids", "plain");
  const strict = join(home, "ids", "strict");
  for (const dir of [plain, strict]) {
    await mkdir(join(dir, "plugins"), { recursive: true });
    await writeFile(join(dir, "plugins", "known_marketplaces.json"), JSON.stringify(LOCAL_MARKETS));
    await writeFile(join(dir, "plugins", "installed_plugins.json"), JSON.stringify(LOCAL_INSTALLED));
  }
  const registry = await registryWith([{ name: "plain", label: "plain", configDir: plain }, { name: "strict", label: "strict", configDir: strict }]);
  await writeFile(join(source, "plugins", "known_marketplaces.json"), JSON.stringify({ "ai-tools": {} }));
  await writeFile(join(source, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "tasks-board@ai-tools": [] } }));
  await run("t3-claude-kimi-pool", { dir: source, noThirdParty: false, modelHome: true });
  await mkdir(join(home, ".t3", "gateway", "t3-claude-strict", "plugins"), { recursive: true });
  await writeFile(join(home, ".t3", "gateway", "t3-claude-strict", "plugins", "installed_plugins.json"), JSON.stringify(LOCAL_INSTALLED));
  const calls: string[] = [];
  const runner: ClaudeCliRunner = async (args, dir) => {
    calls.push(`${dir.replace(home, "~")} ${args.join(" ")}`);
    return args.includes("tasks-board@ai-tools") && dir === plain ? { code: 1, output: "boom" } : { code: 0, output: "" };
  };
  const results = await updateAllClaudePlugins({ home, env: { AIS_NO_THIRD_PARTY_IDENTITIES: "strict" }, registryPath: registry, run: runner });
  expect(calls).toContain("~/ids/plain plugin marketplace update typesafe-ai");
  expect(calls.indexOf("~/ids/plain plugin marketplace update ai-tools")).toBeLessThan(calls.indexOf("~/ids/plain plugin update tasks-board@ai-tools"));
  expect(calls.filter((c) => c.startsWith("~/ids/strict")).join("\n")).not.toMatch(/typesafe|jev/);
  expect(calls.filter((c) => c.startsWith("~/ids/strict")).join("\n")).toContain("plugin update tasks-board@ai-tools");
  // the unmapped-by-name restricted T3 home fails closed, the kimi home follows the swap pool
  expect(calls.some((c) => c.includes("t3-claude-strict") && /jev/.test(c))).toBe(false);
  expect(calls.some((c) => c.includes("t3-claude-kimi-pool"))).toBe(true);
  expect(results.find((r) => r.folder === plain)!.failures[0]).toContain("tasks-board@ai-tools: boom");
  expect(results.find((r) => r.folder === strict)!.skipped).toEqual(expect.arrayContaining(["typesafe-ai", "jev-skills@ai-tools"]));
});

test("the plugin runner uses the real claude binary and fails without one", async () => {
  const seen: { file: string; dir?: string }[] = [];
  const exec = (file: string, _args: string[], env: NodeJS.ProcessEnv, cb: (e: Error | null, o: string, s: string) => void) => {
    seen.push({ file, ...(env.CLAUDE_CONFIG_DIR ? { dir: env.CLAUDE_CONFIG_DIR } : {}) });
    cb(null, "ok", "");
  };
  const ok = await createClaudeCliRunner(() => "/real/bin/claude", exec)(["plugin", "update", "x"], "/cfg");
  expect(ok.code).toBe(0);
  expect(seen).toEqual([{ file: "/real/bin/claude", dir: "/cfg" }]);
  const none = await createClaudeCliRunner(() => { throw new Error("not found"); }, exec)(["plugin", "update", "x"], "/cfg");
  expect(none.code).not.toBe(0);
  expect(none.output).toContain("no real claude binary");
  expect(seen.length).toBe(1);
});

test("a kimi or zai home is restricted when its own identity is on the list, not only the source", async () => {
  const registry = JSON.parse(JSON.stringify({ version: 1, identities: [{ name: "swap", label: "swap", configDir: source, swapPool: { accounts: [], active: undefined } }, { name: "acme-corp", label: "p", aliases: ["acme"], configDir: join(home, "ids", "acme") }] }));
  const gw = join(home, ".t3");
  for (const folder of ["t3-claude-kimi-acme", "t3-claude-zai-acme-corp", "t3-claude-kimi-unregistered"]) {
    const list = folder.endsWith("unregistered") ? ["unregistered"] : ["acme"];
    expect(t3ClaudeSource(registry, join(gw, "gateway", folder), gw, list)?.noThirdParty).toBe(true);
  }
  expect(t3ClaudeSource(registry, join(gw, "gateway", "t3-claude-kimi-other"), gw, ["acme"])?.noThirdParty).toBe(false);
  // through the repair and the update
  await run("t3-claude-kimi-acme", { dir: source, noThirdParty: true, modelHome: true });
  const reg = await registryWith([{ name: "acme-corp", label: "p", aliases: ["acme"], configDir: join(home, "ids", "acme") }]);
  const folder = join(home, ".t3", "gateway", "t3-claude-kimi-acme");
  expect(Object.keys((await read(join(folder, "settings.json"))).enabledPlugins)).not.toContain("jev-compaction@ai-tools");
  expect((await syncT3ClaudeHomes({ home, env: { AIS_NO_THIRD_PARTY_IDENTITIES: "acme" }, registryPath: reg, check: true }))[0]!.status).toBe("current");
  await writeFile(join(folder, "plugins", "known_marketplaces.json"), JSON.stringify(LOCAL_MARKETS));
  await writeFile(join(folder, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "jev-skills@ai-tools": [], "tasks-board@ai-tools": [] } }));
  const calls: string[] = [];
  await updateAllClaudePlugins({ home, env: { AIS_NO_THIRD_PARTY_IDENTITIES: "acme" }, registryPath: reg, run: async (a, d) => (d === folder && calls.push(a.join(" ")), { code: 0, output: "" }) });
  expect(calls.join("\n")).not.toMatch(/typesafe|jev/);
  expect(calls.join("\n")).toContain("marketplace update ai-tools");
});

test("update never touches a plugin cache outside the home: it copies it in first, or skips the plugin", async () => {
  const folder = join(home, ".t3", "gateway", "t3-claude-kimi-pool");
  await mkdir(join(folder, "plugins"), { recursive: true });
  const shared = join(source, "plugins", "cache", "ai-tools", "tasks-board", "1.0.0");
  await mkdir(shared, { recursive: true });
  await writeFile(join(shared, "plugin.json"), "{}");
  await writeFile(join(folder, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "tasks-board@ai-tools": [{ installPath: shared, version: "1.0.0" }], "gone@ai-tools": [{ installPath: join(source, "plugins", "cache", "missing"), version: "1" }] } }));
  const blocked = await localisePluginPaths(folder);
  const after = (await read(join(folder, "plugins", "installed_plugins.json"))).plugins;
  expect(after["tasks-board@ai-tools"][0].installPath).toBe(join(folder, "plugins", "cache", "ai-tools", "tasks-board", "1.0.0"));
  expect(await readFile(join(after["tasks-board@ai-tools"][0].installPath, "plugin.json"), "utf8")).toBe("{}");
  // the shared cache stays as it was
  expect(await readFile(join(shared, "plugin.json"), "utf8")).toBe("{}");
  expect(blocked.get("gone@ai-tools")).toContain("not updated");
  expect(blocked.has("tasks-board@ai-tools")).toBe(false);
});
