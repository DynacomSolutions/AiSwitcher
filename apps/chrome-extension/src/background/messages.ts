// runtime.onMessage handling, kept free of chrome.* so it can be unit tested with fake senders.
import type { PanelStatus } from "../shared/panel.ts";
import type { GrantResult } from "./tabs.ts";

export interface MessageSender { id?: string; origin?: string; frameId?: number; tab?: { id?: number } }

export interface MessageDeps {
  runtimeId: string;
  state: { pause(): void; resume(): void; stop(): Promise<void> };
  status(): Promise<PanelStatus>;
  setDisconnected(value: boolean): Promise<void>;
  isMarked(tabId: number): boolean;
  /** Grants a user's tab group to a live session. */
  grant(groupId: number, sessionId: string): Promise<GrantResult>;
  revoke(groupId: number): Promise<void>;
}

/**
 * Returns true when `reply` will be called asynchronously.
 *
 * Only this extension may talk to the worker. Everything needs an extension-page origin (side panel), with one exception:
 * the in-page Stop button, which comes from our content script in the top frame of a tab we are currently controlling.
 */
export function handleMessage(msg: unknown, sender: MessageSender, reply: (r: unknown) => void, deps: MessageDeps): boolean {
  if (typeof msg !== "object" || msg === null) return false;
  if (sender.id !== deps.runtimeId) return false;
  const fromExtensionPage = sender.origin === `chrome-extension://${deps.runtimeId}`;
  const type = (msg as { type?: unknown }).type;
  if (!fromExtensionPage) {
    const tabId = sender.tab?.id;
    if (type !== "ais-stop" || sender.frameId !== 0 || tabId === undefined || !deps.isMarked(tabId)) return false;
  }
  switch (type) {
    case "ais-pause": deps.state.pause(); reply({ ok: true }); return false;
    case "ais-resume": deps.state.resume(); reply({ ok: true }); return false;
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
    default: return false;
  }
}
