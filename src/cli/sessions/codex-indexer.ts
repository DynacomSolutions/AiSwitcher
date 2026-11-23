import { checkChunk, label, projectFromCwd, type IndexChunk, type SessionIndexFields } from "./indexer-shared.ts";
import { parseMetaLine, userTextFromLine } from "./codex.ts";
import { isCodexInjectedUserText, parseTimestampMs, safeJsonParse, textFromBlocks } from "./shared.ts";

/**
 * Incremental indexer for Codex rollouts (`sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`).
 *
 * Line 1 is the `session_meta` record (thread id, cwd, parent thread, nickname). It follows the tree reader
 * in `codex.ts` (`parseMetaLine`, `firstUserMessage`, the child title rules). The model comes from the
 * latest `turn_context` record. The thread name from `session_index.jsonl` is a different file and is not
 * applied here.
 */

export interface CodexIndexState {
  v: 1;
  kind: "codex";
  relPath: string;
  bytes: number;
  lines: number;
  metaId?: string;
  cwd?: string;
  parentThreadId?: string;
  threadSource?: string;
  agentNickname?: string;
  metaStartedAt?: number;
  firstTs?: number;
  lastTs?: number;
  firstUser?: string;
  model?: string;
  messageCount: number;
}

export function newCodexIndexState(relPath: string): CodexIndexState {
  return { v: 1, kind: "codex", relPath, bytes: 0, lines: 0, messageCount: 0 };
}

/** The thread id from a rollout file name (`rollout-<ts>-<uuid>.jsonl`), or the file stem. */
export function codexRefFromPath(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  const stem = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(stem);
  return uuid ? uuid[0] : stem;
}

/** Takes the next lines of a Codex rollout. Returns a new state; `prev` is not changed. */
export function advanceCodexIndex(prev: CodexIndexState | null, chunk: IndexChunk, relPath: string): CodexIndexState {
  if (prev && prev.relPath !== relPath) throw new Error("index state belongs to another file");
  const s: CodexIndexState = { ...(prev ?? newCodexIndexState(relPath)) };
  checkChunk(s.bytes, chunk);
  for (const line of chunk.lines) {
    const lineNo = s.lines;
    s.lines += 1;
    if (lineNo === 0) {
      // Only the first line counts as the meta record, as the tree reader does.
      const meta = parseMetaLine(line);
      if (meta) {
        if (meta.id !== undefined) s.metaId = meta.id;
        if (meta.cwd !== undefined) s.cwd = meta.cwd;
        if (meta.parentThreadId !== undefined) s.parentThreadId = meta.parentThreadId;
        if (meta.threadSource !== undefined) s.threadSource = meta.threadSource;
        if (meta.agentNickname !== undefined) s.agentNickname = meta.agentNickname;
        if (meta.startedAt !== undefined) s.metaStartedAt = meta.startedAt;
      }
    }
    const entry = safeJsonParse(line);
    if (!entry) continue;
    const ts = parseTimestampMs(entry.timestamp);
    if (ts !== undefined) {
      if (s.firstTs === undefined) s.firstTs = ts;
      s.lastTs = ts;
    }
    if (s.firstUser === undefined) {
      const text = userTextFromLine(line);
      if (text !== undefined) s.firstUser = label(text);
    }
    const payload = entry.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== "object") continue;
    if (entry.type === "turn_context" && typeof payload.model === "string" && payload.model !== "") s.model = payload.model;
    if (entry.type === "response_item" && payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
      const text = textFromBlocks(payload.content);
      if (text?.trim() && !(payload.role === "user" && isCodexInjectedUserText(text))) s.messageCount += 1;
    }
  }
  s.bytes = chunk.endOffset;
  return s;
}

export function codexIndexFields(s: CodexIndexState): SessionIndexFields {
  const isChild = s.parentThreadId !== undefined;
  let title: string | undefined;
  if (isChild) title = s.agentNickname ?? (s.threadSource === "guardian_review" ? "guardian review" : undefined);
  if (title === undefined) title = s.firstUser;
  if (title === undefined && isChild) title = s.threadSource;
  const titleLabel = title === undefined ? "" : label(title);
  return {
    sessionRef: s.metaId ?? codexRefFromPath(s.relPath),
    parentRef: s.parentThreadId ?? null,
    agentName: isChild ? (s.agentNickname ?? null) : null,
    title: titleLabel === "" ? null : titleLabel,
    cwd: s.cwd ?? null,
    project: projectFromCwd(s.cwd),
    model: s.model ?? null,
    startedAt: s.metaStartedAt ?? s.firstTs ?? null,
    updatedAt: s.lastTs ?? null,
    messageCount: s.messageCount,
    indexedBytes: s.bytes,
    indexedLines: s.lines,
  };
}
