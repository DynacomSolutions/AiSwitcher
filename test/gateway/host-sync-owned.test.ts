import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hostSyncOnce } from "../../src/gateway/host-sync.ts";
import { sha256Hex, type HomeFileKind, type HomeFileMeta, type HomeFileRow, type PgHomeStore, type PutResult } from "../../src/gateway/home-store.ts";
import { MemoryRefreshBackend } from "../../src/gateway/refresh-guard.ts";
import { isStickyOwned, recordOwned } from "../../src/identities/gateway-owned.ts";
import { loadGatewayGuard, memberHere } from "../../src/sync/gateway-guard.ts";

// Host sync keeps the sticky ownership record (gateway-owned.ts) and never copies a gateway row into the folder of a login the
// gateway owns. A fake in-memory store stands in for the database; every value is fake.

class FakeStore {
  rows = new Map<string, HomeFileRow>();
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
    this.seed(path, content.toString(), opts.account, opts.kind);
    return { ok: true, version: this.version };
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
  const d = await mkdtemp(join(tmpdir(), "ais-host-sync-owned-"));
  dirs.push(d);
  return d;
};
const put = async (home: string, rel: string, text: string): Promise<void> => {
  await mkdir(dirname(join(home, rel)), { recursive: true });
  await writeFile(join(home, rel), text);
};
const login = (tag: string): string => JSON.stringify({ claudeAiOauth: { accessToken: `at-${tag}`, refreshToken: `rt-${tag}`, expiresAt: 2_000_000_000_000 } });
const heartbeat = (held: string[], passAt = "2026-01-01T00:00:00.000Z"): string => JSON.stringify({ version: 1, passAt, held: Object.fromEntries(held.map((k) => [k, {}])) });
const HEARTBEAT = ".ais/gateway-heartbeat.json";
const FOLDER = ".claude/identities/acme/.credentials.json";
const OTHER = ".claude/identities/plain/.credentials.json";

const sync = (home: string, store: FakeStore) => hostSyncOnce(undefined, { home, store: store as unknown as PgHomeStore, lock: new MemoryRefreshBackend(), importEntries: async () => [] });

describe("host sync and sticky ownership", () => {
  test("the heartbeat the sync pulls is recorded, even when it is stale, and a later empty heartbeat removes nothing", async () => {
    const home = await tmp();
    const store = new FakeStore();
    store.seed(HEARTBEAT, heartbeat(["claude/acme", "codex/acme"]), null, "heartbeat"); // years old: stale
    await sync(home, store);
    const owned = JSON.parse(await readFile(join(home, ".ais", "gateway-owned.json"), "utf8")) as { owned: Record<string, unknown> };
    expect(Object.keys(owned.owned).sort()).toEqual(["claude/acme", "codex/acme"]);
    store.seed(HEARTBEAT, heartbeat([], "2026-02-01T00:00:00.000Z"), null, "heartbeat");
    await sync(home, store);
    const after = JSON.parse(await readFile(join(home, ".ais", "gateway-owned.json"), "utf8")) as { owned: Record<string, unknown> };
    expect(Object.keys(after.owned).sort()).toEqual(["claude/acme", "codex/acme"]);
  });

  test("a store row for a login the gateway owns is never written into its identity folder; an unowned login is", async () => {
    const home = await tmp();
    await put(home, ".claude/identities.json", JSON.stringify({ version: 1, identities: [{ name: "acme", label: "acme", configDir: join(home, ".claude/identities/acme") }, { name: "plain", label: "plain", configDir: join(home, ".claude/identities/plain") }] }));
    await recordOwned(["claude/acme"], "2026-01-01T00:00:00.000Z", join(home, ".ais", "gateway-owned.json"));
    await put(home, FOLDER, login("folder"));
    await put(home, OTHER, login("plain-old"));
    const store = new FakeStore();
    store.seed(FOLDER, login("gateway"), "claude/acme", "login");
    store.seed(OTHER, login("plain-new"), "claude/plain", "login");
    // A first pass has no base: the folder login is the host's own and stays; the unowned folder takes the store.
    await sync(home, store);
    expect(await readFile(join(home, FOLDER), "utf8")).toContain("rt-folder");
    // A folder that does not exist yet is not filled with the gateway's grant either.
    const empty = await tmp();
    await put(empty, ".claude/identities.json", JSON.stringify({ version: 1, identities: [{ name: "acme", label: "acme", configDir: join(empty, ".claude/identities/acme") }] }));
    await recordOwned(["claude/acme"], "2026-01-01T00:00:00.000Z", join(empty, ".ais", "gateway-owned.json"));
    await sync(empty, store);
    await expect(readFile(join(empty, FOLDER), "utf8")).rejects.toThrow();
    const open = await tmp();
    await put(open, ".claude/identities.json", JSON.stringify({ version: 1, identities: [{ name: "acme", label: "acme", configDir: join(open, ".claude/identities/acme") }] }));
    await sync(open, store);
    expect(await readFile(join(open, FOLDER), "utf8")).toContain("rt-gateway"); // control: not owned, so it lands
  });

  test("the sync guard counts a recorded login as held here, so no merge puts a login in its folder", async () => {
    const home = await tmp();
    await put(home, ".claude/identities.json", JSON.stringify({ version: 1, identities: [{ name: "acme", label: "acme", configDir: join(home, ".claude/identities/acme") }] }));
    const guard = await loadGatewayGuard(home);
    const entry = guard.native.get(FOLDER)!;
    expect(memberHere(guard, entry)).toBe(false);
    await recordOwned(["claude/acme"], "2026-01-01T00:00:00.000Z", guard.ownedFile);
    expect(memberHere(guard, entry)).toBe(true);
    expect(await isStickyOwned("claude", "acme", guard.ownedFile)).toBe(true);
  });
});
