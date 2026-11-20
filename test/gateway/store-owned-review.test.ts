import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAdminApp } from "../../src/gateway/admin.ts";
import { buildRenewalReport } from "../../src/gateway/renewal.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { sha256Hex, type HomeFileKind, type HomeFileMeta, type HomeFileRow, type PgHomeStore, type PutResult } from "../../src/gateway/home-store.ts";
import { hostSyncOnce } from "../../src/gateway/host-sync.ts";
import { MemoryRefreshBackend } from "../../src/gateway/refresh-guard.ts";
import { pruneUnmanagedLogins } from "../../src/gateway/store-prune.ts";
import { createManagementCheck } from "../../src/identities/gateway-managed.ts";

// Review fixes for the credential store ownership change. Every name and value is fake.

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), "ais-store-review-"));
  dirs.push(d);
  return d;
};
const put = async (home: string, rel: string, text: string): Promise<void> => {
  await mkdir(dirname(join(home, rel)), { recursive: true });
  await writeFile(join(home, rel), text);
};
const login = (tag: string, expiresAt = 2_000_000_000_000): string => JSON.stringify({ claudeAiOauth: { accessToken: `at-${tag}`, refreshToken: `rt-${tag}`, expiresAt } });
const entry = (token: string): string => JSON.stringify({ claudeAiOauth: { accessToken: token, scopes: ["user:inference"] } });
const GATEWAY_ENTRY = entry("aisg_fixture_token_value");
const idFile = (home: string, ids: Array<{ name: string; swapPool?: { accounts: string[]; active: string }; retired?: boolean }>): string =>
  JSON.stringify({ version: 1, identities: ids.map((i) => ({ name: i.name, label: i.name, configDir: join(home, ".claude/identities", i.name), ...(i.swapPool ? { swapPool: i.swapPool } : {}), ...(i.retired ? { retired: true } : {}) })) });
const FOLDER = (n: string): string => `.claude/identities/${n}/.credentials.json`;

/** Lists the import entries in a child process whose HOME is the fixture (tool configs read HOME when they load). */
function importEntries(home: string): Array<{ kind: string; rel: string }> {
  const code = `import { collectImportEntries } from ${JSON.stringify(join(process.cwd(), "src/gateway/home-import.ts"))}; console.log(JSON.stringify((await collectImportEntries(process.env.HOME)).map((e) => ({ kind: e.kind, rel: e.abs.slice(process.env.HOME.length + 1) }))));`;
  const out = Bun.spawnSync(["bun", "-e", code], { env: { ...process.env, HOME: home, AIS_HOME: "" }, stdout: "pipe", stderr: "pipe" });
  expect(out.exitCode, out.stderr.toString()).toBe(0);
  return JSON.parse(out.stdout.toString().trim().split("\n").pop()!) as Array<{ kind: string; rel: string }>;
}

class FakeStore {
  rows = new Map<string, HomeFileRow>();
  puts: string[] = [];
  private version = 0;
  seed(path: string, text: string, account: string | null, kind: HomeFileKind): void {
    const content = Buffer.from(text);
    this.rows.set(path, { path, account, kind, sha256: sha256Hex(content), version: ++this.version, content });
  }
  async list(): Promise<HomeFileMeta[]> {
    return [...this.rows.values()].map(({ content: _c, ...meta }) => meta);
  }
  async get(paths: string[]): Promise<HomeFileRow[]> {
    return paths.flatMap((p) => (this.rows.has(p) ? [this.rows.get(p)!] : []));
  }
  async getAccount(account: string): Promise<HomeFileRow[]> {
    return [...this.rows.values()].filter((r) => r.account === account);
  }
  async put(path: string, content: Buffer, opts: { account: string | null; kind: HomeFileKind }): Promise<PutResult> {
    this.puts.push(path);
    this.seed(path, content.toString(), opts.account, opts.kind);
    return { ok: true, version: this.version };
  }
  async delete(path: string, expectedVersion: number): Promise<boolean> {
    if (this.rows.get(path)?.version !== expectedVersion) return false;
    return this.rows.delete(path);
  }
  async listen(): Promise<() => Promise<void>> {
    return async () => undefined;
  }
}
const asStore = (s: FakeStore) => s as unknown as PgHomeStore;

