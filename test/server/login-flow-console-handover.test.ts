import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteAllOptions } from "../../src/cli/identities/route-all.ts";
import { writeHeartbeat } from "../../src/identities/gateway-heartbeat.ts";
import { classifyLogin, refreshOf } from "../../src/identities/gateway-routed.ts";
import { memberDir } from "../../src/identities/gateway-members.ts";
import { adoptLoginIntoGateway, LoginFlowManager, type SpawnedChild } from "../../src/server/login-flows.ts";
import type { ToolConfig } from "../../src/identities/types.ts";

/** The console pod has no ~/.secrets: the hand-over must use the app key the folder held before the sign-in. */

const KEYS = { codex: "aisg_SYNTHETIC_FIXTURE_console_codex", claude: "aisg_SYNTHETIC_FIXTURE_console_claude" } as const;
const jwt = (exp: number) => `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify({ exp }))}.sig`;
const codexLogin = (n: string, lastRefresh: string) =>
  JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "x", access_token: jwt(Math.floor(Date.now() / 1000) + 864_000), refresh_token: `rt-SYNTHETIC_FIXTURE-${n}`, account_id: "acct-1" }, last_refresh: lastRefresh });
const claudeLogin = (n: string, expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-SYNTHETIC_FIXTURE-${n}`, refreshToken: `rt-SYNTHETIC_FIXTURE-${n}`, expiresAt, scopes: ["user:inference"] } });
const claudeJson = JSON.stringify({ oauthAccount: { accountUuid: "uuid-1" } });

let home: string;
let saved: string | undefined;
let logs: string[];
let routeOpts: RouteAllOptions;

type Tool = "codex" | "claude";
const folderOf = (t: Tool) => join(home, `.${t}`, "identities", "work");
const loginFile = (t: Tool) => (t === "codex" ? "auth.json" : ".credentials.json");
const cfg = (t: Tool): ToolConfig => ({
  toolName: t,
  realBinaryName: t,
  envVarName: t === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR",
  globalMemoryProjection: t === "codex" ? "codex-developer-instructions" : "claude-md",
  identitiesJsonPath: join(home, `.${t}`, "identities.json"),
  identitiesRootDir: join(home, `.${t}`, "identities"),
}) as ToolConfig;

const entry = (t: Tool) =>
  t === "codex"
    ? JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: KEYS.codex, aisGatewayRouting: { host: "h", at: 1, fingerprints: [] } })
    : JSON.stringify({ claudeAiOauth: { accessToken: KEYS.claude, refreshToken: null, scopes: [] } });

/** A routed identity: the folder holds `folderText` (the gateway entry by default), the member store a dead login. No secrets file exists. */
async function seed(t: Tool, folderText = entry(t)) {
  const folder = folderOf(t);
  await mkdir(folder, { recursive: true });
  await writeFile(join(home, `.${t}`, "identities.json"), JSON.stringify({ version: 1, identities: [{ name: "work", label: "work", configDir: folder }] }));
  await writeFile(join(folder, loginFile(t)), folderText);
  await mkdir(memberDir(t, "work"), { recursive: true });
  if (t === "codex") await writeFile(join(memberDir(t, "work"), "auth.json"), codexLogin("dead", "2030-01-01T00:00:00.000Z"));
  else {
    await writeFile(join(memberDir(t, "work"), ".credentials.json"), claudeLogin("dead", Date.parse("2030-01-01T00:00:00Z")));
    await writeFile(join(memberDir(t, "work"), ".claude.json"), claudeJson);
  }
  await writeHeartbeat({ version: 1, passAt: new Date().toISOString(), held: { [`${t}/work`]: {} }, memberStore: true }, join(home, "heartbeat.json"));
}

/** The fresh same-account sign-in the fake tool writes over the folder. */
async function writeSignIn(t: Tool) {
  if (t === "codex") await writeFile(join(folderOf(t), "auth.json"), codexLogin("new", "2030-01-05T00:00:00.000Z"));
  else {
    await writeFile(join(folderOf(t), ".credentials.json"), claudeLogin("new", Date.parse("2031-01-01T00:00:00Z")));
    await writeFile(join(folderOf(t), ".claude.json"), claudeJson);
  }
}

async function portalLogin(t: Tool) {
  const m = new LoginFlowManager({
    scriptBin: "/usr/bin/script",
    pollIntervalMs: 5,
    resolveBin: () => `/usr/bin/fake-${t}`,
    resolveIdentity: async () => ({ cfg: cfg(t), configDir: folderOf(t), identityName: "work" }),
    fingerprint: async () => undefined,
    spawn: () => {
      void writeSignIn(t);
      return { stdin: { write: () => 0, end: () => {} }, stdout: (async function* () {})(), stderr: (async function* () {})(), exited: Promise.resolve(0), kill: () => {}, pid: 1 } as unknown as SpawnedChild;
    },
    adoptLogin: (tool, name, dir, key) => adoptLoginIntoGateway(tool, name, dir, routeOpts, key),
  });
  const flow = await m.start(t, "work");
  for (let i = 0; i < 300 && m.get(flow.flowId).status !== "completed" && m.get(flow.flowId).status !== "failed"; i++) await Bun.sleep(10);
  return { started: flow, done: m.get(flow.flowId), list: m.list() };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ais-console-gw-"));
  saved = process.env.AIS_GATEWAY_MEMBERS_DIR;
  process.env.AIS_GATEWAY_MEMBERS_DIR = join(home, "members");
  await mkdir(join(home, "proc"), { recursive: true });
  logs = [];
  routeOpts = {
    registries: { codex: join(home, ".codex", "identities.json"), claude: join(home, ".claude", "identities.json"), grok: join(home, "none-g.json"), kimi: join(home, "none-k.json"), pi: join(home, "none-p.json") },
    secretsPath: join(home, "no-such-secrets"),
    memberRoot: join(home, "members"),
    heartbeatPath: join(home, "heartbeat.json"),
    home,
    procRoot: join(home, "proc"),
    port: 47140,
    hostname: "test-host",
    out: (l) => logs.push(l),
  };
});
afterEach(async () => {
  if (saved === undefined) delete process.env.AIS_GATEWAY_MEMBERS_DIR;
  else process.env.AIS_GATEWAY_MEMBERS_DIR = saved;
  await rm(home, { recursive: true, force: true });
});

for (const t of ["codex", "claude"] as const) {
  describe(`console pod without a secrets file: ${t}`, () => {
    test("the hand-over uses the key the folder held: store has the new login, folder has the entry with the same key", async () => {
      await seed(t);
      const { done, started, list } = await portalLogin(t);
      expect(done.status).toBe("completed");
      expect(done.note).toBeUndefined();
      expect(refreshOf(t, await readFile(join(memberDir(t, "work"), loginFile(t)), "utf8"))).toBe("rt-SYNTHETIC_FIXTURE-new");
      const folder = await readFile(join(folderOf(t), loginFile(t)), "utf8");
      expect(classifyLogin(t, folder)).toBe("gateway");
      expect(folder).toContain(KEYS[t]);
      const leaked = JSON.stringify([done, started, list, logs]);
      expect(leaked).not.toContain("aisg_");
    });

    test("no key anywhere: the refusal note stays and the key is not invented", async () => {
      await seed(t, t === "codex" ? codexLogin("plain", "2030-01-02T00:00:00.000Z") : claudeLogin("plain", Date.parse("2030-06-01T00:00:00Z")));
      const { done } = await portalLogin(t);
      expect(done.note).toContain("signed in, but the gateway still uses its older login for this identity");
      expect(done.note).toContain("no AIS_GATEWAY_APP_AGENTS_");
      expect(classifyLogin(t, await readFile(join(folderOf(t), loginFile(t)), "utf8"))).toBe("login");
      expect(refreshOf(t, await readFile(join(memberDir(t, "work"), loginFile(t)), "utf8"))).toBe("rt-SYNTHETIC_FIXTURE-dead");
    });

    test("a folder entry whose key is not an aisg_ key is not used", async () => {
      await seed(t, t === "codex" ? JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-SYNTHETIC_FIXTURE-plain" }) : JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-SYNTHETIC_FIXTURE-x", refreshToken: null } }));
      const { done } = await portalLogin(t);
      expect(done.note).toContain("the gateway still uses its older login");
    });
  });
}
