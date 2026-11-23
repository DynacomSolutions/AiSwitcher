// Shared with the Chrome extension: keep free of Node and Bun imports.

export const CHAT_PROVIDERS = ["claude", "codex", "kimi", "grok", "zai", "opencode"] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];
export const CHAT_STATES = ["starting", "idle", "thinking", "waiting", "failed", "closed"] as const;
export type ChatState = (typeof CHAT_STATES)[number];
export const CHAT_ERROR_CODES = ["pod_start", "attach", "agent_exit", "acp", "timeout", "limit", "busy", "window_cap", "bad_request", "unavailable", "resume_failed", "expired"] as const;
export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number];
export const MAX_CHAT_TEXT = 65536;
export const MAX_CHAT_TABS = 32;
export const MAX_CHATS_PER_WINDOW = 6;
export const MAX_CHAT_NAME = 80;
/** Most starred models the gateway keeps, and most changes one frame may carry. */
export const MAX_FAVOURITES = 200;

/** A starred model: the same three names a pick uses. */
export interface FavKey { provider: ChatProvider; identity: string; model: string }
/** One star change. `at` is the time (epoch ms) the user made it, when the sender knows it: the gateway keeps the newest change of a model. */
export interface FavChange extends FavKey { op: "add" | "remove"; at?: number }
/** One string per starred model. The names may hold `/` and `:`, so the id is a JSON array. */
export const favId = (f: FavKey): string => JSON.stringify([f.provider, f.identity, f.model]);

export interface ChatSelection { provider: ChatProvider; identity: string; model?: string; effort?: string }
export interface ChatSummary { chatId: string; name: string; color: string; windowId: number; state: ChatState; selection: ChatSelection; tabIds: number[]; lastSeq: number; updatedAt: number }
/** The gateway truncates tool args, tool result and text chunks to 8 KiB before it sends them (Task 12). A body over MAX_CHAT_TEXT is rejected by the parser. */
export type ChatBody =
  | { k: "user"; text: string } | { k: "text"; text: string } | { k: "thought"; text: string }
  | { k: "tool"; toolCallId: string; title: string; status: "pending" | "running" | "done" | "failed"; args?: string; result?: string }
  | { k: "permission"; requestId: string; rpcId: string | number; title: string; options: Array<{ id: string; name: string; kind: string }> }
  | { k: "permission_resolved"; requestId: string; optionId?: string; cancelled?: boolean }
  | { k: "error"; code: ChatErrorCode; message: string } | { k: "notice"; text: string }
  | { k: "turn_end"; stopReason: string }
  | { k: "config"; models: Array<{ id: string; name: string }>; efforts: string[]; current: { model?: string; effort?: string } };
export type ChatFromExt =
  | { t: "chat.create"; chatId: string; name: string; color: string; windowId: number; selection: ChatSelection; tabIds: number[] }
  | { t: "chat.prompt"; chatId: string; text: string } | { t: "chat.cancel"; chatId: string }
  | { t: "chat.permission"; chatId: string; requestId: string; optionId?: string }
  | { t: "chat.link"; chatId: string; tabIds: number[] } | { t: "chat.config"; chatId: string; model?: string; effort?: string }
  | { t: "chat.rename"; chatId: string; name: string } | { t: "chat.close"; chatId: string }
  | { t: "chat.resume"; chatId: string; afterSeq: number } | { t: "chat.list"; windowId?: number }
  | { t: "chat.catalog"; reqId: string; provider?: ChatProvider }
  /** Asks for the starred models. The gateway answers with `chat.fav.list`. */
  | { t: "chat.fav.list" } | { t: "chat.fav.set"; changes: FavChange[] };
export interface ChatCatalogProvider { provider: ChatProvider; identities: Array<{ name: string; kind: "identity" | "pool"; models: Array<{ id: string; name: string }>; modelsError?: string }>; efforts: string[] }
export type ChatToExt =
  | { t: "chat.event"; chatId: string; seq: number; ts: number; body: ChatBody } | { t: "chat.state"; chatId: string; state: ChatState; summary: ChatSummary }
  | { t: "chat.list"; chats: ChatSummary[] } | { t: "chat.reject"; chatId?: string; reqId?: string; code: ChatErrorCode; message: string }
  | { t: "chat.catalog"; reqId: string; providers: ChatCatalogProvider[] }
  /** The starred models, oldest first. `seq` grows with each change. The gateway sends it after an attach, after a `chat.fav.list` and after every change. */
  | { t: "chat.fav.list"; seq: number; items: FavKey[] };

