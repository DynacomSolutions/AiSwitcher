import { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Identity } from "../../identities/types.ts";
import { truncateLabel } from "../resume/label.ts";
import { type TranscriptDto, type TranscriptTurnDto, type TreeNodeDto } from "./types.ts";
import {
  argsPreviewFrom,
  clampText,
  isInProgress,
  isoOrEpoch,
  safeJsonParse,
  windowCutoffMs,
  type TranscriptOpts,
  type WindowOpts,
} from "./shared.ts";
import { TurnCollector } from "./turn-collector.ts";

/**
 * Crush-backed session trees + normalized transcripts, shared by the two
 * crush-proxy tools (zai, ali) the same way resume/crush-resume.ts is.
 *
 * Storage: `<CRUSH_GLOBAL_DATA>/projects.json` maps project directories to
 * project-local `<data_dir>/crush.db` SQLite files (one dotdir per project,
 * shared by every identity that ran Crush in that directory — the provider
 * column on messages is what ties a session to a tool). `sessions`
 * carries `parent_session_id` (NON-NULL for sub-agent/child sessions) and
 * `message_count`; `messages.parts` is a JSON array of typed parts
 * (text / reasoning / tool_call / tool_result / binary / finish).
 *
 * Timestamps are UNIX SECONDS (crush's own "milliseconds" schema comment is
 * wrong; see crush-resume.ts's verified note).
 *
 * Tree links: parent_session_id, directly. Orphans (parent outside the
 * window) are handled by the shared dispatcher.
 *
 * Transcript normalization per message row: user text parts -> user turns;
 * assistant text parts -> assistant turns (reasoning parts skipped);
 * assistant tool_call parts -> tool turns with input as argsPreview,
 * result filled from the matching tool_result part via tool_call_id.
 */

interface ProjectsJson {
  projects?: Array<{ path?: string; data_dir?: string; last_accessed?: string }>;
}

interface SessionRow {
  id: string;
  parent_session_id: string | null;
  title: string;
  message_count: number;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  role: string;
  parts: string;
  created_at: number;
}

const QUERY_RETRY_ATTEMPTS = 3;
const QUERY_RETRY_DELAY_MS = 100;
const PLACEHOLDER_TITLE = "Untitled Session";

/** Async reachability pre-check + readonly open with a short retry: the
 * same narrow post-write open window crush-resume.ts documents (a sync
 * open on a hung network mount freezes the loop; a hanging await does
 * not). */
