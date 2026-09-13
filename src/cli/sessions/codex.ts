import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Identity } from "../../identities/types.ts";
import { listRecentFilesAsync } from "../../shared/local-spend.ts";
import { truncateLabel } from "../resume/label.ts";
import { type TranscriptDto, type TranscriptTurnDto, type TreeNodeDto } from "./types.ts";
import {
  argsPreviewFrom,
  clampText,
  findFirstLine,
  forEachLine,
  isoOrEpoch,
  isInProgress,
  mapPool,
  parseTimestampMs,
  readFirstLine,
  safeJsonParse,
  textFromBlocks,
  windowCutoffMs,
  type TranscriptOpts,
  type WindowOpts,
} from "./shared.ts";
import { TurnCollector } from "./turn-collector.ts";

/**
 * Codex session trees + normalized transcripts.
 *
 * Storage: `<configDir>/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`
 * (see cli/resume/codex-resume.ts). Line 1 is always a `session_meta` event
 * carrying the thread id, cwd, `parent_thread_id`, `thread_source` and (for
 * codex's own multi-agent runs) `agent_nickname`/`agent_path`.
 *
 * Tree links: a rollout whose session_meta carries `parent_thread_id` is a
 * CHILD of that thread — codex writes every internal subagent thread
 * (`thread_source: "subagent"`, nicknamed agents) and safety-review thread
 * (`"guardian_review"`) as its own rollout file in the same dated tree, so
 * parent/child is a pure session_meta read (no body scan). Threads without
 * a parent are roots.
 *
 * Transcript normalization: `response_item` payloads only — `message`
 * (role user/assistant, content = input_text/output_text blocks) renders as
 * user/assistant turns; `function_call`/`custom_tool_call` render as tool
 * turns with their result filled from the matching
 * `function_call_output`/`custom_tool_call_output` via call_id. `reasoning`
 * payloads and `event_msg` duplicates (user_message/agent_message) are
 * skipped; token_count events carry per-request deltas rather than
 * per-turn totals, so codex turns have no tokens.
 */

interface CodexMeta {
  id?: string;
  cwd?: string;
  parentThreadId?: string;
  threadSource?: string;
  agentNickname?: string;
  startedAt?: number;
}

function parseMetaLine(line: string | undefined): CodexMeta | undefined {
  if (!line) return undefined;
  const entry = safeJsonParse(line);
  if (!entry || entry.type !== "session_meta") return undefined;
  const payload = entry.payload as Record<string, unknown> | undefined;
  if (!payload) return undefined;
  const id = payload.id ?? payload.session_id;
  return {
    ...(typeof id === "string" ? { id } : {}),
    ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
    ...(typeof payload.parent_thread_id === "string" ? { parentThreadId: payload.parent_thread_id } : {}),
    ...(typeof payload.thread_source === "string" ? { threadSource: payload.thread_source } : {}),
    ...(typeof payload.agent_nickname === "string" ? { agentNickname: payload.agent_nickname } : {}),
    ...(parseTimestampMs(payload.timestamp) !== undefined ? { startedAt: parseTimestampMs(payload.timestamp) } : {}),
  };
}

/** The user-text source for titles: codex writes the real user prompt both
 * as an `event_msg` user_message and as a `response_item` user message, but
 * ALSO injects synthetic user messages (`<environment_context>` XML) that
 * must never become a title or a turn. Returns the first real user text in
 * the file. */
function userTextFromLine(line: string): string | undefined {
  const entry = safeJsonParse(line);
  if (!entry) return undefined;
  const payload = entry.payload as Record<string, unknown> | undefined;
  if (!payload) return undefined;
  if (entry.type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string") {
    return payload.message.trim() ? payload.message : undefined;
  }
  if (entry.type === "response_item" && payload.type === "message" && payload.role === "user") {
    const text = textFromBlocks(payload.content);
    if (text?.trim() && !text.startsWith("<environment_context")) return text;
  }
  return undefined;
}

/** Bounded scan for the first real user prompt (the title source); both
 * shapes codex writes appear within the first few lines, so this reads a
 * few KB at most. */
async function firstUserMessage(filePath: string): Promise<string | undefined> {
  const line = await findFirstLine(filePath, (candidate) => userTextFromLine(candidate) !== undefined);
  return line === undefined ? undefined : userTextFromLine(line);
}