export const sessionIdForChat = (chatId: string): string => `chat:${chatId}`;

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/;
const SEL_RE = /^[A-Za-z0-9._:/@+-]{1,128}$/;
const MAX_SHORT = 256;
const MAX_MODELS = 4096;
const MAX_SMALL_LIST = 64;
const MAX_LIST = 256;
const TOOL_STATUS = ["pending", "running", "done", "failed"] as const;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = MAX_SHORT): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
const id = (v: unknown): string | undefined => (typeof v === "string" && ID_RE.test(v) ? v : undefined);
const sel = (v: unknown): string | undefined => (typeof v === "string" && SEL_RE.test(v) ? v : undefined);
/** True when a provider, identity, model or effort id is safe to send in a selection. */
export const selectable = (v: string): boolean => SEL_RE.test(v);
/** A code that this build does not know reads as `acp`, so a newer gateway never makes an older panel drop a frame. */
const errorCode = (v: unknown): ChatErrorCode | undefined => (typeof v === "string" ? (oneOf(CHAT_ERROR_CODES, v) ?? "acp") : undefined);
const oneOf = <T extends string>(set: readonly T[], v: unknown): T | undefined => (typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : undefined);
const text = (v: unknown): string | undefined => str(v, MAX_CHAT_TEXT);
const name = (v: unknown): string | undefined => (typeof v === "string" && v.length >= 1 && v.length <= MAX_CHAT_NAME ? v : undefined);
const color = (v: unknown): string | undefined => (typeof v === "string" && COLOR_RE.test(v) ? v : undefined);
/** An optional field: absent gives a defined result of undefined, a bad value fails. */
const opt = <T>(v: unknown, check: (x: unknown) => T | undefined): { ok: true; v: T | undefined } | { ok: false } => {
  if (v === undefined) return { ok: true, v: undefined };
  const r = check(v);
  return r === undefined ? { ok: false } : { ok: true, v: r };
};
const withOpt = <T extends object>(base: T, extra: Rec): T => {
  for (const [k, val] of Object.entries(extra)) if (val !== undefined) (base as Rec)[k] = val;
  return base;
};
function list<T>(v: unknown, max: number, one: (x: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(v) || v.length > max) return undefined;
  const out: T[] = [];
  for (const x of v) {
    const r = one(x);
    if (r === undefined) return undefined;
    out.push(r);
  }
  return out;
}
const tabIds = (v: unknown): number[] | undefined => list(v, MAX_CHAT_TABS, int);
const strList = (v: unknown): string[] | undefined => list(v, MAX_SMALL_LIST, (x) => str(x));
const models = (v: unknown): Array<{ id: string; name: string }> | undefined =>
  list(v, MAX_MODELS, (m) => {
    if (!isRec(m)) return undefined;
    const mid = str(m.id), mname = str(m.name);
    return mid === undefined || mname === undefined ? undefined : { id: mid, name: mname };
  });

function favKey(v: unknown): FavKey | undefined {
  if (!isRec(v)) return undefined;
  const provider = oneOf(CHAT_PROVIDERS, v.provider), identity = sel(v.identity), model = sel(v.model);
  return provider && identity && model ? { provider, identity, model } : undefined;
}

function favChange(v: unknown): FavChange | undefined {
  const k = favKey(v);
  if (!k || !isRec(v)) return undefined;
  const op = oneOf(["add", "remove"] as const, v.op), at = opt(v.at, int);
  return op && at.ok ? withOpt({ ...k, op } as FavChange, { at: at.v }) : undefined;
}

function selection(v: unknown): ChatSelection | undefined {
  if (!isRec(v)) return undefined;
  const provider = oneOf(CHAT_PROVIDERS, v.provider), identity = sel(v.identity);
  const model = opt(v.model, sel), effort = opt(v.effort, sel);
  if (!provider || !identity || !model.ok || !effort.ok) return undefined;
  return withOpt({ provider, identity } as ChatSelection, { model: model.v, effort: effort.v });
}

