import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteAllOptions } from "../../src/cli/identities/route-all.ts";
import { sha256Hex, type HomeFileKind, type HomeFileMeta, type HomeFileRow, type PutResult } from "../../src/gateway/home-store.ts";
import type { HomeStoreClient } from "../../src/gateway/home-store.ts";
import { classifyLogin } from "../../src/identities/gateway-routed.ts";
import { memberDir } from "../../src/identities/gateway-members.ts";
import { pushOwnerLogin } from "../../src/gateway/owner-store-push.ts";
import { adoptLoginIntoGateway } from "../../src/server/login-flows.ts";

/**
 * A first sign-in of a new gateway-managed identity (no member copy yet, for example a swap-pool member added in the console)
 * must reach the credential store, or the portal must say that it did not.
 */

const CLAUDE_KEY = "aisg_SYNTHETIC_FIXTURE_claude_key";
const claudeLogin = (n: string) => JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-SYNTHETIC_FIXTURE-${n}`, refreshToken: `rt-SYNTHETIC_FIXTURE-${n}`, expiresAt: 2_000_000_000_000, scopes: ["user:inference"] } });
const claudeJson = (uuid: string) => JSON.stringify({ oauthAccount: { accountUuid: uuid } });

/** In-memory stand-in for the gateway store: same compare-and-swap rules. */
class FakeStore {
  rows = new Map<string, HomeFileRow>();
  puts: Array<{ path: string; expectedVersion: number | null | undefined; account: string | null; kind: HomeFileKind }> = [];
  failPuts = false;
  private version = 0;
  async list(): Promise<HomeFileMeta[]> {
    return [...this.rows.values()].map(({ content: _c, ...meta }) => meta);
  }
  async get(paths: string[]): Promise<HomeFileRow[]> {
    return paths.flatMap((p) => (this.rows.has(p) ? [this.rows.get(p)!] : []));
  }
  async put(path: string, content: Buffer, opts: { account: string | null; kind: HomeFileKind; expectedVersion?: number | null }): Promise<PutResult> {
    if (this.failPuts) throw new Error("store unreachable");
    this.puts.push({ path, expectedVersion: opts.expectedVersion, account: opts.account, kind: opts.kind });
    const cur = this.rows.get(path);
    if ((opts.expectedVersion === null && cur) || (typeof opts.expectedVersion === "number" && cur?.version !== opts.expectedVersion)) return { ok: false };
    this.version += 1;
    this.rows.set(path, { path, account: opts.account, kind: opts.kind, sha256: sha256Hex(content), version: this.version, content });
    return { ok: true, version: this.version };
  }
  async close(): Promise<void> {}
}
const asStore = (s: FakeStore): HomeStoreClient => s as unknown as HomeStoreClient;

let home: string;
let folder: string;
let routeOpts: RouteAllOptions;
let savedDir: string | undefined;
const LOGIN_ROW = ".ais/gateway-members/claude/fresh/.credentials.json";
const RECORD_ROW = ".ais/gateway-members/claude/fresh/.claude.json";

async function registry(pool: boolean): Promise<void> {
  const identities: unknown[] = [{ name: "fresh", label: "fresh", configDir: folder }];
  if (pool) identities.push({ name: "pool", label: "pool", configDir: join(home, ".claude", "identities", "pool"), swapPool: { accounts: ["fresh"] } });
  await writeFile(join(home, ".claude", "identities.json"), JSON.stringify({ version: 1, identities }));
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ais-first-login-"));
  savedDir = process.env.AIS_GATEWAY_MEMBERS_DIR;
  process.env.AIS_GATEWAY_MEMBERS_DIR = join(home, ".ais", "gateway-members");
  folder = join(home, ".claude", "identities", "fresh");
  await mkdir(folder, { recursive: true });
  await mkdir(join(home, "proc"), { recursive: true });
  await registry(true);
  await writeFile(join(home, "secrets"), `AIS_GATEWAY_APP_AGENTS_CLAUDE_TOKEN=${CLAUDE_KEY}\n`);
  // what `claude auth login` leaves in a brand new folder
  await writeFile(join(folder, ".credentials.json"), claudeLogin("new"));
  await writeFile(join(folder, ".claude.json"), claudeJson("uuid-new"));
  routeOpts = {
    registries: { codex: join(home, "none-c.json"), claude: join(home, ".claude", "identities.json"), grok: join(home, "none-g.json"), kimi: join(home, "none-k.json"), pi: join(home, "none-p.json") },
    secretsPath: join(home, "secrets"),
    memberRoot: join(home, ".ais", "gateway-members"),
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

describe("first sign-in of a new gateway-managed identity", () => {
  test("a swap-pool member: both rows go to the store with expectedVersion null and the folder gets the gateway entry", async () => {
    const store = new FakeStore();
    const result = await adoptLoginIntoGateway("claude", "fresh", folder, routeOpts, undefined, { store: asStore(store) });
    expect(result?.outcome).toBe("adopted");
    expect(store.puts.map((p) => [p.path, p.expectedVersion, p.account, p.kind])).toEqual([
      [RECORD_ROW, null, "claude/fresh", "login"],
      [LOGIN_ROW, null, "claude/fresh", "login"],
    ]);
    expect(store.rows.get(LOGIN_ROW)?.content.toString("utf8")).toBe(claudeLogin("new"));
    expect(store.rows.get(RECORD_ROW)?.content.toString("utf8")).toBe(claudeJson("uuid-new"));
    expect(classifyLogin("claude", await readFile(join(folder, ".credentials.json"), "utf8"))).toBe("gateway");
    // The member copy equals the store rows and stays: on a host the member root is the sync mirror of those rows, and
    // deleting its files left the console without the account record (email) until the sync daemon restarted.
    const dir = memberDir("claude", "fresh", routeOpts.memberRoot);
    expect(await readFile(join(dir, ".credentials.json"), "utf8")).toBe(claudeLogin("new"));
    expect(await readFile(join(dir, ".claude.json"), "utf8")).toBe(claudeJson("uuid-new"));
  });

  test("a folder that held a gateway entry before the sign-in is managed without a pool, using that key", async () => {
    await registry(false);
    const store = new FakeStore();
    const opts = { ...routeOpts, secretsPath: join(home, "no-secrets") };
    const result = await adoptLoginIntoGateway("claude", "fresh", folder, opts, CLAUDE_KEY, { store: asStore(store) });
    expect(result?.outcome).toBe("adopted");
    expect(store.rows.has(LOGIN_ROW)).toBe(true);
    expect(classifyLogin("claude", await readFile(join(folder, ".credentials.json"), "utf8"))).toBe("gateway");
  });

  test("an identity the gateway does not manage keeps its login: nothing is pushed", async () => {
    await registry(false);
    const store = new FakeStore();
    expect(await adoptLoginIntoGateway("claude", "fresh", folder, routeOpts, undefined, { store: asStore(store) })).toBeUndefined();
    expect(store.puts).toEqual([]);
    expect(classifyLogin("claude", await readFile(join(folder, ".credentials.json"), "utf8"))).toBe("login");
  });

  test("a failed store push is an error, and the folder keeps the login", async () => {
    const store = new FakeStore();
    store.failPuts = true;
    const result = await adoptLoginIntoGateway("claude", "fresh", folder, routeOpts, undefined, { store: asStore(store) });
    expect(result?.outcome).toBe("error");
    expect(result?.message).toContain("could not be saved to the gateway store");
    expect(classifyLogin("claude", await readFile(join(folder, ".credentials.json"), "utf8"))).toBe("login");
    expect(existsSync(memberDir("claude", "fresh", routeOpts.memberRoot))).toBe(false);
  });

  test("no store config in the process is an error too, never a silent success", async () => {
    const result = await adoptLoginIntoGateway("claude", "fresh", folder, routeOpts, undefined, { config: undefined });
    expect(result?.outcome).toBe("error");
    expect(classifyLogin("claude", await readFile(join(folder, ".credentials.json"), "utf8"))).toBe("login");
  });

  test("a missing app key leaves the login in the store but reports the entry as an error", async () => {
    const store = new FakeStore();
    const opts = { ...routeOpts, secretsPath: join(home, "no-secrets") };
    const saved = process.env.AIS_GATEWAY_APP_AGENTS_CLAUDE_TOKEN;
    delete process.env.AIS_GATEWAY_APP_AGENTS_CLAUDE_TOKEN;
    try {
      const result = await adoptLoginIntoGateway("claude", "fresh", folder, opts, undefined, { store: asStore(store) });
      expect(result?.outcome).toBe("error");
      expect(result?.message).toContain("already holds the login");
      expect(store.rows.has(LOGIN_ROW)).toBe(true);
      // the push worked, so the member copy (equal to the store rows) stays
      expect(await readFile(join(memberDir("claude", "fresh", routeOpts.memberRoot), ".claude.json"), "utf8")).toBe(claudeJson("uuid-new"));
    } finally {
      if (saved !== undefined) process.env.AIS_GATEWAY_APP_AGENTS_CLAUDE_TOKEN = saved;
    }
  });

  test("an app key held by a sibling folder is used when the pod has no secrets file", async () => {
    const sibling = join(home, ".claude", "identities", "other");
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE_KEY, scopes: [] } }));
    await writeFile(
      join(home, ".claude", "identities.json"),
      JSON.stringify({ version: 1, identities: [{ name: "fresh", label: "fresh", configDir: folder }, { name: "other", label: "other", configDir: sibling }, { name: "pool", label: "pool", configDir: join(home, "p"), swapPool: { accounts: ["fresh"] } }] }),
    );
    const store = new FakeStore();
    const saved = process.env.AIS_GATEWAY_APP_AGENTS_CLAUDE_TOKEN;
    delete process.env.AIS_GATEWAY_APP_AGENTS_CLAUDE_TOKEN;
    try {
      const result = await adoptLoginIntoGateway("claude", "fresh", folder, { ...routeOpts, secretsPath: join(home, "no-secrets") }, undefined, { store: asStore(store) });
      expect(result?.outcome).toBe("adopted");
      expect(classifyLogin("claude", await readFile(join(folder, ".credentials.json"), "utf8"))).toBe("gateway");
    } finally {
      if (saved !== undefined) process.env.AIS_GATEWAY_APP_AGENTS_CLAUDE_TOKEN = saved;
    }
  });

  test("a second sign-in updates the existing rows by compare-and-swap on their version", async () => {
    const store = new FakeStore();
    await adoptLoginIntoGateway("claude", "fresh", folder, routeOpts, undefined, { store: asStore(store) });
    await writeFile(join(folder, ".credentials.json"), claudeLogin("again"));
    await writeFile(join(folder, ".claude.json"), claudeJson("uuid-again"));
    store.puts.length = 0;
    // The member copy from the first sign-in stays, so this one takes the existing-member path: route-all pushes the owner login.
    const storePush: RouteAllOptions["storePush"] = (tool, name, root) => pushOwnerLogin(tool, name, { root, home, store: asStore(store) });
    const result = await adoptLoginIntoGateway("claude", "fresh", folder, { ...routeOpts, storePush }, CLAUDE_KEY, { store: asStore(store) });
    expect(result?.outcome).toBe("adopted");
    // the two login rows move by compare-and-swap (the replaced-login marker is a new row)
    expect(store.puts.filter((p) => p.path === LOGIN_ROW || p.path === RECORD_ROW).every((p) => typeof p.expectedVersion === "number")).toBe(true);
    expect(store.rows.get(LOGIN_ROW)?.content.toString("utf8")).toBe(claudeLogin("again"));
    expect((await readdir(folder)).some((f) => f === ".credentials.json")).toBe(true);
  }, 30_000);
});
