import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCrushSnapshotTree, mergeCrushSnapshotTree } from "../../src/sync/sqlite-merge.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-sqlite-merge-"));
  tempDirs.push(dir);
  return dir;
}

function createDb(path: string): Database {
  const db = new Database(path);
  db.run(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
    summary_message_id TEXT, todos TEXT
  )`);
  db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, parts TEXT NOT NULL DEFAULT '[]',
    model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    finished_at INTEGER, provider TEXT, is_summary_message INTEGER DEFAULT 0 NOT NULL
  )`);
  db.run(`CREATE TABLE files (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(path, session_id, version)
  )`);
  db.run(`CREATE TABLE read_files (
    session_id TEXT NOT NULL, path TEXT NOT NULL, read_at INTEGER NOT NULL,
    PRIMARY KEY(path, session_id)
  )`);
  return db;
}

function insertSession(
  db: Database,
  id: string,
  values: { messages: number; input: number; output: number; cost: number; updatedAt: number; title: string },
): void {
  db.run("INSERT INTO sessions VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 1, NULL, NULL)", [
    id,
    values.title,
    values.messages,
    values.input,
    values.output,
    values.cost,
    values.updatedAt,
  ]);
}

describe("Crush SQLite snapshots", () => {
  test("serialises a verified snapshot and merges rows by stable IDs without summing duplicates", async () => {
    const home = await makeDir();
    const rel = join("Projects", "App", ".crush", "crush.db");
    const livePath = join(home, rel);
    await mkdir(join(livePath, ".."), { recursive: true });
    const live = createDb(livePath);
    insertSession(live, "shared", { messages: 5, input: 100, output: 20, cost: 1, updatedAt: 10, title: "old" });
    live.run("INSERT INTO messages VALUES ('m1', 'shared', 'user', '[]', NULL, 1, 1, NULL, NULL, 0)");
    live.close();

    const sourceHome = await makeDir();
    const sourcePath = join(sourceHome, rel);
    await mkdir(join(sourcePath, ".."), { recursive: true });
    const source = createDb(sourcePath);
    insertSession(source, "shared", { messages: 8, input: 150, output: 30, cost: 1.5, updatedAt: 20, title: "new" });
    insertSession(source, "remote-only", { messages: 2, input: 10, output: 3, cost: 0.2, updatedAt: 5, title: "remote" });
    source.run("INSERT INTO messages VALUES ('m1', 'shared', 'user', '[1]', NULL, 1, 20, NULL, NULL, 0)");
    source.run("INSERT INTO messages VALUES ('m2', 'shared', 'assistant', '[]', 'glm', 2, 2, 2, 'zai', 0)");
    source.close();

    const snapshotRoot = join(sourceHome, "snapshot");
    const manifest = await createCrushSnapshotTree(snapshotRoot, sourceHome, [rel]);
    expect(manifest.databases).toEqual([rel]);

    expect(await mergeCrushSnapshotTree(manifest, home)).toBe(1);
    const merged = new Database(livePath, { readonly: true });
    const shared = merged.query("SELECT * FROM sessions WHERE id = 'shared'").get() as Record<string, unknown>;
    expect(shared).toMatchObject({
      title: "new",
      message_count: 8,
      prompt_tokens: 150,
      completion_tokens: 30,
      cost: 1.5,
      updated_at: 20,
    });
    expect((merged.query("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count).toBe(2);
    expect((merged.query("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count).toBe(2);
    expect((merged.query("SELECT parts FROM messages WHERE id = 'm1'").get() as { parts: string }).parts).toBe("[1]");
    expect(Object.values(merged.query("PRAGMA quick_check").get() as Record<string, unknown>)).toContain("ok");
    merged.close();
  });
});
