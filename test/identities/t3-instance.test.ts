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
  await writeFile(secrets, `AIS_GATEWAY_APP_AGENTS_CLAUDE_TOKEN=${TOKEN}\nAIS_GATEWAY_APP_XAI_TOKEN=${TOKEN}\nAIS_GATEWAY_APP_OC_TOKEN=${TOKEN}\nAIS_GATEWAY_APP_BAD_TOKEN=sk-real\n`);
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
  expect(fs.env).toMatchObject({ ANTHROPIC_BASE_URL: "https://gw.example/gateway/agents-claude", HTTPS_PROXY: "http://proxy.example:3128", NODE_EXTRA_CA_CERTS: "/ca.pem", NO_PROXY: "127.0.0.1,localhost,::1,opencode.ai,cli-chat-proxy.grok.com", ANTHROPIC_MODEL: "m1", ANTHROPIC_DEFAULT_HAIKU_MODEL: "m3", CLAUDE_CODE_SUBAGENT_MODEL: "m1" });
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

test("opencode create: own folder, env, auth.json with only the app token, then current", async () => {
  const o = opts({ id: "o1", driver: "opencode", app: "oc", gatewayUrl: "https://gw.example/gateway/oc", binary: "/opt/opencode" });
  const r = await applyT3Instance(o);
  expect(r.status).toBe("created");
  const folder = join(home, ".t3", "gateway", "o1");
  const entry = (await settings()).providerInstances.o1;
  expect(entry.driver).toBe("opencode");
  expect(entry.config.binaryPath).toBe("/opt/opencode");
  expect(entry.environment).toEqual([
    { name: "OPENCODE_CONFIG_DIR", value: folder, sensitive: false },
    { name: "XDG_DATA_HOME", value: folder, sensitive: false },
  ]);
  expect(JSON.stringify(await settings())).not.toContain(TOKEN);
  expect(await readFile(join(folder, "token"), "utf8")).toBe(`${TOKEN}\n`);
  const auth = JSON.parse(await readFile(join(folder, "opencode", "auth.json"), "utf8"));
  expect(auth).toEqual({ "opencode-go": { type: "api", key: TOKEN } });
  expect(await mode(join(folder, "opencode", "auth.json"))).toBe(0o600);
  const cfg = JSON.parse(await readFile(join(folder, "opencode.json"), "utf8"));
  expect(cfg.provider.gateway.options.baseURL).toBe("https://gw.example/gateway/oc");
  expect(cfg.disabled_providers).toContain("opencode-go");
  expect(JSON.stringify(cfg)).not.toContain(TOKEN);
  expect(r.usage?.some((u) => u.status === "updated")).toBe(true);
  expect((await applyT3Instance(o)).status).toBe("current");
  const c = await applyT3Instance({ ...o, check: true });
  expect(c.status).toBe("current");
  expect((await applyT3Instance({ ...o, remove: true })).status).toBe("removed");
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

describe("grok launcher models rewrite", () => {
  const runFake = async (args: string[], body: string): Promise<{ out: string; code: number }> => {
    const dir = await mkdtemp(join(tmpdir(), "grok-launcher-"));
    try {
      await mkdir(join(dir, "gh"), { recursive: true });
      await writeFile(join(dir, "gh", "token"), "tok\n");
      const fake = join(dir, "fakegrok");
      await writeFile(fake, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      const l = join(dir, "launch");
      await writeFile(l, grokLauncherSource({ binary: fake, t3Home: dir, fallback: "/fb/grok" }));
      const p = Bun.spawn(["sh", l, ...args], { env: { PATH: process.env.PATH ?? "", GROK_HOME: join(dir, "gh") }, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      return { out, code: await p.exited };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  test("models: XAI line becomes logged in, list kept, exit 0", async () => {
    const r = await runFake(["models"], 'echo "You are using XAI_API_KEY."; echo "grok-4"; echo "grok-3" >&2; exit 0');
    expect(r.out).toContain("You are logged in (AIS gateway token).");
    expect(r.out).toContain("grok-4");
    expect(r.out).toContain("grok-3");
    expect(r.out).not.toContain("XAI_API_KEY");
    expect(r.code).toBe(0);
  });
  test("models: exit code is kept", async () => {
    const r = await runFake(["models"], 'echo "boom"; exit 3');
    expect(r.out).toContain("boom");
    expect(r.code).toBe(3);
  });
  test("other subcommands pass through unchanged", async () => {
    const r = await runFake(["acp"], 'echo "You are using XAI_API_KEY."; echo "args: $*"; exit 0');
    expect(r.out).toBe("You are using XAI_API_KEY.\nargs: acp\n");
    expect(r.code).toBe(0);
  });
});

describe("pi driver", () => {
  const piOpts = (o: Partial<T3InstanceOptions> = {}) =>
    opts({ id: "p1", driver: "pi", app: "kimi-app", provider: "kimi", gatewayUrl: "https://gw.example/gateway/kimi-app", models: ["k1", "k2"], name: "Pi One", ...o });
  beforeEach(async () => {
    await writeFile(secrets, `AIS_GATEWAY_APP_KIMI_APP_TOKEN=${TOKEN}\n`, { flag: "a" });
  });

  test("create writes token, models.json, settings.json and the instance entry", async () => {
    const r = await applyT3Instance(piOpts());
    expect(r.status).toBe("created");
    const folder = join(home, ".t3", "gateway", "p1");
    expect(await readFile(join(folder, "token"), "utf8")).toBe(`${TOKEN}\n`);
    expect(await mode(join(folder, "token"))).toBe(0o600);
    const models = JSON.parse(await readFile(join(folder, "models.json"), "utf8"));
    const prov = models.providers.kimi;
    expect(prov.baseUrl).toBe("https://gw.example/gateway/kimi-app");
    expect(prov.api).toBe("anthropic-messages");
    expect(prov.apiKey).toBe(`!cat '${join(folder, "token")}'`);
    expect(prov.models.map((m: { id: string }) => m.id)).toEqual(["k1", "k2"]);
    expect(prov.models[0]).toMatchObject({ contextWindow: 262144, maxTokens: 32768, input: ["text"], reasoning: false });
    expect(JSON.stringify(models)).not.toContain(TOKEN);
    expect(await mode(join(folder, "models.json"))).toBe(0o600);
    expect(JSON.parse(await readFile(join(folder, "settings.json"), "utf8"))).toEqual({ defaultProvider: "kimi", defaultModel: "k1" });
    expect(await mode(join(folder, "settings.json"))).toBe(0o600);
    const entry = (await settings()).providerInstances.p1;
    expect(entry).toEqual({
      driver: "pi",
      displayName: "Pi One",
      enabled: true,
      environment: [{ name: "PI_CODING_AGENT_DIR", value: folder, sensitive: false }],
      config: { binaryPath: join(home, ".local", "bin", "pi"), customModels: ["k1", "k2"] },
    });
    expect(JSON.stringify(await settings())).not.toContain(TOKEN);
    expect((await settings()).providerInstances.other).toEqual({ driver: "codex", enabled: true });
  });

  test("provider falls back to the app name; models are required", async () => {
    await applyT3Instance(piOpts({ provider: undefined }));
    const folder = join(home, ".t3", "gateway", "p1");
    expect(Object.keys(JSON.parse(await readFile(join(folder, "models.json"), "utf8")).providers)).toEqual(["kimi-app"]);
    await expect(applyT3Instance(piOpts({ id: "p2", models: undefined }))).rejects.toThrow("--models");
  });

  test("current, --check and update", async () => {
    expect((await applyT3Instance(piOpts({ check: true }))).status).toBe("created");
    expect(await settings().then((s) => s.providerInstances.p1)).toBeUndefined();
    await applyT3Instance(piOpts());
    expect((await applyT3Instance(piOpts())).status).toBe("current");
    expect((await applyT3Instance(piOpts({ check: true }))).status).toBe("current");
    expect((await applyT3Instance(piOpts({ check: true, models: ["k9"] }))).status).toBe("updated");
    const r = await applyT3Instance(piOpts({ models: ["k9"] }));
    expect(r.status).toBe("updated");
    expect(JSON.parse(await readFile(join(home, ".t3", "gateway", "p1", "settings.json"), "utf8")).defaultModel).toBe("k9");
  });

  test("--remove drops the entry and keeps the folder", async () => {
    await applyT3Instance(piOpts());
    expect((await applyT3Instance(piOpts({ remove: true }))).status).toBe("removed");
    expect((await settings()).providerInstances.p1).toBeUndefined();
    expect((await stat(join(home, ".t3", "gateway", "p1"))).isDirectory()).toBe(true);
    expect((await applyT3Instance(piOpts({ remove: true }))).status).toBe("absent");
  });
});

describe("claude stale oauthAccount", () => {
  const folderOf = () => join(home, ".t3", "gateway", "c1");
  const okFetch = (uuid: string) => async () => ({ ok: true, status: 200, json: async () => ({ account: { uuid } }) });
  const seed = async (json: object) => {
    await applyT3Instance(opts({}));
    await writeFile(join(folderOf(), ".claude.json"), `${JSON.stringify(json, null, 2)}\n`, { mode: 0o600 });
  };
  const read = async () => readFile(join(folderOf(), ".claude.json"), "utf8");

  test("stale account is removed, other keys kept", async () => {
    await seed({ hasCompletedOnboarding: true, mine: 1, oauthAccount: { accountUuid: "old", emailAddress: "old@example.invalid" } });
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const r = await applyT3Instance(opts({ fetch: async (url, init) => { seen = { url, headers: init.headers }; return okFetch("gw")(); } }));
    expect(r.status).toBe("updated");
    expect(r.changes).toEqual(["account"]);
    expect(seen?.url).toBe("https://gw.example/gateway/agents-claude/api/oauth/profile");
    expect(seen?.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, "anthropic-beta": "oauth-2025-04-20" });
    expect(await read()).toBe(`${JSON.stringify({ hasCompletedOnboarding: true, mine: 1 }, null, 2)}\n`);
    expect(await mode(join(folderOf(), ".claude.json"))).toBe(0o600);
  });

  test("matching account is untouched and current", async () => {
    await seed({ oauthAccount: { accountUuid: "gw" } });
    const before = await read();
    const r = await applyT3Instance(opts({ fetch: okFetch("gw") }));
    expect(r.status).toBe("current");
    expect(await read()).toBe(before);
  });

  test("no oauthAccount is untouched and current", async () => {
    await seed({ mine: 1 });
    const before = await read();
    const r = await applyT3Instance(opts({ fetch: okFetch("gw") }));
    expect(r.status).toBe("current");
    expect(await read()).toBe(before);
  });

  test("fetch failure leaves the file and warns", async () => {
    await seed({ oauthAccount: { accountUuid: "old" } });
    const before = await read();
    for (const f of [async () => { throw new Error("boom"); }, async () => ({ ok: false, status: 500, json: async () => ({}) }), async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } })]) {
      const r = await applyT3Instance(opts({ fetch: f }));
      expect(r.status).toBe("current");
      expect(r.warnings?.length).toBe(1);
      expect(await read()).toBe(before);
    }
  });

  test("--check reports mismatch and writes nothing", async () => {
    await seed({ oauthAccount: { accountUuid: "old" } });
    const before = await read();
    const r = await applyT3Instance(opts({ check: true, fetch: okFetch("gw") }));
    expect(r.status).toBe("updated");
    expect(r.changes).toEqual(["account"]);
    expect(await read()).toBe(before);
  });
});
