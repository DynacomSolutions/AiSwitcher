import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { normalizePath } from "../../identities/match.ts";
import type { Identity } from "../../identities/types.ts";
import { truncateLabel } from "./label.ts";
import type { ResumableSession, ToolResumeResult } from "./types.ts";
import { readSessionCwdOverrides, type SessionCwdOverrides } from "./cwd-overrides.ts";

const MAX_WALK_DEPTH = 6; // real layout is sessions/YYYY/MM/DD/ (3 levels): generous headroom, not a hard assumption

async function collectRolloutFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(full);
      }
    }
  }
  await walk(root, 0);
  return results;
}

/** Reads only up to (and including) the first newline, then releases the
 * stream: session_meta (the only line this is ever used for) is always line
 * 1, and rollout files can run into the megabytes, so this avoids reading
 * the whole file just to check a candidate's cwd. Returns undefined (rather
 * than throwing) on any read failure, matching every other per-file read in
 * this module: one unreadable/vanished rollout file (e.g. deleted or
 * archived between the directory listing and this read) is skipped, not a
 * reason to fail the whole identity's scan. */
async function readFirstLine(path: string): Promise<string | undefined> {
  // getReader() itself never touches the filesystem (Bun.file is lazy); any
  // real failure (missing/permission-denied file) only surfaces on the first
  // read() below, already inside this same try/catch.
  const reader = Bun.file(path).stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex >= 0) return buffer.slice(0, newlineIndex);
      }
      if (done) return buffer.trim() ? buffer : undefined;
    }
  } catch {
    return undefined;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Best-effort: nothing to do if the underlying resource is already gone.
    }
  }
}

interface SessionMeta {
  sessionId?: string;
  cwd?: string;
  threadSource?: string;
  hasParentThread: boolean;
}

function parseSessionMeta(firstLine: string): SessionMeta | undefined {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(firstLine);
  } catch {
    return undefined;
  }
  if (entry.type !== "session_meta") return undefined;
  const payload = entry.payload as Record<string, unknown> | undefined;
  if (!payload) return undefined;

  const id = payload.id ?? payload.session_id;
  return {
    sessionId: typeof id === "string" ? id : undefined,
    cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
    threadSource: typeof payload.thread_source === "string" ? payload.thread_source : undefined,
    hasParentThread: payload.parent_thread_id !== undefined && payload.parent_thread_id !== null,
  };
}

interface RestOfFile {
  label?: string;
  lastTimestamp?: string;
}

function parseRestOfFile(text: string): RestOfFile {
  const result: RestOfFile = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.timestamp === "string") result.lastTimestamp = entry.timestamp;

    if (result.label === undefined && entry.type === "event_msg") {
      const payload = entry.payload as Record<string, unknown> | undefined;
      if (payload?.type === "user_message" && typeof payload.message === "string" && payload.message.trim()) {
        result.label = truncateLabel(payload.message);
      }
    }
  }
  return result;
}

/**
 * Enumerates resumable Codex sessions for one identity, scoped to sessions
 * whose own recorded cwd matches `targetCwd` exactly.
 *
 * Storage: `<configDir>/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`
 * (archived sessions move to a flat `archived_sessions/`, deliberately not
 * scanned here, matching what codex's own resume/fork pickers do). Every
 * rollout file's first line is a "session_meta" event whose payload carries
 * cwd and id, cheap to peek without reading the rest of a file that can run
 * into the megabytes.
 *
 * Internal subagent threads (e.g. a safety-review "guardian" thread spawned
 * mid-session) get their OWN rollout file in the exact same directory tree,
 * with a `parent_thread_id` pointing back at the real session, so those are
 * filtered out (`hasParentThread`) regardless of `thread_source`, so they
 * don't leak into the list as if they were independently resumable. A
 * missing `thread_source` is treated as a top-level user session, not
 * excluded: confirmed empirically that roughly a third of real rollout
 * files on this machine predate codex stamping that field at all, and are
 * ordinary, resumable sessions with no `parent_thread_id` either. Only a
 * `thread_source` that's explicitly present and NOT "user" is excluded on
 * that basis.
 */
export async function readCodexSessions(
  identity: Identity,
  targetCwd: string,
  cwdOverrides?: SessionCwdOverrides,
): Promise<ToolResumeResult> {
  const base = { toolName: "codex" as const, identity };
  const sessionsRoot = join(identity.configDir, "sessions");
  const overrides = cwdOverrides ?? await readSessionCwdOverrides("codex");

  let files: string[];
  try {
    files = await collectRolloutFiles(sessionsRoot);
  } catch (err) {
    return { ...base, sessions: [], error: err instanceof Error ? err.message : String(err) };
  }

  const sessions: ResumableSession[] = [];
  for (const filePath of files) {
    const firstLine = await readFirstLine(filePath);
    if (!firstLine) continue;
    const meta = parseSessionMeta(firstLine);
    if (!meta?.sessionId || meta.cwd === undefined) continue;
    const effectiveCwd = overrides[meta.sessionId] ?? normalizePath(meta.cwd);
    if (effectiveCwd !== targetCwd) continue;
    if (meta.hasParentThread || (meta.threadSource !== undefined && meta.threadSource !== "user")) continue;

    let text: string;
    try {
      text = await Bun.file(filePath).text();
    } catch {
      continue;
    }
    const rest = parseRestOfFile(text);

    let lastActiveAt = rest.lastTimestamp;
    if (!lastActiveAt) {
      try {
        lastActiveAt = (await stat(filePath)).mtime.toISOString();
      } catch {
        lastActiveAt = new Date(0).toISOString();
      }
    }

    sessions.push({
      toolName: "codex",
      identity,
      sessionId: meta.sessionId,
      cwd: effectiveCwd,
      label: rest.label ?? "(no user message)",
      lastActiveAt,
    });
  }
  return { ...base, sessions };
}
