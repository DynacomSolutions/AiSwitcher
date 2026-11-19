import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Hex, type HomeFileKind, type HomeFileMeta, type HomeFileRow, type PgHomeStore, type PutResult } from "../../src/gateway/home-store.ts";
import { hostSyncOnce } from "../../src/gateway/host-sync.ts";
import { MemoryRefreshBackend } from "../../src/gateway/refresh-guard.ts";
import { pruneUnmanagedLogins } from "../../src/gateway/store-prune.ts";
import { recordOwned } from "../../src/identities/gateway-owned.ts";

// A host-owned claude login (an identity the gateway does not manage) never goes into the credential store, and no store row lands on
// it. A managed login still travels. An in-memory store stands in for the database; every name and value is fake.

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

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), "ais-host-login-gate-"));
  dirs.push(d);
  return d;
};
const put = async (home: string, rel: string, text: string): Promise<void> => {
  await mkdir(dirname(join(home, rel)), { recursive: true });
  await writeFile(join(home, rel), text);
};
const login = (tag: string, expiresAt = 2_000_000_000_000): string => JSON.stringify({ claudeAiOauth: { accessToken: `at-${tag}`, refreshToken: `rt-${tag}`, expiresAt } });
const registry = (home: string, names: string[]): string => JSON.stringify({ version: 1, identities: names.map((n) => ({ name: n, label: n, configDir: join(home, ".claude/identities", n) })) });
const FOLDER = (n: string): string => `.claude/identities/${n}/.credentials.json`;
const asStore = (s: FakeStore) => s as unknown as PgHomeStore;
const sync = (home: string, store: FakeStore) => hostSyncOnce(undefined, { home, store: asStore(store), lock: new MemoryRefreshBackend(), importEntries: async () => [] });

describe("host store sync keeps a host-owned login out of the store", () => {
  test("a login file that is new or that a real CLI keeps rotating is never pushed, and a stale row never lands on it", async () => {
    const home = await tmp();
    await put(home, ".claude/identities.json", registry(home, ["hostwise", "fresh"]));
    await put(home, FOLDER("hostwise"), login("host-newer", 2_100_000_000_000));
    await put(home, FOLDER("fresh"), login("fresh-host"));
    const store = new FakeStore();
    // A stale copy from an earlier sync: older than the host file, so the old rule pushed the host file over it.
    store.seed(FOLDER("hostwise"), login("stale-row", 1_900_000_000_000), "claude/hostwise", "login");
    await sync(home, store);
    expect(store.puts).toEqual([]);
    expect(store.rows.get(FOLDER("hostwise"))?.content.toString()).toContain("rt-stale-row");
    expect(store.rows.has(FOLDER("fresh"))).toBe(false);
    // The row moves past the host file (a later write elsewhere), and the CLI rotates the file again: still neither way.
    store.seed(FOLDER("hostwise"), login("row-later", 2_200_000_000_000), "claude/hostwise", "login");
    await put(home, FOLDER("hostwise"), login("host-rotated", 2_100_000_500_000));
    await sync(home, store);
    expect(await readFile(join(home, FOLDER("hostwise")), "utf8")).toContain("rt-host-rotated");
    expect(store.puts).toEqual([]);
  });

  test("a login the gateway owns on this host still travels to the store", async () => {
    const home = await tmp();
    await put(home, ".claude/identities.json", registry(home, ["held"]));
    await recordOwned(["claude/held"], "2026-01-01T00:00:00.000Z", join(home, ".ais", "gateway-owned.json"));
    await put(home, FOLDER("held"), login("host-newer", 2_100_000_000_000));
    const store = new FakeStore();
    store.seed(FOLDER("held"), login("old-row", 1_900_000_000_000), "claude/held", "login");
    await sync(home, store);
    expect(store.rows.get(FOLDER("held"))?.content.toString()).toContain("rt-host-newer");
  });
});

