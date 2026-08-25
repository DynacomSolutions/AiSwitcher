import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAliSessions } from "../../../src/cli/resume/ali-resume.ts";
import type { Identity } from "../../../src/identities/types.ts";

// ali-resume.ts is a thin wrapper around the same crush-resume.ts reader
// zai-resume.ts uses (see test/cli/resume/zai-resume.test.ts for the full
// behavior suite against the shared implementation); this file only
// confirms ali's own wiring (toolName "ali", "data" subdir) works end to
// end.
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-ali-resume-test-"));
  tempDirs.push(dir);
  return dir;
}

function identity(configDir: string): Identity {
  return { name: "identity-a", label: "Identity A", configDir };
}

const TARGET_CWD = "/Users/t/Projects/AiProfileSwitcher";

async function writeProjectsJson(
  configDir: string,
  projects: Array<{ path: string; data_dir: string }>,
): Promise<void> {
  await mkdir(join(configDir, "data"), { recursive: true });
  await writeFile(join(configDir, "data", "projects.json"), JSON.stringify({ projects }));
}

async function makeCrushDb(
  dataDir: string,
  sessions: Array<{ id: string; title: string }>,
): Promise<void> {
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
    "INSERT INTO sessions (id, title, updated_at, created_at) VALUES (?, ?, 1000, 1000)",
  );
  const insertMessage = db.prepare(
    "INSERT INTO messages (id, session_id, role, provider, created_at, updated_at) VALUES (?, ?, 'assistant', 'alibaba', 1000, 1000)",
  );
  for (const s of sessions) {
    insertSession.run(s.id, s.title);
    insertMessage.run(`${s.id}-msg`, s.id);
  }
  db.close();
}

describe("readAliSessions", () => {
  test("no projects.json at all yields an empty result, not an error", async () => {
    const configDir = await makeConfigDir();
    const result = await readAliSessions(identity(configDir), TARGET_CWD);
    expect(result.toolName).toBe("ali");
    expect(result.sessions).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  test("returns sessions for the project matching targetCwd", async () => {
    const configDir = await makeConfigDir();
    const dataDir = join(configDir, "data", "project-data");
    await writeProjectsJson(configDir, [{ path: TARGET_CWD, data_dir: dataDir }]);
    await makeCrushDb(dataDir, [{ id: "s1", title: "Fix the bug" }]);

    const result = await readAliSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.sessionId).toBe("s1");
    expect(result.sessions[0]?.toolName).toBe("ali");
    expect(result.sessions[0]?.label).toBe("Fix the bug");
  });

  test("a project registered under a different cwd is not returned", async () => {
    const configDir = await makeConfigDir();
    const dataDir = join(configDir, "data", "project-data");
    await writeProjectsJson(configDir, [{ path: "/Users/t/Projects/Other", data_dir: dataDir }]);
    await makeCrushDb(dataDir, [{ id: "s1", title: "Unrelated" }]);

    const result = await readAliSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions).toEqual([]);
  });
});
