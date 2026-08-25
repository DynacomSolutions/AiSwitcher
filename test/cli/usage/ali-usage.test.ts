import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchAliUsage } from "../../../src/cli/usage/ali-usage.ts";
import type { Identity } from "../../../src/identities/types.ts";

// ali-usage.ts is a thin wrapper around the same crush-usage.ts reader
// zai-usage.ts uses (see test/cli/usage/zai-usage.test.ts for the full
// aggregation-behavior suite, exercised there against the shared
// implementation); this file only confirms ali's own wiring (identity's
// "data" subdir, undefined-when-empty) works end to end, not every
// aggregation edge case a second time.
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-ali-usage-test-"));
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

async function makeCrushDb(
  dataDir: string,
  sessions: Array<{ id: string; messageCount: number; promptTokens: number; completionTokens: number; cost: number; model?: string }>,
): Promise<void> {
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
      "VALUES (?, 'Session', ?, ?, ?, ?, 1000, 1000)",
  );
  const insertMessage = db.prepare(
    "INSERT INTO messages (id, session_id, role, provider, model, created_at, updated_at) VALUES (?, ?, 'assistant', 'alibaba', ?, 1000, 1000)",
  );
  for (const s of sessions) {
    insertSession.run(s.id, s.messageCount, s.promptTokens, s.completionTokens, s.cost);
    insertMessage.run(`${s.id}-msg`, s.id, s.model ?? null);
  }
  db.close();
}

describe("fetchAliUsage", () => {
  test("no projects.json at all yields undefined (identity never used crush)", async () => {
    const configDir = await makeConfigDir();
    expect(await fetchAliUsage(identity(configDir))).toBeUndefined();
  });

  test("estimates full Token Plan usage from the identity's own data/projects.json", async () => {
    const configDir = await makeConfigDir();
    const dataDir = join(configDir, "data", "project-data");
    await writeProjectsJson(configDir, [{ path: "/Users/t/Projects/A", data_dir: dataDir }]);
    await makeCrushDb(dataDir, [{
      id: "s1",
      messageCount: 4,
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      cost: 0,
      model: "alibaba/qwen3.8-max",
    }]);

    const report = await fetchAliUsage(identity(configDir));
    expect(report?.totalMessages).toBe(4);
    expect(report?.totalInput).toBe(1_000_000);
    expect(report?.totalOutput).toBe(1_000_000);
    // Singapore's public qwen3.8-max rates are CNY 14.988 in / 44.965 out
    // per million tokens, converted by the shared public-price estimate.
    expect(report?.totalCost).toBeCloseTo((14.988 + 44.965) / 6.7682);
  });
});