export async function readCodexTree(identity: Identity, opts: WindowOpts = {}): Promise<TreeNodeDto[]> {
  const cutoffMs = windowCutoffMs(opts);
  const sessionsRoot = join(identity.configDir, "sessions");
  // listRecentFilesAsync does the path-date (YYYY/MM/DD) AND mtime pruning
  // shared with the Bedrock spend scanner; codex is the layout it was
  // written for.
  const { files } = await listRecentFilesAsync(sessionsRoot, new Date(cutoffMs), {}, true);

  const nodes = await mapPool(files, 16, async (filePath) => {
    const meta = parseMetaLine(await readFirstLine(filePath));
    if (!meta?.id) return undefined;
    // No parent and an explicitly non-user source: a thread kind we can't
    // place in the tree (none observed live); skip rather than guess.
    if (!meta.parentThreadId && meta.threadSource !== undefined && meta.threadSource !== "user") return undefined;

    let mtimeMs: number;
    try {
      mtimeMs = (await stat(filePath)).mtimeMs;
    } catch {
      return undefined;
    }
    if (mtimeMs < cutoffMs) return undefined;

    const isChild = meta.parentThreadId !== undefined;
    let title: string | undefined;
    if (isChild) {
      title = meta.agentNickname ?? (meta.threadSource === "guardian_review" ? "guardian review" : undefined);
    }
    if (!title) title = await firstUserMessage(filePath);
    if (!title) title = isChild ? (meta.threadSource ?? "(no summary)") : "(no summary)";

    const node: TreeNodeDto = {
      id: meta.id,
      tool: "codex",
      identity: identity.name,
      title: truncateLabel(title),
      cwd: meta.cwd ?? null,
      startedAt: isoOrEpoch(meta.startedAt ?? mtimeMs),
      updatedAt: isoOrEpoch(mtimeMs),
      inProgress: isInProgress(mtimeMs, opts),
      depth: 0, // recomputed by the tree dispatcher
      ...(isChild ? { parentId: meta.parentThreadId, ...(meta.agentNickname ? { agentName: meta.agentNickname } : {}) } : {}),
    };
    return node;
  });
  return nodes.filter((n): n is TreeNodeDto => n !== undefined);
}

/* ------------------------------- transcript ------------------------------- */

function pushCodexPayload(collector: TurnCollector, payload: Record<string, unknown>, atMs: number | undefined): void {
  const type = payload.type;
  if (type === "message") {
    const role = payload.role;
    if (role !== "user" && role !== "assistant") return; // developer/instructions noise
    const text = textFromBlocks(payload.content);
    if (text?.trim() && !(role === "user" && text.startsWith("<environment_context"))) {
      collector.push({ role, text: clampText(text), ...(atMs !== undefined ? { atMs } : {}) });
    }
    return;
  }
  if (type === "function_call" || type === "custom_tool_call") {
    if (typeof payload.name !== "string") return;
    const turn: TranscriptTurnDto = {
      role: "tool",
      text: "",
      toolName: payload.name,
      argsPreview: argsPreviewFrom(type === "function_call" ? payload.arguments : payload.input),
      ...(atMs !== undefined ? { atMs } : {}),
    };
    collector.push(turn);
    if (typeof payload.call_id === "string") collector.track(payload.call_id, turn);
    return;
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    if (typeof payload.call_id === "string") collector.fill(payload.call_id, toolOutputText(payload.output));
  }
}

function toolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  // Some outputs arrive as {content: "..."} / {output: "..."} shapes.
  if (output && typeof output === "object") {
    const rec = output as Record<string, unknown>;
    for (const key of ["content", "output", "text"]) {
      if (typeof rec[key] === "string") return rec[key] as string;
    }
  }
  return "";
}

async function locateCodexTranscript(configDir: string, id: string): Promise<string | undefined> {
  // Generous fixed window (transcripts are reachable from a tree that only
  // shows the recent window, but a slightly stale UI should still resolve).
  const { files } = await listRecentFilesAsync(join(configDir, "sessions"), new Date(Date.now() - 365 * 86_400_000), {}, true);
  const found = await mapPool(files, 16, async (filePath) => {
    const meta = parseMetaLine(await readFirstLine(filePath));
    return meta?.id === id ? filePath : undefined;
  });
  return found.find((f): f is string => f !== undefined);
}

export async function readCodexTranscript(
  identity: Identity,
  id: string,
  opts: TranscriptOpts & WindowOpts = {},
): Promise<TranscriptDto | undefined> {
  const filePath = await locateCodexTranscript(identity.configDir, id);
  if (!filePath) return undefined;

  let meta = parseMetaLine(await readFirstLine(filePath));
  const collector = new TurnCollector(opts.tail);
  let title: string | undefined;
  let lastTs: number | undefined;
  await forEachLine(filePath, (line) => {
    const entry = safeJsonParse(line);
    if (!entry) return;
    if (meta === undefined && entry.type === "session_meta") meta = parseMetaLine(line);
    const atMs = parseTimestampMs(entry.timestamp);
    if (atMs !== undefined) lastTs = atMs;
    if (entry.type === "event_msg") {
      return; // event_msg duplicates response_items; never turns
    }
    if (title === undefined) {
      const userText = userTextFromLine(line);
      if (userText !== undefined) title = userText;
    }
    const payload = entry.payload;
    if (payload && typeof payload === "object") {
      pushCodexPayload(collector, payload as Record<string, unknown>, atMs);
    }
  });

  let mtimeMs: number | undefined;
  try {
    mtimeMs = (await stat(filePath)).mtimeMs;
  } catch {
    // vanished mid-read
  }

  const resolvedTitle = title ?? (meta?.threadSource && meta.threadSource !== "user" ? meta.threadSource : undefined);
  return {
    session: {
      id,
      tool: "codex",
      identity: identity.name,
      ...(resolvedTitle ? { title: truncateLabel(resolvedTitle) } : {}),
      ...(meta?.cwd !== undefined ? { cwd: meta.cwd } : {}),
      ...(meta?.startedAt !== undefined ? { startedAt: new Date(meta.startedAt).toISOString() } : {}),
      ...(lastTs !== undefined || mtimeMs !== undefined ? { updatedAt: isoOrEpoch(lastTs ?? mtimeMs) } : {}),
    },
    turns: collector.turns,
    totalTurns: collector.total,
    truncated: collector.truncated,
    inProgress: mtimeMs !== undefined ? isInProgress(mtimeMs, opts) : false,
  };
}
