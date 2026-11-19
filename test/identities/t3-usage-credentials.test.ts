import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runT3UsageCommand } from "../../src/cli/gateway/t3-usage.ts";
import { syncT3UsageCredentials, type UsageResult } from "../../src/identities/t3-usage-credentials.ts";
import { createT3UsageTicker } from "../../src/sync/t3-usage-ticker.ts";

const root = await mkdtemp(join(tmpdir(), "ais-t3usage-"));
afterAll(() => rm(root, { recursive: true, force: true }));

const TOKEN = "aisg_testtoken123";
const GROK_KEY = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
let n = 0;

type Env = { name: string; value?: string; sensitive?: boolean; valueRedacted?: boolean }[];

async function scratch(instances: Record<string, unknown>, secrets = "") {
  const home = join(root, `h${n++}`);
  await mkdir(join(home, ".t3", "userdata"), { recursive: true });
  const settings = JSON.stringify({ providerInstances: instances });
  await writeFile(join(home, ".t3", "userdata", "settings.json"), settings);
  const secretsPath = join(home, "secrets");
  await writeFile(secretsPath, secrets);
  return { home, secretsPath, settings, opts: { home, env: {}, secretsPath } };
}

async function opencodeDirs(home: string, id: string, config: unknown) {
  const configDir = join(home, id, "cfg");
  const dataHome = join(home, id, "data");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "opencode.json"), typeof config === "string" ? config : `${JSON.stringify(config, null, 2)}\n`);
  const environment: Env = [
    { name: "OPENCODE_CONFIG_DIR", value: configDir },
    { name: "XDG_DATA_HOME", value: dataHome },
  ];
  return { configDir, dataHome, environment, authFile: join(dataHome, "opencode", "auth.json") };
}

const provider = (extra: Record<string, unknown> = {}) => ({ provider: { gw: { options: { baseURL: "https://gw.example.test/gateway/myapp", ...extra } } }, model: "gw/x" });
const secretsFor = (t: string) => `AIS_GATEWAY_APP_MYAPP_TOKEN=${t}\n`;
const mode = async (p: string) => (await stat(p)).mode & 0o777;
const statuses = (r: UsageResult[]) => r.map((x) => `${x.id}:${x.status}`);

async function withOpencode(config: unknown, secrets: string, setup?: (d: { configDir: string; dataHome: string }) => Promise<void>) {
  const s = await scratch({}, secrets);
  const d = await opencodeDirs(s.home, "oc", config);
  await setup?.(d);
  await writeFile(join(s.home, ".t3", "userdata", "settings.json"), JSON.stringify({ providerInstances: { oc: { driver: "opencode", enabled: true, environment: d.environment } } }));
  return { s, d };
}

test("opencode writes auth.json keeping other entries, 0600, and adds disabled_providers keeping the rest", async () => {
  const { s, d } = await withOpencode({ ...provider(), keep: { a: 1 } }, secretsFor(TOKEN), async (d) => {
    await mkdir(join(d.dataHome, "opencode"), { recursive: true });
    await writeFile(join(d.dataHome, "opencode", "auth.json"), JSON.stringify({ other: { type: "api", key: "k" } }));
  });
  const r = await syncT3UsageCredentials(s.opts);
  expect(r.map((x) => x.status)).toEqual(["updated", "updated"]);
  expect(JSON.parse(await readFile(d.authFile, "utf8"))).toEqual({ other: { type: "api", key: "k" }, "opencode-go": { type: "api", key: TOKEN } });
  expect(await mode(d.authFile)).toBe(0o600);
  const cfg = await readFile(join(d.configDir, "opencode.json"), "utf8");
  expect(cfg.endsWith("}\n")).toBe(true);
  const parsed = JSON.parse(cfg);
  expect(parsed.disabled_providers).toEqual(["opencode-go"]);
  expect(Object.keys(parsed)).toEqual(["provider", "model", "keep", "disabled_providers"]);
  expect(JSON.stringify(r)).not.toContain(TOKEN);
  // settings.json is only read.
  expect(JSON.parse(await readFile(join(s.home, ".t3", "userdata", "settings.json"), "utf8")).providerInstances.oc.driver).toBe("opencode");
});

test("opencode keeps existing disabled_providers entries and appends opencode-go", async () => {
  const { s, d } = await withOpencode({ ...provider(), disabled_providers: ["x"] }, secretsFor(TOKEN));
  await syncT3UsageCredentials(s.opts);
  expect(JSON.parse(await readFile(join(d.configDir, "opencode.json"), "utf8")).disabled_providers).toEqual(["x", "opencode-go"]);
});

