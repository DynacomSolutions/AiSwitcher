import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteAllOptions } from "../../src/cli/identities/route-all.ts";
import { writeHeartbeat } from "../../src/identities/gateway-heartbeat.ts";
import { classifyLogin, refreshFingerprint, refreshOf } from "../../src/identities/gateway-routed.ts";
import { memberDir } from "../../src/identities/gateway-members.ts";
import { readLoginRevoked, recordLoginRevoked } from "../../src/identities/gateway-revoked.ts";
import { adoptLoginIntoGateway, LoginFlowManager, type SpawnedChild } from "../../src/server/login-flows.ts";
import { authStatus } from "../../src/server/auth.ts";
import { HttpError } from "../../src/server/types.ts";
import type { ToolConfig } from "../../src/identities/types.ts";

/** A portal sign-in on a gateway-routed identity must end with the gateway using the new login, or say plainly that it did not. */

const CODEX_KEY = "aisg_SYNTHETIC_FIXTURE_codex_key";
const CLAUDE_KEY = "aisg_SYNTHETIC_FIXTURE_claude_key";
const jwt = (exp: number) => `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify({ exp }))}.sig`;
const codexLogin = (n: string, lastRefresh: string, account = "acct-1") =>
  JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "x", access_token: jwt(Math.floor(Date.now() / 1000) + 864_000), refresh_token: `rt-SYNTHETIC_FIXTURE-${n}`, account_id: account }, last_refresh: lastRefresh });
