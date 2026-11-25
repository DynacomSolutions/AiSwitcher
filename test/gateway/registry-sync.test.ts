import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { importHome } from "../../src/gateway/home-import.ts";
import { sha256Hex, type HomeFileKind, type HomeFileMeta, type HomeFileRow, type PgHomeStore, type PutResult } from "../../src/gateway/home-store.ts";
import { hostSyncOnce, startHostSync } from "../../src/gateway/host-sync.ts";
import { MemoryRefreshBackend } from "../../src/gateway/refresh-guard.ts";
import { droppedIdentities, mergeRegistries, readRegistryBase } from "../../src/gateway/registry-sync.ts";

// A registry change made in the store (a console add) must reach the host file and never be reverted by the host sync or by the
// periodic import, also after a restart. A host-side change still reaches the store; when both sides moved, neither loses an
// identity. A fake in-memory store with the version check stands in for the database; every value is fake.

class FakeStore {
  rows = new Map<string, HomeFileRow>();
  puts: string[] = [];
  private version = 0;
  private set(path: string, text: string, account: string | null, kind: HomeFileKind): number {
    const content = Buffer.from(text);
    this.rows.set(path, { path, account, kind, sha256: sha256Hex(content), version: ++this.version, content });
    return this.version;
  }
  /** A write that is not the host's: the console, or another replica. */
  seed(path: string, text: string, account: string | null, kind: HomeFileKind): void {
    this.set(path, text, account, kind);
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
  async put(path: string, content: Buffer, opts: { account: string | null; kind: HomeFileKind; expectedVersion?: number | null }): Promise<PutResult> {
    const cur = this.rows.get(path);
    if (opts.expectedVersion === null && cur) return { ok: false };
    if (typeof opts.expectedVersion === "number" && cur?.version !== opts.expectedVersion) return { ok: false };
    this.puts.push(path);
    return { ok: true, version: this.set(path, content.toString(), opts.account, opts.kind) };
  }
  async listen(): Promise<() => Promise<void>> {
    return async () => undefined;
  }
  async close(): Promise<void> {}
  text(path: string): string {
    return this.rows.get(path)!.content.toString();
  }
}

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), "ais-registry-sync-"));
  dirs.push(d);
  return d;
};
const REG = ".claude/identities.json";
const put = async (home: string, rel: string, text: string): Promise<void> => {
  await mkdir(dirname(join(home, rel)), { recursive: true });
  await writeFile(join(home, rel), text);
};
const read = (home: string, rel: string): Promise<string> => readFile(join(home, rel), "utf8");
const ident = (name: string, extra: Record<string, unknown> = {}) => ({ name, label: name, configDir: `/profiles/u/.claude/identities/${name}`, ...extra });
const registry = (names: string[], pool: string[] = ["alpha"]): string =>
  `${JSON.stringify({ version: 1, identities: [ident("pool-main", { swapPool: { accounts: pool, active: pool[0] } }), ...names.map((n) => ident(n))] }, null, 2)}\n`;
const namesOf = (text: string): string[] => (JSON.parse(text) as { identities: Array<{ name: string }> }).identities.map((i) => i.name);
const poolOf = (text: string): string[] => (JSON.parse(text) as { identities: Array<{ name: string; swapPool?: { accounts: string[] } }> }).identities.find((i) => i.name === "pool-main")!.swapPool!.accounts;

const entries = (home: string) => async () => [{ abs: join(home, REG), account: null, kind: "registry" as const }];
const sync = (home: string, store: FakeStore) =>
  hostSyncOnce(undefined, { home, store: store as unknown as PgHomeStore, lock: new MemoryRefreshBackend(), importEntries: entries(home), warn: () => undefined });
const run = (home: string, store: FakeStore) => importHome(store as unknown as PgHomeStore, { home, lock: new MemoryRefreshBackend(), entries: [{ abs: join(home, REG), account: null, kind: "registry" }] });

/** A host and a store in step on the old registry (the state before a console add). */
async function inStep(): Promise<{ home: string; store: FakeStore }> {
  const home = await tmp();
  const store = new FakeStore();
  const old = registry(["alpha"]);
  store.seed(REG, old, null, "registry");
  await put(home, REG, old);
  await sync(home, store);
  expect(store.puts).toEqual([]);
  return { home, store };
}

