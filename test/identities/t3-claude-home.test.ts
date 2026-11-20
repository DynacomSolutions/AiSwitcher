import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyT3Instance } from "../../src/identities/t3-instance.ts";
import { composeT3ClaudeSettings, diffT3ClaudeHome, isThirdPartySender } from "../../src/identities/t3-claude-home.ts";
import { isNoThirdParty, noThirdPartyNames } from "../../src/shared/t3-claude-source.ts";
import { syncT3ClaudeHomes } from "../../src/shared/t3-claude-sync.ts";
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

const run = (id: string, src: { dir: string; noThirdParty: boolean } | "none", extra: object = {}) =>
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
  await run("t3-claude-kimi-pool", "none");
  const registry = join(home, "identities.json");
  await writeFile(registry, JSON.stringify({ version: 1, identities: [{ name: "swap", label: "swap", aliases: ["team-pool"], configDir: source, swapPool: { accounts: [], active: undefined } }] }));
  const folder = join(home, ".t3", "gateway", "claude-team-pool");
  await writeFile(join(source, "settings.json"), JSON.stringify({ ...SOURCE_SETTINGS, theme: "light" }));
  const checked = await syncT3ClaudeHomes({ home, env: {}, registryPath: registry, check: true });
  expect(checked.map((r) => [r.folder.split("/").pop(), r.status])).toEqual([["claude-team-pool", "drift"], ["t3-claude-kimi-pool", "skipped"]]);
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
