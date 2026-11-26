// Helpers for chat turns: map ACP updates to feed items, cut long text, tell limit errors from other errors.
import type { ChatBody } from "../../browser/chat-protocol.ts";
import { isLimitFailure, resetFromText } from "../../acp/limit-snooze.ts";
import type { AcpUpdate } from "./acp.ts";

/** One text chunk, one tool argument and one tool result are each at most this long. */
export const MAX_ITEM_CHARS = 8192;
export const TRUNCATED_MARK = "\n[truncated]";

/** Remove NUL characters. Postgres text and jsonb cannot hold them. */
export const clean = (text: string): string => (text.includes("\u0000") ? text.replaceAll("\u0000", "") : text);

const bytesOf = (cp: string): number => Buffer.byteLength(cp);

/** The longest start of `text` that fits `maxBytes` of UTF-8, cut between code points. */
function headFitting(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const cp of text) {
    const n = bytesOf(cp);
    if (bytes + n > maxBytes) break;
    bytes += n;
    end += cp.length;
  }
  return text.slice(0, end);
}

/** A short field of the feed: at most 256 UTF-16 units, cut between code points, no NUL. The parser of the extension limits it so. */
export function shortField(raw: string, max = 256): string {
  const text = clean(raw);
  if (text.length <= max) return text;
  let end = 0;
  for (const cp of text) {
    if (end + cp.length > max) break;
    end += cp.length;
  }
  return text.slice(0, end);
}

/** Cut a long value to 8 KiB of UTF-8, between code points. The marker shows the cut. */
export function cut(raw: string): string {
  const text = clean(raw);
  if (text.length * 3 <= MAX_ITEM_CHARS || Buffer.byteLength(text) <= MAX_ITEM_CHARS) return text;
  return `${headFitting(text, MAX_ITEM_CHARS - Buffer.byteLength(TRUNCATED_MARK))}${TRUNCATED_MARK}`;
}

/** Split a long chunk into pieces that each fit 8 KiB of UTF-8, between code points. */
export function pieces(raw: string): string[] {
  let rest = clean(raw);
  const out: string[] = [];
  while (rest !== "") {
    const head = rest.length * 3 <= MAX_ITEM_CHARS ? rest : headFitting(rest, MAX_ITEM_CHARS);
    out.push(head);
    rest = rest.slice(head.length);
  }
  return out;
}

type ToolStatus = "pending" | "running" | "done" | "failed";
const STATUS: Record<string, ToolStatus> = { pending: "pending", in_progress: "running", completed: "done", failed: "failed" };

export type ToolBody = Extract<ChatBody, { k: "tool" }>;

/** Merge a tool update into the last known item of the same tool call. */
export function mergeTool(prev: ToolBody | undefined, u: Extract<AcpUpdate, { kind: "tool" }>): ToolBody {
  const next: ToolBody = {
    k: "tool",
    toolCallId: shortField(u.toolCallId),
    title: Array.from(clean(u.title ?? prev?.title ?? "Tool")).slice(0, 512).join(""),
    status: (u.status !== undefined ? STATUS[u.status] : undefined) ?? prev?.status ?? "pending",
  };
  const args = u.args !== undefined ? cut(u.args) : prev?.args;
  const result = u.result !== undefined ? cut(u.result) : prev?.result;
  if (args !== undefined) next.args = args;
  if (result !== undefined) next.result = result;
  return next;
}

/** The error item for a failed prompt. Other agent text never reaches the feed. Only the text of a usage limit does, because it names the reset time. */
export function promptFailure(message: string, code: number, nowMs: number, data?: unknown): { code: "limit" | "acp"; message: string; kind: "limit" | "rate_limit" | "acp" } {
  // The agent names a usage limit in `data.errorKind`. Its text holds the reset time in the user's own words, so the feed shows it.
  // The code stays `limit`: panels from before v0.5.95 drop a frame with an unknown code, and the feed would stall.
  if (typeof data === "object" && data !== null && (data as { errorKind?: unknown }).errorKind === "rate_limit") {
    const text = shortField(message.replace(/^Internal error: /, ""));
    return { code: "limit", message: text === "" ? "Your usage limit is reached. Try again later." : text, kind: "rate_limit" };
  }
  const limitFailure = isLimitFailure({ text: message, code: String(code) });
  const reset = limitFailure ? resetFromText(message, nowMs) : undefined;
  if (limitFailure) {
    return {
      code: "limit",
      message: reset ? `Your usage limit is reached. It resets at ${reset.toISOString()}.` : "Your usage limit is reached. Try again later.",
      kind: "limit",
    };
  }
  return { code: "acp", message: "The agent could not finish this turn.", kind: "acp" };
}
