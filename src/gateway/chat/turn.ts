// Helpers for chat turns: map ACP updates to feed items, cut long text, tell limit errors from other errors.
import type { ChatBody } from "../../browser/chat-protocol.ts";
import { isLimitFailure, resetFromText } from "../../acp/limit-snooze.ts";
import type { AcpUpdate } from "./acp.ts";

/** One text chunk, one tool argument and one tool result are each at most this long. */
export const MAX_ITEM_CHARS = 8192;
export const TRUNCATED_MARK = "\n[truncated]";

/** Cut a long value. The marker shows the cut. */
export function cut(text: string): string {
  return text.length <= MAX_ITEM_CHARS ? text : `${text.slice(0, MAX_ITEM_CHARS - TRUNCATED_MARK.length)}${TRUNCATED_MARK}`;
}

/** Split a long chunk into pieces that each fit one event. */
export function pieces(text: string): string[] {
  if (text.length <= MAX_ITEM_CHARS) return text === "" ? [] : [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += MAX_ITEM_CHARS) out.push(text.slice(i, i + MAX_ITEM_CHARS));
  return out;
}

type ToolStatus = "pending" | "running" | "done" | "failed";
const STATUS: Record<string, ToolStatus> = { pending: "pending", in_progress: "running", completed: "done", failed: "failed" };

export type ToolBody = Extract<ChatBody, { k: "tool" }>;

/** Merge a tool update into the last known item of the same tool call. */
export function mergeTool(prev: ToolBody | undefined, u: Extract<AcpUpdate, { kind: "tool" }>): ToolBody {
  const next: ToolBody = {
    k: "tool",
    toolCallId: u.toolCallId.slice(0, 256),
    title: (u.title ?? prev?.title ?? "Tool").slice(0, 512),
    status: (u.status !== undefined ? STATUS[u.status] : undefined) ?? prev?.status ?? "pending",
  };
  const args = u.args !== undefined ? cut(u.args) : prev?.args;
  const result = u.result !== undefined ? cut(u.result) : prev?.result;
  if (args !== undefined) next.args = args;
  if (result !== undefined) next.result = result;
  return next;
}

/** The error item for a failed prompt. The agent's own text never reaches the feed. */
export function promptFailure(message: string, code: number, nowMs: number): { code: "limit" | "acp"; message: string; kind: "limit" | "acp" } {
  const reset = resetFromText(message, nowMs);
  if (reset || isLimitFailure({ text: message, code: String(code) })) {
    return {
      code: "limit",
      message: reset ? `Your usage limit is reached. It resets at ${reset.toISOString()}.` : "Your usage limit is reached. Try again later.",
      kind: "limit",
    };
  }
  return { code: "acp", message: "The agent could not finish this turn.", kind: "acp" };
}
