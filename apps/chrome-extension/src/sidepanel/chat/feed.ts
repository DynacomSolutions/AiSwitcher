// Pure reducer: hub items in, feed items out. No DOM here.
import type { ChatItem } from "../../shared/chat.ts";

export type FeedItem =
  | { kind: "user"; seq: number; text: string } | { kind: "assistant"; seq: number; text: string; streaming: boolean }
  | { kind: "tool"; seq: number; toolCallId: string; title: string; status: "pending" | "running" | "done" | "failed"; args?: string; result?: string }
  | { kind: "permission"; seq: number; requestId: string; title: string; options: Array<{ id: string; name: string; kind: string }>; resolved?: { optionId?: string; cancelled?: boolean } }
  | { kind: "error"; seq: number; code: string; message: string } | { kind: "notice"; seq: number; text: string };

type Assistant = Extract<FeedItem, { kind: "assistant" }>;
type Tool = Extract<FeedItem, { kind: "tool" }>;
type Permission = Extract<FeedItem, { kind: "permission" }>;

export function buildFeed(items: ChatItem[]): FeedItem[] {
  const sorted = [...items].sort((a, b) => a.seq - b.seq);
  const out: FeedItem[] = [];
  const tools = new Map<string, Tool>();
  const perms = new Map<string, Permission>();
  let open: Assistant | undefined;
  let lastSeq = -1;
  for (const { seq, body } of sorted) {
    if (seq === lastSeq) continue; // a replayed event
    lastSeq = seq;
    switch (body.k) {
      case "text":
        if (open) open.text += body.text;
        else { open = { kind: "assistant", seq, text: body.text, streaming: true }; out.push(open); }
        break;
      case "thought": case "config": break; // hidden, and they do not split a message
      case "turn_end":
        if (open) open.streaming = false;
        open = undefined;
        for (const a of out) if (a.kind === "assistant") a.streaming = false;
        break;
      case "user": open = undefined; out.push({ kind: "user", seq, text: body.text }); break;
      case "tool": {
        open = undefined;
        const prev = tools.get(body.toolCallId);
        if (prev) {
          prev.title = body.title;
          prev.status = body.status;
          if (body.args !== undefined) prev.args = body.args;
          if (body.result !== undefined) prev.result = body.result;
        } else {
          const card: Tool = { kind: "tool", seq, toolCallId: body.toolCallId, title: body.title, status: body.status };
          if (body.args !== undefined) card.args = body.args;
          if (body.result !== undefined) card.result = body.result;
          tools.set(body.toolCallId, card);
          out.push(card);
        }
        break;
      }
      case "permission": {
        open = undefined;
        const card: Permission = { kind: "permission", seq, requestId: body.requestId, title: body.title, options: body.options };
        perms.set(body.requestId, card);
        out.push(card);
        break;
      }
      case "permission_resolved": {
        const card = perms.get(body.requestId);
        if (card) {
          card.resolved = {};
          if (body.optionId !== undefined) card.resolved.optionId = body.optionId;
          if (body.cancelled !== undefined) card.resolved.cancelled = body.cancelled;
        }
        break;
      }
      case "error": open = undefined; out.push({ kind: "error", seq, code: body.code, message: body.message }); break;
      case "notice": open = undefined; out.push({ kind: "notice", seq, text: body.text }); break;
    }
  }
  return out;
}
