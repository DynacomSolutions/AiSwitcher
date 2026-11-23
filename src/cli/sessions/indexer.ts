import { advanceClaudeIndex, claudeIndexFields, type ClaudeIndexState } from "./claude-indexer.ts";
import { advanceCodexIndex, codexIndexFields, type CodexIndexState } from "./codex-indexer.ts";
import type { IndexChunk, SessionIndexFields } from "./indexer-shared.ts";

export { IndexOffsetError, projectFromCwd, type IndexChunk, type SessionIndexFields } from "./indexer-shared.ts";
export { advanceClaudeIndex, claudeIndexFields, claudeRefsFromPath, newClaudeIndexState, type ClaudeIndexState } from "./claude-indexer.ts";
export { advanceCodexIndex, codexIndexFields, codexRefFromPath, newCodexIndexState, type CodexIndexState } from "./codex-indexer.ts";

/** The `scan_state` column: the state of the indexer of the file's kind. */
export type SessionIndexState = ClaudeIndexState | CodexIndexState;
export type IndexedKind = SessionIndexState["kind"];

export interface IndexStep {
  state: SessionIndexState;
  fields: SessionIndexFields;
}

/** True for a stored `scan_state` that this code can continue (right kind, version and file). */
export function isUsableIndexState(value: unknown, kind: IndexedKind, relPath: string): value is SessionIndexState {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return s.v === 1 && s.kind === kind && s.relPath === relPath && typeof s.bytes === "number" && typeof s.lines === "number";
}

/**
 * One step for the enrichment loop: the stored state (null for a new file) and the next lines in, the
 * new state and the index fields out. Throws `IndexOffsetError` when the chunk does not continue the state.
 */
export function advanceSessionIndex(
  kind: IndexedKind,
  prev: SessionIndexState | null,
  chunk: IndexChunk,
  relPath: string,
): IndexStep {
  if (kind === "claude") {
    const state = advanceClaudeIndex(prev as ClaudeIndexState | null, chunk, relPath);
    return { state, fields: claudeIndexFields(state) };
  }
  const state = advanceCodexIndex(prev as CodexIndexState | null, chunk, relPath);
  return { state, fields: codexIndexFields(state) };
}