describe("a registry row that moved in the store", () => {
  test("a console add reaches the host file and the sync does not revert it, also after a restart", async () => {
    const { home, store } = await inStep();
    const added = registry(["alpha", "newcomer"], ["alpha", "newcomer"]);
    store.seed(REG, added, null, "registry"); // the console add: a store write, the host file is unchanged
    const version = store.rows.get(REG)!.version;
    const r = await sync(home, store); // a fresh mirror: the restart case, no in-memory base
    expect(r.wrote).toBe(1);
    expect(r.pushed).toBe(0);
    expect(r.imported.updated).toEqual([]);
    expect(await read(home, REG)).toBe(added);
    expect(store.text(REG)).toBe(added);
    expect(store.rows.get(REG)!.version).toBe(version);
    expect(store.puts).toEqual([]);
  });

  test("the periodic import never pushes the unchanged host file over the newer row", async () => {
    const { home, store } = await inStep();
    const added = registry(["alpha", "newcomer"], ["alpha", "newcomer"]);
    store.seed(REG, added, null, "registry");
    const report = await run(home, store); // the import runs before the mirror has pulled
    expect(report.updated).toEqual([]);
    expect(report.skipped.map((s) => s.path)).toEqual([REG]);
    expect(store.text(REG)).toBe(added);
    expect(store.puts).toEqual([]);
    await sync(home, store);
    expect(await read(home, REG)).toBe(added);
  });

  test("a running sync keeps the console add: its mirror and its import both leave the row alone", async () => {
    const { home, store } = await inStep();
    const added = registry(["alpha", "newcomer"], ["alpha", "newcomer"]);
    store.seed(REG, added, null, "registry");
    const sync2 = startHostSync(undefined, { home, store: store as unknown as PgHomeStore, lock: new MemoryRefreshBackend(), importEntries: entries(home), pollMs: 20, importMs: 20, warn: () => undefined });
    try {
      await sync2.ready;
      await new Promise((r) => setTimeout(r, 300));
      expect(await read(home, REG)).toBe(added);
      expect(store.text(REG)).toBe(added);
      expect(store.puts).toEqual([]);
    } finally {
      await sync2.stop();
    }
  });

  test("the record of the last step survives in the state directory", async () => {
    const { home } = await inStep();
    expect((await readRegistryBase(home, REG))?.sha).toBe(sha256Hex(await read(home, REG)));
  });
});

describe("a registry file that moved on the host", () => {
  test("a host add reaches the store", async () => {
    const { home, store } = await inStep();
    const hostNew = registry(["alpha", "hostnew"], ["alpha", "hostnew"]);
    await put(home, REG, hostNew);
    const r = await sync(home, store);
    expect(r.imported.updated).toEqual([REG]);
    expect(store.text(REG)).toBe(hostNew);
    await sync(home, store);
    expect(store.text(REG)).toBe(hostNew);
    expect(await read(home, REG)).toBe(hostNew);
  });

  test("a host file that drops an identity is merged, never pushed: the store keeps the identity", async () => {
    const { home, store } = await inStep();
    await put(home, REG, registry([], ["alpha"]));
    await sync(home, store);
    expect(namesOf(store.text(REG))).toEqual(["pool-main", "alpha"]);
    expect(namesOf(await read(home, REG))).toEqual(["pool-main", "alpha"]);
  });

  test("a host deletion with a tombstone reaches the store, and a tombstoned store entry is dropped in a merge", async () => {
    const { home, store } = await inStep();
    const gone = `${JSON.stringify({ version: 1, identities: [ident("pool-main", { swapPool: { accounts: ["alpha"], active: "alpha" } })], deleted: [{ name: "alpha", at: 1 }] }, null, 2)}\n`;
    await put(home, REG, gone);
    await sync(home, store);
    expect(namesOf(store.text(REG))).toEqual(["pool-main"]);
    const merged = JSON.parse(mergeRegistries(gone, registry(["alpha", "extra"]))!.toString()) as { identities: Array<{ name: string }>; deleted: Array<{ name: string; at: number }> };
    expect(merged.identities.map((i) => i.name)).toEqual(["pool-main", "extra"]);
    expect(merged.deleted).toEqual([{ name: "alpha", at: 1 }]);
  });

  test("droppedIdentities: a non-registry text over a populated registry counts as dropping every name", () => {
    expect(droppedIdentities("{}", registry(["alpha"]))).toEqual(["pool-main", "alpha"]);
    expect(droppedIdentities("", registry(["alpha"]))).toEqual(["pool-main", "alpha"]);
    expect(droppedIdentities("{}", "{}")).toEqual([]);
  });

  test("a host file that is not a registry is never pushed over the store row", async () => {
    const home = await tmp();
    const store = new FakeStore();
    store.seed(REG, registry(["alpha"]), null, "registry");
    await put(home, REG, "{}");
    await sync(home, store);
    expect(store.puts).toEqual([]);
    expect(namesOf(store.text(REG))).toEqual(["pool-main", "alpha"]);
  });

  test("an empty host registry never empties the store registry", async () => {
    const { home, store } = await inStep();
    await put(home, REG, `${JSON.stringify({ version: 1, identities: [] })}\n`);
    await sync(home, store);
    expect(namesOf(store.text(REG))).toEqual(["pool-main", "alpha"]);
  });

  test("retiring an identity on the host still reaches the store", async () => {
    const { home, store } = await inStep();
    const retired = `${JSON.stringify({ version: 1, identities: [ident("pool-main", { swapPool: { accounts: ["alpha"], active: "alpha" } }), ident("alpha", { retired: true })] }, null, 2)}\n`;
    await put(home, REG, retired);
    await sync(home, store);
    expect(store.text(REG)).toBe(retired);
  });
});