describe("the import leaves a host-owned login out", () => {
  test("collectImportEntries names the managed login, never an unmanaged folder login or pi's copy of it", async () => {
    const home = await tmp();
    await put(home, ".claude/identities.json", registry(home, ["plain", "held"]));
    await put(home, FOLDER("plain"), login("plain"));
    await put(home, FOLDER("held"), login("held"));
    await put(home, ".ais/gateway-members/claude/held/.credentials.json", login("held-member"));
    await put(home, ".pi/identities.json", JSON.stringify({ version: 1, identities: ["plain", "held"].map((n) => ({ name: n, label: n, configDir: join(home, ".pi/identities", n) })) }));
    const pi = (tag: string): string => JSON.stringify({ anthropic: { type: "oauth", refresh: `rt-${tag}`, access: `at-${tag}`, expires: 2_000_000_000_000 } });
    await put(home, ".pi/identities/plain/auth.json", pi("plain-pi"));
    await put(home, ".pi/identities/held/auth.json", pi("held-pi"));
    // HOME is read when the tool configs load, so the listing runs in a child process whose HOME is the fixture.
    const code = `import { collectImportEntries } from ${JSON.stringify(join(process.cwd(), "src/gateway/home-import.ts"))}; console.log(JSON.stringify((await collectImportEntries(process.env.HOME)).filter((e) => e.kind === "login").map((e) => e.abs.slice(process.env.HOME.length + 1))));`;
    const out = Bun.spawnSync(["bun", "-e", code], { env: { ...process.env, HOME: home, AIS_HOME: "" }, stdout: "pipe", stderr: "pipe" });
    expect(out.exitCode, out.stderr.toString()).toBe(0);
    const paths = JSON.parse(out.stdout.toString().trim().split("\n").pop()!) as string[];
    expect(paths.some((p) => p.includes("plain"))).toBe(false);
    expect(paths.filter((p) => p.includes("held")).length).toBeGreaterThan(0);
  });
});

describe("pruning the stale store copy of a host-owned login", () => {
  const setup = async (): Promise<{ home: string; store: FakeStore }> => {
    const home = await tmp();
    await put(home, ".claude/identities.json", registry(home, ["stale", "held", "listed"]));
    await recordOwned(["claude/held"], "2026-01-01T00:00:00.000Z", join(home, ".ais", "gateway-owned.json"));
    const store = new FakeStore();
    for (const n of ["stale", "held", "listed"]) store.seed(FOLDER(n), login(n), `claude/${n}`, "login");
    store.seed(".claude/identities.json", "{}", null, "registry");
    store.seed(".ais/gateway-members/claude/stale/.credentials.json", login("member"), "claude/stale", "login");
    return { home, store };
  };
  const gateway = (...names: string[]) => async () => new Set(names);

  test("removes only the folder login row of an identity that neither this host nor the gateway manages", async () => {
    const { home, store } = await setup();
    const r = await pruneUnmanagedLogins(asStore(store), { home, gatewayLogins: gateway("claude/listed") });
    expect(r.removed).toEqual([FOLDER("stale")]);
    expect([...store.rows.keys()].sort()).toEqual([".ais/gateway-members/claude/stale/.credentials.json", ".claude/identities.json", FOLDER("held"), FOLDER("listed")].sort());
  });

  test("a dry run removes nothing, an unreadable gateway list removes nothing, a row that moved is kept", async () => {
    const { home, store } = await setup();
    const dry = await pruneUnmanagedLogins(asStore(store), { home, dryRun: true, gatewayLogins: gateway() });
    expect(dry.removed).toContain(FOLDER("stale"));
    expect(store.rows.size).toBe(5);
    const blind = await pruneUnmanagedLogins(asStore(store), { home, gatewayLogins: async () => undefined });
    expect(blind.removed).toEqual([]);
    expect(store.rows.size).toBe(5);
    const racing = asStore({ ...store, list: () => store.list(), delete: async () => false } as unknown as FakeStore);
    const lost = await pruneUnmanagedLogins(racing, { home, gatewayLogins: gateway() });
    expect(lost.removed).toEqual([]);
    expect(lost.kept.some((k) => k.why.includes("changed"))).toBe(true);
  });
});
