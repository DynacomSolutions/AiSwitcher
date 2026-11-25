import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayCliDeps } from "../../src/cli/gateway/apps.ts";
import { runAcpRelayProcess, runT3AcpCommand } from "../../src/cli/gateway/t3-acp.ts";
import { syncT3GatewayModels, zcodeConfigPathFromCommand, zcodeLauncherOriginal } from "../../src/identities/t3-gateway-models.ts";
import { acpRelayPaths, aisHasRelay, checkAcpRelay, compareVersions, installAcpRelay, launcherSource, removeAcpRelay, resolveAgentInstall, zcodeLauncherPath, zcodeLauncherSource } from "../../src/identities/t3-acp-relay.ts";

const root = await mkdtemp(join(tmpdir(), "ais-t3acp-"));
afterAll(() => rm(root, { recursive: true, force: true }));

let n = 0;
interface Host {
  home: string;
  opts: { home: string; env: Record<string, string>; now: () => number };
  settings: string;
  launcher: (agent: string) => string;
  install: (agent: string, version: string) => Promise<string>;
  read: () => Promise<any>;
}

const instance = (agentId: string, config: Record<string, unknown> = {}) => ({ driver: "acpRegistry", enabled: true, displayName: agentId, environment: [{ name: "SOME_HOME", value: "/x" }], config: { agentId, source: "registry", ...config } });