describe("both sides moved", () => {
  test("neither side loses a new identity and the pool accounts are joined", async () => {
    const { home, store } = await inStep();
    store.seed(REG, registry(["alpha", "consoled"], ["alpha", "consoled"]), null, "registry");
    await put(home, REG, registry(["alpha", "hosted"], ["alpha", "hosted"]));
    await sync(home, store);
    for (const text of [store.text(REG), await read(home, REG)]) {
      expect(namesOf(text).sort()).toEqual(["alpha", "consoled", "hosted", "pool-main"]);
      expect(poolOf(text).sort()).toEqual(["alpha", "consoled", "hosted"]);
    }
    expect(store.text(REG)).toBe(await read(home, REG));
    // The merge is stable: a further pass changes nothing.
    const before = store.rows.get(REG)!.version;
    await sync(home, store);
    expect(store.rows.get(REG)!.version).toBe(before);
  });

  test("with no record (an upgrade), the host file and the newer row are merged, not replaced", async () => {
    const home = await tmp();
    const store = new FakeStore();
    store.seed(REG, registry(["alpha", "consoled"], ["alpha", "consoled"]), null, "registry");
    await put(home, REG, registry(["alpha", "hosted"], ["alpha", "hosted"]));
    const report = await run(home, store); // the import runs first, as in a sync pass
    expect(report.updated).toEqual([REG]);
    expect(namesOf(store.text(REG)).sort()).toEqual(["alpha", "consoled", "hosted", "pool-main"]);
    await sync(home, store);
    expect(await read(home, REG)).toBe(store.text(REG));
    expect(poolOf(await read(home, REG)).sort()).toEqual(["alpha", "consoled", "hosted"]);
  });

  test("with no record, a host file that holds nothing new is not pushed: the row is written to it", async () => {
    const home = await tmp();
    const store = new FakeStore();
    const added = registry(["alpha", "consoled"], ["alpha", "consoled"]);
    store.seed(REG, added, null, "registry");
    await put(home, REG, registry(["alpha"]));
    const report = await run(home, store);
    expect(report.updated).toEqual([]);
    expect(store.puts).toEqual([]);
    await sync(home, store);
    expect(await read(home, REG)).toBe(added);
    expect(store.puts).toEqual([]);
  });

  test("a host registry that is not JSON is never pushed over a populated store registry", async () => {
    const { home, store } = await inStep();
    store.seed(REG, registry(["alpha", "consoled"]), null, "registry");
    await put(home, REG, "not json");
    await sync(home, store);
    expect(namesOf(store.text(REG))).toEqual(["pool-main", "alpha", "consoled"]);
  });
});

describe("mergeRegistries", () => {
  test("the host entry wins on a name, the pool accounts are joined (host order first), other keys take the host value", () => {
    const host = JSON.stringify({ version: 1, identities: [ident("p", { label: "host label", swapPool: { accounts: ["b", "a"], active: "b" } }), ident("b"), ident("a")], extra: "host" });
    const store = JSON.stringify({ version: 1, identities: [ident("p", { label: "store label", swapPool: { accounts: ["a", "c"], active: "a" } }), ident("c")], extra: "store", chromeProfileOverrides: [] });
    const merged = JSON.parse(mergeRegistries(host, store)!.toString()) as { identities: Array<{ name: string; label: string; swapPool?: { accounts: string[]; active: string } }>; extra: string; chromeProfileOverrides: unknown[] };
    expect(merged.identities.map((i) => i.name)).toEqual(["p", "b", "a", "c"]);
    expect(merged.identities[0]!.label).toBe("host label");
    expect(merged.identities[0]!.swapPool).toEqual({ accounts: ["b", "a", "c"], active: "b" });
    expect(merged.extra).toBe("host");
    expect(merged.chromeProfileOverrides).toEqual([]);
  });

  test("a side that is not a registry gives no merge", () => {
    expect(mergeRegistries("nope", "{}")).toBeUndefined();
    expect(mergeRegistries("{}", JSON.stringify({ identities: [] }))).toBeUndefined();
  });
});

