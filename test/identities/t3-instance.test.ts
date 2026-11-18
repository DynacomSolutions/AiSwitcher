import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyT3Instance, grokLauncherSource, type T3InstanceOptions } from "../../src/identities/t3-instance.ts";

let home: string;
let secrets: string;
let settingsPath: string;
const TOKEN = "aisg_testtoken123";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "t3-instance-"));
  secrets = join(home, "secrets");
  await writeFile(secrets, `AIS_GATEWAY_APP_AGENTS_CLAUDE_TOKEN=${TOKEN}\nAIS_GATEWAY_APP_XAI_TOKEN=${TOKEN}\nAIS_GATEWAY_APP_BAD_TOKEN=sk-real\n`);
  settingsPath = join(home, ".t3", "userdata", "settings.json");
  await mkdir(join(home, ".t3", "userdata"), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ theme: "dark", providerInstances: { other: { driver: "codex", enabled: true } } }, null, 2) + "\n", { mode: 0o600 });
});
afterEach(() => rm(home, { recursive: true, force: true }));

let clock = 1_700_000_000_000;
const opts = (o: Partial<T3InstanceOptions>): T3InstanceOptions => ({
  id: "c1",
  driver: "claude",
  app: "agents-claude",
  gatewayUrl: "https://gw.example/gateway/agents-claude",
  proxyUrl: "http://proxy.example:3128",
  caPath: "/ca.pem",
  home,
  env: {},
  secretsPath: secrets,
  now: () => (clock += 5000),
  ...o,
});
const settings = async () => JSON.parse(await readFile(settingsPath, "utf8"));
const mode = async (p: string) => (await stat(p)).mode & 0o777;
const backups = async () => (await readdir(join(home, ".t3", "backups")).catch(() => [])).filter((n) => n.startsWith("settings.json.pre-t3-instance."));

test("claude create writes instance, folder files and keeps others", async () => {
  const likeHome = join(home, "like");
  await mkdir(likeHome);
  await writeFile(join(likeHome, "settings.json"), JSON.stringify({ hooks: { Stop: [1] }, other: 1 }));
  const s = await settings();
  s.providerInstances.like = { driver: "claudeAgent", config: { binaryPath: "/bin/cl", homePath: likeHome } };
  await writeFile(settingsPath, JSON.stringify(s));
  const r = await applyT3Instance(opts({ like: "like", models: ["m1", "m2", "m3"], name: "C One" }));
  expect(r.status).toBe("created");
  const after = await settings();
  expect(after.theme).toBe("dark");
  expect(after.providerInstances.other).toEqual({ driver: "codex", enabled: true });
  const folder = join(home, ".t3", "gateway", "c1");
  expect(after.providerInstances.c1).toEqual({ driver: "claudeAgent", displayName: "C One", enabled: true, config: { binaryPath: "/bin/cl", homePath: folder, customModels: ["m1", "m2", "m3"] } });
  const fs = JSON.parse(await readFile(join(folder, "settings.json"), "utf8"));
  expect(fs.env).toMatchObject({ ANTHROPIC_BASE_URL: "https://gw.example/gateway/agents-claude", HTTPS_PROXY: "http://proxy.example:3128", NODE_EXTRA_CA_CERTS: "/ca.pem", NO_PROXY: "127.0.0.1,localhost,::1", ANTHROPIC_MODEL: "m1", ANTHROPIC_DEFAULT_HAIKU_MODEL: "m3", CLAUDE_CODE_SUBAGENT_MODEL: "m1" });
  expect(fs.hooks).toEqual({ Stop: [1] });
  expect(fs.other).toBeUndefined();
  const cred = JSON.parse(await readFile(join(folder, ".credentials.json"), "utf8"));
  expect(cred.claudeAiOauth.accessToken).toBe(TOKEN);
  expect(cred.claudeAiOauth.scopes).toEqual(["user:inference", "user:profile"]);
  expect(await mode(join(folder, ".credentials.json"))).toBe(0o600);
  expect(await mode(folder)).toBe(0o700);
  expect(await readFile(join(folder, ".claude.json"), "utf8")).toContain("hasCompletedOnboarding");
  expect((await backups()).length).toBe(1);
});

test("second run is current with no new backup; existing .claude.json kept", async () => {
  await applyT3Instance(opts({}));
  const folder = join(home, ".t3", "gateway", "c1");
  await writeFile(join(folder, ".claude.json"), '{"mine":1}');
  const r = await applyT3Instance(opts({}));
  expect(r.status).toBe("current");
  expect((await backups()).length).toBe(1);
  expect(await readFile(join(folder, ".claude.json"), "utf8")).toBe('{"mine":1}');
});

test("--check on drift fails and writes nothing", async () => {
  const r = await applyT3Instance(opts({ check: true }));
  expect(r.status).toBe("created");
  expect(await settings().then((s) => s.providerInstances.c1)).toBeUndefined();
  expect((await readdir(join(home, ".t3")).catch(() => [] as string[])).includes("gateway")).toBe(false);
  expect((await backups()).length).toBe(0);
  await applyT3Instance(opts({}));
  expect((await applyT3Instance(opts({ check: true }))).status).toBe("current");
  expect((await applyT3Instance(opts({ check: true, models: ["x"] }))).status).toBe("updated");
});