const claudeLogin = (n: string, expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-SYNTHETIC_FIXTURE-${n}`, refreshToken: `rt-SYNTHETIC_FIXTURE-${n}`, expiresAt, scopes: ["user:inference"] } });
const claudeJson = (uuid: string) => JSON.stringify({ oauthAccount: { accountUuid: uuid } });
const OLD = "2030-01-01T00:00:00.000Z";
const NEW = "2030-01-05T00:00:00.000Z";
const fp = (n: string) => refreshFingerprint(`rt-SYNTHETIC_FIXTURE-${n}`).slice(0, 8);

let home: string;
let folder: string;
let routeOpts: RouteAllOptions;
let savedDir: string | undefined;

const codexCfg = (): ToolConfig => ({
  toolName: "codex",
  realBinaryName: "codex",
  envVarName: "CODEX_HOME",
  globalMemoryProjection: "codex-developer-instructions",
  identitiesJsonPath: join(home, ".codex", "identities.json"),
  identitiesRootDir: join(home, ".codex", "identities"),
});

/** A fresh heartbeat from a member-store gateway that holds the account but has not renewed it (its login is dead). */
async function heartbeat(over: { held?: readonly string[]; ageMs?: number; memberStore?: boolean; renewed?: boolean } = {}) {
  const keys = over.held ?? ["codex/work", "claude/work"];
  await writeHeartbeat(
    {
      version: 1,
      passAt: new Date(Date.now() - (over.ageMs ?? 1000)).toISOString(),
      held: Object.fromEntries(keys.map((k) => [k, over.renewed ? { lastSuccessAt: new Date().toISOString() } : {}])),
      ...(over.memberStore === false ? {} : { memberStore: true }),
    },
    join(home, "heartbeat.json"),
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ais-login-gw-"));
  savedDir = process.env.AIS_GATEWAY_MEMBERS_DIR;
  process.env.AIS_GATEWAY_MEMBERS_DIR = join(home, "members");
  folder = join(home, ".codex", "identities", "work");
  await mkdir(folder, { recursive: true });
  await mkdir(join(home, "proc"), { recursive: true });
  await writeFile(join(home, ".codex", "identities.json"), JSON.stringify({ version: 1, identities: [{ name: "work", label: "work", configDir: folder }] }));
  await writeFile(join(home, "secrets"), `AIS_GATEWAY_APP_AGENTS_CODEX_TOKEN=${CODEX_KEY}\nAIS_GATEWAY_APP_AGENTS_CLAUDE_TOKEN=${CLAUDE_KEY}\n`);
  // routed: the folder holds the gateway entry, the member store holds the (dead) login
  await writeFile(join(folder, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: CODEX_KEY, aisGatewayRouting: { host: "h", at: 1, fingerprints: [] } }));
  await mkdir(memberDir("codex", "work"), { recursive: true });
  await writeFile(join(memberDir("codex", "work"), "auth.json"), codexLogin("dead", OLD));
  await recordLoginRevoked("codex", "work", "token_revoked", fp("dead"));
  await heartbeat();
  routeOpts = {
    registries: { codex: join(home, ".codex", "identities.json"), claude: join(home, ".claude", "identities.json"), grok: join(home, "none-g.json"), kimi: join(home, "none-k.json"), pi: join(home, "none-p.json") },
    secretsPath: join(home, "secrets"),
    memberRoot: join(home, "members"),
    heartbeatPath: join(home, "heartbeat.json"),
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
function manager(written: string, over: { adopt?: boolean; exitAfter?: Promise<unknown>; flowTimeoutMs?: number } = {}) {
  return new LoginFlowManager({
    scriptBin: "/usr/bin/script",
    pollIntervalMs: 5,
    ...(over.flowTimeoutMs ? { flowTimeoutMs: over.flowTimeoutMs } : {}),
    resolveBin: () => "/usr/bin/fake-codex",
    resolveIdentity: async () => ({ cfg: codexCfg(), configDir: folder, identityName: "work" }),
    fingerprint: async () => undefined,
    spawn: () => {
      void writeFile(join(folder, "auth.json"), written);
      return { stdin: { write: () => 0, end: () => {} }, stdout: (async function* () {})(), stderr: (async function* () {})(), exited: (over.exitAfter ?? Promise.resolve()).then(() => 0), kill: () => {}, pid: 1 } as unknown as SpawnedChild;
    },
    ...(over.adopt === false ? {} : { adoptLogin: (t, n, d) => adoptLoginIntoGateway(t, n, d, routeOpts) }),
  });
}

async function portalLogin(written: string, adopt = true) {
  const m = manager(written, { adopt });
  const flow = await m.start("codex", "work");
  for (let i = 0; i < 300 && m.get(flow.flowId).status !== "completed" && m.get(flow.flowId).status !== "failed"; i++) await Bun.sleep(10);
  return m.get(flow.flowId);
}

const storeText = () => readFile(join(memberDir("codex", "work"), "auth.json"), "utf8");
const folderText = () => readFile(join(folder, "auth.json"), "utf8");

describe("portal sign-in on a gateway-routed codex identity", () => {
  test("before: the portal reports the dead login as revoked", async () => {
    const e = (await authStatus([codexCfg()])).entries[0]!;
    expect(e.state).toBe("expired");
    expect(e.detail).toContain("re-login required");
  });

  test("without the hand-over the new login sits in the folder and the gateway keeps reading the dead copy", async () => {
    const flow = await portalLogin(codexLogin("new", NEW), false);
    expect(flow.status).toBe("completed");
    expect(classifyLogin("codex", await folderText())).toBe("login");
    expect(refreshOf("codex", await storeText())).toBe("rt-SYNTHETIC_FIXTURE-dead");
  });

  test("the new login of the same account reaches the member store, the folder gets the gateway entry back, the revoked marker ends", async () => {
    const flow = await portalLogin(codexLogin("new", NEW));
    expect(flow.status).toBe("completed");
    expect(flow.note).toBeUndefined();
    expect(refreshOf("codex", await storeText())).toBe("rt-SYNTHETIC_FIXTURE-new");
    expect(classifyLogin("codex", await folderText())).toBe("gateway");
    expect(readLoginRevoked("codex", "work")).toBeUndefined();
    const e = (await authStatus([codexCfg()])).entries[0]!;
    expect(e.state).toBe("ok");
    expect(e.detail).toContain("via gateway member store");
  });

  test("a different account is refused: the folder keeps the new login, the store its own, and the flow says so", async () => {
    const flow = await portalLogin(codexLogin("other", NEW, "acct-2"));
    expect(flow.status).toBe("completed");
    expect(flow.note).toContain("the gateway still uses its older login");
    expect(flow.note).toContain("different account");
    expect(refreshOf("codex", await storeText())).toBe("rt-SYNTHETIC_FIXTURE-dead");
    expect(classifyLogin("codex", await folderText())).toBe("login");
  });

  test("a login that is not provably fresher is refused BEFORE the folder is touched (it stays a login, no backup buries it)", async () => {
    const flow = await portalLogin(codexLogin("older", "2029-12-01T00:00:00.000Z"));
    expect(flow.note).toContain("the gateway still uses its older login");
    expect(refreshOf("codex", await storeText())).toBe("rt-SYNTHETIC_FIXTURE-dead");
    expect(classifyLogin("codex", await folderText())).toBe("login");
    expect(refreshOf("codex", await folderText())).toBe("rt-SYNTHETIC_FIXTURE-older");
  });

  test("an identity the gateway does not hold (no store copy) is left alone", async () => {
    await rm(memberDir("codex", "work"), { recursive: true, force: true });
    const plain = codexLogin("plain", NEW);
    const flow = await portalLogin(plain);
    expect(flow.status).toBe("completed");
    expect(flow.note).toBeUndefined();
    expect(await folderText()).toBe(plain);
  });

  for (const [label, hb, expected] of [
    ["no heartbeat", "none", "no gateway heartbeat"],
    ["a stale heartbeat", { ageMs: 3 * 3_600_000 }, "stale"],
    ["a gateway built before the member store", { memberStore: false }, "predates the member store"],
    ["a gateway that does not hold the account", { held: ["codex/other"] }, "does not hold this account"],
  ] as const) {
    test(`${label} refuses the hand-over, leaves the folder's new login and says so`, async () => {
      if (hb === "none") await rm(join(home, "heartbeat.json"));
      else await heartbeat(hb);
      const flow = await portalLogin(codexLogin("new", NEW));
      expect(flow.note).toContain("the gateway still uses its older login");
      expect(flow.note).toContain(expected);
      expect(classifyLogin("codex", await folderText())).toBe("login");
      expect(refreshOf("codex", await storeText())).toBe("rt-SYNTHETIC_FIXTURE-dead");
    });
  }

  test("a gateway that renewed the dead login before is accepted too", async () => {
    await heartbeat({ renewed: true });
    const flow = await portalLogin(codexLogin("new", NEW));
    expect(flow.note).toBeUndefined();
    expect(refreshOf("codex", await storeText())).toBe("rt-SYNTHETIC_FIXTURE-new");
  });

  test("a session that appears right after the switch is reported, not claimed as success", async () => {
    await writeFile(join(folder, "auth.json"), codexLogin("new", NEW));
    let started = false;
    const opts: RouteAllOptions = {
      ...routeOpts,
      now: () => {
        // routingNow runs under the locks once the store holds the new login, after the session check: a codex session starts here
        if (!started && readFileSync(join(memberDir("codex", "work"), "auth.json"), "utf8").includes("rt-SYNTHETIC_FIXTURE-new")) {
          started = true;
          const dir = join(home, "proc", "4401");
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "cmdline"), "/usr/bin/codex\0resume\0");
          writeFileSync(join(dir, "environ"), `PATH=/x\0CODEX_HOME=${folder}`);
        }
        return Date.now();
      },
    };
    const note = await adoptLoginIntoGateway("codex", "work", folder, opts);
    expect(started).toBe(true);
    expect(note).toContain("WARNING");
    expect(note).toContain("4401");
  });
});

