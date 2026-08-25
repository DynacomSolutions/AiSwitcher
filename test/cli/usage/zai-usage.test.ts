import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchZaiUsage } from "../../../src/cli/usage/zai-usage.ts";
import type { Identity } from "../../../src/identities/types.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-zai-usage-test-"));
  tempDirs.push(dir);
  return dir;
}

function identity(configDir: string): Identity {
  return { name: "identity-a", label: "Identity A", configDir };
}

async function writeProjectsJson(
  configDir: string,
  projects: Array<{ path?: string; data_dir?: string }>,
): Promise<void> {
  await mkdir(join(configDir, "data"), { recursive: true });
  await writeFile(join(configDir, "data", "projects.json"), JSON.stringify({ projects }));
}

interface SessionSeed {
  id: string;
  messageCount: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  model?: string;
  /** UNIX seconds — defaults to a fixed 1000 (same for every seeded session)
   * so pre-existing tests that don't care about dates stay unaffected. */
  createdAt?: number;
  updatedAt?: number;
}

/** Creates a real crush.db with the real `sessions` table shape (confirmed
 * live 2026-07-18 against a project this repo's own `crush` runs created) —
 * including the token/cost columns `ais resume`'s own zai-resume.ts test
 * helper doesn't need. Also creates a `messages` table and seeds one
 * provider-tagged assistant message per session, since fetchCrushUsage
 * filters sessions by provider via a JOIN on messages. */
async function makeCrushDb(dataDir: string, sessions: SessionSeed[]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "crush.db"), { create: true });
  db.run(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT,
      title TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0.0,
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
    "INSERT INTO sessions (id, title, message_count, prompt_tokens, completion_tokens, cost, updated_at, created_at) " +
      "VALUES (?, 'Session', ?, ?, ?, ?, ?, ?)",
  );
  const insertMessage = db.prepare(
    "INSERT INTO messages (id, session_id, role, provider, model, created_at, updated_at) VALUES (?, ?, 'assistant', ?, ?, ?, ?)",
  );
  for (const s of sessions) {
    insertSession.run(s.id, s.messageCount, s.promptTokens, s.completionTokens, s.cost, s.updatedAt ?? 1000, s.createdAt ?? 1000);
    insertMessage.run(`${s.id}-msg`, s.id, "zai", s.model ?? null, 1000, 1000);
  }
  db.close();
}

