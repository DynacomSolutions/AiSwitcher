// runtime.onMessage handling, kept free of chrome.* so it can be unit tested with fake senders.
import type { PanelStatus } from "../shared/panel.ts";
import type { ChatCommandResult } from "../shared/chat.ts";
import { parsePanelCommand } from "../shared/chat.ts";
import type { GrantResult } from "./tabs.ts";
import type { PendingRequest } from "../shared/request.ts";

export interface MessageSender { id?: string; origin?: string; url?: string; frameId?: number; tab?: { id?: number } }

export interface MessageDeps {
  runtimeId: string;
  state: { pause(): void; resume(): void; stop(): Promise<void>; stopSession(sessionId: string): void; resumeSession(sessionId: string): void; stopTab(tabId: number): void };
  status(): Promise<PanelStatus>;
  setDisconnected(value: boolean): Promise<void>;
  isMarked(tabId: number): boolean;
  /** True when the session is marked on that tab. */
  isSessionMarked(tabId: number, sessionId: string): boolean;
  /** Grants a user's tab group to a live session. */
  grant(groupId: number, sessionId: string): Promise<GrantResult>;
  revoke(groupId: number): Promise<void>;
  /** Runs a side panel chat command. Present when chat is wired. */
  chatCommand?(cmd: NonNullable<ReturnType<typeof parsePanelCommand>>): Promise<ChatCommandResult>;
  /** Pending request_group approvals. Present when the executor is wired. */
  requests?: { list(): PendingRequest[]; answer(id: string, approve: boolean): boolean; popupRequestId(tabId: number): string | undefined };
  updater?: { check(): Promise<unknown>; update(): Promise<void>; setAuto(enabled: boolean): Promise<void> };
}

const CONTENT_TYPES = new Set(["ais-stop", "ais-stop-session", "ais-stop-tab"]);

/** Only the extension's own pages may open the chat port. A content script has the extension id but a web page origin. */
export function acceptPort(port: { name: string; sender?: { id?: string; origin?: string } }, runtimeId: string): boolean {
  return port.name === "ais-chat" && port.sender?.id === runtimeId && port.sender.origin === `chrome-extension://${runtimeId}`;
}

/** An extension page (side panel or popup page): our id, an extension origin and, when Chrome gives a url, an extension url. */
export function isOwnPage(sender: MessageSender, runtimeId: string): boolean {
  if (sender.id !== runtimeId || sender.origin !== `chrome-extension://${runtimeId}`) return false;
  return sender.url === undefined || sender.url.startsWith(`chrome-extension://${runtimeId}/`);
}

/**
 * Returns true when `reply` will be called asynchronously.
 *
 * Only this extension may talk to the worker. Everything needs an extension-page origin (side panel), with one exception:
 * the in-page Stop buttons, which come from our content script in the top frame of a tab we are currently controlling.
 */
