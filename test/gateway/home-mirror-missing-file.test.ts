import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HomeMirror } from "../../src/gateway/home-mirror.ts";
import { sha256Hex, type HomeFileKind, type HomeFileMeta, type HomeFileRow, type HomeStoreClient, type PutResult } from "../../src/gateway/home-store.ts";

// A file the host mirror wrote and that is later deleted locally heals on the next pass, without a daemon restart.
// A fake in-memory store stands in for the database; every value is fake.

class FakeStore {
  rows = new Map<string, HomeFileRow>();
  puts = 0;
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
  async put(path: string, content: Buffer, opts: { account: string | null; kind: HomeFileKind }): Promise<PutResult> {
    this.puts += 1;
    this.seed(path, content.toString(), opts.account, opts.kind);
    return { ok: true, version: this.version };
  }
}

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), "ais-mirror-missing-"));
  dirs.push(d);
  return d;
};

const RECORD = ".ais/gateway-members/claude/fresh/.claude.json";
const LOGIN = ".ais/gateway-members/claude/fresh/.credentials.json";
const DERIVED = ".ais/derived.json";

describe("host mirror and a deleted local file", () => {
  test("a login or meta row whose file was deleted is written again on the next pass", async () => {
    const home = await tmp();
    const store = new FakeStore();
    store.seed(RECORD, '{"oauthAccount":{"emailAddress":"a@example.test"}}', "claude/fresh", "login");
    store.seed(LOGIN, '{"claudeAiOauth":{"refreshToken":"rt-SYNTHETIC_FIXTURE"}}', "claude/fresh", "login");
    store.seed(".ais/meta.json", "{}", "claude/fresh", "meta");
    const mirror = new HomeMirror(store as unknown as HomeStoreClient, { home, fileStore: true });
    await mirror.pullAll();
    expect(existsSync(join(home, RECORD))).toBe(true);
    await rm(join(home, RECORD));
    await rm(join(home, ".ais/meta.json"));
    await mirror.pushDirty();
    expect(await readFile(join(home, RECORD), "utf8")).toBe('{"oauthAccount":{"emailAddress":"a@example.test"}}');
    expect(await readFile(join(home, ".ais/meta.json"), "utf8")).toBe("{}");
    expect(store.puts).toBe(0);
  });

  test("a deleted file is not written back when the gateway owns the login and keepHostLogin says keep", async () => {
    const home = await tmp();
    const store = new FakeStore();
    store.seed(LOGIN, '{"claudeAiOauth":{"refreshToken":"rt-SYNTHETIC_FIXTURE"}}', "claude/fresh", "login");
    let keep = false;
    const mirror = new HomeMirror(store as unknown as HomeStoreClient, { home, fileStore: true, keepHostLogin: async () => keep });
    await mirror.pullAll();
    await rm(join(home, LOGIN));
    keep = true;
    await mirror.pushDirty();
    expect(existsSync(join(home, LOGIN))).toBe(false);
  });

  test("a deleted derived file stays deleted, and a scratch mirror (no file store) does not write it back", async () => {
    const home = await tmp();
    const store = new FakeStore();
    store.seed(DERIVED, "{}", null, "derived");
    store.seed(LOGIN, '{"claudeAiOauth":{"refreshToken":"rt-SYNTHETIC_FIXTURE"}}', "claude/fresh", "login");
    const host = new HomeMirror(store as unknown as HomeStoreClient, { home, fileStore: true });
    await host.pullAll();
    await rm(join(home, LOGIN));
    await host.pushDirty();
    expect(existsSync(join(home, DERIVED))).toBe(false);
    const scratch = await tmp();
    const pod = new HomeMirror(store as unknown as HomeStoreClient, { home: scratch });
    await pod.pullAll();
    await rm(join(scratch, LOGIN));
    await pod.pushDirty();
    expect(existsSync(join(scratch, LOGIN))).toBe(false);
  });
});