function summary(v: unknown): ChatSummary | undefined {
  if (!isRec(v)) return undefined;
  const chatId = id(v.chatId), n = name(v.name), c = color(v.color), windowId = int(v.windowId), state = oneOf(CHAT_STATES, v.state);
  const s = selection(v.selection), tabs = tabIds(v.tabIds), lastSeq = int(v.lastSeq), updatedAt = int(v.updatedAt);
  if (chatId === undefined || n === undefined || c === undefined || windowId === undefined || !state || !s || !tabs || lastSeq === undefined || updatedAt === undefined) return undefined;
  return { chatId, name: n, color: c, windowId, state, selection: s, tabIds: tabs, lastSeq, updatedAt };
}

function body(v: unknown): ChatBody | undefined {
  if (!isRec(v)) return undefined;
  switch (v.k) {
    case "user": case "text": case "thought": case "notice": {
      const t = text(v.text);
      return t === undefined ? undefined : ({ k: v.k, text: t } as ChatBody);
    }
    case "tool": {
      const toolCallId = str(v.toolCallId), title = str(v.title, MAX_CHAT_TEXT), status = oneOf(TOOL_STATUS, v.status);
      const args = opt(v.args, text), result = opt(v.result, text);
      if (toolCallId === undefined || title === undefined || !status || !args.ok || !result.ok) return undefined;
      return withOpt({ k: "tool", toolCallId, title, status } as ChatBody, { args: args.v, result: result.v });
    }
    case "permission": {
      const requestId = str(v.requestId), title = str(v.title, MAX_CHAT_TEXT);
      const rpcId = typeof v.rpcId === "number" && Number.isSafeInteger(v.rpcId) ? v.rpcId : str(v.rpcId);
      const options = list(v.options, MAX_SMALL_LIST, (o) => {
        if (!isRec(o)) return undefined;
        const oid = str(o.id), on = str(o.name), kind = str(o.kind);
        return oid === undefined || on === undefined || kind === undefined ? undefined : { id: oid, name: on, kind };
      });
      if (requestId === undefined || title === undefined || rpcId === undefined || !options) return undefined;
      return { k: "permission", requestId, rpcId, title, options };
    }
    case "permission_resolved": {
      const requestId = str(v.requestId), optionId = opt(v.optionId, (x) => str(x));
      const cancelled = opt(v.cancelled, (x) => (typeof x === "boolean" ? x : undefined));
      if (requestId === undefined || !optionId.ok || !cancelled.ok) return undefined;
      return withOpt({ k: "permission_resolved", requestId } as ChatBody, { optionId: optionId.v, cancelled: cancelled.v });
    }
    case "error": {
      const code = errorCode(v.code), message = str(v.message, MAX_CHAT_TEXT);
      return code && message !== undefined ? { k: "error", code, message } : undefined;
    }
    case "turn_end": {
      const stopReason = str(v.stopReason);
      return stopReason === undefined ? undefined : { k: "turn_end", stopReason };
    }
    case "config": {
      const m = models(v.models), efforts = strList(v.efforts);
      if (!m || !efforts || !isRec(v.current)) return undefined;
      const cm = opt(v.current.model, (x) => str(x)), ce = opt(v.current.effort, (x) => str(x));
      if (!cm.ok || !ce.ok) return undefined;
      return { k: "config", models: m, efforts, current: withOpt({}, { model: cm.v, effort: ce.v }) };
    }
    default: return undefined;
  }
}

function catalogProvider(v: unknown): ChatCatalogProvider | undefined {
  if (!isRec(v)) return undefined;
  const provider = oneOf(CHAT_PROVIDERS, v.provider), efforts = strList(v.efforts);
  const identities = list(v.identities, MAX_LIST, (i) => {
    if (!isRec(i)) return undefined;
    const n = str(i.name), kind = i.kind === "identity" || i.kind === "pool" ? i.kind : undefined, m = models(i.models);
    const err = opt(i.modelsError, (x) => str(x, MAX_CHAT_TEXT));
    if (n === undefined || !kind || !m || !err.ok) return undefined;
    return withOpt({ name: n, kind, models: m } as ChatCatalogProvider["identities"][number], { modelsError: err.v });
  });
  return provider && efforts && identities ? { provider, identities, efforts } : undefined;
}

