import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanLabel } from "./session-label.ts";

/** Where T3 Code keeps its thread projection. */
export function t3DbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.T3CODE_HOME || join(homedir(), ".t3"), "userdata", "statev2.sqlite");
}

/**
 * The title of the T3 Code thread this process runs in, or undefined. Opens the database read-only,
 * does one primary-key lookup and closes it. Any failure (no file, locked, changed schema) gives undefined.
 * `dbPath` is injectable for tests.
 */
export function t3ThreadTitle(env: NodeJS.ProcessEnv = process.env, dbPath: string = t3DbPath(env)): string | undefined {
  const threadId = env.T3CODE_THREAD_ID;
  if (!threadId) return undefined;
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    // A locked database must not hold a launch up: give up after 150 ms.
    db.exec("PRAGMA busy_timeout = 150");
    const row = db.query("SELECT title, deleted_at FROM orchestration_v2_projection_threads WHERE thread_id = ?").get(threadId) as
      | { title?: unknown; deleted_at?: unknown }
      | null;
    if (!row || row.deleted_at || typeof row.title !== "string") return undefined;
    return cleanLabel(row.title) || undefined;
  } catch {
    return undefined;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