describe("1. a routed swap pool folder reaches the store", () => {
  test("the routed pool's gateway entry is imported, an unrouted pool's folder is not, and its members stay managed", async () => {
    const home = await tmp();
    await put(home, ".claude/identities.json", idFile(home, [{ name: "m1" }, { name: "routed", swapPool: { accounts: ["m1"], active: "m1" } }, { name: "plain-pool", swapPool: { accounts: ["ghost"], active: "ghost" } }]));
    await put(home, FOLDER("m1"), login("m1"));
    await put(home, FOLDER("routed"), GATEWAY_ENTRY);
    await put(home, FOLDER("plain-pool"), login("copy-of-m1"));
    const rels = importEntries(home).map((e) => e.rel);
    expect(rels).toContain(FOLDER("routed"));
    expect(rels).not.toContain(FOLDER("plain-pool"));
    expect(rels).toContain(FOLDER("m1")); // a member of a routed pool is managed
  });
});

describe("3. login rows go before the registries", () => {
  test("every registry entry comes after every login entry", async () => {
    const home = await tmp();
    await put(home, ".claude/identities.json", idFile(home, [{ name: "a" }, { name: "b" }]));
    await recordManaged(home, ["a", "b"]);
    await put(home, FOLDER("a"), login("a"));
    await put(home, FOLDER("b"), login("b"));
    const kinds = importEntries(home).map((e) => e.kind);
    expect(kinds).toContain("login");
    expect(kinds.indexOf("registry")).toBeGreaterThan(kinds.lastIndexOf("login"));
  });
});

async function recordManaged(home: string, names: string[]): Promise<void> {
  const { recordOwned } = await import("../../src/identities/gateway-owned.ts");
  await recordOwned(names.map((n) => `claude/${n}`), "2026-01-01T00:00:00.000Z", join(home, ".ais", "gateway-owned.json"));
}

