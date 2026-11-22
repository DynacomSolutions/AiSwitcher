// Chat list logic for the side panel. Pure: no DOM and no chrome API.
import type { ChatProvider } from "../../../../../src/browser/chat-protocol.ts";
import { MAX_CHATS_PER_WINDOW } from "../../../../../src/browser/chat-protocol.ts";
import { CAP_MESSAGE } from "../../shared/chat.ts";
import type { ChatView } from "../../shared/chat.ts";

export type RowState = "thinking" | "waiting for you" | "idle" | "failed" | "starting";
export const STATE_LABEL: Record<RowState, string> = { thinking: "Thinking", "waiting for you": "Waiting for you", idle: "Idle", failed: "Failed", starting: "Starting" };

export function rowFor(c: ChatView, seenSeq?: number): { colour: string; name: string; provider: ChatProvider; state: RowState; unread: boolean } {
  const s = c.summary;
  const state: RowState = s.state === "thinking" ? "thinking" : s.state === "waiting" ? "waiting for you" : s.state === "failed" ? "failed" : s.state === "starting" ? "starting" : "idle";
  return { colour: s.color, name: s.name, provider: s.selection.provider, state, unread: seenSeq !== undefined && s.lastSeq > seenSeq };
}

/** Open chats of one window. Closed chats and other windows do not count. */
export function openChats(chats: ChatView[], windowId: number): ChatView[] {
  return chats.filter(c => c.summary.windowId === windowId && c.summary.state !== "closed");
}

export function capState(chats: ChatView[], windowId: number): { full: boolean; message?: string } {
  if (openChats(chats, windowId).length < MAX_CHATS_PER_WINDOW) return { full: false };
  return { full: true, message: CAP_MESSAGE };
}

/** True while a turn runs. Close asks for a confirmation then. */
export const turnRunning = (c: ChatView): boolean => c.summary.state === "thinking" || c.summary.state === "waiting";
