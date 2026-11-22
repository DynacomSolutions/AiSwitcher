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

export interface ChatSelection { provider: ChatProvider; identity: string; model?: string; effort?: string }
export interface ChatSummary { chatId: string; name: string; color: string; windowId: number; state: ChatState; selection: ChatSelection; tabIds: number[]; lastSeq: number; updatedAt: number }
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
  | { t: "chat.catalog"; reqId: string; provider?: ChatProvider };
export interface ChatCatalogProvider { provider: ChatProvider; identities: Array<{ name: string; kind: "identity" | "pool"; models: Array<{ id: string; name: string }>; modelsError?: string }>; efforts: string[] }
export type ChatToExt =
  | { t: "chat.event"; chatId: string; seq: number; ts: number; body: ChatBody } | { t: "chat.state"; chatId: string; state: ChatState; summary: ChatSummary }
  | { t: "chat.list"; chats: ChatSummary[] } | { t: "chat.reject"; chatId?: string; reqId?: string; code: ChatErrorCode; message: string }
  | { t: "chat.catalog"; reqId: string; providers: ChatCatalogProvider[] };

export const sessionIdForChat = (chatId: string): string => `chat:${chatId}`;

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/;
const MAX_SHORT = 256;
const MAX_LIST = 256;
const TOOL_STATUS = ["pending", "running", "done", "failed"] as const;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max = MAX_SHORT): v is string => typeof v === "string" && v.length <= max;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);
const oneOf = <T extends string>(set: readonly T[], v: unknown): v is T => typeof v === "string" && (set as readonly string[]).includes(v);
const optStr = (v: unknown, max = MAX_SHORT): boolean => v === undefined || isStr(v, max);
const isText = (v: unknown): v is string => isStr(v, MAX_CHAT_TEXT);
const isTabIds = (v: unknown): v is number[] => Array.isArray(v) && v.length <= MAX_CHAT_TABS && v.every(isInt);
const isName = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= MAX_CHAT_NAME;
const isModels = (v: unknown): v is Array<{ id: string; name: string }> => Array.isArray(v) && v.length <= MAX_LIST && v.every((m) => isRec(m) && isStr(m.id) && isStr(m.name));
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= MAX_LIST && v.every((s) => isStr(s));

function isSelection(v: unknown): v is ChatSelection {
  return isRec(v) && oneOf(CHAT_PROVIDERS, v.provider) && isStr(v.identity) && v.identity.length > 0 && optStr(v.model) && optStr(v.effort);
}

function isSummary(v: unknown): v is ChatSummary {
  return isRec(v) && isId(v.chatId) && isName(v.name) && typeof v.color === "string" && COLOR_RE.test(v.color) && isInt(v.windowId)
    && oneOf(CHAT_STATES, v.state) && isSelection(v.selection) && isTabIds(v.tabIds) && isInt(v.lastSeq) && typeof v.updatedAt === "number" && Number.isFinite(v.updatedAt);
}

function isBody(v: unknown): v is ChatBody {
  if (!isRec(v)) return false;
  switch (v.k) {
    case "user": case "text": case "thought": case "notice": return isText(v.text);
    case "tool": return isStr(v.toolCallId) && isStr(v.title, MAX_CHAT_TEXT) && oneOf(TOOL_STATUS, v.status) && optStr(v.args, MAX_CHAT_TEXT) && optStr(v.result, MAX_CHAT_TEXT);
    case "permission": return isStr(v.requestId) && (isStr(v.rpcId) || typeof v.rpcId === "number") && isStr(v.title, MAX_CHAT_TEXT)
      && Array.isArray(v.options) && v.options.length <= MAX_LIST && v.options.every((o) => isRec(o) && isStr(o.id) && isStr(o.name) && isStr(o.kind));
    case "permission_resolved": return isStr(v.requestId) && optStr(v.optionId) && (v.cancelled === undefined || typeof v.cancelled === "boolean");
    case "error": return oneOf(CHAT_ERROR_CODES, v.code) && isStr(v.message, MAX_CHAT_TEXT);
    case "turn_end": return isStr(v.stopReason);
    case "config": return isModels(v.models) && isStrList(v.efforts) && isRec(v.current) && optStr(v.current.model) && optStr(v.current.effort);
    default: return false;
  }
}

function isCatalogProvider(v: unknown): v is ChatCatalogProvider {
  return isRec(v) && oneOf(CHAT_PROVIDERS, v.provider) && isStrList(v.efforts) && Array.isArray(v.identities) && v.identities.length <= MAX_LIST
    && v.identities.every((i) => isRec(i) && isStr(i.name) && (i.kind === "identity" || i.kind === "pool") && isModels(i.models) && optStr(i.modelsError, MAX_CHAT_TEXT));
}

export function parseChatFromExt(v: unknown): ChatFromExt | undefined {
  if (!isRec(v) || typeof v.t !== "string") return undefined;
  const ok = ((): boolean => {
    switch (v.t) {
      case "chat.create": return isId(v.chatId) && isName(v.name) && typeof v.color === "string" && COLOR_RE.test(v.color) && isInt(v.windowId) && isSelection(v.selection) && isTabIds(v.tabIds);
      case "chat.prompt": return isId(v.chatId) && isText(v.text);
      case "chat.cancel": case "chat.close": return isId(v.chatId);
      case "chat.permission": return isId(v.chatId) && isStr(v.requestId) && optStr(v.optionId);
      case "chat.link": return isId(v.chatId) && isTabIds(v.tabIds);
      case "chat.config": return isId(v.chatId) && optStr(v.model) && optStr(v.effort);
      case "chat.rename": return isId(v.chatId) && isName(v.name);
      case "chat.resume": return isId(v.chatId) && isInt(v.afterSeq);
      case "chat.list": return v.windowId === undefined || isInt(v.windowId);
      case "chat.catalog": return isId(v.reqId) && (v.provider === undefined || oneOf(CHAT_PROVIDERS, v.provider));
      default: return false;
    }
  })();
  return ok ? (v as unknown as ChatFromExt) : undefined;
}

export function parseChatToExt(v: unknown): ChatToExt | undefined {
  if (!isRec(v) || typeof v.t !== "string") return undefined;
  const ok = ((): boolean => {
    switch (v.t) {
      case "chat.event": return isId(v.chatId) && isInt(v.seq) && typeof v.ts === "number" && Number.isFinite(v.ts) && isBody(v.body);
      case "chat.state": return isId(v.chatId) && oneOf(CHAT_STATES, v.state) && isSummary(v.summary);
      case "chat.list": return Array.isArray(v.chats) && v.chats.length <= MAX_LIST && v.chats.every(isSummary);
      case "chat.reject": return (v.chatId === undefined || isId(v.chatId)) && (v.reqId === undefined || isId(v.reqId)) && oneOf(CHAT_ERROR_CODES, v.code) && isStr(v.message, MAX_CHAT_TEXT);
      case "chat.catalog": return isId(v.reqId) && Array.isArray(v.providers) && v.providers.length <= MAX_LIST && v.providers.every(isCatalogProvider);
      default: return false;
    }
  })();
  return ok ? (v as unknown as ChatToExt) : undefined;
}