describe("the flow while the hand-over runs", () => {
  test("a flow in its hand-over cannot time out or be cancelled", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const m = new LoginFlowManager({
      scriptBin: "/usr/bin/script",
      pollIntervalMs: 5,
      flowTimeoutMs: 40,
      resolveBin: () => "/usr/bin/fake-codex",
      resolveIdentity: async () => ({ cfg: codexCfg(), configDir: folder, identityName: "work" }),
      fingerprint: async () => undefined,
      spawn: () => ({ stdin: { write: () => 0, end: () => {} }, stdout: (async function* () {})(), stderr: (async function* () {})(), exited: Promise.resolve(0), kill: () => {}, pid: 1 }) as unknown as SpawnedChild,
      adoptLogin: async () => {
        await gate;
        return undefined;
      },
    });
    const flow = await m.start("codex", "work");
    await Bun.sleep(120); // well past the flow timeout
    expect(m.get(flow.flowId).status).not.toBe("failed");
    expect(m.get(flow.flowId).error).toBeUndefined();
    expect(() => m.cancel(flow.flowId)).toThrow(HttpError);
    expect(m.get(flow.flowId).status).not.toBe("cancelled");
    release();
    for (let i = 0; i < 100 && m.get(flow.flowId).status !== "completed"; i++) await Bun.sleep(10);
    expect(m.get(flow.flowId).status).toBe("completed");
  });
});

