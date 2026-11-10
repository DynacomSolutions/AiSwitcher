import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteAllOptions } from "../../src/cli/identities/route-all.ts";
import { classifyLogin, refreshOf } from "../../src/identities/gateway-routed.ts";
import { memberDir } from "../../src/identities/gateway-members.ts";
import { recordLoginRevoked } from "../../src/identities/gateway-revoked.ts";
import { LoginFlowManager, type SpawnedChild } from "../../src/server/login-flows.ts";
import { authStatus } from "../../src/server/auth.ts";
import type { ToolConfig } from "../../src/identities/types.ts";

/** A portal sign-in on a gateway-routed codex identity must end with the gateway using the new login. */

const KEY = "aisg_SYNTHETIC_FIXTURE_codex_key";
const jwt = (exp: number) => `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify({ exp }))}.sig`;
const login = (n: string, lastRefresh: string, account = "acct-1") =>
  JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "x", access_token: jwt(Math.floor(Date.now() / 1000) + 864_000), refresh_token: `rt-SYNTHETIC_FIXTURE-${n}`, account_id: account }, last_refresh: lastRefresh });
const OLD = "2030-01-01T00:00:00.000Z";
const NEW = "2030-01-05T00:00:00.000Z";

let home: string;
let folder: string;
let routeOpts: RouteAllOptions;
let savedDir: string | undefined;

const cfg: () => ToolConfig = () => ({
  toolName: "codex",
  realBinaryName: "codex",
  envVarName: "CODEX_HOME",
  globalMemoryProjection: "codex-developer-instructions",
  identitiesJsonPath: join(home, ".codex", "identities.json"),
  identitiesRootDir: join(home, ".codex", "identities"),
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ais-login-gw-"));
  savedDir = process.env.AIS_GATEWAY_MEMBERS_DIR;
  process.env.AIS_GATEWAY_MEMBERS_DIR = join(home, "members");
  folder = join(home, ".codex", "identities", "work");
  await mkdir(folder, { recursive: true });
  await mkdir(join(home, "proc"), { recursive: true });
  await writeFile(join(home, ".codex", "identities.json"), JSON.stringify({ version: 1, identities: [{ name: "work", label: "work", configDir: folder }] }));
  await writeFile(join(home, "secrets"), `AIS_GATEWAY_APP_AGENTS_CODEX_TOKEN=${KEY}\n`);
  // routed: the folder holds the gateway entry, the member store holds the (dead) login
  await writeFile(join(folder, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: KEY, aisGatewayRouting: { host: "h", at: 1, fingerprints: [] } }));
  await mkdir(memberDir("codex", "work"), { recursive: true });
  await writeFile(join(memberDir("codex", "work"), "auth.json"), login("dead", OLD));
  await recordLoginRevoked("codex", "work", "token_revoked");
  routeOpts = {
    registries: { codex: join(home, ".codex", "identities.json"), claude: join(home, "none-claude.json"), grok: join(home, "none-g.json"), kimi: join(home, "none-k.json"), pi: join(home, "none-p.json") },
    secretsPath: join(home, "secrets"),
    memberRoot: join(home, "members"),
    heartbeatPath: join(home, "no-heartbeat.json"),
    home,
    procRoot: join(home, "proc"),
    port: 47140,
    hostname: "test-host",
    out: () => {},
  };
});
afterEach(async () => {
  if (savedDir === undefined) delete process.env.AIS_GATEWAY_MEMBERS_DIR;
  else process.env.AIS_GATEWAY_MEMBERS_DIR = savedDir;
  await rm(home, { recursive: true, force: true });
});

/** Runs a fake `codex login` that writes `written` over the folder's auth.json (what the real tool does) and exits 0. */
async function portalLogin(written: string, adopt = true) {
  const manager = new LoginFlowManager({
    scriptBin: "/usr/bin/script",
    pollIntervalMs: 5,
    resolveBin: () => "/usr/bin/fake-codex",
    resolveIdentity: async () => ({ cfg: cfg(), configDir: folder, identityName: "work" }),
    fingerprint: async () => undefined,
    spawn: () => {
      void writeFile(join(folder, "auth.json"), written);
      return { stdin: { write: () => 0, end: () => {} }, stdout: (async function* () {})(), stderr: (async function* () {})(), exited: Promise.resolve(0), kill: () => {}, pid: 1 } as unknown as SpawnedChild;
    },
    ...(adopt ? { adoptLogin: (t: string, n: string, d: string) => import("../../src/server/login-flows.ts").then((m) => m.adoptLoginIntoGateway(t, n, d, routeOpts)) } : {}),
  });
  const flow = await manager.start("codex", "work");
  for (let i = 0; i < 200 && manager.get(flow.flowId).status !== "completed" && manager.get(flow.flowId).status !== "failed"; i++) await Bun.sleep(10);
  return manager.get(flow.flowId);
}

const storeText = () => readFile(join(memberDir("codex", "work"), "auth.json"), "utf8");
const folderText = () => readFile(join(folder, "auth.json"), "utf8");

describe("portal sign-in on a gateway-routed identity", () => {
  test("before: the portal reports the dead login as revoked", async () => {
    const e = (await authStatus([cfg()])).entries[0]!;
    expect(e.state).toBe("expired");
    expect(e.detail).toContain("re-login required");
  });

  test("without the hand-over the new login sits in the folder and the gateway keeps reading the dead copy", async () => {
    const flow = await portalLogin(login("new", NEW), false);
    expect(flow.status).toBe("completed");
    expect(classifyLogin("codex", await folderText())).toBe("login");
    expect(refreshOf("codex", await storeText())).toBe("rt-SYNTHETIC_FIXTURE-dead");
  });

  test("the new login of the same account reaches the member store and the folder gets the gateway entry back", async () => {
    const flow = await portalLogin(login("new", NEW));
    expect(flow.status).toBe("completed");
    expect(flow.note).toContain("now serves the gateway");
    expect(refreshOf("codex", await storeText())).toBe("rt-SYNTHETIC_FIXTURE-new");
    expect(classifyLogin("codex", await folderText())).toBe("gateway");
    const e = (await authStatus([cfg()])).entries[0]!;
    expect(e.state).toBe("ok");
    expect(e.detail).toContain("via gateway member store");
  });

  test("a different account is refused: the store keeps its login and the flow says so", async () => {
    const flow = await portalLogin(login("other", NEW, "acct-2"));
    expect(flow.status).toBe("completed");
    expect(flow.note).toContain("the gateway still uses its older login");
    expect(flow.note).toContain("different account");
    expect(refreshOf("codex", await storeText())).toBe("rt-SYNTHETIC_FIXTURE-dead");
  });

  test("a login that is not provably fresher keeps the store copy and says so", async () => {
    const flow = await portalLogin(login("older", "2029-12-01T00:00:00.000Z"));
    expect(flow.note).toContain("the gateway still uses its older login");
    expect(refreshOf("codex", await storeText())).toBe("rt-SYNTHETIC_FIXTURE-dead");
  });

  test("an identity the gateway does not hold (no store copy) is left alone", async () => {
    await rm(memberDir("codex", "work"), { recursive: true, force: true });
    const plain = login("plain", NEW);
    const flow = await portalLogin(plain);
    expect(flow.status).toBe("completed");
    expect(flow.note).toBeUndefined();
    expect(await folderText()).toBe(plain);
  });
});