describe("fetchZaiUsage", () => {
  test("no projects.json at all yields undefined (identity never used crush)", async () => {
    const configDir = await makeConfigDir();
    expect(await fetchZaiUsage(identity(configDir))).toBeUndefined();
  });

  test("sums real message/token/cost totals across every session in one project's crush.db", async () => {
    const configDir = await makeConfigDir();
    const dataDir = join(configDir, "data", "project-data");
    await writeProjectsJson(configDir, [{ path: "/Users/t/Projects/A", data_dir: dataDir }]);
    await makeCrushDb(dataDir, [
      { id: "s1", messageCount: 4, promptTokens: 37946, completionTokens: 92, cost: 0.0005524 },
      { id: "s2", messageCount: 2, promptTokens: 36166, completionTokens: 926, cost: 0.0020792 },
    ]);

    const report = await fetchZaiUsage(identity(configDir));
    expect(report?.entries).toEqual([]);
    expect(report?.totalMessages).toBe(6);
    expect(report?.totalInput).toBe(74112);
    expect(report?.totalOutput).toBe(1018);
    expect(report?.totalCacheRead).toBe(0);
    expect(report?.totalCacheWrite).toBe(0);
    expect(report?.totalCost).toBeCloseTo(0.0026316);
  });

  test("aggregates across multiple project directories for the same identity", async () => {
    const configDir = await makeConfigDir();
    const dataDirA = join(configDir, "data", "project-a");
    const dataDirB = join(configDir, "data", "project-b");
    await writeProjectsJson(configDir, [
      { path: "/Users/t/Projects/A", data_dir: dataDirA },
      { path: "/Users/t/Projects/B", data_dir: dataDirB },
    ]);
    await makeCrushDb(dataDirA, [{ id: "s1", messageCount: 2, promptTokens: 1000, completionTokens: 100, cost: 0.01 }]);
    await makeCrushDb(dataDirB, [{ id: "s2", messageCount: 3, promptTokens: 2000, completionTokens: 200, cost: 0.02 }]);

    const report = await fetchZaiUsage(identity(configDir));
    expect(report?.totalMessages).toBe(5);
    expect(report?.totalInput).toBe(3000);
    expect(report?.totalOutput).toBe(300);
    expect(report?.totalCost).toBeCloseTo(0.03);
  });

  test("estimates included GLM-5.2 tokens instead of trusting Crush's historic zero cost", async () => {
    const configDir = await makeConfigDir();
    const dataDir = join(configDir, "data", "project-a");
    await writeProjectsJson(configDir, [{ path: "/Users/t/Projects/A", data_dir: dataDir }]);
    await makeCrushDb(dataDir, [{
      id: "s1",
      messageCount: 2,
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      cost: 0,
      model: "zai/glm-5.2",
    }]);

    const report = await fetchZaiUsage(identity(configDir));
    expect(report?.totalCost).toBeCloseTo(5.8);
  });

  test("a registered project with no crush.db yet is skipped, not fatal", async () => {
    const configDir = await makeConfigDir();
    const dataDirA = join(configDir, "data", "project-a");
    const dataDirB = join(configDir, "data", "project-b");
    await mkdir(dataDirB, { recursive: true }); // registered, but no crush.db written
    await writeProjectsJson(configDir, [
      { path: "/Users/t/Projects/A", data_dir: dataDirA },
      { path: "/Users/t/Projects/B", data_dir: dataDirB },
    ]);
    await makeCrushDb(dataDirA, [{ id: "s1", messageCount: 2, promptTokens: 1000, completionTokens: 100, cost: 0.01 }]);

    const report = await fetchZaiUsage(identity(configDir));
    expect(report?.totalMessages).toBe(2);
  });

  test("every registered project having no crush.db yields undefined", async () => {
    const configDir = await makeConfigDir();
    const dataDir = join(configDir, "data", "project-a");
    await mkdir(dataDir, { recursive: true });
    await writeProjectsJson(configDir, [{ path: "/Users/t/Projects/A", data_dir: dataDir }]);

    expect(await fetchZaiUsage(identity(configDir))).toBeUndefined();
  });

  test("dateSpan is the real MIN(created_at)/MAX(updated_at) across every session in one db", async () => {
    const configDir = await makeConfigDir();
    const dataDir = join(configDir, "data", "project-a");
    await writeProjectsJson(configDir, [{ path: "/Users/t/Projects/A", data_dir: dataDir }]);
    await makeCrushDb(dataDir, [
      { id: "s1", messageCount: 1, promptTokens: 10, completionTokens: 1, cost: 0, createdAt: 2_000, updatedAt: 2_500 },
      { id: "s2", messageCount: 1, promptTokens: 10, completionTokens: 1, cost: 0, createdAt: 1_000, updatedAt: 9_000 },
    ]);

    const report = await fetchZaiUsage(identity(configDir));
    expect(report?.dateSpan).toEqual({ firstMs: 1_000_000, lastMs: 9_000_000 });
  });

  test("dateSpan combines the earliest/latest across multiple project directories, not just the last one read", async () => {
    const configDir = await makeConfigDir();
    const dataDirA = join(configDir, "data", "project-a");
    const dataDirB = join(configDir, "data", "project-b");
    await writeProjectsJson(configDir, [
      { path: "/Users/t/Projects/A", data_dir: dataDirA },
      { path: "/Users/t/Projects/B", data_dir: dataDirB },
    ]);
    await makeCrushDb(dataDirA, [{ id: "s1", messageCount: 1, promptTokens: 10, completionTokens: 1, cost: 0, createdAt: 5_000, updatedAt: 5_500 }]);
    await makeCrushDb(dataDirB, [{ id: "s2", messageCount: 1, promptTokens: 10, completionTokens: 1, cost: 0, createdAt: 1_000, updatedAt: 20_000 }]);

    const report = await fetchZaiUsage(identity(configDir));
    expect(report?.dateSpan).toEqual({ firstMs: 1_000_000, lastMs: 20_000_000 });
  });

  test("duplicate projects.json entries pointing at the same data_dir don't double-count", async () => {
    const configDir = await makeConfigDir();
    const dataDir = join(configDir, "data", "project-a");
    await writeProjectsJson(configDir, [
      { path: "/Users/t/Projects/A", data_dir: dataDir },
      { path: "/Users/t/Projects/A", data_dir: dataDir },
    ]);
    await makeCrushDb(dataDir, [{ id: "s1", messageCount: 2, promptTokens: 1000, completionTokens: 100, cost: 0.01 }]);

    const report = await fetchZaiUsage(identity(configDir));
    expect(report?.totalMessages).toBe(2);
  });

  test("sessions belonging to a different provider in a shared crush.db are excluded, not double-counted", async () => {
    const configDir = await makeConfigDir();
    const dataDir = join(configDir, "data", "project-a");
    await writeProjectsJson(configDir, [{ path: "/Users/t/Projects/A", data_dir: dataDir }]);
    await makeCrushDb(dataDir, [{ id: "s1", messageCount: 2, promptTokens: 1000, completionTokens: 100, cost: 0.01 }]);
    const db = new Database(join(dataDir, "crush.db"));
    db.run("INSERT INTO sessions (id, title, message_count, prompt_tokens, completion_tokens, cost, updated_at, created_at) " +
      "VALUES ('s2', 'Session', 3, 2000, 200, 0.02, 1000, 1000)");
    db.run("INSERT INTO messages (id, session_id, role, provider, created_at, updated_at) VALUES ('s2-msg', 's2', 'assistant', 'alibaba', 1000, 1000)");
    db.close();

    const report = await fetchZaiUsage(identity(configDir));
    expect(report?.totalMessages).toBe(2);
    expect(report?.totalInput).toBe(1000);
    expect(report?.totalCost).toBeCloseTo(0.01);
  });
});
