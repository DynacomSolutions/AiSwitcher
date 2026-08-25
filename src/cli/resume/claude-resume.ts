import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { normalizePath } from "../../identities/match.ts";
import type { Identity } from "../../identities/types.ts";
import { truncateLabel } from "./label.ts";
import type { ResumableSession, ToolResumeResult } from "./types.ts";

/**
 * Claude Code's own project-directory naming: every character that isn't a
 * letter or digit is replaced with "-" (confirmed empirically against every
 * real project directory on this machine: slashes, dots, and spaces all
 * turn into "-", e.g. "/Users/t/Projects/r8er.co.uk" ->
 * "-Users-t-Projects-r8er-co-uk"). This is a pure forward encoding used only
 * to find the CANDIDATE directory; the authoritative check is always each
 * session's own recorded "cwd" field below, since the encoding is lossy in
 * the reverse direction (a real path containing a literal "-" is
 * indistinguishable from an encoded "/").
 */
function encodeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function extractUserMessageText(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string" && text.trim()) return text;
      }
    }
  }
  return undefined;
}

interface ParsedSession {
  cwd?: string;
  firstUserMessage?: string;
  /** Claude's own auto-generated session title ("ai-title" lines): when
   * present this is what the real --resume picker shows, so it beats the raw
   * first message as a label. A session can regenerate its title as it
   * grows, so the LAST such line wins, not the first. */
  aiTitle?: string;
  lastTimestamp?: string;
}

function parseSessionFile(text: string): ParsedSession {
  const result: ParsedSession = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") {
      result.aiTitle = entry.aiTitle;
    }
    if (result.firstUserMessage === undefined && entry.type === "user" && entry.isMeta !== true) {
      const text = extractUserMessageText(entry.message);
      if (text) result.firstUserMessage = text;
    }
    if (result.cwd === undefined && typeof entry.cwd === "string") {
      result.cwd = entry.cwd;
    }
    if (typeof entry.timestamp === "string") {
      result.lastTimestamp = entry.timestamp;
    }
  }
  return result;
}

/**
 * Enumerates resumable Claude Code sessions for one identity, scoped to
 * sessions whose own recorded cwd matches `targetCwd` exactly.
 *
 * Storage: `<configDir>/projects/<encoded-cwd>/<session-uuid>.jsonl`, one
 * NDJSON file per session. Sibling entries in that same directory named
 * after a session's uuid but without a ".jsonl" extension are sidecar data
 * (subagent transcripts, tool results, worktree state) for that same
 * session, not separate sessions; globbing strictly on "*.jsonl" skips them
 * automatically, as does the sibling "memory/" directory.
 */
export async function readClaudeSessions(identity: Identity, targetCwd: string): Promise<ToolResumeResult> {
  const base = { toolName: "claude" as const, identity };
  const projectDir = join(identity.configDir, "projects", encodeProjectDirName(targetCwd));

  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ...base, sessions: [] };
    return { ...base, sessions: [], error: err instanceof Error ? err.message : String(err) };
  }

  const sessions: ResumableSession[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const sessionId = entry.slice(0, -".jsonl".length);
    const filePath = join(projectDir, entry);

    let text: string;
    try {
      text = await Bun.file(filePath).text();
    } catch {
      continue;
    }

    const parsed = parseSessionFile(text);
    if (parsed.cwd === undefined) continue;
    // normalizePath on both sides (targetCwd arrives already normalized from
    // dispatch.ts) matches every other cwd comparison in this codebase (see
    // identities/match.ts), and guards against the lossy forward-only
    // encoding colliding with a different real cwd that happens to encode to
    // the same directory name.
    const sessionCwd = normalizePath(parsed.cwd);
    if (sessionCwd !== targetCwd) continue;

    sessions.push({
      toolName: "claude",
      identity,
      sessionId,
      cwd: sessionCwd,
      label: parsed.aiTitle ?? (parsed.firstUserMessage ? truncateLabel(parsed.firstUserMessage) : "(no user message)"),
      lastActiveAt: parsed.lastTimestamp ?? new Date(0).toISOString(),
    });
  }
  return { ...base, sessions };
}