describe("portal sign-in on a gateway-routed claude identity", () => {
  const LATER = Date.parse("2031-01-01T00:00:00Z");
  const EARLIER = Date.parse("2030-01-01T00:00:00Z");
  let cfolder: string;
  const cstore = () => memberDir("claude", "work");

  async function seedClaude(opts: { storeAccount?: string | null } = {}) {
    cfolder = join(home, ".claude", "identities", "work");
    await mkdir(cfolder, { recursive: true });
    await writeFile(join(home, ".claude", "identities.json"), JSON.stringify({ version: 1, identities: [{ name: "work", label: "work", configDir: cfolder }] }));
    await writeFile(join(cfolder, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE_KEY, scopes: [] } }));
    await mkdir(cstore(), { recursive: true });
    await writeFile(join(cstore(), ".credentials.json"), claudeLogin("dead", EARLIER));
    if (opts.storeAccount !== null) await writeFile(join(cstore(), ".claude.json"), claudeJson(opts.storeAccount ?? "uuid-1"));
    await recordLoginRevoked("claude", "work", "invalid_grant", fp("dead"));
  }
  /** What `claude auth login` leaves in the folder. */
  async function signIn(expiresAt: number, uuid = "uuid-1") {
    await writeFile(join(cfolder, ".credentials.json"), claudeLogin("new", expiresAt));
    await writeFile(join(cfolder, ".claude.json"), claudeJson(uuid));
  }
  const folderKind = async () => classifyLogin("claude", await readFile(join(cfolder, ".credentials.json"), "utf8"));
  const storeRefresh = async () => refreshOf("claude", await readFile(join(cstore(), ".credentials.json"), "utf8"));

  test("a fresher login of the same account reaches the store and the folder gets the gateway entry back", async () => {
    await seedClaude();
    await signIn(LATER);
    expect(await adoptLoginIntoGateway("claude", "work", cfolder, routeOpts)).toBeUndefined();
    expect(await storeRefresh()).toBe("rt-SYNTHETIC_FIXTURE-new");
    expect(await folderKind()).toBe("gateway");
    expect(readLoginRevoked("claude", "work")).toBeUndefined();
  });

  test("a login that is not fresher is refused before the folder is touched", async () => {
    await seedClaude();
    await signIn(EARLIER);
    const note = await adoptLoginIntoGateway("claude", "work", cfolder, routeOpts);
    expect(note).toContain("the gateway still uses its older login");
    expect(await folderKind()).toBe("login");
    expect(await storeRefresh()).toBe("rt-SYNTHETIC_FIXTURE-dead");
  });

  test("a store copy with no account record cannot be matched: refused, the folder keeps the new login", async () => {
    await seedClaude({ storeAccount: null });
    await signIn(LATER);
    const note = await adoptLoginIntoGateway("claude", "work", cfolder, routeOpts);
    expect(note).toContain("the gateway still uses its older login");
    expect(note).toContain("could not confirm");
    expect(await folderKind()).toBe("login");
    expect(await storeRefresh()).toBe("rt-SYNTHETIC_FIXTURE-dead");
  });

  test("a different account is refused", async () => {
    await seedClaude();
    await signIn(LATER, "uuid-2");
    const note = await adoptLoginIntoGateway("claude", "work", cfolder, routeOpts);
    expect(note).toContain("different account");
    expect(await folderKind()).toBe("login");
  });
});
