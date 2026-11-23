import {
  checkChunk,
  label,
  projectFromCwd,
  type IndexChunk,
  type SessionIndexFields,
} from "./indexer-shared.ts";
import { isClaudeInjectedUserText, parseTimestampMs, safeJsonParse, textFromBlocks } from "./shared.ts";

/**
 * Incremental indexer for Claude Code transcripts (`<enc-cwd>/<session>.jsonl` and the subagent files
 * `<enc-cwd>/<session>/subagents/**\/agent-<id>.jsonl`).
 *
 * It follows the tree readers in `claude.ts` (`scanSessionFile`, `scanAgentFile`) rule by rule, so a full
 * pass gives the same title, cwd, times and count as the tree node.
 */

export interface ClaudeIndexState {
  v: 1;
  kind: "claude";
  relPath: string;
  bytes: number;
  lines: number;
  /** The first non-blank line was read (a subagent file takes agentId, cwd and start time from it). */
  headerSeen: boolean;
  headerAgentId?: string;
  cwd?: string;
  firstTs?: number;
  lastTs?: number;
  /** Labels (already cut to the tree length). aiTitle may be "" (a blank title still hides the first prompt rule). */
  aiTitle?: string;
  customTitle?: string;
  firstUser?: string;
  model?: string;
  messageCount: number;
}

interface ClaudePathRefs {
  sessionRef: string;
  parentRef: string | null;
  /** Subagent id taken from the file name. */
  fileAgentId: string | null;
}

/** Node ids from the path alone. The shipper uses this at ingest time, before the indexer ran. */
export function claudeRefsFromPath(relPath: string): ClaudePathRefs {
  const parts = relPath.split("/").filter((part) => part !== "");
  const base = parts[parts.length - 1] ?? relPath;
  const stem = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
  const sub = parts.indexOf("subagents");
  if (sub >= 1 && base.startsWith("agent-")) {
    const parent = parts[sub - 1]!;
    const agentId = stem.slice("agent-".length);
    return { sessionRef: `${parent}/${agentId}`, parentRef: parent, fileAgentId: agentId };
  }
  return { sessionRef: stem, parentRef: null, fileAgentId: null };
}

/** The text of a real user prompt line, or undefined (the rule of `scanSessionFile`). */
function promptText(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== "user" || entry.isMeta === true) return undefined;
  const message = entry.message as Record<string, unknown> | undefined;
  const text = typeof message?.content === "string" ? message.content : textFromBlocks(message?.content);
  return text && text.trim() && !isClaudeInjectedUserText(text) ? text : undefined;
}

export function newClaudeIndexState(relPath: string): ClaudeIndexState {
  return { v: 1, kind: "claude", relPath, bytes: 0, lines: 0, headerSeen: false, messageCount: 0 };
}

/** Takes the next lines of a Claude transcript. Returns a new state; `prev` is not changed. */
export function advanceClaudeIndex(prev: ClaudeIndexState | null, chunk: IndexChunk, relPath: string): ClaudeIndexState {
  if (prev && prev.relPath !== relPath) throw new Error("index state belongs to another file");
  const s: ClaudeIndexState = { ...(prev ?? newClaudeIndexState(relPath)) };
  checkChunk(s.bytes, chunk);
  const isAgent = claudeRefsFromPath(relPath).fileAgentId !== null;
  for (const line of chunk.lines) {
    s.lines += 1;
    const isHeader = !s.headerSeen && line.trim() !== "";
    if (isHeader) s.headerSeen = true;
    const entry = safeJsonParse(line);
    if (isHeader && entry) {
      // A subagent file: the header line names the agent, its cwd and its start.
      if (typeof entry.agentId === "string") s.headerAgentId = entry.agentId;
      if (isAgent) {
        if (typeof entry.cwd === "string") s.cwd = entry.cwd;
        const headTs = parseTimestampMs(entry.timestamp);
        if (headTs !== undefined) s.firstTs = headTs;
      }
    }
    if (!entry) continue;
    const type = entry.type;
    if (s.firstUser === undefined) {
      const text = promptText(entry);
      if (text !== undefined) s.firstUser = label(text);
    }
    if (type === "ai-title" && typeof entry.aiTitle === "string") s.aiTitle = label(entry.aiTitle);
    if (type === "custom-title" && typeof entry.customTitle === "string" && entry.customTitle.trim()) s.customTitle = label(entry.customTitle);
    if (!isAgent && s.cwd === undefined && typeof entry.cwd === "string") s.cwd = entry.cwd;
    if (type === "user" || type === "assistant") s.messageCount += 1;
    if (type === "assistant") {
      const model = (entry.message as Record<string, unknown> | undefined)?.model;
      if (typeof model === "string" && model !== "" && model !== "<synthetic>") s.model = model;
    }
    const ts = parseTimestampMs(entry.timestamp);
    if (ts !== undefined) {
      if (!isAgent && s.firstTs === undefined) s.firstTs = ts;
      s.lastTs = ts;
    }
  }
  s.bytes = chunk.endOffset;
  return s;
}

export function claudeIndexFields(s: ClaudeIndexState): SessionIndexFields {
  const refs = claudeRefsFromPath(s.relPath);
  const isAgent = refs.fileAgentId !== null;
  const agentId = isAgent ? (s.headerAgentId ?? refs.fileAgentId!) : null;
  let title: string | null;
  if (isAgent) title = s.firstUser ?? label(agentId!);
  else title = s.customTitle || s.aiTitle || s.firstUser || null;
  return {
    sessionRef: isAgent ? `${refs.parentRef}/${agentId}` : refs.sessionRef,
    parentRef: refs.parentRef,
    agentName: agentId,
    title: title === "" ? null : title,
    cwd: s.cwd ?? null,
    project: projectFromCwd(s.cwd),
    model: s.model ?? null,
    startedAt: s.firstTs ?? null,
    updatedAt: s.lastTs ?? null,
    messageCount: s.messageCount,
    indexedBytes: s.bytes,
    indexedLines: s.lines,
  };
}
