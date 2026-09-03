import { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { normalizePath } from "../../identities/match.ts";
import type { Identity } from "../../identities/types.ts";
import { truncateLabel } from "./label.ts";
import type { ResumableSession, ToolResumeResult } from "./types.ts";

/**
 * Shared reader behind both resume/zai-resume.ts and resume/ali-resume.ts,
 * extracted once both crush-backed tools turned out to need the identical
 * project-local `.crush/crush.db` session lookup. See zai-resume.ts's own
 * history (now just a thin wrapper around this) for the fuller discovery
 * story: Crush's own per-identity project registry,
 * `<CRUSH_GLOBAL_DATA>/projects.json` (this project sets CRUSH_GLOBAL_DATA
 * to `<configDir>/<dataSubdir>`, both zai's and ali's ToolConfig use
 * dataSubdir "data", see identities/tool-configs.ts), confirmed live
 * 2026-07-18: `{ projects: [{ path, data_dir, last_accessed }] }`, one entry
 * per project directory Crush has ever been run in FROM this identity.
 * Unlike claude/codex/grok/kimi, Crush's actual session/message data does
 * NOT live under the identity's own configDir at all: it lives in a
 * project-local `<path>/.crush/crush.db` SQLite file, the same "one dotdir
 * per project" model `.git` uses. `projects.json` is the only thing that
 * ties a project directory back to a specific identity at all (there's no
 * per-session identity marker any other way).
 */
interface ProjectsJson {
  projects?: Array<{ path?: string; data_dir?: string; last_accessed?: string }>;
}

/**
 * One row of Crush's own `sessions` table (`<data_dir>/crush.db`), confirmed
 * live 2026-07-18 via direct SQLite inspection of a real project database.
 * `created_at`/`updated_at` are UNIX SECONDS. Crush's own schema carries a
 * misleading inline SQL comment claiming milliseconds; verified this is
 * simply wrong by converting a real row's value both ways and checking
 * which produced today's actual date (seconds did; milliseconds landed in
 * 1970). `parent_session_id` is non-null for a sub-agent/child session,
 * excluded from the query below, since a user resuming a session wants a
 * top-level conversation, not an internal sub-task.
 */
interface SessionRow {
  id: string;
  title: string;
  updated_at: number;
  created_at: number;
}

const PLACEHOLDER_TITLE = "Untitled Session";

function labelFromTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed || trimmed === PLACEHOLDER_TITLE) return "(no summary)";
  return truncateLabel(trimmed);
}

const QUERY_RETRY_ATTEMPTS = 3;
const QUERY_RETRY_DELAY_MS = 100;

/** Confirmed live (2026-07-18): opening `crush.db` readonly and immediately
 * querying it can transiently fail with "unable to open database file" in a
 * brief window right after Crush itself was actively writing to the same
 * file (reproduced directly: failed once immediately after a live `crush
 * run` against the same db, succeeded consistently on every retry seconds
 * later); WAL mode is supposed to let readers proceed alongside a writer
 * without this, but empirically there's still a narrow window where it
 * doesn't. A user running `ais resume` right after finishing a real
 * crush-backed session is exactly the moment this is most likely to happen,
 * so a short retry (not a single unconditional attempt) is worth it here
 * specifically, unlike a one-shot "corrupt file" kind of failure.
 *
 * `providerId` scopes the listing to sessions whose messages belong to the
 * given provider (e.g. "zai" or "alibaba"): multiple crush-backed
 * identities can share the same project-local crush.db, and without this
 * filter each tool's resume listing would leak the other's sessions. A
 * session with NO provider-tagged messages yet (user prompt sent, no
 * assistant reply recorded) is included for every provider, since nothing
 * identifies its owner yet and hiding it would make a just-started session
 * unresumable. */