test("opencode token order: token file, literal apiKey, {file:} reference, then ~/.secrets", async () => {
  const cases: { name: string; apiKey?: string; tokenFile?: string; refFile?: string; secrets: string; want: string }[] = [
    { name: "token file", apiKey: "aisg_SYNTHETIC_FIXTURE_literal", tokenFile: "aisg_fromfile\n", secrets: secretsFor("aisg_secret"), want: "aisg_fromfile" },
    { name: "literal", apiKey: "aisg_SYNTHETIC_FIXTURE_literal", tokenFile: "sk-notgateway", secrets: secretsFor("aisg_secret"), want: "aisg_SYNTHETIC_FIXTURE_literal" },
    { name: "file ref", apiKey: "{file:ref.txt}", refFile: " aisg_fromref \n", secrets: secretsFor("aisg_secret"), want: "aisg_fromref" },
    { name: "secrets", apiKey: "sk-provider", secrets: secretsFor("aisg_secret"), want: "aisg_secret" },
  ];
  for (const c of cases) {
    const { s, d } = await withOpencode(provider(c.apiKey ? { apiKey: c.apiKey } : {}), c.secrets, async (d) => {
      if (c.tokenFile) await writeFile(join(d.configDir, "token"), c.tokenFile);
      if (c.refFile) await writeFile(join(d.configDir, "ref.txt"), c.refFile);
    });
    await syncT3UsageCredentials(s.opts);
    expect(JSON.parse(await readFile(d.authFile, "utf8"))["opencode-go"].key, c.name).toBe(c.want);
  }
});

test("opencode refuses a token that is not a gateway token and writes nothing", async () => {
  const { s, d } = await withOpencode(provider({ apiKey: "sk-SYNTHETIC_FIXTURE-key" }), secretsFor("sk-SYNTHETIC_FIXTURE-other"));
  const r = await syncT3UsageCredentials(s.opts);
  expect(statuses(r)).toEqual(["oc:failed"]);
  expect(r[0]!.detail).toContain("no gateway token");
  expect(JSON.stringify(r)).not.toContain("sk-");
  await expect(stat(d.authFile)).rejects.toThrow();
  expect(JSON.parse(await readFile(join(d.configDir, "opencode.json"), "utf8")).disabled_providers).toBeUndefined();
});

test("opencode without OPENCODE_CONFIG_DIR or XDG_DATA_HOME is skipped", async () => {
  const s = await scratch({ a: { driver: "opencode", enabled: true, environment: [{ name: "XDG_DATA_HOME", value: "/x" }] }, b: { driver: "claudeAgent", enabled: true } });
  expect(statuses(await syncT3UsageCredentials(s.opts))).toEqual(["a:skipped"]);
});

const grokInstance = (home: string, extra: Env = [], withAuthPath = true) => {
  const dir = join(home, "grok");
  const environment: Env = [
    { name: "GROK_HOME", value: dir },
    ...(withAuthPath ? [{ name: "GROK_AUTH_PATH", value: join(dir, "cli-auth.json") }] : []),
    { name: "GROK_XAI_API_BASE_URL", value: "https://gw.example.test/gateway/myapp" },
    { name: "GROK_CODE_XAI_API_KEY", sensitive: true, valueRedacted: true },
    ...extra,
  ];
  return { dir, instance: { driver: "grok", enabled: false, environment } };
};

test("grok writes auth.json with the gateway token, 0600, from ~/.secrets", async () => {
  const s = await scratch({}, secretsFor(TOKEN));
  const g = grokInstance(s.home);
  await writeFile(join(s.home, ".t3", "userdata", "settings.json"), JSON.stringify({ providerInstances: { g: g.instance } }));
  const r = await syncT3UsageCredentials(s.opts);
  expect(statuses(r)).toEqual(["g:updated"]);
  const file = join(g.dir, "auth.json");
  expect(await readFile(file, "utf8")).toBe(`${JSON.stringify({ [GROK_KEY]: { key: TOKEN, auth_mode: "oidc", email: "myapp@gateway.invalid" } }, null, 2)}\n`);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ [GROK_KEY]: { key: TOKEN, auth_mode: "oidc", email: "myapp@gateway.invalid" } });
  expect(await mode(file)).toBe(0o600);
});

test("grok token file wins over secrets, a non-gateway token fails", async () => {
  const s = await scratch({}, secretsFor("aisg_secret"));
  const g = grokInstance(s.home);
  await mkdir(g.dir, { recursive: true });
  await writeFile(join(g.dir, "token"), "aisg_filetoken\n");
  await writeFile(join(s.home, ".t3", "userdata", "settings.json"), JSON.stringify({ providerInstances: { g: g.instance } }));
  await syncT3UsageCredentials(s.opts);
  expect(JSON.parse(await readFile(join(g.dir, "auth.json"), "utf8"))[GROK_KEY].key).toBe("aisg_filetoken");
  const bad = await scratch({}, secretsFor("sk-nope"));
  const g2 = grokInstance(bad.home);
  await writeFile(join(bad.home, ".t3", "userdata", "settings.json"), JSON.stringify({ providerInstances: { g: g2.instance } }));
  expect(statuses(await syncT3UsageCredentials(bad.opts))).toEqual(["g:failed"]);
  await expect(stat(join(g2.dir, "auth.json"))).rejects.toThrow();
});

