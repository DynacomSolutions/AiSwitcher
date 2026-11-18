import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayCliDeps } from "../../src/cli/gateway/apps.ts";
import { runAcpRelayProcess, runT3AcpCommand } from "../../src/cli/gateway/t3-acp.ts";
import { acpRelayPaths, aisHasRelay, checkAcpRelay, compareVersions, installAcpRelay, launcherSource, removeAcpRelay, resolveAgentInstall } from "../../src/identities/t3-acp-relay.ts";

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
  expect(await cli(none)).toEqual(["t3-acp: no T3 Code provider instance of kimi-code, grok-build or glm-acp-agent"]);
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