async function queryTopLevelSessions(dbPath: string, providerId: string): Promise<SessionRow[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= QUERY_RETRY_ATTEMPTS; attempt++) {
    try {
      // Async reachability pre-check: see usage/crush-usage.ts's
      // crushDbReachable comment (a sync open on a hung network mount
      // freezes Bun's whole event loop; a hanging await does not).
      const probe = stat(dbPath)
        .then((info) => info.isFile())
        .catch(() => false);
      const reachable = await Promise.race([probe, Bun.sleep(3_000).then(() => false)]);
      if (!reachable) return [];
      const db = new Database(dbPath, { readonly: true });
      try {
        return db
          .query(
            "SELECT id, title, updated_at, created_at FROM sessions s WHERE s.parent_session_id IS NULL " +
              "AND (EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.provider = $provider) " +
              "OR NOT EXISTS (SELECT 1 FROM messages m2 WHERE m2.session_id = s.id AND m2.provider IS NOT NULL)) " +
              "ORDER BY s.updated_at DESC",
          )
          .all({ $provider: providerId }) as SessionRow[];
      } finally {
        db.close();
      }
    } catch (err) {
      lastErr = err;
      if (attempt < QUERY_RETRY_ATTEMPTS) await Bun.sleep(QUERY_RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

/**
 * Enumerates resumable Crush sessions for one crush-backed identity (zai or
 * ali), scoped to sessions whose project directory (per that identity's OWN
 * `projects.json`) matches `targetCwd` exactly.
 *
 * A `projects.json` entry with no readable `crush.db` yet (the directory was
 * only ever used for something that doesn't create a session, e.g. `crush
 * dirs`/`crush models`) is skipped silently, not an error, the same
 * "identity has just never used this tool from this cwd" case every other
 * reader treats as a plain empty result. A `crush.db` that still fails to
 * open/query after retrying (see queryTopLevelSessions) surfaces as a
 * partial-failure error alongside whatever other matching projects DID read
 * successfully, same convention as kimi-resume.ts's bucketError /
 * grok-resume.ts's bucketError.
 */
export async function readCrushSessions(
  toolName: "zai" | "ali",
  identity: Identity,
  targetCwd: string,
  dataSubdir: string,
  providerId: string,
): Promise<ToolResumeResult> {
  const base = { toolName, identity };
  const projectsJsonPath = join(identity.configDir, dataSubdir, "projects.json");

  let projectsJson: ProjectsJson;
  try {
    projectsJson = (await Bun.file(projectsJsonPath).json()) as ProjectsJson;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ...base, sessions: [] };
    return { ...base, sessions: [], error: err instanceof Error ? err.message : String(err) };
  }

  // Dedupe by data_dir: a stale/duplicate projects.json entry pointing at
  // the same crush.db would otherwise double up every session in it.
  const seenDataDirs = new Set<string>();
  const matches: Array<{ dataDir: string }> = [];
  for (const entry of projectsJson.projects ?? []) {
    if (!entry.path || !entry.data_dir) continue;
    if (normalizePath(entry.path) !== targetCwd) continue;
    if (seenDataDirs.has(entry.data_dir)) continue;
    seenDataDirs.add(entry.data_dir);
    matches.push({ dataDir: entry.data_dir });
  }

  const sessions: ResumableSession[] = [];
  let dbError: string | undefined;
  for (const { dataDir } of matches) {
    const dbPath = join(dataDir, "crush.db");
    if (!(await Bun.file(dbPath).exists())) continue; // project registered, never actually created a session

    let rows: SessionRow[];
    try {
      rows = await queryTopLevelSessions(dbPath, providerId);
    } catch (err) {
      dbError ??= err instanceof Error ? err.message : String(err);
      continue;
    }

    for (const row of rows) {
      sessions.push({
        toolName,
        identity,
        sessionId: row.id,
        cwd: targetCwd,
        label: labelFromTitle(row.title),
        lastActiveAt: new Date(row.updated_at * 1000).toISOString(),
      });
    }
  }

  sessions.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  return dbError ? { ...base, sessions, error: dbError } : { ...base, sessions };
}
