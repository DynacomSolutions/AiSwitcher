import type { ToolConfig } from "../../identities/types.ts";

/**
 * DTO contract for the session-tree and session-transcript surfaces
 * (GET /api/sessions/tree, GET /api/sessions/transcript; docs/API.md is the
 * human-readable copy of everything below). Field names here are the wire
 * contract the WebUI codes against: additive changes only once shipped.
 *
 * Privacy note: transcripts intentionally expose conversation text to the
 * LOCAL console (loopback-only server, bearer-guarded); nothing here is
 * ever logged by the server itself.
 */

export type SessionTool = ToolConfig["toolName"];

/** Roles a normalized transcript turn can take. `tool` = one tool invocation
 * (call + its result merged into a single turn for the chat UI). */
export type TranscriptRole = "user" | "assistant" | "tool" | "system";

/** One node of a session tree: a top-level session (root) or a spawned
 * subagent/child session (linked to its parent by parentId). */
export interface TreeNodeDto {
  /** Opaque session handle. Most tools use their native session/thread id;
   * namespaced forms exist where the tool itself has no id for a child:
   * claude subagents are "<parentSessionId>/<agentId>", kimi subagents are
   * "<sessionId>/<agentDir>". Pass this value back verbatim as the
   * transcript endpoint's `id` parameter. */
  id: string;
  /** Parent node id within the SAME tool+identity result, when this node is
   * a spawned child. Omitted for roots. When the parent itself fell outside
   * the requested `days` window (or its record vanished), the parentId is
   * KEPT but the node renders as a root: `depth` is 0 and no node with that
   * id exists in this response (orphan). */
  parentId?: string;
  tool: SessionTool;
  /** Registry identity name (the tree is always read per identity). */
  identity: string;
  /** Short human title (<= 72 chars, whitespace-collapsed). Never empty:
   * falls back to "(no summary)" / "(no user message)" style placeholders
   * matching the resume readers. */
  title: string;
  /** The session's own recorded working directory when the tool records
   * one; null when it does not (crush sessions record the project path
   * indirectly, subagent nodes inherit their own recorded cwd). */
  cwd: string | null;
  /** ISO 8601. Session start, from the tool's own records (epoch fallback
   * "1970-01-01T00:00:00.000Z" when a tool records nothing parseable). */
  startedAt: string;
  /** ISO 8601. Last recorded activity (timestamps inside the record when
   * available, file mtime otherwise). */
  updatedAt: string;
  /** Heuristic: primary transcript file modified within the last 60s (crush:
   * sessions.updated_at within 60s). Best-effort live marker. */
  inProgress: boolean;
  /** Message count when the tool exposes one cheaply (crush's
   * sessions.message_count, claude counted during the scan). Absent means
   * "not cheaply available", never zero. */
  messageCount?: number;
  /** 0 for roots; parent.depth + 1 within this response. Orphans (parent
   * outside the window/missing) render as roots: depth 0 with parentId set. */
  depth: number;
  /** Tool-native subagent name when the child is a spawned agent
   * (codex: agent_nickname; kimi: agent dir name; claude: the agentId). */
  agentName?: string;
}

/** One tool+identity slice of the tree endpoint response. */
export interface ToolTreeDto {
  tool: SessionTool;
  identity: string;
  nodes: TreeNodeDto[];
  /** Set ONLY when the tool genuinely has no tree support in this build
   * (no reader implemented). `nodes` is empty in that case. Never set
   * merely because an identity has no sessions. */
  unavailable?: string;
  /** Partial read failure: some data may still be present (same convention
   * as the resume readers' error field). */
  error?: string;
}

export interface SessionTreeEnvelope {
  /** One entry per (tool, identity) scanned. Tools without tree support
   * still appear, with `unavailable` set and empty nodes. */
  tools: ToolTreeDto[];
  generatedAt: string;
  /** Lookback window actually applied (days). */
  days: number;
}

/** One normalized transcript turn. A chat-UI bubble maps 1:1 to a turn. */
export interface TranscriptTurnDto {
  role: TranscriptRole;
  /** Normalized text. For role=tool this is the tool RESULT (truncated);
   * the call itself is toolName + argsPreview. Assistant `thinking`/
   * reasoning content is deliberately NOT included. Per-turn text is
   * truncated at 2000 chars. */
  text: string;
  /** role=tool only: the tool that was invoked. */
  toolName?: string;
  /** role=tool only: truncated (400 chars) JSON preview of the call input. */
  argsPreview?: string;
  /** Epoch ms when the tool records a per-entry timestamp; absent
   * otherwise (grok records none). */
  atMs?: number;
  /** input+output tokens for the turn when the tool records per-message
   * usage (claude, pi). Absent = not cheaply available. */
  tokens?: number;
}

export interface TranscriptSessionMetaDto {
  id: string;
  tool: SessionTool;
  identity: string;
  title?: string;
  cwd?: string;
  startedAt?: string;
  updatedAt?: string;
}

export interface TranscriptDto {
  session: TranscriptSessionMetaDto;
  /** Chronological, tail-weighted: at most `tail` turns (default 500),
   * counting from the END of the session, so an in-progress chat always
   * shows its newest turns. */
  turns: TranscriptTurnDto[];
  /** Total normalized turns in the whole session, INCLUDING any dropped
   * from the front by the tail cap. */
  totalTurns: number;
  /** true when turns were dropped from the front (totalTurns >
   * turns.length). The transcript still reflects appended lines: every
   * read streams the file to its current end. */
  truncated: boolean;
  inProgress: boolean;
}