describe("ais identities delete", () => {
  test("deleteIdentity leaves a tombstone, and retire keeps the entry", async () => {
    const { deleteIdentity, retireIdentity } = await import("../../src/cli/identities/actions.ts");
    const file = JSON.parse(registry(["alpha", "beta"]));
    deleteIdentity(file, "alpha");
    expect(file.deleted?.map((t: { name: string }) => t.name)).toEqual(["alpha"]);
    expect(file.identities.map((i: { name: string }) => i.name)).toEqual(["pool-main", "beta"]);
    retireIdentity(file, "beta", new Date("2026-11-25T00:00:00Z"));
    expect(file.identities.some((i: { name: string }) => i.name === "beta")).toBe(true);
    expect(file.deleted?.map((t: { name: string }) => t.name)).toEqual(["alpha"]);
  });
});

describe("tombstones with times", () => {
  const dated = (name: string, addedAt?: number, extra: Record<string, unknown> = {}) => ({ ...ident(name, extra), ...(addedAt !== undefined ? { addedAt } : {}) });
  const regOf = (ids: unknown[], deleted?: unknown[]) => `${JSON.stringify({ version: 1, identities: ids, ...(deleted ? { deleted } : {}) }, null, 2)}\n`;
  const merge = (host: string, store: string) => JSON.parse(mergeRegistries(host, store)!.toString()) as { identities: Array<{ name: string; label: string }>; deleted?: Array<{ name: string; at: number }> };

  test("createIdentity stamps addedAt and clears the name's tombstone", async () => {
    const { createIdentity } = await import("../../src/cli/identities/actions.ts");
    const file = { version: 1 as const, identities: [], deleted: [{ name: "alpha", at: 5 }, { name: "other", at: 5 }] };
    const id = createIdentity(file, { name: "alpha", label: "alpha", configDir: "~/x/alpha" });
    expect(typeof id.addedAt).toBe("number");
    expect(file.deleted).toEqual([{ name: "other", at: 5 }]);
  });

  test("an add newer than the delete beats it, in the merge and in droppedIdentities", () => {
    const store = regOf([dated("a", 10), dated("b", 20)]);
    const host = regOf([dated("a", 10)], [{ name: "b", at: 15 }]);
    expect(merge(host, store).identities.map((i) => i.name)).toEqual(["a", "b"]);
    expect(droppedIdentities(host, store)).toEqual(["b"]);
    const older = regOf([dated("a", 10)], [{ name: "b", at: 25 }]);
    expect(merge(older, store).identities.map((i) => i.name)).toEqual(["a"]);
    expect(droppedIdentities(older, store)).toEqual([]);
  });

  test("the old name-only form still reads as a tombstone for an entry without addedAt", () => {
    const store = regOf([dated("a"), dated("b")]);
    const host = regOf([dated("a")], ["b"]);
    expect(merge(host, store).identities.map((i) => i.name)).toEqual(["a"]);
    expect(droppedIdentities(host, store)).toEqual([]);
  });

  test("a tombstone goes once the store no longer lists the name", () => {
    expect(merge(regOf([dated("a")], [{ name: "b", at: 9 }]), regOf([dated("a")])).deleted).toBeUndefined();
    expect(merge(regOf([dated("a")], [{ name: "b", at: 9 }]), regOf([dated("a"), dated("b")])).deleted).toEqual([{ name: "b", at: 9 }]);
  });

  test("a console delete beats a host with local changes, and a host re-add after it survives", () => {
    const store = regOf([dated("a"), dated("b")], [{ name: "b", at: 100 }].slice(0, 0));
    const consoleDeleted = regOf([dated("a")], [{ name: "b", at: 100 }]);
    const hostEdited = regOf([dated("a"), dated("b", undefined, { label: "edited" })]);
    expect(merge(hostEdited, consoleDeleted).identities.map((i) => i.name)).toEqual(["a"]);
    const hostReadded = regOf([dated("a"), dated("b", 200)]);
    expect(merge(hostReadded, consoleDeleted).identities.map((i) => i.name)).toEqual(["a", "b"]);
    expect(store).toContain("b");
  });

  test("a host-only tombstone applies only to names the host's base listed; any other name is a re-add", () => {
    const store = regOf([dated("a"), dated("b", 900)]);
    const host = regOf([dated("a")], [{ name: "b", at: 1000 }]);
    const out = JSON.parse(mergeRegistries(host, store, { baseNames: ["a"] })!.toString()) as { identities: Array<{ name: string }>; deleted?: unknown[] };
    expect(out.identities.map((i) => i.name)).toEqual(["a", "b"]);
    expect(out.deleted).toBeUndefined();
    const listed = JSON.parse(mergeRegistries(host, store, { baseNames: ["a", "b"] })!.toString()) as { identities: Array<{ name: string }> };
    expect(listed.identities.map((i) => i.name)).toEqual(["a"]);
  });

  test("a tombstone is kept for 90 days even when the store no longer lists the name", () => {
    const day = 86_400_000;
    const recent = merge(regOf([dated("a")], [{ name: "b", at: Date.now() - 2 * day }]), regOf([dated("a")]));
    expect(recent.deleted?.map((t) => t.name)).toEqual(["b"]);
    const old = merge(regOf([dated("a")], [{ name: "b", at: Date.now() - 100 * day }]), regOf([dated("a")]));
    expect(old.deleted).toBeUndefined();
  });

  test("mergeIdentity keeps the larger addedAt whichever side wins", async () => {
    const { mergeIdentity } = await import("../../src/sync/registry.ts");
    const a = { name: "x", label: "x", configDir: "~/x", addedAt: 10 } as never;
    const b = { name: "x", label: "x", configDir: "~/x", addedAt: 20 } as never;
    expect((mergeIdentity(a, b) as { addedAt?: number }).addedAt).toBe(20);
    expect((mergeIdentity(b, a) as { addedAt?: number }).addedAt).toBe(20);
  });

  test("an entry without addedAt that the host's base did not list is a re-add; one the base listed stays covered", () => {
    const store = regOf([dated("a")], [{ name: "b", at: 1000 }]);
    const host = regOf([dated("a"), dated("b")]);
    expect(JSON.parse(mergeRegistries(host, store, { baseNames: ["a"] })!.toString()).identities.map((i: { name: string }) => i.name)).toEqual(["a", "b"]);
    expect(JSON.parse(mergeRegistries(host, store, { baseNames: ["a", "b"] })!.toString()).identities.map((i: { name: string }) => i.name)).toEqual(["a"]);
  });

  test("markAdded stamps the time and clears the tombstone", async () => {
    const { markAdded } = await import("../../src/identities/tombstones.ts");
    const file = { identities: [{ name: "x" }], deleted: [{ name: "x", at: 1 }, { name: "y", at: 1 }] } as { identities: Array<{ name: string; addedAt?: number }>; deleted?: Array<{ name: string; at: number }> };
    markAdded(file, file.identities[0]!);
    expect(typeof file.identities[0]!.addedAt).toBe("number");
    expect(file.deleted).toEqual([{ name: "y", at: 1 }]);
  });

  test("portableIdentitiesFile and mergeRegistryConflict keep the tombstones", async () => {
    const { portableIdentitiesFile, mergeRegistryConflict } = await import("../../src/sync/registry.ts");
    const { CLAUDE_CONFIG } = await import("../../src/identities/tool-configs.ts");
    const dir0 = await tmp();
    const file = { version: 1 as const, identities: [], deleted: [{ name: "b", at: 3 }] };
    expect(portableIdentitiesFile(file, { ...CLAUDE_CONFIG, identitiesJsonPath: join(dir0, ".claude", "identities.json") }, dir0).deleted).toEqual([{ name: "b", at: 3 }]);
    const dir = await tmp();
    const live = join(dir, "live.json");
    const prev = join(dir, "prev.json");
    await writeFile(live, regOf([dated("a")], [{ name: "b", at: 3 }]));
    await writeFile(prev, regOf([dated("a"), dated("b")]));
    expect(await mergeRegistryConflict(live, prev)).toBe(true);
    const out = JSON.parse(await readFile(live, "utf8")) as { identities: Array<{ name: string }>; deleted: unknown[] };
    expect(out.identities.map((i) => i.name)).toEqual(["a"]);
    expect(out.deleted).toEqual([{ name: "b", at: 3 }]);
  });
});
