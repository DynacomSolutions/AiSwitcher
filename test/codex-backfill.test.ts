import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recoverOrphanedCodexBackfill,
  type CodexBackfillRecoveryDeps,
} from "../src/shared/codex-backfill.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeCodexHome(
  status: "pending" | "running" | "complete",
  updatedAt = 1234,
): Promise<string> {
  const codexHome = await mkdtemp(join(tmpdir(), "ais-codex-backfill-test-"));
  tempDirs.push(codexHome);
  const db = new Database(join(codexHome, "state_5.sqlite"), { create: true });
  db.run(`
    CREATE TABLE backfill_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL,
      last_watermark TEXT,
      last_success_at INTEGER,
      updated_at INTEGER NOT NULL
    )
  `);
  db.query(
    "INSERT INTO backfill_state (id, status, last_watermark, last_success_at, updated_at) " +
      "VALUES (1, ?, 'sessions/2026/05/01/rollout.jsonl', NULL, ?)",
  ).run(status, updatedAt);
  db.close();
  return codexHome;
}

function deps(owner: boolean | undefined, logs: string[] = []): CodexBackfillRecoveryDeps {
  return {
    hasOpenDatabaseOwner: async () => owner,
    log: (message) => logs.push(message),
  };
}

function readState(codexHome: string): { status: string; last_watermark: string; updated_at: number } {
  const db = new Database(join(codexHome, "state_5.sqlite"), { readonly: true });
  try {
    return db.query("SELECT status, last_watermark, updated_at FROM backfill_state WHERE id = 1").get() as {
      status: string;
      last_watermark: string;
      updated_at: number;
    };
  } finally {
    db.close();
  }
}

describe("recoverOrphanedCodexBackfill", () => {
  test("ignores an identity with no state database", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "ais-codex-backfill-test-"));
    tempDirs.push(codexHome);
    expect(await recoverOrphanedCodexBackfill(codexHome, deps(false))).toBe("not-applicable");
  });

  test("ignores pending and completed backfills", async () => {
    for (const status of ["pending", "complete"] as const) {
      const codexHome = await makeCodexHome(status);
      let checkedOwner = false;
      const result = await recoverOrphanedCodexBackfill(codexHome, {
        hasOpenDatabaseOwner: async () => {
          checkedOwner = true;
          return false;
        },
        log: () => {},
      });
      expect(result).toBe("not-running");
      expect(checkedOwner).toBeFalse();
      expect(readState(codexHome).updated_at).toBe(1234);
    }
  });

  test("leaves a running backfill alone while a process owns its database", async () => {
    const codexHome = await makeCodexHome("running");
    expect(await recoverOrphanedCodexBackfill(codexHome, deps(true))).toBe("active");
    expect(readState(codexHome).updated_at).toBe(1234);
  });

  test("does not mutate a lease when process ownership cannot be verified", async () => {
    const codexHome = await makeCodexHome("running");
    expect(await recoverOrphanedCodexBackfill(codexHome, deps(undefined))).toBe("unverifiable");
    expect(readState(codexHome).updated_at).toBe(1234);
  });

  test("expires an orphaned lease while preserving its checkpoint", async () => {
    const codexHome = await makeCodexHome("running");
    const logs: string[] = [];
    expect(await recoverOrphanedCodexBackfill(codexHome, deps(false, logs))).toBe("recovered");
    expect(readState(codexHome)).toEqual({
      status: "running",
      last_watermark: "sessions/2026/05/01/rollout.jsonl",
      updated_at: 0,
    });
    expect(logs).toEqual([
      `codex: recovered an orphaned state DB backfill lease at ${codexHome}; ` +
        "resuming from sessions/2026/05/01/rollout.jsonl",
    ]);
  });

  test("a worker checkpoint won during the ownership check is never overwritten", async () => {
    const codexHome = await makeCodexHome("running");
    const result = await recoverOrphanedCodexBackfill(codexHome, {
      hasOpenDatabaseOwner: async () => {
        const db = new Database(join(codexHome, "state_5.sqlite"));
        db.query("UPDATE backfill_state SET updated_at = 5678 WHERE id = 1").run();
        db.close();
        return false;
      },
      log: () => {},
    });
    expect(result).toBe("raced");
    expect(readState(codexHome).updated_at).toBe(5678);
  });

  test("the real ownership probe protects an open database, then recovers it after close", async () => {
    const codexHome = await makeCodexHome("running");
    const heldOpen = new Database(join(codexHome, "state_5.sqlite"), { readonly: true });
    try {
      expect(await recoverOrphanedCodexBackfill(codexHome)).toBe("active");
      expect(readState(codexHome).updated_at).toBe(1234);
    } finally {
      heldOpen.close();
    }

    expect(await recoverOrphanedCodexBackfill(codexHome, { ...deps(false), log: () => {} })).toBe(
      "recovered",
    );
    expect(readState(codexHome).updated_at).toBe(0);
  });
});
