import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { normalizePath } from "../../identities/match.ts";
import type { Identity } from "../../identities/types.ts";
import { truncateLabel } from "./label.ts";
import type { ResumableSession, ToolResumeResult } from "./types.ts";

interface SummaryJson {
  info?: { id?: string; cwd?: string };
  session_summary?: string;
  generated_title?: string;
  created_at?: string;
  updated_at?: string;
  last_active_at?: string;
}

/** Falls back to the per-cwd-bucket prompt_history.jsonl (one line per
 * prompt ever typed in that directory, across every session there) when a
 * session has no auto-generated summary yet, matched by session_id, using
 * the first matching line's raw prompt text. */
async function firstPromptFallback(cwdBucketDir: string, sessionId: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await Bun.file(join(cwdBucketDir, "prompt_history.jsonl")).text();
  } catch {
    return undefined;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.session_id === sessionId && typeof entry.prompt === "string" && entry.prompt.trim()) {
      return entry.prompt;
    }
  }
  return undefined;
}

/**
 * Enumerates resumable Grok sessions for one identity, scoped to sessions
 * whose own recorded cwd matches `targetCwd` exactly.
 *
 * Storage: `<configDir>/sessions/<url-encoded-absolute-cwd>/<session-uuid>/`,
 * each holding a `summary.json` index card (info.cwd, session_summary,
 * timestamps) plus the full transcript and other sidecar files. The bucket
 * directory name is itself the cwd, percent-encoded, but summary.json's own
 * `info.cwd` is already the raw path, so matching reads that field directly
 * rather than trying to reverse Grok's own percent-encoding scheme. This
 * deliberately does NOT shell out to `grok sessions list --cwd`: that
 * command silently collapses to the enclosing git repository root instead of
 * matching the literal directory (confirmed live), which would surface
 * sessions from the wrong directory for anyone working in a subdirectory of
 * a git repo.
 */
export async function readGrokSessions(identity: Identity, targetCwd: string): Promise<ToolResumeResult> {
  const base = { toolName: "grok" as const, identity };
  const sessionsRoot = join(identity.configDir, "sessions");

  let cwdBucketDirs: string[];
  try {
    const entries = await readdir(sessionsRoot, { withFileTypes: true });
    cwdBucketDirs = entries.filter((e) => e.isDirectory()).map((e) => join(sessionsRoot, e.name));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ...base, sessions: [] };
    return { ...base, sessions: [], error: err instanceof Error ? err.message : String(err) };
  }

  const sessions: ResumableSession[] = [];
  // Collects the first non-ENOENT bucket-level failure rather than
  // discarding it: a bucket vanishing between the listing above and this
  // read (ENOENT) just means it's gone, but anything else (permissions,
  // I/O) is a real problem that should still show up in the report even
  // though sessions found in OTHER buckets are still returned.
  let bucketError: string | undefined;
  for (const cwdBucketDir of cwdBucketDirs) {
    let sessionEntries;
    try {
      sessionEntries = await readdir(cwdBucketDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        bucketError ??= err instanceof Error ? err.message : String(err);
      }
      continue;
    }
    for (const entry of sessionEntries) {
      if (!entry.isDirectory()) continue; // skips prompt_history.jsonl and similar sibling files
      const sessionDir = join(cwdBucketDir, entry.name);

      let summary: SummaryJson;
      try {
        summary = await Bun.file(join(sessionDir, "summary.json")).json();
      } catch {
        continue; // no summary.json: not a real session directory (or mid-write)
      }
      if (!summary.info?.cwd) continue;
      const sessionCwd = normalizePath(summary.info.cwd);
      if (sessionCwd !== targetCwd) continue;

      const sessionId = summary.info.id ?? entry.name;
      const generatedLabel = summary.session_summary?.trim() || summary.generated_title?.trim();
      const fallbackPrompt = generatedLabel ? undefined : await firstPromptFallback(cwdBucketDir, sessionId);
      const label = generatedLabel ? truncateLabel(generatedLabel) : fallbackPrompt ? truncateLabel(fallbackPrompt) : "(no summary)";

      sessions.push({
        toolName: "grok",
        identity,
        sessionId,
        cwd: sessionCwd,
        label,
        lastActiveAt: summary.last_active_at ?? summary.updated_at ?? summary.created_at ?? new Date(0).toISOString(),
      });
    }
  }
  return bucketError ? { ...base, sessions, error: bucketError } : { ...base, sessions };
}
