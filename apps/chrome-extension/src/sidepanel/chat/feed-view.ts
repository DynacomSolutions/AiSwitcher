// DOM view of the chat feed. All agent text goes in through textContent or the safe markdown renderer.
// Nodes are keyed by item and patched in place, so focus and scroll survive an update.
import type { FeedItem } from "./feed.ts";
import { parseMarkdown, renderBlocks, type MdBlock } from "./markdown.ts";

export interface FeedViewOptions {
  onPermission(requestId: string, optionId?: string): void;
  /** Tool cards whose result the user expanded. The caller keeps it between renders. */
  expanded: Set<string>;
}

const ARGS_MAX = 120;
const RESULT_MAX = 400;
const ERROR_LABELS: Record<string, string> = {
  pod_start: "Agent did not start", attach: "Could not connect", agent_exit: "Agent stopped", acp: "Agent error", timeout: "Timed out",
  limit: "Usage limit reached:", busy: "Agent is busy", window_cap: "Too many chats", bad_request: "Bad request", unavailable: "Not available",
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

// Parsed markdown by exact text. The same text always gives the same blocks, so a hit is always correct.
const PARSE_CACHE_MAX = 300;
const parseCache = new Map<string, MdBlock[]>();
export function parseCached(text: string): MdBlock[] {
  const hit = parseCache.get(text);
  if (hit) return hit;
  const blocks = parseMarkdown(text);
  if (parseCache.size >= PARSE_CACHE_MAX) parseCache.delete(parseCache.keys().next().value as string);
  parseCache.set(text, blocks);
  return blocks;
}

interface Entry { node: HTMLElement; sig: string; update(f: FeedItem): void }
interface State { entries: Map<string, Entry>; feed: FeedItem[]; opts: FeedViewOptions }
const states = new WeakMap<HTMLElement, State>();

type Of<K extends FeedItem["kind"]> = Extract<FeedItem, { kind: K }>;

function userEntry(doc: Document): Entry {
  const node = el(doc, "div", "msg user");
  return { node, sig: "", update: (f) => { node.textContent = (f as Of<"user">).text; } };
}
function noticeEntry(doc: Document): Entry {
  const node = el(doc, "div", "msg notice");
  return { node, sig: "", update: (f) => { node.textContent = (f as Of<"notice">).text; } };
}
function errorEntry(doc: Document): Entry {
  const node = el(doc, "div", "msg error");
  const label = el(doc, "strong"), msg = el(doc, "span");
  node.append(label, msg);
  return { node, sig: "", update: (f) => { const e = f as Of<"error">; label.textContent = errorLabel(e.code); msg.textContent = ` ${e.message}`; } };
}
function assistantEntry(doc: Document): Entry {
  const node = el(doc, "div", "msg assistant");
  let shown: string | undefined;
  return {
    node, sig: "",
    update: (f) => {
      const a = f as Of<"assistant">;
      node.className = a.streaming ? "msg assistant streaming" : "msg assistant";
      // A streaming message is busy: assistive tools wait for it to end instead of reading every chunk.
      if (a.streaming) node.setAttribute("aria-busy", "true"); else node.removeAttribute("aria-busy");
      if (shown !== a.text) { shown = a.text; node.replaceChildren(renderBlocks(doc, parseCached(a.text))); }
    },
  };
}
function toolEntry(doc: Document, st: () => State, rerender: () => void): Entry {
  const node = el(doc, "div", "msg tool");
  const head = el(doc, "div", "tool-head");
  const name = el(doc, "span", "tool-name"), status = el(doc, "span", "tool-status");
  head.append(name, status);
  const args = el(doc, "div", "tool-args"), result = el(doc, "pre", "tool-result"), more = el(doc, "button", "link-btn");
  more.setAttribute("type", "button");
  node.append(head, args, result, more);
  let cur: Of<"tool"> | undefined;
  more.addEventListener("click", () => {
    if (!cur) return;
    const set = st().opts.expanded;
    if (set.has(cur.toolCallId)) set.delete(cur.toolCallId); else set.add(cur.toolCallId);
    rerender();
  });
  return {
    node, sig: "",
    update: (f) => {
      const t = (cur = f as Of<"tool">);
      const open = st().opts.expanded.has(t.toolCallId);
      node.className = `msg tool ${t.status}`;
      name.textContent = t.title;
      status.className = `tool-status ${t.status}`;
      status.textContent = t.status;
      args.hidden = !t.args;
      args.textContent = t.args ? cut(t.args, ARGS_MAX) : "";
      result.hidden = !t.result;
      result.textContent = t.result ? (open ? t.result : cut(t.result, RESULT_MAX)) : "";
      more.hidden = !t.result || t.result.length <= RESULT_MAX;
      more.textContent = open ? "Show less" : "Show more";
    },
  };
}
function permissionEntry(doc: Document, st: () => State): Entry {
  const node = el(doc, "div", "msg permission");
  const title = el(doc, "div", "perm-title"), area = el(doc, "div");
  node.append(title, area);
  let areaSig = "";
  return {
    node, sig: "",
    update: (f) => {
      const p = f as Of<"permission">;
      title.textContent = p.title;
      const sig = JSON.stringify([p.options, p.resolved ?? null]);
      if (sig === areaSig) return;
      areaSig = sig;
      if (p.resolved) {
        const chosen = p.options.find((o) => o.id === p.resolved?.optionId);
        area.className = "perm-done";
        area.replaceChildren(doc.createTextNode(p.resolved.cancelled || !chosen ? "Cancelled" : chosen.name));
        return;
      }
      area.className = "actions";
      const firstAllow = p.options.findIndex((o) => o.kind.startsWith("allow"));
      const firstReject = p.options.findIndex((o) => o.kind.startsWith("reject"));
      area.replaceChildren(...p.options.map((o, i) => {
        const b = el(doc, "button", i === firstAllow ? "primary" : i === firstReject ? "secondary" : "", o.name);
        b.setAttribute("type", "button");
        b.addEventListener("click", () => st().opts.onPermission(p.requestId, o.id));
        return b;
      }));
    },
  };
}

function keyOf(f: FeedItem): string { return `${f.kind}:${f.seq}`; }

/** Shows the feed in `root`. New items are added, changed items are patched, and nodes the user is using stay in place. */
export function renderFeed(doc: Document, root: HTMLElement, feed: FeedItem[], opts: FeedViewOptions): void {
  let state = states.get(root);
  if (!state) { state = { entries: new Map(), feed, opts }; states.set(root, state); }
  state.feed = feed;
  state.opts = opts;
  const st = state;
  const rerender = (): void => renderFeed(doc, root, st.feed, st.opts);
  root.setAttribute("role", "log");
  root.setAttribute("aria-live", "polite");
  root.setAttribute("aria-relevant", "additions");

  const seen = new Set<string>();
  let ref: ChildNode | null = root.firstChild;
  for (const f of feed) {
    const key = keyOf(f);
    seen.add(key);
    let entry = st.entries.get(key);
    if (!entry) {
      switch (f.kind) {
        case "user": entry = userEntry(doc); break;
        case "assistant": entry = assistantEntry(doc); break;
        case "tool": entry = toolEntry(doc, () => st, rerender); break;
        case "permission": entry = permissionEntry(doc, () => st); break;
        case "error": entry = errorEntry(doc); break;
        case "notice": entry = noticeEntry(doc); break;
      }
      st.entries.set(key, entry);
    }
    const sig = JSON.stringify(f) + (f.kind === "tool" && opts.expanded.has(f.toolCallId) ? "+open" : "");
    if (sig !== entry.sig) { entry.sig = sig; entry.update(f); }
    if (entry.node === ref) ref = ref.nextSibling;
    else root.insertBefore(entry.node, ref);
  }
  for (const [key, entry] of st.entries) {
    if (!seen.has(key)) { entry.node.remove(); st.entries.delete(key); }
  }
}
