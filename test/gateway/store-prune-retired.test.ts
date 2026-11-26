import { describe, expect, test } from "bun:test";
import { sha256Hex, type HomeFileKind, type HomeFileMeta, type HomeFileRow, type PgHomeStore } from "../../src/gateway/home-store.ts";
import { PruneRefused, pruneRetiredIdentities } from "../../src/gateway/store-prune.ts";

// Every name and value is fake.

class FakeStore {
  rows = new Map<string, HomeFileRow>();
  deletes: string[] = [];
  /** Bumps this path's version right after list, so the delete sees a moved row. */
  moveAfterList: string | undefined;
  private version = 0;
  seed(path: string, text: string, kind: HomeFileKind = "login"): void {
    const content = Buffer.from(text);
    this.rows.set(path, { path, account: null, kind, sha256: sha256Hex(content), version: ++this.version, content });
  }
  async list(): Promise<HomeFileMeta[]> {
    const metas = [...this.rows.values()].map(({ content: _c, ...meta }) => meta);
    if (this.moveAfterList) this.seed(this.moveAfterList, "moved");
    return metas;
  }
  async get(paths: string[]): Promise<HomeFileRow[]> {
    return paths.flatMap((p) => (this.rows.has(p) ? [this.rows.get(p)!] : []));
  }
  async delete(path: string, expectedVersion: number): Promise<boolean> {
    this.deletes.push(path);
    if (this.rows.get(path)?.version !== expectedVersion) return false;
    return this.rows.delete(path);
  }
}
const asStore = (s: FakeStore) => s as unknown as PgHomeStore;

const REG = ".opencode/identities.json";
const F = (n: string, f = "auth.json"): string => `.opencode/identities/${n}/${f}`;
const registry = (ids: unknown[], deleted?: unknown[]): string => JSON.stringify({ version: 1, identities: ids, ...(deleted ? { deleted } : {}) });
const noPins = async (): Promise<Map<string, ReadonlySet<string>>> => new Map();
/** Active pins: name -> providers of the apps that pin it. */
const pins = (o: Record<string, string[]>) => async (): Promise<Map<string, ReadonlySet<string>>> => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));

function fixture(ids: unknown[], deleted?: unknown[]): FakeStore {
  const s = new FakeStore();
  s.seed(REG, registry(ids, deleted), "registry" as HomeFileKind);
  return s;
}
const keys = (s: FakeStore): string[] => [...s.rows.keys()].sort();