describe("4. an unreadable registry never reads as complete or as unmanaged", () => {
  test("the management check answers undefined while the registry cannot be read, and only a good read marks a login unmanaged", async () => {
    const home = await tmp();
    const registry = join(home, "identities.json");
    const check = createManagementCheck({ ttlMs: 0, registryPath: () => registry });
    await writeFile(registry, "{ not json");
    expect(await check("claude", "stray")).toBeUndefined();
    await mkdir(join(home, "pool"), { recursive: true });
    await writeFile(join(home, "pool/.credentials.json"), GATEWAY_ENTRY);
    await writeFile(registry, JSON.stringify({ version: 1, identities: [{ name: "m1", label: "m1", configDir: join(home, "m1") }, { name: "stray", label: "stray", retired: true, configDir: join(home, "stray") }, { name: "pool", label: "pool", configDir: join(home, "pool"), swapPool: { accounts: ["m1"], active: "m1" } }] }));
    expect(await check("claude", "m1")).toBe(true);
    expect(await check("claude", "stray")).toBe(false);
    expect(await check("claude", "pool")).toBe(true);
    expect(await check("claude", "ghost")).toBe(true);
    expect(await check("zai", "anything")).toBe(true);
  });

  test("a kimi login in the kimi registry is managed, so its every-tick renewal runs; a kimi swap pool is never marked unmanaged", async () => {
    const home = await tmp();
    const registry = join(home, "kimi-identities.json");
    await writeFile(registry, JSON.stringify({ version: 1, identities: [{ name: "k1", label: "k1", configDir: join(home, "k1") }, { name: "kpool", label: "kpool", configDir: join(home, "kpool"), swapPool: { accounts: ["k1"], active: "k1" } }] }));
    const check = createManagementCheck({ ttlMs: 0, registryPath: () => registry });
    expect(await check("kimi", "k1")).toBe(true);
    expect(await check("kimi", "kpool")).toBe(true);
  });

  test("the renewal report throws when a registry read fails, so /logins/renewal answers 503", async () => {
    const accounts = async (): Promise<never> => {
      throw new Error("registry unreadable");
    };
    await expect(buildRenewalReport({ tools: ["claude"], accounts, summary: async () => [] })).rejects.toThrow();
    const ADMIN = "adm-test-value-0003-0123456789abcdef";
    const app = createAdminApp({ store: new MemoryGatewayStore(), adminToken: ADMIN, now: () => new Date(), renewal: () => buildRenewalReport({ tools: ["claude"], accounts, summary: async () => [] }) });
    const res = await app.request("/logins/renewal", { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(res.status).toBe(503);
  });
});

describe("5. pi's copy of a host-owned login", () => {
  const piFile = (tag: string, expires = 2_000_000_000_000): string => JSON.stringify({ anthropic: { type: "oauth", refresh: `rt-${tag}`, access: `at-${tag}`, expires } });
  const PI = (n: string): string => `.pi/identities/${n}/auth.json`;
  const piRegistry = (home: string, names: string[]): string => JSON.stringify({ version: 1, identities: names.map((n) => ({ name: n, label: n, configDir: join(home, ".pi/identities", n) })) });

  test("host sync never pushes pi's copy of an unmanaged claude login, and still pushes one for a managed login", async () => {
    const home = await tmp();
    await put(home, ".claude/identities.json", idFile(home, [{ name: "hostwise", retired: true }, { name: "held" }]));
    await put(home, ".pi/identities.json", piRegistry(home, ["hostwise", "held", "pi-only"]));
    await recordManaged(home, ["held"]);
    await put(home, PI("hostwise"), piFile("host"));
    await put(home, PI("held"), piFile("held"));
    await put(home, PI("pi-only"), piFile("only"));
    const store = new FakeStore();
    for (const n of ["hostwise", "held", "pi-only"]) store.seed(PI(n), piFile("stale", 1_900_000_000_000), `pi/${n}`, "login");
    await hostSyncOnce(undefined, { home, store: asStore(store), lock: new MemoryRefreshBackend(), importEntries: async () => [] });
    expect(store.rows.get(PI("hostwise"))?.content.toString()).toContain("rt-stale");
    expect(store.rows.get(PI("held"))?.content.toString()).toContain("rt-held");
    expect(store.rows.get(PI("pi-only"))?.content.toString()).toContain("rt-only"); // no claude or codex identity of that name: the host copy goes as before
  });

  test("prune removes pi's stale copy of an unmanaged login, with the same checks", async () => {
    const home = await tmp();
    await put(home, ".claude/identities.json", idFile(home, [{ name: "stale", retired: true }, { name: "held" }]));
    await put(home, ".pi/identities.json", piRegistry(home, ["stale", "held", "pi-only"]));
    await recordManaged(home, ["held"]);
    const store = new FakeStore();
    for (const n of ["stale", "held", "pi-only"]) store.seed(PI(n), piFile(n), `pi/${n}`, "login");
    const dry = await pruneUnmanagedLogins(asStore(store), { home, dryRun: true, gatewayLogins: async () => new Set() });
    expect(dry.removed).toEqual([PI("stale")]);
    const blind = await pruneUnmanagedLogins(asStore(store), { home, gatewayLogins: async () => undefined });
    expect(blind.removed).toEqual([]);
    const listed = await pruneUnmanagedLogins(asStore(store), { home, gatewayLogins: async () => new Set(["claude/stale"]) });
    expect(listed.removed).toEqual([]);
    const real = await pruneUnmanagedLogins(asStore(store), { home, gatewayLogins: async () => new Set() });
    expect(real.removed).toEqual([PI("stale")]);
    expect([...store.rows.keys()].sort()).toEqual([PI("held"), PI("pi-only")]);
  });
});