test("grok create: env without secrets, launcher, token, auth.json", async () => {
  const r = await applyT3Instance(opts({ id: "g1", driver: "grok", app: "xai", gatewayUrl: "https://gw.example/gateway/xai", binary: "/opt/grok" }));
  expect(r.status).toBe("created");
  const folder = join(home, ".t3", "gateway", "g1");
  const entry = (await settings()).providerInstances.g1;
  const launcher = join(home, ".ais", "t3", "grok", "g1");
  expect(entry.driver).toBe("grok");
  expect(entry.config.binaryPath).toBe(launcher);
  expect(entry.environment).toEqual([
    { name: "GROK_HOME", value: folder, sensitive: false },
    { name: "GROK_AUTH_PATH", value: join(folder, "cli-auth.json"), sensitive: false },
    { name: "GROK_XAI_API_BASE_URL", value: "https://gw.example/gateway/xai", sensitive: false },
  ]);
  expect(JSON.stringify(await settings())).not.toContain(TOKEN);
  const src = await readFile(launcher, "utf8");
  expect(src.startsWith("#!/bin/sh")).toBe(true);
  expect(src).toContain("export XAI_API_KEY");
  expect(src).not.toContain("export GROK_CODE_XAI_API_KEY");
  expect(src).toContain("BIN='/opt/grok'");
  expect(src).toContain('exec "$BIN" "$@"');
  expect(await mode(launcher)).toBe(0o755);
  expect(await readFile(join(folder, "token"), "utf8")).toBe(`${TOKEN}\n`);
  expect(await mode(join(folder, "token"))).toBe(0o600);
  expect(await readFile(join(folder, "auth.json"), "utf8")).toContain(TOKEN);
  expect(r.usage?.some((u) => u.status === "updated")).toBe(true);
  expect((await applyT3Instance(opts({ id: "g1", driver: "grok", app: "xai", gatewayUrl: "https://gw.example/gateway/xai", binary: "/opt/grok" }))).status).toBe("current");
});

test("--remove drops the entry, keeps the folder and others", async () => {
  await applyT3Instance(opts({}));
  const r = await applyT3Instance(opts({ remove: true }));
  expect(r.status).toBe("removed");
  const s = await settings();
  expect(s.providerInstances.c1).toBeUndefined();
  expect(s.providerInstances.other).toBeDefined();
  expect((await stat(join(home, ".t3", "gateway", "c1"))).isDirectory()).toBe(true);
  expect((await applyT3Instance(opts({ remove: true }))).status).toBe("absent");
});

test("a non-aisg token is refused and nothing is written", async () => {
  await expect(applyT3Instance(opts({ app: "bad" }))).rejects.toThrow("aisg_");
  expect((await backups()).length).toBe(0);
  expect((await settings()).providerInstances.c1).toBeUndefined();
});

describe("grok launcher binary resolution", () => {
  const run = async (src: string, t3Home: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "grok-launcher-"));
    try {
      await mkdir(join(dir, "gh"), { recursive: true });
      await writeFile(join(dir, "gh", "token"), "tok\n");
      const l = join(dir, "launch");
      await writeFile(l, src.replace('exec "$BIN"', 'echo "$BIN $XAI_API_KEY"; exit 0 #'));
      const p = Bun.spawn(["sh", l], { env: { PATH: process.env.PATH ?? "", GROK_HOME: join(dir, "gh") }, stdout: "pipe" });
      return (await new Response(p.stdout).text()).trim();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  const setup = async (): Promise<string> => {
    const t3 = await mkdtemp(join(tmpdir(), "grok-t3-"));
    const dir = join(t3, "caches", "acp-registry", "package-installs");
    await mkdir(dir, { recursive: true });
    for (const [v, exists] of [["1.0.9", true], ["1.0.79", true], ["1.0.100", false]] as const) {
      const exe = join(t3, `grok-${v}`);
      if (exists) await writeFile(exe, "");
      await writeFile(join(dir, `grok-build-${v}.json`), JSON.stringify({ agentId: "grok-build", agentVersion: v, executablePath: exe }));
    }
    return t3;
  };
  test("explicit binary wins", async () => {
    const t3 = await setup();
    expect(await run(grokLauncherSource({ binary: "/opt/grok", t3Home: t3, fallback: "/fb/grok" }), t3)).toBe("/opt/grok tok");
    await rm(t3, { recursive: true, force: true });
  });
  test("newest existing registry install", async () => {
    const t3 = await setup();
    expect(await run(grokLauncherSource({ t3Home: t3, fallback: "/fb/grok" }), t3)).toBe(`${t3}/grok-1.0.79 tok`);
    await rm(t3, { recursive: true, force: true });
  });
  test("fallback when no install record", async () => {
    const t3 = await mkdtemp(join(tmpdir(), "grok-t3-"));
    expect(await run(grokLauncherSource({ t3Home: t3, fallback: "/fb/grok" }), t3)).toBe("/fb/grok tok");
    await rm(t3, { recursive: true, force: true });
  });
});
