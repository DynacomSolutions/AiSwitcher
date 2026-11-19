import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HomeMirror, REPLACED_MARKER_FILE } from "../../src/gateway/home-mirror.ts";
import { importHome } from "../../src/gateway/home-import.ts";
import { sha256Hex, type HomeFileKind, type HomeFileMeta, type HomeFileRow, type PgHomeStore, type PutResult } from "../../src/gateway/home-store.ts";
import { recordLoginReplaced } from "../../src/gateway/login-replaced.ts";
import { pushOwnerLogin } from "../../src/gateway/owner-store-push.ts";

/** The owner's sign-in reaches the PostgreSQL store at once, and a stale grant of the replaced account never wins afterwards. */

const grant = (refresh: string, expiresAtMs: number): string => JSON.stringify({ claudeAiOauth: { accessToken: `SYNTHETIC_FIXTURE-a-${refresh}`, refreshToken: `SYNTHETIC_FIXTURE-${refresh}`, expiresAt: expiresAtMs } });
const OLD = grant("old", 2_100_000_000_000); // the replaced account's grant: later expiry than the new login
const NEW = grant("new", 2_000_000_000_000);
const MEMBER = ".ais/gateway-members/claude/alpha";
const LOGIN = `${MEMBER}/.credentials.json`;
const RECORD = `${MEMBER}/.claude.json`;
const MARKER = `${MEMBER}/${REPLACED_MARKER_FILE}`;

/** In-memory stand-in for PgHomeStore: same compare-and-swap rules, no database. */
class FakeStore {
  rows = new Map<string, HomeFileRow>();
  puts: Array<{ path: string; expectedVersion: number | null | undefined; account: string | null }> = [];
  private version = 0;
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
    this.puts.push({ path, expectedVersion: opts.expectedVersion, account: opts.account });
    const cur = this.rows.get(path);
    if ((opts.expectedVersion === null && cur) || (typeof opts.expectedVersion === "number" && cur?.version !== opts.expectedVersion)) return { ok: false };
    this.version += 1;
    this.rows.set(path, { path, account: opts.account, kind: opts.kind, sha256: sha256Hex(content), version: this.version, content });
    return { ok: true, version: this.version };
  }
  seed(path: string, text: string, kind: HomeFileKind = "login"): void {
    this.version += 1;
    this.rows.set(path, { path, account: "claude/alpha", kind, sha256: sha256Hex(text), version: this.version, content: Buffer.from(text) });
  }
  text(path: string): string | undefined {
    return this.rows.get(path)?.content.toString("utf8");
  }
}
const asStore = (s: FakeStore): PgHomeStore => s as unknown as PgHomeStore;

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "ais-owner-push-"));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function write(home: string, rel: string, text: string): Promise<void> {
  await mkdir(dirname(join(home, rel)), { recursive: true });
  await writeFile(join(home, rel), text);
}

/** A host whose member store holds the owner's new login (the old one already recorded as replaced), and a store still holding the old rows. */
async function adopted(): Promise<{ home: string; store: FakeStore; root: string }> {
  const home = await tmp();
  const root = join(home, ".ais", "gateway-members");
  const store = new FakeStore();
  store.seed(LOGIN, OLD);
  store.seed(RECORD, JSON.stringify({ oauthAccount: { accountUuid: "uuid-old" } }));
  await recordLoginReplaced("claude", "alpha", OLD, root);
  await write(home, LOGIN, NEW);
  await write(home, RECORD, JSON.stringify({ oauthAccount: { accountUuid: "uuid-new" } }));
  return { home, store, root };
}

describe("pushOwnerLogin", () => {
  test("replaces the login, account record and replaced marker rows by compare-and-swap, account key unchanged", async () => {
    const { home, store, root } = await adopted();
    const loginBefore = store.rows.get(LOGIN)!.version;
    const note = await pushOwnerLogin("claude", "alpha", { root, home, store: asStore(store) });
    expect(note).toBe("pushed 3 files to the PostgreSQL store");
    expect(store.text(LOGIN)).toBe(NEW);
    expect(JSON.parse(store.text(RECORD)!).oauthAccount.accountUuid).toBe("uuid-new");
    expect(JSON.parse(store.text(MARKER)!).fingerprints.length).toBe(1);
    const loginPut = store.puts.find((p) => p.path === LOGIN)!;
    expect(loginPut.expectedVersion).toBe(loginBefore);
    expect(store.puts.every((p) => p.account === "claude/alpha")).toBe(true);
    // The marker lands first, so the guard exists before the new login does.
    expect(store.puts[0]!.path).toBe(MARKER);
  });

  test("without a store config it says the host sync does the push, and changes nothing", async () => {
    const { home, root } = await adopted();
    const note = await pushOwnerLogin("claude", "alpha", { root, home, env: {}, secretsPath: join(home, "no-secrets") });
    expect(note).toContain("no store config");
    expect(note).toContain("host sync");
  });

  test("a store that throws gives a note, never an exception", async () => {
    const { home, root } = await adopted();
    const bad = { get: async () => { throw new Error("down"); } } as unknown as PgHomeStore;
    expect(await pushOwnerLogin("claude", "alpha", { root, home, store: bad })).toContain("could not push");
  });
});

describe("a stale grant of the replaced account never wins afterwards", () => {
  test("the import keeps the new rows even when the old login has the later expiry", async () => {
    const { home, store, root } = await adopted();
    await pushOwnerLogin("claude", "alpha", { root, home, store: asStore(store) });
    const report = await importHome(asStore(store), { home, entries: [{ abs: join(home, LOGIN), account: "claude/alpha", kind: "login", content: Buffer.from(OLD) }] });
    expect(report.skipped.some((s) => s.path === LOGIN && s.why.includes("replaced"))).toBe(true);
    expect(store.text(LOGIN)).toBe(NEW);
  });

  test("a replica that still holds the old login (no base, fresher grant) takes the new row instead of pushing the old one", async () => {
    const { home, store, root } = await adopted();
    await pushOwnerLogin("claude", "alpha", { root, home, store: asStore(store) });
    const replica = await tmp();
    await write(replica, LOGIN, OLD);
    await new HomeMirror(asStore(store), { home: replica, fileStore: true, warn: () => {} }).pullAll();
    expect(await readFile(join(replica, LOGIN), "utf8")).toBe(NEW);
    expect(store.text(LOGIN)).toBe(NEW);
  });
});
