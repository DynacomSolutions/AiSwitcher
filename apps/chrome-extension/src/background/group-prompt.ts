// One-time approval prompt for request_group. Each prompt is a pending request that lives in the worker.
// A Chrome notification (with buttons where the OS shows them), the side panel and a popup page all answer through approve() and deny().
import type { ChromeApi } from "./chrome-api.ts";
import { NOTIFICATION_TITLE, SHARED_NOTE, consentText, notificationMessage } from "../shared/request.ts";
import type { PendingRequest, RequestInfo } from "../shared/request.ts";

export type PromptAnswer = "approve" | "deny" | "closed" | "timeout" | "aborted";

export const APPROVE_LABEL = "Approve";
export const DENY_LABEL = "Deny";
export const POPUP_PATH = "request.html";
export const POPUP_SIZE = { width: 420, height: 360 };

interface Entry { request: PendingRequest; resolve: (answer: PromptAnswer) => void }

export class GroupPrompt {
  private readonly pending = new Map<string, Entry>();
  private readonly listeners: Array<() => void> = [];

  constructor(private readonly api: ChromeApi, private readonly newId: () => string = () => crypto.randomUUID(), private readonly now: () => number = () => Date.now()) {
    // Registered when the worker starts, so the listeners exist when Chrome wakes it for a click.
    api.notifications.onButtonClicked((id, index) => this.settle(id, index === 0 ? "approve" : "deny"));
    api.notifications.onClosed(id => this.settle(id, "closed"));
    api.notifications.onClicked(id => { void this.open(id); });
  }

  /** Called after the list of pending requests changed. */
  onChange(listener: () => void): void { this.listeners.push(listener); }

  /** The requests that wait for an answer, oldest first. */
  list(): PendingRequest[] { return [...this.pending.values()].map(e => e.request); }

  /** The one answer path of every UI. False when the request has ended. */
  approve(id: string): boolean { return this.settle(id, "approve"); }
  deny(id: string): boolean { return this.settle(id, "deny"); }

  /** Shows the request where the owner sees it: the side panel of the last focused window, else a popup window. */
  async open(id: string): Promise<void> {
    if (!this.pending.has(id)) return;
    try {
      const windowId = await this.api.panel.lastFocusedWindowId();
      if (windowId === undefined) throw new Error("no window");
      await this.api.panel.openSidePanel(windowId);
    } catch {
      await this.api.panel.openPopup(`${POPUP_PATH}?id=${encodeURIComponent(id)}`, POPUP_SIZE).catch(() => {});
    }
  }

  /** Shows the prompt and waits for one answer. The notification is always cleared when the wait ends. */
  async ask(info: RequestInfo, signal: AbortSignal, timeoutMs: number): Promise<PromptAnswer> {
    if (signal.aborted) return "aborted";
    const id = this.newId();
    const createdAt = this.now();
    const request: PendingRequest = { ...info, id, consent: consentText(info.allowClose), ...(info.shared ? { note: SHARED_NOTE } : {}), createdAt, deadline: createdAt + timeoutMs };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const answer = new Promise<PromptAnswer>(resolve => {
      this.pending.set(id, { request, resolve });
      timer = setTimeout(() => this.settle(id, "timeout"), timeoutMs);
      onAbort = () => this.settle(id, "aborted");
      signal.addEventListener("abort", onAbort, { once: true });
    });
    this.changed();
    try {
      await this.api.notifications.create(id, { title: NOTIFICATION_TITLE, message: notificationMessage(info), buttons: [APPROVE_LABEL, DENY_LABEL] });
    } catch {
      // The notification failed, but the side panel and the popup can still show the request.
      void this.open(id);
    }
    try {
      return await answer;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
      this.pending.delete(id);
      this.changed();
      await this.api.notifications.clear(id).catch(() => {});
    }
  }

  private settle(id: string, answer: PromptAnswer): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    entry.resolve(answer);
    this.changed();
    return true;
  }

  private changed(): void { for (const l of this.listeners) l(); }
}
