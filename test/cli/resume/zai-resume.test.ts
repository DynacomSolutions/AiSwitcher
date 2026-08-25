import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readZaiSessions } from "../../../src/cli/resume/zai-resume.ts";
import type { Identity } from "../../../src/identities/types.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-zai-resume-test-"));
  tempDirs.push(dir);
  return dir;
}

function identity(configDir: string): Identity {
  return { name: "identity-a", label: "Identity A", configDir };
}

const TARGET_CWD = "/Users/t/Projects/AiProfileSwitcher";

async function writeProjectsJson(
  configDir: string,
  projects: Array<{ path: string; data_dir: string; last_accessed?: string }>,
): Promise<void> {
  await mkdir(join(configDir, "data"), { recursive: true });
  await writeFile(join(configDir, "data", "projects.json"), JSON.stringify({ projects }));
}

interface SessionSeed {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  parentSessionId?: string;
}

/** Creates a real crush.db at `dataDir/crush.db` with the minimal real
 * `sessions` table shape (confirmed live 2026-07-18 against a project this
 * repo's own `crush` runs created) and seeds it with the given rows. Also
 * creates a `messages` table and seeds one provider-tagged assistant message
 * per session, since readCrushSessions filters sessions by provider via a
 * JOIN on messages. */
async function makeCrushDb(dataDir: string, sessions: SessionSeed[]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "crush.db"), { create: true });
  db.run(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT,
      title TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      parts TEXT NOT NULL DEFAULT '[]',
      model TEXT,
      provider TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  const insertSession = db.prepare(
    "INSERT INTO sessions (id, parent_session_id, title, message_count, updated_at, created_at) VALUES (?, ?, ?, 2, ?, ?)",
  );
  const insertMessage = db.prepare(
    "INSERT INTO messages (id, session_id, role, provider, created_at, updated_at) VALUES (?, ?, 'assistant', 'zai', 1000, 1000)",
  );
  for (const s of sessions) {
    insertSession.run(s.id, s.parentSessionId ?? null, s.title, s.updatedAt, s.createdAt);
    insertMessage.run(`${s.id}-msg`, s.id);
  }
  db.close();
}

