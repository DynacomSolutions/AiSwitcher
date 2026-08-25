import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

const STATE_DB_NAME = "state_5.sqlite";

interface BackfillRow {
  status: string;
  last_watermark: string | null;
  updated_at: number;
}

export type CodexBackfillRecoveryResult =
  | "not-applicable"
  | "not-running"
  | "active"
  | "unverifiable"
  | "recovered"
  | "raced";

export interface CodexBackfillRecoveryDeps {
  hasOpenDatabaseOwner(paths: string[]): Promise<boolean | undefined>;
  log(message: string): void;
}

function databasePaths(codexHome: string): string[] {
  const dbPath = join(codexHome, STATE_DB_NAME);
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`];
}

async function lsofHasOpenDatabaseOwner(paths: string[]): Promise<boolean | undefined> {
  const lsof = Bun.which("lsof") ??
    (process.platform === "darwin" && existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : undefined);
  if (!lsof) return undefined;

  const existingPaths = paths.filter(existsSync);
  if (existingPaths.length === 0) return false;

  const proc = Bun.spawn([lsof, "-t", ...existingPaths], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (stdout.trim()) return true;
  if (exitCode === 0 || exitCode === 1) return false;
  return undefined;
}

async function procfsHasOpenDatabaseOwner(paths: string[]): Promise<boolean | undefined> {
  if (process.platform !== "linux") return undefined;

  let processDirs: string[];
  try {
    processDirs = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  } catch {
    return undefined;
  }

  const targets = new Set(paths);
  for (const pid of processDirs) {
    const fdDir = join("/proc", pid, "fd");
    let fds: string[];
    try {
      fds = await readdir(fdDir);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = (await readlink(join(fdDir, fd))).replace(/ \(deleted\)$/, "");
        if (targets.has(target)) return true;
      } catch {
        // Processes and file descriptors can disappear while /proc is read.
      }
    }
  }
  return false;
}

async function defaultHasOpenDatabaseOwner(paths: string[]): Promise<boolean | undefined> {
  const lsofResult = await lsofHasOpenDatabaseOwner(paths);
  if (lsofResult !== undefined) return lsofResult;
  return await procfsHasOpenDatabaseOwner(paths);
}

const DEFAULT_DEPS: CodexBackfillRecoveryDeps = {
  hasOpenDatabaseOwner: defaultHasOpenDatabaseOwner,
  log: console.error,
};

function readBackfillRow(dbPath: string): BackfillRow | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query("SELECT status, last_watermark, updated_at FROM backfill_state WHERE id = 1")
      .get() as BackfillRow | undefined;
  } finally {
    db.close();
  }
}

/**
 * Codex 0.144.6 gives a crashed rollout-backfill worker a 15-minute lease,
 * while every replacement process gives up after 30 seconds. Recover that
 * exact orphaned state before launch without touching thread data or the
 * persisted watermark.
 *
 * An open SQLite database (including a WAL/SHM sidecar) proves a worker may
 * still be alive, so AIS leaves it alone. When no process owns the files, a
 * compare-and-swap update expires only the unchanged lease: if a worker
 * checkpoints after our read, its newer updated_at prevents the repair.
 */
export async function recoverOrphanedCodexBackfill(
  codexHome: string,
  deps: CodexBackfillRecoveryDeps = DEFAULT_DEPS,
): Promise<CodexBackfillRecoveryResult> {
  const paths = databasePaths(codexHome);
  const dbPath = paths[0]!;
  if (!existsSync(dbPath)) return "not-applicable";

  let observed: BackfillRow | undefined;
  try {
    observed = readBackfillRow(dbPath);
  } catch {
    // Older Codex schemas and genuinely damaged databases remain Codex's to
    // diagnose. This helper only repairs the known orphaned-lease state.
    return "not-applicable";
  }
  if (!observed || observed.status !== "running") return "not-running";

  let hasOwner: boolean | undefined;
  try {
    hasOwner = await deps.hasOpenDatabaseOwner(paths);
  } catch {
    hasOwner = undefined;
  }
  if (hasOwner === true) return "active";
  if (hasOwner === undefined) return "unverifiable";

  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    const update = db
      .query(
        "UPDATE backfill_state SET updated_at = 0 " +
          "WHERE id = 1 AND status = 'running' AND updated_at = ?",
      )
      .run(observed.updated_at);
    if (update.changes !== 1) return "raced";
  } catch {
    return "raced";
  } finally {
    db.close();
  }

  const checkpoint = observed.last_watermark ? ` from ${observed.last_watermark}` : "";
  deps.log(
    `codex: recovered an orphaned state DB backfill lease at ${codexHome}; resuming${checkpoint}`,
  );
  return "recovered";
}