describe("store prune --retired", () => {
  test("a tombstoned name is removed, every file below it", async () => {
    const s = fixture([{ name: "live" }], [{ name: "gone", at: 5 }]);
    s.seed(F("gone"), "x");
    s.seed(F("gone", "sub/other.json"), "x");
    s.seed(F("live"), "x");
    const r = await pruneRetiredIdentities(asStore(s), { tool: "opencode", activePins: noPins });
    expect(r.removed.sort()).toEqual([F("gone"), F("gone", "sub/other.json")].sort());
    expect(keys(s)).toEqual([REG, F("live")].sort());
  });

  test("an unlisted name is removed, and rows of other tools stay", async () => {
    const s = fixture([{ name: "live" }]);
    s.seed(F("ghost"), "x");
    s.seed(".grok/identities/ghost/auth.json", "x");
    const r = await pruneRetiredIdentities(asStore(s), { tool: "opencode", activePins: noPins });
    expect(r.removed).toEqual([F("ghost")]);
    expect(s.rows.has(".grok/identities/ghost/auth.json")).toBe(true);
  });

  test("a listed name is kept, also with an older tombstone, but removed when the tombstone covers it", async () => {
    const s = fixture([{ name: "newer", addedAt: 10 }, { name: "older", addedAt: 1 }], [{ name: "newer", at: 5 }, { name: "older", at: 5 }]);
    s.seed(F("newer"), "x");
    s.seed(F("older"), "x");
    const r = await pruneRetiredIdentities(asStore(s), { tool: "opencode", activePins: noPins });
    expect(r.removed).toEqual([F("older")]);
    expect(r.kept).toEqual([{ path: F("newer"), why: "the registry still lists this identity" }]);
  });

  test("an active pinned name is kept", async () => {
    const s = fixture([{ name: "live" }], ["pinned", "free"]);
    s.seed(F("pinned"), "x");
    s.seed(F("free"), "x");
    const r = await pruneRetiredIdentities(asStore(s), { tool: "opencode", activePins: pins({ pinned: ["opencode"] }) });
    expect(r.removed).toEqual([F("free")]);
    expect(r.kept).toEqual([{ path: F("pinned"), why: "an active opencode gateway app pins it" }]);
  });

  test("a name pinned only by an active app of another provider is removed", async () => {
    const s = fixture([{ name: "live" }], ["other"]);
    s.seed(F("other"), "x");
    const r = await pruneRetiredIdentities(asStore(s), { tool: "opencode", activePins: pins({ other: ["claude", "codex"] }) });
    expect(r.removed).toEqual([F("other")]);
    expect(s.rows.has(F("other"))).toBe(false);
  });

  test("a name pinned by apps of several providers is kept when one has the tool's provider", async () => {
    const s = fixture([{ name: "live" }], ["both"]);
    s.seed(F("both"), "x");
    const r = await pruneRetiredIdentities(asStore(s), { tool: "opencode", activePins: pins({ both: ["claude", "opencode"] }) });
    expect(r.removed).toEqual([]);
    expect(r.kept).toEqual([{ path: F("both"), why: "an active opencode gateway app pins it" }]);
  });

  test("the kimi-code tool is kept by a kimi pin and not by a claude pin", async () => {
    const s = new FakeStore();
    s.seed(".kimi-code/identities.json", registry([{ name: "live" }], ["a", "b"]), "registry" as HomeFileKind);
    s.seed(".kimi-code/identities/a/auth.json", "x");
    s.seed(".kimi-code/identities/b/auth.json", "x");
    const r = await pruneRetiredIdentities(asStore(s), { tool: "kimi-code", activePins: pins({ a: ["kimi"], b: ["claude"] }) });
    expect(r.removed).toEqual([".kimi-code/identities/b/auth.json"]);
    expect(r.kept).toEqual([{ path: ".kimi-code/identities/a/auth.json", why: "an active kimi gateway app pins it" }]);
  });

  test("an unmapped tool keeps a name with any active pin, and says so", async () => {
    const s = new FakeStore();
    s.seed(".newtool/identities.json", registry([{ name: "live" }], ["a", "free"]), "registry" as HomeFileKind);
    s.seed(".newtool/identities/a/auth.json", "x");
    s.seed(".newtool/identities/free/auth.json", "x");
    const r = await pruneRetiredIdentities(asStore(s), { tool: "newtool", activePins: pins({ a: ["claude"] }) });
    expect(r.removed).toEqual([".newtool/identities/free/auth.json"]);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]?.why).toContain("no known provider");
  });

  test("a prototype key is not read as a known tool", async () => {
    const s = new FakeStore();
    s.seed(".constructor/identities.json", registry([{ name: "live" }], ["a"]), "registry" as HomeFileKind);
    s.seed(".constructor/identities/a/auth.json", "x");
    const r = await pruneRetiredIdentities(asStore(s), { tool: "constructor", activePins: pins({ a: ["claude"] }) });
    expect(r.kept[0]?.why).toContain("no known provider");
  });

  test("a pool record name and a pool account are kept", async () => {
    const s = fixture([{ name: "pool1", swapPool: { accounts: ["member", "ghost-member"], active: "member" } }], ["pool1", "member", "ghost-member", "free"]);
    for (const n of ["pool1", "member", "ghost-member", "free"]) s.seed(F(n), "x");
    const r = await pruneRetiredIdentities(asStore(s), { tool: "opencode", activePins: noPins });
    expect(r.removed).toEqual([F("free")]);
    expect(r.kept.map((k) => k.path).sort()).toEqual([F("ghost-member"), F("member"), F("pool1")].filter((p) => s.rows.has(p)).sort());
    expect(keys(s)).toEqual([REG, F("ghost-member"), F("member"), F("pool1")].sort());
  });

  test("an empty registry refuses everything", async () => {
    const s = fixture([], ["a"]);
    s.seed(F("a"), "x");
    await expect(pruneRetiredIdentities(asStore(s), { tool: "opencode", activePins: noPins })).rejects.toBeInstanceOf(PruneRefused);
    expect(s.deletes).toEqual([]);
    expect(s.rows.has(F("a"))).toBe(true);
  });

  test("a missing or unparseable registry refuses everything", async () => {
    const none = new FakeStore();
    none.seed(F("a"), "x");
    await expect(pruneRetiredIdentities(asStore(none), { tool: "opencode", activePins: noPins })).rejects.toBeInstanceOf(PruneRefused);
    const bad = new FakeStore();
    bad.seed(REG, "not json");
    bad.seed(F("a"), "x");
    await expect(pruneRetiredIdentities(asStore(bad), { tool: "opencode", activePins: noPins })).rejects.toBeInstanceOf(PruneRefused);
    expect(none.deletes.concat(bad.deletes)).toEqual([]);
  });

  test("an unreadable app list refuses everything", async () => {
    const s = fixture([{ name: "live" }]);
    s.seed(F("ghost"), "x");
    await expect(pruneRetiredIdentities(asStore(s), { tool: "opencode", activePins: async () => undefined })).rejects.toBeInstanceOf(PruneRefused);
    expect(s.deletes).toEqual([]);
  });

  test("a row that moved between list and delete is kept", async () => {
    const s = fixture([{ name: "live" }]);
    s.seed(F("ghost"), "x");
    s.moveAfterList = F("ghost");
    const r = await pruneRetiredIdentities(asStore(s), { tool: "opencode", activePins: noPins });
    expect(r.removed).toEqual([]);
    expect(r.kept).toEqual([{ path: F("ghost"), why: "the row changed while it was checked" }]);
    expect(s.rows.has(F("ghost"))).toBe(true);
  });

  test("--dry-run deletes nothing but lists the candidates", async () => {
    const s = fixture([{ name: "live" }]);
    s.seed(F("ghost"), "x");
    const r = await pruneRetiredIdentities(asStore(s), { tool: "opencode", dryRun: true, activePins: noPins });
    expect(r.removed).toEqual([F("ghost")]);
    expect(s.deletes).toEqual([]);
    expect(s.rows.has(F("ghost"))).toBe(true);
  });

  test("a bad tool name is refused", async () => {
    const s = fixture([{ name: "live" }]);
    await expect(pruneRetiredIdentities(asStore(s), { tool: "../x", activePins: noPins })).rejects.toBeInstanceOf(PruneRefused);
  });
});