describe("readZaiSessions", () => {
  test("no projects.json at all yields an empty, error-free result", async () => {
    const configDir = await makeConfigDir();
    const result = await readZaiSessions(identity(configDir), TARGET_CWD);
    expect(result).toEqual({ toolName: "zai", identity: identity(configDir), sessions: [] });
  });

  test("a matching project's sessions are returned, newest first, with real titles as labels", async () => {
    const configDir = await makeConfigDir();
    const dataDir = join(configDir, "data", "project-data");
    await writeProjectsJson(configDir, [{ path: TARGET_CWD, data_dir: dataDir, last_accessed: "2026-07-17T17:06:15Z" }]);
    await makeCrushDb(dataDir, [
      { id: "s1", title: "Say hi in one word", createdAt: 1784309607, updatedAt: 1784309614 },
      { id: "s2", title: "One word hi", createdAt: 1784309699, updatedAt: 1784309702 },
    ]);

    const result = await readZaiSessions(identity(configDir), TARGET_CWD);
    expect(result.error).toBeUndefined();
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0]).toMatchObject({
      sessionId: "s2",
      cwd: TARGET_CWD,
      label: "One word hi",
      lastActiveAt: new Date(1784309702 * 1000).toISOString(),
    });
    expect(result.sessions[1]?.sessionId).toBe("s1");
  });

  test("the placeholder title 'Untitled Session' counts as no label", async () => {
    const configDir = await makeConfigDir();
    const dataDir = join(configDir, "data", "project-data");
    await writeProjectsJson(configDir, [{ path: TARGET_CWD, data_dir: dataDir }]);
    await makeCrushDb(dataDir, [{ id: "s1", title: "Untitled Session", createdAt: 1784300000, updatedAt: 1784300000 }]);

    const result = await readZaiSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions[0]?.label).toBe("(no summary)");
  });

  test("a sub-agent session (non-null parent_session_id) is excluded", async () => {
    const configDir = await makeConfigDir();
    const dataDir = join(configDir, "data", "project-data");
    await writeProjectsJson(configDir, [{ path: TARGET_CWD, data_dir: dataDir }]);
    await makeCrushDb(dataDir, [
      { id: "parent", title: "Top-level session", createdAt: 1784300000, updatedAt: 1784300010 },
      { id: "child", title: "Sub-agent task", createdAt: 1784300001, updatedAt: 1784300002, parentSessionId: "parent" },
    ]);

    const result = await readZaiSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.sessionId).toBe("parent");
  });

  test("a projects.json entry for a different directory is excluded", async () => {
    const configDir = await makeConfigDir();
    const dataDir = join(configDir, "data", "project-data");
    await writeProjectsJson(configDir, [{ path: "/Users/t/Projects/Other", data_dir: dataDir }]);
    await makeCrushDb(dataDir, [{ id: "s1", title: "Unrelated work", createdAt: 1784300000, updatedAt: 1784300000 }]);

    const result = await readZaiSessions(identity(configDir), TARGET_CWD);
    expect(result).toEqual({ toolName: "zai", identity: identity(configDir), sessions: [] });
  });

  test("a matching project with no crush.db yet (never actually created a session) is skipped, not an error", async () => {
    const configDir = await makeConfigDir();
    const dataDir = join(configDir, "data", "project-data");
    await mkdir(dataDir, { recursive: true }); // registered, but no crush.db written
    await writeProjectsJson(configDir, [{ path: TARGET_CWD, data_dir: dataDir }]);

    const result = await readZaiSessions(identity(configDir), TARGET_CWD);
    expect(result).toEqual({ toolName: "zai", identity: identity(configDir), sessions: [] });
  });

  test("duplicate projects.json entries pointing at the same data_dir don't duplicate sessions", async () => {
    const configDir = await makeConfigDir();
    const dataDir = join(configDir, "data", "project-data");
    await writeProjectsJson(configDir, [
      { path: TARGET_CWD, data_dir: dataDir, last_accessed: "2026-07-16T00:00:00Z" },
      { path: TARGET_CWD, data_dir: dataDir, last_accessed: "2026-07-17T00:00:00Z" },
    ]);
    await makeCrushDb(dataDir, [{ id: "s1", title: "Only once", createdAt: 1784300000, updatedAt: 1784300000 }]);

    const result = await readZaiSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions).toHaveLength(1);
  });

  test("sessions belonging to a different provider in a shared crush.db are excluded", async () => {
    const configDir = await makeConfigDir();
    const dataDir = join(configDir, "data", "project-data");
    await writeProjectsJson(configDir, [{ path: TARGET_CWD, data_dir: dataDir }]);
    await makeCrushDb(dataDir, [{ id: "s1", title: "A zai session", createdAt: 1784300000, updatedAt: 1784300000 }]);
    const db = new Database(join(dataDir, "crush.db"));
    db.run("INSERT INTO sessions (id, parent_session_id, title, message_count, updated_at, created_at) " +
      "VALUES ('s2', NULL, 'An alibaba session', 2, 1784300100, 1784300100)");
    db.run("INSERT INTO messages (id, session_id, role, provider, created_at, updated_at) VALUES ('s2-msg', 's2', 'assistant', 'alibaba', 1000, 1000)");
    db.close();

    const result = await readZaiSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.sessionId).toBe("s1");
  });

  test("a session with no provider-tagged messages yet is still listed", async () => {
    const configDir = await makeConfigDir();
    const dataDir = join(configDir, "data", "project-data");
    await writeProjectsJson(configDir, [{ path: TARGET_CWD, data_dir: dataDir }]);
    await makeCrushDb(dataDir, []);
    const db = new Database(join(dataDir, "crush.db"));
    db.run("INSERT INTO sessions (id, parent_session_id, title, message_count, updated_at, created_at) " +
      "VALUES ('s1', NULL, 'Just started', 1, 1784300000, 1784300000)");
    db.run("INSERT INTO messages (id, session_id, role, provider, created_at, updated_at) VALUES ('s1-user', 's1', 'user', NULL, 1000, 1000)");
    db.close();

    const result = await readZaiSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.sessionId).toBe("s1");
  });
});