export function parseChatFromExt(v: unknown): ChatFromExt | undefined {
  if (!isRec(v)) return undefined;
  const chatId = id(v.chatId);
  switch (v.t) {
    case "chat.create": {
      const n = name(v.name), c = color(v.color), windowId = int(v.windowId), s = selection(v.selection), tabs = tabIds(v.tabIds);
      if (!chatId || n === undefined || c === undefined || windowId === undefined || !s || !tabs) return undefined;
      return { t: "chat.create", chatId, name: n, color: c, windowId, selection: s, tabIds: tabs };
    }
    case "chat.prompt": {
      const t = text(v.text);
      return chatId && t !== undefined && t.length >= 1 ? { t: "chat.prompt", chatId, text: t } : undefined;
    }
    case "chat.cancel": return chatId ? { t: "chat.cancel", chatId } : undefined;
    case "chat.close": return chatId ? { t: "chat.close", chatId } : undefined;
    case "chat.permission": {
      const requestId = str(v.requestId), optionId = opt(v.optionId, (x) => str(x));
      if (!chatId || requestId === undefined || !optionId.ok) return undefined;
      return withOpt({ t: "chat.permission", chatId, requestId } as ChatFromExt, { optionId: optionId.v });
    }
    case "chat.link": {
      const tabs = tabIds(v.tabIds);
      return chatId && tabs ? { t: "chat.link", chatId, tabIds: tabs } : undefined;
    }
    case "chat.config": {
      const m = opt(v.model, sel), e = opt(v.effort, sel);
      if (!chatId || !m.ok || !e.ok) return undefined;
      return withOpt({ t: "chat.config", chatId } as ChatFromExt, { model: m.v, effort: e.v });
    }
    case "chat.rename": {
      const n = name(v.name);
      return chatId && n !== undefined ? { t: "chat.rename", chatId, name: n } : undefined;
    }
    case "chat.resume": {
      const afterSeq = int(v.afterSeq);
      return chatId && afterSeq !== undefined ? { t: "chat.resume", chatId, afterSeq } : undefined;
    }
    case "chat.list": {
      const w = opt(v.windowId, int);
      return w.ok ? withOpt({ t: "chat.list" } as ChatFromExt, { windowId: w.v }) : undefined;
    }
    case "chat.catalog": {
      const reqId = id(v.reqId), p = opt(v.provider, (x) => oneOf(CHAT_PROVIDERS, x));
      if (!reqId || !p.ok) return undefined;
      return withOpt({ t: "chat.catalog", reqId } as ChatFromExt, { provider: p.v });
    }
    case "chat.fav.list": return { t: "chat.fav.list" };
    case "chat.fav.set": {
      const changes = list(v.changes, MAX_FAVOURITES, favChange);
      return changes ? { t: "chat.fav.set", changes } : undefined;
    }
    default: return undefined;
  }
}

export function parseChatToExt(v: unknown): ChatToExt | undefined {
  if (!isRec(v)) return undefined;
  switch (v.t) {
    case "chat.event": {
      const chatId = id(v.chatId), seq = int(v.seq), ts = int(v.ts), b = body(v.body);
      return chatId && seq !== undefined && ts !== undefined && b ? { t: "chat.event", chatId, seq, ts, body: b } : undefined;
    }
    case "chat.state": {
      const chatId = id(v.chatId), state = oneOf(CHAT_STATES, v.state), sm = summary(v.summary);
      return chatId && state && sm && sm.chatId === chatId ? { t: "chat.state", chatId, state, summary: sm } : undefined;
    }
    case "chat.list": {
      const chats = list(v.chats, MAX_LIST, summary);
      return chats ? { t: "chat.list", chats } : undefined;
    }
    case "chat.reject": {
      const chatId = opt(v.chatId, id), reqId = opt(v.reqId, id), code = errorCode(v.code), message = str(v.message, MAX_CHAT_TEXT);
      if (!chatId.ok || !reqId.ok || !code || message === undefined) return undefined;
      return withOpt({ t: "chat.reject", code, message } as ChatToExt, { chatId: chatId.v, reqId: reqId.v });
    }
    case "chat.catalog": {
      const reqId = id(v.reqId), providers = list(v.providers, MAX_LIST, catalogProvider);
      return reqId && providers ? { t: "chat.catalog", reqId, providers } : undefined;
    }
    case "chat.fav.list": {
      const seq = int(v.seq), items = list(v.items, MAX_FAVOURITES, favKey);
      return seq !== undefined && items ? { t: "chat.fav.list", seq, items } : undefined;
    }
    default: return undefined;
  }
}