export function handleMessage(msg: unknown, sender: MessageSender, reply: (r: unknown) => void, deps: MessageDeps): boolean {
  if (typeof msg !== "object" || msg === null) return false;
  if (sender.id !== deps.runtimeId) return false;
  const fromExtensionPage = sender.origin === `chrome-extension://${deps.runtimeId}`;
  const type = (msg as { type?: unknown }).type;
  if (type === "ais-requests" || type === "ais-request-answer") {
    // Approvals come from the side panel (it has no tab) and from the popup page the worker opened for one request. A content script has a web page origin.
    // Any other tab that shows an extension page is refused: an agent could have opened or driven it.
    if (!isOwnPage(sender, deps.runtimeId) || !deps.requests) return false;
    const popupFor = sender.tab?.id === undefined ? undefined : deps.requests.popupRequestId(sender.tab.id);
    if (sender.tab !== undefined && popupFor === undefined) return false;
    if (type === "ais-requests") { reply(deps.requests.list().filter(r => popupFor === undefined || r.id === popupFor)); return false; }
    const { id, approve } = msg as { id?: unknown; approve?: unknown };
    if (typeof id !== "string" || typeof approve !== "boolean") { reply({ ok: false, error: "bad_args" }); return false; }
    if (popupFor !== undefined && id !== popupFor) return false;
    reply({ ok: deps.requests.answer(id, approve) });
    return false;
  }
  if (!fromExtensionPage) {
    const tabId = sender.tab?.id;
    if (!CONTENT_TYPES.has(type as string) || sender.frameId !== 0 || tabId === undefined || !deps.isMarked(tabId)) return false;
    // A content script may stop only sessions marked on its own tab. The tab id is the sender's, never one from the body.
    if (type === "ais-stop-session") {
      const sessionId = (msg as { sessionId?: unknown }).sessionId;
      if (typeof sessionId !== "string" || !deps.isSessionMarked(tabId, sessionId)) return false;
    }
  }
  if (typeof type === "string" && type.startsWith("ais-chat-")) {
    // Chat commands come from extension pages only: the content script list above never includes them.
    const cmd = fromExtensionPage && deps.chatCommand ? parsePanelCommand(msg) : undefined;
    if (!cmd || !deps.chatCommand) return false;
    void deps.chatCommand(cmd).then(reply);
    return true;
  }
  switch (type) {
    case "ais-pause": deps.state.pause(); reply({ ok: true }); return false;
    case "ais-resume": deps.state.resume(); reply({ ok: true }); return false;
    case "ais-stop-session": {
      const { sessionId } = msg as { sessionId?: unknown };
      if (typeof sessionId !== "string") { reply({ ok: false, error: "bad_args" }); return false; }
      deps.state.stopSession(sessionId); reply({ ok: true }); return false;
    }
    case "ais-resume-session": {
      const { sessionId } = msg as { sessionId?: unknown };
      if (typeof sessionId !== "string") { reply({ ok: false, error: "bad_args" }); return false; }
      deps.state.resumeSession(sessionId); reply({ ok: true }); return false;
    }
    case "ais-stop-tab": {
      const tabId = sender.tab?.id;
      if (tabId === undefined) { reply({ ok: false, error: "bad_args" }); return false; }
      deps.state.stopTab(tabId); reply({ ok: true }); return false;
    }
    case "ais-stop": void deps.state.stop().then(() => reply({ ok: true })); return true;
    case "ais-disconnect": void deps.setDisconnected(true).then(() => reply({ ok: true })); return true;
    case "ais-connect": void deps.setDisconnected(false).then(() => reply({ ok: true })); return true;
    case "ais-grant": {
      const { groupId, sessionId } = msg as { groupId?: unknown; sessionId?: unknown };
      if (typeof groupId !== "number" || !Number.isInteger(groupId) || typeof sessionId !== "string") { reply({ ok: false, error: "bad_args" }); return false; }
      void deps.grant(groupId, sessionId).then(r => reply(r === "ok" ? { ok: true } : { ok: false, error: r }));
      return true;
    }
    case "ais-revoke": {
      const { groupId } = msg as { groupId?: unknown };
      if (typeof groupId !== "number" || !Number.isInteger(groupId)) { reply({ ok: false, error: "bad_args" }); return false; }
      void deps.revoke(groupId).then(() => reply({ ok: true }));
      return true;
    }
    case "ais-status": void deps.status().then(reply); return true;
    case "ais-update-check": if (!deps.updater) return false; void deps.updater.check().then(() => reply({ ok: true })); return true;
    case "ais-update-now": if (!deps.updater) return false; void deps.updater.update().then(() => reply({ ok: true })); return true;
    case "ais-update-auto": {
      const { enabled } = msg as { enabled?: unknown };
      if (!deps.updater || typeof enabled !== "boolean") { reply({ ok: false, error: "bad_args" }); return false; }
      void deps.updater.setAuto(enabled).then(() => reply({ ok: true }));
      return true;
    }
    default: return false;
  }
}