test("grok reports blocking env and a missing or T3-facing GROK_AUTH_PATH as problems", async () => {
  const s = await scratch({}, secretsFor(TOKEN));
  const a = grokInstance(s.home, [{ name: "XAI_API_KEY", sensitive: true, valueRedacted: true }, { name: "GROK_CONFIG", value: "/x" }]);
  const b = grokInstance(join(s.home, "b"), [], false);
  const c = grokInstance(join(s.home, "c"));
  (c.instance.environment.find((e) => e.name === "GROK_AUTH_PATH") as { value: string }).value = join(c.dir, "auth.json");
  await writeFile(join(s.home, ".t3", "userdata", "settings.json"), JSON.stringify({ providerInstances: { a: a.instance, b: b.instance, c: c.instance } }));
  const r = await syncT3UsageCredentials(s.opts);
  const problems = r.filter((x) => x.status === "problem");
  expect(problems.map((x) => x.id)).toEqual(["a", "b", "c"]);
  expect(problems[0]!.detail).toContain("XAI_API_KEY, GROK_CONFIG");
  expect(problems[1]!.detail).toContain("GROK_AUTH_PATH is not set");
  expect(problems[2]!.detail).toContain("equals");
});

test("--check writes nothing and fails; the second normal run reports current; T3CODE_HOME is honoured", async () => {
  const s = await scratch({}, secretsFor(TOKEN));
  const g = grokInstance(s.home);
  const t3Home = join(s.home, "elsewhere");
  await mkdir(join(t3Home, "userdata"), { recursive: true });
  await writeFile(join(t3Home, "userdata", "settings.json"), JSON.stringify({ providerInstances: { g: g.instance } }));
  const opts = { ...s.opts, env: { T3CODE_HOME: t3Home } };
  const lines: string[] = [];
  const deps = { out: (l: string) => lines.push(l), secretsPath: s.secretsPath } as never;
  await expect(runT3UsageCommand([], { check: true }, deps, opts)).rejects.toThrow("out of date");
  await expect(stat(join(g.dir, "auth.json"))).rejects.toThrow();
  expect(lines[0]).toContain("out of date");
  expect(lines.join("\n")).not.toContain(TOKEN);
  await runT3UsageCommand([], {}, deps, opts);
  expect(statuses(await syncT3UsageCredentials(opts))).toEqual(["g:current"]);
  await runT3UsageCommand([], { check: true }, deps, opts);
  expect(lines[lines.length - 1]).toBe(`g grok ${join(g.dir, "auth.json")} current`);
});

test("a file with loose mode is tightened to 0600 and a changed token is rewritten", async () => {
  const s = await scratch({}, secretsFor(TOKEN));
  const g = grokInstance(s.home);
  await writeFile(join(s.home, ".t3", "userdata", "settings.json"), JSON.stringify({ providerInstances: { g: g.instance } }));
  await syncT3UsageCredentials(s.opts);
  const file = join(g.dir, "auth.json");
  await Bun.$`chmod 644 ${file}`;
  expect(statuses(await syncT3UsageCredentials(s.opts))).toEqual(["g:updated"]);
  expect(await mode(file)).toBe(0o600);
  await writeFile(s.secretsPath, secretsFor("aisg_rotated"));
  await syncT3UsageCredentials(s.opts);
  expect(JSON.parse(await readFile(file, "utf8"))[GROK_KEY].key).toBe("aisg_rotated");
});

test("no settings.json gives no results and the CLI says so", async () => {
  const home = join(root, `h${n++}`);
  expect(await syncT3UsageCredentials({ home, env: {} })).toEqual([]);
  const lines: string[] = [];
  await runT3UsageCommand([], {}, { out: (l: string) => lines.push(l) } as never, { home, env: {} });
  expect(lines[0]).toContain("no T3");
});

test("ticker logs a failure or problem once, an update each time, and runs every interval", async () => {
  let t = 0;
  const logs: string[] = [];
  let next: UsageResult[] = [{ id: "g", driver: "grok", file: "/f", status: "failed", detail: "no gateway token" }];
  const ticker = createT3UsageTicker({ now: () => t, log: (m) => logs.push(m), intervalMs: 1000, sync: async () => next });
  await ticker.tick();
  await ticker.idle();
  t = 500;
  await ticker.tick();
  await ticker.idle();
  expect(logs).toHaveLength(1);
  t = 1000;
  await ticker.tick();
  await ticker.idle();
  expect(logs).toHaveLength(1);
  next = [{ id: "g", driver: "grok", file: "/f", status: "updated" }];
  t = 2000;
  await ticker.tick();
  await ticker.idle();
  expect(logs).toHaveLength(2);
  expect(logs[1]).toContain("updated");
});