async function host(instances: Record<string, unknown>, withAis = true): Promise<Host> {
  const home = join(root, `h${++n}`);
  const t3 = join(home, ".t3");
  await mkdir(join(t3, "userdata"), { recursive: true });
  await mkdir(join(t3, "caches", "acp-registry", "package-installs"), { recursive: true });
  const settings = join(t3, "userdata", "settings.json");
  await writeFile(settings, `${JSON.stringify({ theme: "dark", providerInstances: instances }, null, 2)}\n`, { mode: 0o644 });
  if (withAis) {
    await mkdir(join(home, ".local", "bin"), { recursive: true });
    await writeFile(join(home, ".local", "bin", "ais"), "#!/bin/sh\n", { mode: 0o755 });
  }
  const install = async (agent: string, version: string): Promise<string> => {
    const bin = join(t3, "tools", agent, version, "npm", "bin");
    await mkdir(bin, { recursive: true });
    const exe = join(bin, agent);
    await writeFile(exe, "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(join(t3, "caches", "acp-registry", "package-installs", `${agent}-${version.replace(/\W/g, "")}abc.json`), JSON.stringify({ agentId: agent, agentVersion: version, packageVersion: version, binDirectory: bin, executablePath: exe }));
    return exe;
  };
  return { home, opts: { home, env: {}, now: () => 1_795_000_000_000 }, settings, launcher: (agent) => join(home, ".ais", "t3", "acp", agent), install, read: async () => JSON.parse(await readFile(settings, "utf8")) };
}

const cli = async (h: Host, flags: Record<string, true> = {}): Promise<string[]> => {
  const out: string[] = [];
  await runT3AcpCommand([], flags, { out: (l: string) => out.push(l) } as unknown as GatewayCliDeps, h.opts);
  return out;
};

test("sets the launcher on every instance of a relay agent, and nothing else", async () => {
  const h = await host({
    "kimi-a": instance("kimi-code"),
    "kimi-b": instance("kimi-code"),
    grok: instance("grok-build"),
    other: instance("some-other-agent"),
    local: instance("kimi-code", { source: "local", commandPath: "/opt/kimi" }),
    claude: { driver: "claudeAgent", config: { agentId: "kimi-code" } },
  });
  const kimi = await h.install("kimi-code", "2.5.2");
  await h.install("grok-build", "1.0.79");
  const before = await readFile(h.settings, "utf8");

  const r = await installAcpRelay(h.opts);
  expect(r.changed).toBe(true);
  expect(r.instances).toEqual([
    { instance: "kimi-a", agentId: "kimi-code", status: "set" },
    { instance: "kimi-b", agentId: "kimi-code", status: "set" },
    { instance: "grok", agentId: "grok-build", status: "set" },
  ]);
  const after = await h.read();
  expect(after.providerInstances["kimi-a"].config).toEqual({ agentId: "kimi-code", source: "registry", commandPath: h.launcher("kimi-code") });
  expect(after.providerInstances["kimi-b"].config.commandPath).toBe(h.launcher("kimi-code"));
  expect(after.providerInstances.grok.config.commandPath).toBe(h.launcher("grok-build"));
  expect(after.providerInstances["kimi-a"].environment).toEqual([{ name: "SOME_HOME", value: "/x" }]);
  expect(after.providerInstances.other.config).toEqual({ agentId: "some-other-agent", source: "registry" });
  expect(after.providerInstances.local.config.commandPath).toBe("/opt/kimi");
  expect(after.providerInstances.claude).toEqual({ driver: "claudeAgent", config: { agentId: "kimi-code" } });
  expect(after.theme).toBe("dark");
  expect((await stat(h.settings)).mode & 0o777).toBe(0o644);
  expect((await readFile(h.settings, "utf8")).endsWith("}\n")).toBe(true);

  // the launcher: executable, starts ais with the agent id, falls back to the agent itself
  const launcher = await readFile(h.launcher("kimi-code"), "utf8");
  expect(launcher).toBe(launcherSource("kimi-code", join(h.home, ".local", "bin", "ais"), kimi));
  expect(launcher).toContain(`AGENT='${kimi}'`);
  expect(launcher).toContain(`if [ -x "$AIS" ] && "$AIS" __acp_relay --supported >/dev/null 2>&1; then exec "$AIS" __acp_relay kimi-code "--fallback=$AGENT" "$@"; fi`);
  expect(launcher).toContain(`exec "$AGENT" "$@"`);
  expect((await stat(h.launcher("kimi-code"))).mode & 0o777).toBe(0o755);

  // the settings as they were are kept
  expect(r.backup).toBe(join(h.home, ".t3", "backups", "settings.json.pre-acp-relay.1795000000"));
  expect(await readFile(r.backup as string, "utf8")).toBe(before);

  // a second run changes nothing
  const again = await installAcpRelay(h.opts);
  expect(again.changed).toBe(false);
  expect(again.instances.map((i) => i.status)).toEqual(["current", "current", "current"]);
  expect(again.backup).toBeUndefined();
  expect(await checkAcpRelay(h.opts)).toEqual([]);
});

test("an instance with its own executable override, or an agent T3 Code has not installed, is left alone", async () => {
  const h = await host({ mine: instance("kimi-code", { commandPath: "/opt/my-kimi" }), grok: instance("grok-build") });
  await h.install("kimi-code", "2.5.2");
  const r = await installAcpRelay(h.opts);
  expect(r.changed).toBe(false);
  expect(r.instances.map((i) => [i.instance, i.status])).toEqual([
    ["mine", "kept"],
    ["grok", "no_install"],
  ]);
  expect((await h.read()).providerInstances.mine.config.commandPath).toBe("/opt/my-kimi");
  expect(await checkAcpRelay(h.opts)).toEqual(["mine (kimi-code): has its own executable override, the relay is not used", "grok (grok-build): the relay is not set"]);
});

test("the newest install whose executable exists is used", async () => {
  const h = await host({ k: instance("kimi-code") });
  await h.install("kimi-code", "2.9.1");
  const newest = await h.install("kimi-code", "2.10.0");
  const gone = await h.install("kimi-code", "3.0.0");
  await rm(gone);
  expect(await resolveAgentInstall("kimi-code", h.opts)).toMatchObject({ version: "2.10.0", executable: newest });
  expect(await resolveAgentInstall("grok-build", h.opts)).toBeUndefined();
  expect(compareVersions("2.10.0", "2.9.1")).toBeGreaterThan(0);
  expect(compareVersions("1.0", "1.0.0")).toBe(0);
  expect(compareVersions("1.0.0-beta", "1.0.0-alpha")).toBeGreaterThan(0);
  expect(compareVersions("1.0.0", "1.0.0-beta")).toBeGreaterThan(0); // a release is newer than its pre-release
  expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
  expect(compareVersions("1.0.1-beta", "1.0.0")).toBeGreaterThan(0);
  expect(compareVersions("1.0.0+build5", "1.0.0")).toBe(0);
});

test("--check names what is not in place", async () => {
  const h = await host({ k: instance("kimi-code") }, false);
  await h.install("kimi-code", "2.5.2");
  expect(await checkAcpRelay(h.opts)).toEqual(["k (kimi-code): the relay is not set"]);
  await installAcpRelay(h.opts);
  expect(await checkAcpRelay(h.opts)).toEqual([`kimi-code: ${join(h.home, ".local", "bin", "ais")} is missing, so the agent starts without the relay`]);

  await mkdir(join(h.home, ".local", "bin"), { recursive: true });
  await writeFile(join(h.home, ".local", "bin", "ais"), "#!/bin/sh\n", { mode: 0o755 });
  expect(await checkAcpRelay(h.opts)).toEqual([]);

  // an ais from before the relay: the launcher would start the agent without it
  await writeFile(join(h.home, ".local", "bin", "ais"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  expect(aisHasRelay(join(h.home, ".local", "bin", "ais"))).toBe(false);
  expect(await checkAcpRelay(h.opts)).toEqual([`kimi-code: ${join(h.home, ".local", "bin", "ais")} is a version without the relay, so the agent starts without it (ais update)`]);
  await writeFile(join(h.home, ".local", "bin", "ais"), "#!/bin/sh\n", { mode: 0o755 });
  expect(aisHasRelay(join(h.home, ".local", "bin", "ais"))).toBe(true);
  expect(aisHasRelay(join(h.home, "no-such-ais"))).toBe(false);

  // a launcher someone changed
  await writeFile(h.launcher("kimi-code"), "#!/bin/sh\nexit 1\n");
  expect(await checkAcpRelay(h.opts)).toEqual([`kimi-code: the launcher ${h.launcher("kimi-code")} is missing or out of date`]);
  await installAcpRelay(h.opts);
  expect(await checkAcpRelay(h.opts)).toEqual([]);

  // the registry has a newer version: T3 Code will not install it while the override is set
  await writeFile(acpRelayPaths(h.opts).registry, JSON.stringify({ agents: [{ id: "kimi-code", version: "2.6.0" }, { id: "grok-build", version: "9.9.9" }] }));
  const problems = await checkAcpRelay(h.opts);
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain("kimi-code: version 2.5.2 is installed and the registry has 2.6.0");
});

test("--remove takes the launchers out again and leaves other overrides", async () => {
  const h = await host({ k: instance("kimi-code"), mine: instance("grok-build", { commandPath: "/opt/my-grok" }) });
  await h.install("kimi-code", "2.5.2");
  await installAcpRelay(h.opts);
  const r = await removeAcpRelay(h.opts);
  expect(r.instances).toEqual([{ instance: "k", agentId: "kimi-code", status: "removed" }]);
  const after = await h.read();
  expect(after.providerInstances.k.config).toEqual({ agentId: "kimi-code", source: "registry" });
  expect(after.providerInstances.mine.config.commandPath).toBe("/opt/my-grok");
  expect(await stat(join(h.home, ".ais", "t3", "acp")).catch(() => undefined)).toBeUndefined();
  expect((await removeAcpRelay(h.opts)).changed).toBe(false);
  // two backups in the same second: the first (the settings before the relay) is never written over
  const backups = (await readdir(join(h.home, ".t3", "backups"))).sort();
  expect(backups).toEqual(["settings.json.pre-acp-relay.1795000000", "settings.json.pre-acp-relay.1795000000.1"]);
  expect(JSON.parse(await readFile(join(h.home, ".t3", "backups", backups[0]!), "utf8")).providerInstances.k.config.commandPath).toBeUndefined();
  expect(JSON.parse(await readFile(join(h.home, ".t3", "backups", backups[1]!), "utf8")).providerInstances.k.config.commandPath).toBe(h.launcher("kimi-code"));
});

test("a settings file T3 Code wrote in the meantime is not written over: the command starts again", async () => {
  const h = await host({ k: instance("kimi-code") });
  await h.install("kimi-code", "2.5.2");
  let calls = 0;
  const r = await installAcpRelay({
    ...h.opts,
    now: () => {
      // T3 Code saves a setting between the read and the write of the first try
      if (++calls === 1) {
        const cur = JSON.parse(require("node:fs").readFileSync(h.settings, "utf8"));
        cur.theme = "light";
        require("node:fs").writeFileSync(h.settings, `${JSON.stringify(cur, null, 2)}\n`);
      }
      return 1_795_000_000_000;
    },
  });
  expect(calls).toBe(2);
  expect(r.changed).toBe(true);
  const after = await h.read();
  expect(after.theme).toBe("light");
  expect(after.providerInstances.k.config.commandPath).toBe(h.launcher("kimi-code"));
  expect(await readdir(join(h.home, ".t3", "backups"))).toEqual(["settings.json.pre-acp-relay.1795000000"]);
});

test("no T3 Code settings file: nothing is written", async () => {
  const home = join(root, "empty");
  await mkdir(home, { recursive: true });
  expect(await installAcpRelay({ home, env: {} })).toEqual({ instances: [], changed: false });
  expect(await checkAcpRelay({ home, env: {} })).toEqual([]);
  expect(await readdir(home)).toEqual([]);
});

test("T3CODE_HOME moves T3 Code's folder", async () => {
  const h = await host({});
  const paths = acpRelayPaths({ home: h.home, env: { T3CODE_HOME: "/data/t3" } });
  expect(paths.settings).toBe("/data/t3/userdata/settings.json");
  expect(paths.installs).toBe("/data/t3/caches/acp-registry/package-installs");
  // a second T3 Code folder has its own launchers, so --remove for one never breaks the other
  expect(paths.launchers).toMatch(new RegExp(`^${join(h.home, ".ais", "t3", "acp-")}[0-9a-f]{8}$`));
  expect(acpRelayPaths({ home: h.home, env: {} }).launchers).toBe(join(h.home, ".ais", "t3", "acp"));
  expect(acpRelayPaths({ home: h.home, env: { T3CODE_HOME: join(h.home, ".t3") } }).launchers).toBe(join(h.home, ".ais", "t3", "acp"));
});

test("the command reports each instance, and --check fails when something is missing", async () => {
  const h = await host({ k: instance("kimi-code"), z: instance("glm-acp-agent") });
  await h.install("kimi-code", "2.5.2");
  await expect(cli(h, { check: true })).rejects.toThrow("2 problems");
  const out = await cli(h);
  expect(out[0]).toBe("t3-acp: k (kimi-code): relay set");
  expect(out[1]).toContain("t3-acp: z (glm-acp-agent): not set: T3 Code has not installed this agent yet");
  expect(out[2]).toContain("t3-acp: settings backup ");
  expect(out[3]).toContain("t3-acp: done");
  expect((await cli(h)).at(-1)).toBe("t3-acp: already in place");
  await h.install("glm-acp-agent", "1.17.0");
  await cli(h);
  expect(await cli(h, { check: true })).toEqual(["t3-acp: in place"]);
  expect((await cli(h, { remove: true })).at(-1)).toContain("t3-acp: removed");
  expect(await cli(h, { remove: true })).toEqual(["t3-acp: nothing to remove"]);
  const none = await host({ c: { driver: "claudeAgent", config: {} } });
  expect(await cli(none)).toEqual(["t3-acp: no T3 Code provider instance of kimi-code, grok-build, glm-acp-agent or ZCode"]);
  await chmod(h.settings, 0o644);
});

test("a launcher runs the agent directly when ais is missing, with its arguments", async () => {
  const h = await host({ k: instance("kimi-code") }, false);
  const exe = await h.install("kimi-code", "2.5.2");
  await writeFile(exe, '#!/bin/sh\nprintf "%s|" "$@"\n', { mode: 0o755 });
  await installAcpRelay(h.opts);
  const run = Bun.spawnSync([h.launcher("kimi-code"), "acp", "two words", "it's"]);
  expect(run.stdout.toString()).toBe("acp|two words|it's|");
  // with ais there, ais gets the agent id first
  await mkdir(join(h.home, ".local", "bin"), { recursive: true });
  await writeFile(join(h.home, ".local", "bin", "ais"), '#!/bin/sh\nprintf "ais:%s|" "$@"\n', { mode: 0o755 });
  const viaAis = Bun.spawnSync([h.launcher("kimi-code"), "acp", "two words"]);
  expect(viaAis.stdout.toString()).toBe(`ais:__acp_relay|ais:kimi-code|ais:--fallback=${exe}|ais:acp|ais:two words|`);
  // an ais from before the relay fails on the command: the agent still starts, directly
  await writeFile(join(h.home, ".local", "bin", "ais"), '#!/bin/sh\necho "unknown command" >&2\nexit 1\n', { mode: 0o755 });
  const oldAis = Bun.spawnSync([h.launcher("kimi-code"), "acp", "two words"]);
  expect(oldAis.stdout.toString()).toBe("acp|two words|");
  expect(oldAis.stderr.toString()).toBe("");
});

test("the relay command: --supported, and no agent to run", async () => {
  expect(await runAcpRelayProcess(["--supported"])).toBe(0);
  const h = await host({});
  const err = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    expect(await runAcpRelayProcess(["kimi-code", "acp"], h.opts)).toBe(127);
    expect(await runAcpRelayProcess([], h.opts)).toBe(2);
  } finally {
    process.stderr.write = err;
  }
});

// ZCode: a local-source instance whose commandPath is the ZCode launcher script.
const ZCODE_LAUNCHER_TEXT = '#!/bin/sh\nexport ZCODE_HOME="$HOME/.zcode"\nexport ZCODE_PERSONAL_PROVIDER_CONFIG_FILE="$HOME/.zcode/v2/provider_config.json"\nexec /usr/bin/node server.js "$@"\n';

const zl = (h: Host & { original: string }): string => zcodeLauncherPath(acpRelayPaths(h.opts).launchers, h.original);

async function zcodeHost(withAis = true): Promise<Host & { original: string }> {
  const h = await host({}, withAis);
  const original = join(h.home, ".local", "share", "zcode", "zcode-acp-launch");
  await mkdir(join(h.home, ".local", "share", "zcode"), { recursive: true });
  await writeFile(original, ZCODE_LAUNCHER_TEXT, { mode: 0o755 });
  await writeFile(h.settings, `${JSON.stringify({ theme: "dark", providerInstances: { zc: { driver: "acpRegistry", enabled: true, config: { source: "local", commandPath: original, commandArgs: [] } }, mine: { driver: "acpRegistry", config: { source: "local", commandPath: "/opt/other-agent" } } } }, null, 2)}\n`);
  return { ...h, original };
}

test("zcode: the instance's launcher moves behind the relay, a re-run changes nothing, --check passes", async () => {
  const h = await zcodeHost();
  const r = await installAcpRelay(h.opts);
  expect(r.instances).toEqual([{ instance: "zc", agentId: "zcode", status: "set" }]);
  const launcher = zcodeLauncherPath(acpRelayPaths(h.opts).launchers, h.original);
  expect(launcher).toMatch(/\/zcode-[0-9a-f]{8}$/);
  expect((await h.read()).providerInstances.zc.config).toEqual({ source: "local", commandPath: launcher, commandArgs: [] });
  expect((await h.read()).providerInstances.mine.config.commandPath).toBe("/opt/other-agent"); // not a ZCode launcher: left alone
  const text = await readFile(launcher, "utf8");
  expect(text).toBe(zcodeLauncherSource(join(h.home, ".local", "bin", "ais"), h.original));
  expect(zcodeLauncherOriginal(text)).toBe(h.original);
  expect(text).toContain('__acp_relay --supported=binary');
  expect(text).toContain('__acp_relay zcode "--binary=$ORIGINAL"');
  expect(text).not.toContain("--fallback");
  expect((await stat(launcher)).mode & 0o777).toBe(0o755);
  // idempotent: the settings file and the launcher stay as they are
  const settingsAfter = await readFile(h.settings, "utf8");
  const again = await installAcpRelay(h.opts);
  expect(again.changed).toBe(false);
  expect(again.instances).toEqual([{ instance: "zc", agentId: "zcode", status: "current" }]);
  expect(await readFile(h.settings, "utf8")).toBe(settingsAfter);
  expect(await readFile(launcher, "utf8")).toBe(text);
  expect(await checkAcpRelay(h.opts)).toEqual([]);
  // the original launcher is never changed
  expect(await readFile(h.original, "utf8")).toBe(ZCODE_LAUNCHER_TEXT);
});

test("zcode: --check says what is wrong", async () => {
  const h = await zcodeHost();
  expect(await checkAcpRelay(h.opts)).toEqual(["zc (zcode): the relay is not set"]);
  await installAcpRelay(h.opts);
  await rm(join(h.home, ".local", "bin", "ais"));
  expect(await checkAcpRelay(h.opts)).toEqual([`zcode: ${join(h.home, ".local", "bin", "ais")} is missing, so the agent starts without the relay`]);
  await writeFile(join(h.home, ".local", "bin", "ais"), "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(zl(h), "#!/bin/sh\n# edited\n");
  expect(await checkAcpRelay(h.opts)).toEqual([`zcode: the launcher ${zl(h)} does not record its original launcher`]);
  await installAcpRelay(h.opts); // an edited generated launcher is not repaired by a re-run: it no longer names the original
  expect((await readFile(zl(h), "utf8")).includes("edited")).toBe(true);
});

test("zcode: --remove puts the original launcher back and deletes the generated one", async () => {
  const h = await zcodeHost();
  await installAcpRelay(h.opts);
  const r = await removeAcpRelay(h.opts);
  expect(r.instances).toEqual([{ instance: "zc", agentId: "zcode", status: "removed" }]);
  expect((await h.read()).providerInstances.zc.config).toEqual({ source: "local", commandPath: h.original, commandArgs: [] });
  expect(await stat(zl(h)).catch(() => undefined)).toBeUndefined();
  expect((await removeAcpRelay(h.opts)).changed).toBe(false);
  // after a remove, a new install works again
  expect((await installAcpRelay(h.opts)).changed).toBe(true);
});

test("zcode: the generated launcher starts the relay, or the original directly when ais is missing", async () => {
  const h = await zcodeHost(false);
  await writeFile(h.original, '#!/bin/sh\nexport ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=/x/c.json\nprintf "orig:%s|" "$@"\n', { mode: 0o755 });
  await installAcpRelay(h.opts);
  expect(Bun.spawnSync([zl(h), "a b", "c"]).stdout.toString()).toBe("orig:a b|orig:c|");
  await mkdir(join(h.home, ".local", "bin"), { recursive: true });
  await writeFile(join(h.home, ".local", "bin", "ais"), '#!/bin/sh\nprintf "ais:%s|" "$@"\n', { mode: 0o755 });
  expect(Bun.spawnSync([zl(h), "a b"]).stdout.toString()).toBe(`ais:__acp_relay|ais:zcode|ais:--binary=${h.original}|ais:a b|`);
  await writeFile(join(h.home, ".local", "bin", "ais"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  expect(Bun.spawnSync([zl(h), "x"]).stdout.toString()).toBe("orig:x|");
});

test("zcode: the model-list sync still finds the config through the generated launcher", async () => {
  const h = await zcodeHost();
  await installAcpRelay(h.opts);
  expect(zcodeLauncherSource("/x/ais", h.original)).not.toContain("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE");
  expect(await zcodeConfigPathFromCommand(zl(h), h.home)).toBe(join(h.home, ".zcode", "v2", "provider_config.json"));
  expect(await zcodeConfigPathFromCommand(h.original, h.home)).toBe(join(h.home, ".zcode", "v2", "provider_config.json"));
  expect(await zcodeConfigPathFromCommand("/no/such/launcher", h.home)).toBeUndefined();
  // end to end: sync reads the provider config named by the original launcher and updates it
  const configDir = join(h.home, ".zcode", "v2");
  await mkdir(configDir, { recursive: true });
  const configFile = join(configDir, "provider_config.json");
  const rule = { providerId: "ais-gateway", config: { personalModelIds: ["glm-old"], modelOrder: ["glm-old"], access: { type: "api-key", apiKey: "aisg_SYNTHETIC_FIXTURE_zcode" }, api: { type: "openai-chat-completions", baseUrl: "https://gw.example.test/gateway/t3-zai/v1" } } };
  await writeFile(configFile, JSON.stringify({ schemaVersion: 1, config: { providerConfigRules: { providerRules: [rule] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }, defaultModelSelection: { providerId: "ais-gateway", modelId: "glm-old" } } }));
  const fetchStub = (async () => new Response(JSON.stringify({ data: [{ id: "glm-5.3" }] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const results = await syncT3GatewayModels({ home: h.home, env: {}, fetch: fetchStub });
  expect(results.map((x) => [x.provider, x.status])).toEqual([["ais-gateway", "updated"]]);
  expect(JSON.parse(await readFile(configFile, "utf8")).config.providerConfigRules.providerRules[0].config.personalModelIds).toEqual(["glm-5.3"]);
});

test("zcode: the command reports the instance", async () => {
  const h = await zcodeHost();
  const out = await cli(h);
  expect(out[0]).toBe("t3-acp: zc (zcode): relay set");
  expect((await cli(h, { check: true }))).toEqual(["t3-acp: in place"]);
  expect((await cli(h, { remove: true })).at(-1)).toContain("t3-acp: removed");
});

test("zcode: two instances with different launchers each keep their own generated launcher and original", async () => {
  const h = await zcodeHost();
  const second = join(h.home, ".local", "share", "zcode-b", "zcode-acp-launch");
  await mkdir(join(h.home, ".local", "share", "zcode-b"), { recursive: true });
  const textB = ZCODE_LAUNCHER_TEXT.replace("$HOME/.zcode/v2", "$HOME/.zcode-b/v2");
  await writeFile(second, textB, { mode: 0o755 });
  const settings = await h.read();
  settings.providerInstances.zb = { driver: "acpRegistry", enabled: true, config: { source: "local", commandPath: second, commandArgs: [] } };
  await writeFile(h.settings, `${JSON.stringify(settings, null, 2)}\n`);
  const launchers = acpRelayPaths(h.opts).launchers;
  const lA = zcodeLauncherPath(launchers, h.original);
  const lB = zcodeLauncherPath(launchers, second);
  expect(lA).not.toBe(lB);

  const r = await installAcpRelay(h.opts);
  expect(r.instances).toEqual([
    { instance: "zc", agentId: "zcode", status: "set" },
    { instance: "zb", agentId: "zcode", status: "set" },
  ]);
  let now = await h.read();
  expect(now.providerInstances.zc.config.commandPath).toBe(lA);
  expect(now.providerInstances.zb.config.commandPath).toBe(lB);
  expect(zcodeLauncherOriginal(await readFile(lA, "utf8"))).toBe(h.original);
  expect(zcodeLauncherOriginal(await readFile(lB, "utf8"))).toBe(second);

  // idempotent: nothing changes, the launchers keep their own original
  const settingsAfter = await readFile(h.settings, "utf8");
  const again = await installAcpRelay(h.opts);
  expect(again.changed).toBe(false);
  expect(again.instances.map((x) => x.status)).toEqual(["current", "current"]);
  expect(await readFile(h.settings, "utf8")).toBe(settingsAfter);
  expect(zcodeLauncherOriginal(await readFile(lA, "utf8"))).toBe(h.original);
  expect(zcodeLauncherOriginal(await readFile(lB, "utf8"))).toBe(second);
  expect(await checkAcpRelay(h.opts)).toEqual([]);

  // the model sync follows each launcher to its own provider config
  expect(await zcodeConfigPathFromCommand(lA, h.home)).toBe(join(h.home, ".zcode", "v2", "provider_config.json"));
  expect(await zcodeConfigPathFromCommand(lB, h.home)).toBe(join(h.home, ".zcode-b", "v2", "provider_config.json"));

  // --check names the instance whose launcher is gone
  await rm(lB);
  expect(await checkAcpRelay(h.opts)).toEqual([`zcode: the launcher ${lB} does not record its original launcher`]);
  await writeFile(lB, zcodeLauncherSource(join(h.home, ".local", "bin", "ais"), second), { mode: 0o755 });

  // --remove restores each exact original
  const removed = await removeAcpRelay(h.opts);
  expect(removed.instances).toEqual([
    { instance: "zc", agentId: "zcode", status: "removed" },
    { instance: "zb", agentId: "zcode", status: "removed" },
  ]);
  now = await h.read();
  expect(now.providerInstances.zc.config.commandPath).toBe(h.original);
  expect(now.providerInstances.zb.config.commandPath).toBe(second);
  expect(await stat(lA).catch(() => undefined)).toBeUndefined();
  expect(await readFile(h.original, "utf8")).toBe(ZCODE_LAUNCHER_TEXT);
  expect(await readFile(second, "utf8")).toBe(textB);
});
