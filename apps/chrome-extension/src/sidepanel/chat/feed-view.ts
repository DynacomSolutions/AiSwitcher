// DOM view of the chat feed. All agent text goes in through textContent or the safe markdown renderer.
import type { FeedItem } from "./feed.ts";
import { parseMarkdown, renderBlocks } from "./markdown.ts";

export interface FeedViewOptions {
  onPermission(requestId: string, optionId?: string): void;
  /** Tool cards whose result the user expanded. The caller keeps it between renders. */
  expanded: Set<string>;
}

const ARGS_MAX = 120;
const RESULT_MAX = 400;
const ERROR_LABELS: Record<string, string> = {
  pod_start: "Agent did not start", attach: "Could not connect", agent_exit: "Agent stopped", acp: "Agent error", timeout: "Timed out",
  limit: "Usage limit reached", busy: "Agent is busy", window_cap: "Too many chats", bad_request: "Bad request", unavailable: "Not available",
  resume_failed: "Could not resume", expired: "Chat expired",
};
export const errorLabel = (code: string): string => ERROR_LABELS[code] ?? "Error";
export const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}...` : s);

function el(doc: Document, tag: string, cls?: string, text?: string): HTMLElement {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderTool(doc: Document, f: Extract<FeedItem, { kind: "tool" }>, opts: FeedViewOptions, rerender: () => void): HTMLElement {
  const card = el(doc, "div", `msg tool ${f.status}`);
  const head = el(doc, "div", "tool-head");
  head.append(el(doc, "span", "tool-name", f.title), el(doc, "span", `tool-status ${f.status}`, f.status));
  card.append(head);
  if (f.args) card.append(el(doc, "div", "tool-args", cut(f.args, ARGS_MAX)));
  if (f.result) {
    const open = opts.expanded.has(f.toolCallId);
    card.append(el(doc, "pre", "tool-result", open ? f.result : cut(f.result, RESULT_MAX)));
    if (f.result.length > RESULT_MAX) {
      const more = el(doc, "button", "link-btn", open ? "Show less" : "Show more");
      more.setAttribute("type", "button");
      more.addEventListener("click", () => { if (open) opts.expanded.delete(f.toolCallId); else opts.expanded.add(f.toolCallId); rerender(); });
      card.append(more);
    }
  }
  return card;
}

function renderPermission(doc: Document, f: Extract<FeedItem, { kind: "permission" }>, opts: FeedViewOptions): HTMLElement {
  const card = el(doc, "div", "msg permission");
  card.append(el(doc, "div", "perm-title", f.title));
  if (f.resolved) {
    const chosen = f.options.find((o) => o.id === f.resolved?.optionId);
    card.append(el(doc, "div", "perm-done", f.resolved.cancelled || !chosen ? "Cancelled" : chosen.name));
    return card;
  }
  const row = el(doc, "div", "actions");
  const firstAllow = f.options.findIndex((o) => o.kind.startsWith("allow"));
  const firstReject = f.options.findIndex((o) => o.kind.startsWith("reject"));
  f.options.forEach((o, i) => {
    const b = el(doc, "button", i === firstAllow ? "primary" : i === firstReject ? "secondary" : "", o.name);
    b.setAttribute("type", "button");
    b.addEventListener("click", () => opts.onPermission(f.requestId, o.id));
    row.append(b);
  });
  card.append(row);
  return card;
}

/** Replaces the children of `root` with the feed. */
export function renderFeed(doc: Document, root: HTMLElement, feed: FeedItem[], opts: FeedViewOptions): void {
  const rerender = (): void => renderFeed(doc, root, feed, opts);
  const nodes: Node[] = [];
  for (const f of feed) {
    switch (f.kind) {
      case "user": nodes.push(el(doc, "div", "msg user", f.text)); break;
      case "assistant": {
        const m = el(doc, "div", f.streaming ? "msg assistant streaming" : "msg assistant");
        m.append(renderBlocks(doc, parseMarkdown(f.text)));
        nodes.push(m);
        break;
      }
      case "tool": nodes.push(renderTool(doc, f, opts, rerender)); break;
      case "permission": nodes.push(renderPermission(doc, f, opts)); break;
      case "error": {
        const m = el(doc, "div", "msg error");
        m.append(el(doc, "strong", undefined, errorLabel(f.code)), el(doc, "span", undefined, ` ${f.message}`));
        nodes.push(m);
        break;
      }
      case "notice": nodes.push(el(doc, "div", "msg notice", f.text)); break;
    }
  }
  root.replaceChildren(...nodes);
}