async function queryCrushDb<T>(dbPath: string, query: (db: Database) => T): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= QUERY_RETRY_ATTEMPTS; attempt++) {
    try {
      const probe = stat(dbPath)
        .then((info) => info.isFile())
        .catch(() => false);
      const reachable = await Promise.race([probe, Bun.sleep(3_000).then(() => false)]);
      if (!reachable) throw new Error(`crush db not reachable: ${dbPath}`);
      const db = new Database(dbPath, { readonly: true });
      try {
        return query(db);
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

function titleFromCrushTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed || trimmed === PLACEHOLDER_TITLE) return "(no summary)";
  return truncateLabel(trimmed);
}

/** The provider-scoped session query shared by the tree reader: a session
 * belongs to this tool when any of its messages carries the tool's
 * provider tag, or when NO message carries any provider tag (a just-
 * started session with no assistant reply yet) — identical ownership rule
 * to crush-resume.ts. */
const SESSIONS_SQL =
  "SELECT s.id, s.parent_session_id, s.title, s.message_count, s.created_at, s.updated_at FROM sessions s WHERE " +
  "s.updated_at >= $cutoff AND " +
  "(EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.provider = $provider) " +
  "OR NOT EXISTS (SELECT 1 FROM messages m2 WHERE m2.session_id = s.id AND m2.provider IS NOT NULL)) " +
  "ORDER BY s.updated_at DESC";

async function projectDataDirs(identity: Identity, dataSubdir: string): Promise<Array<{ dataDir: string; projectPath: string }>> {
  let projectsJson: ProjectsJson;
  try {
    projectsJson = (await Bun.file(join(identity.configDir, dataSubdir, "projects.json")).json()) as ProjectsJson;
  } catch {
    return []; // never registered a project: the common empty case
  }
  const seen = new Set<string>();
  const out: Array<{ dataDir: string; projectPath: string }> = [];
  for (const entry of projectsJson.projects ?? []) {
    if (!entry.path || !entry.data_dir || seen.has(entry.data_dir)) continue;
    seen.add(entry.data_dir);
    out.push({ dataDir: entry.data_dir, projectPath: entry.path });
  }
  return out;
}

export async function readCrushTree(
  toolName: "zai" | "ali",
  identity: Identity,
  dataSubdir: string,
  providerId: string,
  opts: WindowOpts = {},
): Promise<{ nodes: TreeNodeDto[]; error?: string }> {
  const cutoffMs = windowCutoffMs(opts);
  const cutoffS = Math.floor(cutoffMs / 1000);
  const nodes: TreeNodeDto[] = [];
  let dbError: string | undefined;
  for (const { dataDir, projectPath } of await projectDataDirs(identity, dataSubdir)) {
    const dbPath = join(dataDir, "crush.db");
    let rows: SessionRow[];
    try {
      rows = await queryCrushDb(dbPath, (db) =>
        db.query(SESSIONS_SQL).all({ $cutoff: cutoffS, $provider: providerId }) as unknown as SessionRow[],
      );
    } catch (err) {
      dbError ??= err instanceof Error ? err.message : String(err);
      continue;
    }
    for (const row of rows) {
      const updatedAtMs = row.updated_at * 1000;
      nodes.push({
        id: row.id,
        ...(row.parent_session_id ? { parentId: row.parent_session_id } : {}),
        tool: toolName,
        identity: identity.name,
        title: titleFromCrushTitle(row.title),
        cwd: projectPath,
        startedAt: new Date(row.created_at * 1000).toISOString(),
        updatedAt: isoOrEpoch(updatedAtMs),
        inProgress: isInProgress(updatedAtMs, opts),
        ...(row.message_count > 0 ? { messageCount: row.message_count } : {}),
        depth: 0, // recomputed by the tree dispatcher
      });
    }
  }
  return dbError ? { nodes, error: dbError } : { nodes };
}

/* ------------------------------- transcript ------------------------------- */

function pushCrushParts(collector: TurnCollector, row: MessageRow, atMs: number): void {
  // parts is a JSON array; safeJsonParse's object narrowing keeps unknown[]
  // usable without a second cast.
  const parsed: unknown = safeJsonParse(row.parts);
  const list = Array.isArray(parsed) ? parsed : [];
  for (const part of list) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const data = (p.data ?? {}) as Record<string, unknown>;
    if (p.type === "text" && typeof data.text === "string" && data.text.trim()) {
      if (row.role === "user" || row.role === "assistant") {
        collector.push({ role: row.role as "user" | "assistant", text: clampText(data.text), atMs });
      }
    } else if (p.type === "tool_call" && typeof data.name === "string" && row.role === "assistant") {
      const turn: TranscriptTurnDto = {
        role: "tool",
        text: "",
        toolName: data.name,
        argsPreview: argsPreviewFrom(data.input),
        atMs,
      };
      collector.push(turn);
      if (typeof data.id === "string") collector.track(data.id, turn);
    } else if (p.type === "tool_result") {
      const callId = data.tool_call_id;
      if (typeof callId === "string") {
        const content = data.content;
        collector.fill(callId, typeof content === "string" ? content : JSON.stringify(content) ?? "");
      }
    }
    // reasoning / binary / finish parts: deliberately skipped
  }
}

async function locateCrushSession(
  identity: Identity,
  dataSubdir: string,
  sessionId: string,
): Promise<{ dbPath: string; projectPath: string } | undefined> {
  for (const { dataDir, projectPath } of await projectDataDirs(identity, dataSubdir)) {
    const dbPath = join(dataDir, "crush.db");
    try {
      const row = await queryCrushDb(dbPath, (db) =>
        db.query("SELECT id FROM sessions WHERE id = $id LIMIT 1").all({ $id: sessionId }) as unknown as Array<{ id: string }>,
      );
      if (row.length > 0) return { dbPath, projectPath };
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function readCrushTranscript(
  toolName: "zai" | "ali",
  identity: Identity,
  dataSubdir: string,
  providerId: string,
  sessionId: string,
  opts: TranscriptOpts & WindowOpts = {},
): Promise<TranscriptDto | undefined> {
  const located = await locateCrushSession(identity, dataSubdir, sessionId);
  if (!located) return undefined;

  const rows = await queryCrushDb(located.dbPath, (db) => {
    const session = db
      .query("SELECT title, created_at, updated_at FROM sessions WHERE id = $id")
      .all({ $id: sessionId }) as unknown as Array<{ title: string; created_at: number; updated_at: number }>;
    const messages = db
      .query("SELECT role, parts, created_at FROM messages WHERE session_id = $id ORDER BY created_at, rowid")
      .all({ $id: sessionId }) as unknown as MessageRow[];
    return { session: session[0], messages };
  });
  if (!rows.session) return undefined;

  const collector = new TurnCollector(opts.tail);
  for (const row of rows.messages) {
    pushCrushParts(collector, row, row.created_at * 1000);
  }

  return {
    session: {
      id: sessionId,
      tool: toolName,
      identity: identity.name,
      ...(rows.session.title.trim() ? { title: titleFromCrushTitle(rows.session.title) } : {}),
      cwd: located.projectPath,
      startedAt: new Date(rows.session.created_at * 1000).toISOString(),
      updatedAt: new Date(rows.session.updated_at * 1000).toISOString(),
    },
    turns: collector.turns,
    totalTurns: collector.total,
    truncated: collector.truncated,
    inProgress: isInProgress(rows.session.updated_at * 1000, opts),
  };
}
