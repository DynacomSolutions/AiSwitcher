import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizePath } from "../../identities/match.ts";
import type { Identity } from "../../identities/types.ts";
import { truncateLabel } from "./label.ts";
import type { ResumableSession, ToolResumeResult } from "./types.ts";

/** One line of kimi's own `<configDir>/session_index.jsonl` — the exact
 * index kimi's built-in `-S, --session` resume picker reads (confirmed live
 * 2026-07-17 against the real `~/.kimi-code` on this machine). All three
 * fields are required in practice, but treated as optional here so one
 * half-written line just gets skipped rather than failing the whole scan. */
interface SessionIndexEntry {
  sessionId?: string;
  sessionDir?: string;
  workDir?: string;
}

/** `<sessionDir>/state.json`, kimi's per-session metadata card. `title` is
 * "New Session" (with `isCustomTitle: false`) until kimi auto-generates or
 * the user sets a real one — the placeholder carries zero information, so it
 * is treated as "no label", not surfaced literally for what could be dozens
 * of distinct sessions all named "New Session". */
interface StateJson {
  createdAt?: string;
  updatedAt?: string;
  title?: string;
  isCustomTitle?: boolean;
  workDir?: string;
}

const PLACEHOLDER_TITLE = "New Session";

function labelFromState(state: StateJson | undefined): string {
  const title = state?.title?.trim();
  if (!title || title === PLACEHOLDER_TITLE) return "(no summary)";
  return truncateLabel(title);
}

/**
 * Enumerates resumable Kimi Code sessions for one identity, scoped to
 * sessions whose own recorded workDir matches `targetCwd` exactly.
 *
 * Storage (confirmed live 2026-07-17 against the real `~/.kimi-code` on this
 * machine): `<configDir>/session_index.jsonl`, one JSON object per line —
 * `{ sessionId: "session_<uuid>", sessionDir: "<configDir>/sessions/
 * wd_<slug>_<hash>/session_<uuid>", workDir: "/abs/cwd" }` — with each
 * sessionDir holding a `state.json` metadata card (title, createdAt,
 * updatedAt, workDir).
 *
 * This adapter reads the INDEX rather than walking `sessions/wd_<slug>_
 * <hash>/` buckets the way grok-resume.ts walks its own per-cwd buckets, and
 * that difference in shape is deliberate: kimi's bucket names are a one-way
 * slug+hash of the cwd (`wd_` + a sanitized path fragment + a hash) that
 * cannot be reversed back into the original cwd reliably, so bucket names
 * alone can't answer "which sessions belong to THIS directory". The index
 * already records each session's raw `workDir` — and it's the same file
 * kimi's own `-S, --session` resume picker reads, so it is authoritative by
 * construction rather than by reverse-engineering.
 *
 * A session whose state.json is missing or unreadable still yields an entry
 * built from the index data alone (label "(no summary)", epoch fallback
 * timestamp): the index is kimi's own source of truth for "this session
 * exists and is resumable", and a corrupted sidecar shouldn't hide it.
 */
export async function readKimiSessions(identity: Identity, targetCwd: string): Promise<ToolResumeResult> {
  const base = { toolName: "kimi" as const, identity };
  const indexPath = join(identity.configDir, "session_index.jsonl");

  let text: string;
  try {
    text = await readFile(indexPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // No index at all: this identity has simply never run kimi — the common
    // case, an empty result with NO error field, matching the other readers.
    if (code === "ENOENT") return { ...base, sessions: [] };
    return { ...base, sessions: [], error: err instanceof Error ? err.message : String(err) };
  }

  const sessions: ResumableSession[] = [];
  // Same partial-failure convention as grok-resume.ts's bucketError: a
  // state.json vanishing between the index write and this read (ENOENT) just
  // means it's gone, but anything else (permissions, I/O, corrupt JSON) is a
  // real problem that should still surface in the report even though the
  // sessions themselves are still returned from index data.
  let bucketError: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: SessionIndexEntry;
    try {
      entry = JSON.parse(line) as SessionIndexEntry;
    } catch {
      continue; // one unparseable line (truncated write, etc.) must not sink the rest
    }
    if (!entry.sessionId || !entry.sessionDir || !entry.workDir) continue;
    const sessionCwd = normalizePath(entry.workDir);
    if (sessionCwd !== targetCwd) continue;

    let state: StateJson | undefined;
    try {
      state = JSON.parse(await readFile(join(entry.sessionDir, "state.json"), "utf8")) as StateJson;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        bucketError ??= err instanceof Error ? err.message : String(err);
      }
    }

    sessions.push({
      toolName: "kimi",
      identity,
      sessionId: entry.sessionId,
      cwd: sessionCwd,
      label: labelFromState(state),
      lastActiveAt: state?.updatedAt ?? state?.createdAt ?? new Date(0).toISOString(),
    });
  }
  return bucketError ? { ...base, sessions, error: bucketError } : { ...base, sessions };
}
