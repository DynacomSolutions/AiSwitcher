// Types shared by the service worker and the side panel for chats.
import type { ChatBody, ChatCatalogProvider, ChatProvider, ChatSelection, ChatSummary, FavKey } from "../../../../src/browser/chat-protocol.ts";
import { CHAT_PROVIDERS, MAX_CHATS_PER_WINDOW } from "../../../../src/browser/chat-protocol.ts";

/** Shown by the hub and by the panel when a window has the most chats. */
export const CAP_MESSAGE = `You can have ${MAX_CHATS_PER_WINDOW} chats in one window. Close a chat to start another.`;

export interface ChatItem { seq: number; ts: number; body: ChatBody }
export interface ChatView { summary: ChatSummary; items: ChatItem[]; pending?: { permission?: string } }
/** `favourites` are the starred models: the gateway list, with the changes the user made that the gateway has not confirmed yet. */
export interface ChatPanelState { windowId: number; connected: boolean; chats: ChatView[]; catalog?: ChatCatalogProvider[]; favourites?: FavKey[]; cap: number; error?: string }

export type ChatPanelCommand =
  | { type: "ais-chat-create"; windowId: number; selection: ChatSelection; text?: string; tabIds: number[] }
  | { type: "ais-chat-prompt"; chatId: string; text: string } | { type: "ais-chat-cancel"; chatId: string }
  | { type: "ais-chat-permission"; chatId: string; requestId: string; optionId?: string }
  | { type: "ais-chat-link"; chatId: string; tabIds: number[] } | { type: "ais-chat-config"; chatId: string; model?: string; effort?: string }
  | { type: "ais-chat-rename"; chatId: string; name: string } | { type: "ais-chat-close"; chatId: string } | { type: "ais-chat-catalog"; provider?: ChatProvider }
  /** Stars a model (`add`) or takes the star away (`remove`). */
  | ({ type: "ais-chat-favourite"; op: "add" | "remove" } & FavKey);

export type ChatCommandResult = { ok: true } | { ok: false; error: string };

/** What the panel sends on the port to choose the window whose state it wants. */
export interface ChatPortSubscribe { type: "ais-chat-subscribe"; windowId: number }

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isOptStr = (v: unknown): boolean => v === undefined || typeof v === "string";
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isIntList = (v: unknown): v is number[] => Array.isArray(v) && v.every(isInt);

/**
 * Checks the shape of a panel command. The hub checks every frame again with the protocol parser before it sends it,
 * so this check only makes sure the fields exist with the right types.
 */
export function parsePanelCommand(v: unknown): ChatPanelCommand | undefined {
  if (!isRec(v)) return undefined;
  switch (v.type) {
    case "ais-chat-create": {
      const s = v.selection;
      if (!isInt(v.windowId) || !isIntList(v.tabIds) || !isOptStr(v.text) || !isRec(s)) return undefined;
      if (!(CHAT_PROVIDERS as readonly unknown[]).includes(s.provider) || !isStr(s.identity) || !isOptStr(s.model) || !isOptStr(s.effort)) return undefined;
      return v as unknown as ChatPanelCommand;
    }
    case "ais-chat-prompt": return isStr(v.chatId) && isStr(v.text) ? (v as unknown as ChatPanelCommand) : undefined;
    case "ais-chat-cancel": case "ais-chat-close": return isStr(v.chatId) ? (v as unknown as ChatPanelCommand) : undefined;
    case "ais-chat-permission": return isStr(v.chatId) && isStr(v.requestId) && isOptStr(v.optionId) ? (v as unknown as ChatPanelCommand) : undefined;
    case "ais-chat-link": return isStr(v.chatId) && isIntList(v.tabIds) ? (v as unknown as ChatPanelCommand) : undefined;
    case "ais-chat-config": return isStr(v.chatId) && isOptStr(v.model) && isOptStr(v.effort) ? (v as unknown as ChatPanelCommand) : undefined;
    case "ais-chat-rename": return isStr(v.chatId) && isStr(v.name) ? (v as unknown as ChatPanelCommand) : undefined;
    case "ais-chat-catalog": return v.provider === undefined || (CHAT_PROVIDERS as readonly unknown[]).includes(v.provider) ? (v as unknown as ChatPanelCommand) : undefined;
    case "ais-chat-favourite": return (v.op === "add" || v.op === "remove") && (CHAT_PROVIDERS as readonly unknown[]).includes(v.provider) && isStr(v.identity) && isStr(v.model) ? (v as unknown as ChatPanelCommand) : undefined;
    default: return undefined;
  }
}

export function parsePortSubscribe(v: unknown): ChatPortSubscribe | undefined {
  return isRec(v) && v.type === "ais-chat-subscribe" && isInt(v.windowId) ? { type: "ais-chat-subscribe", windowId: v.windowId } : undefined;
}
