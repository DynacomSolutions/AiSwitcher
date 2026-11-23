// One-time approval prompt for request_group. Each prompt is a pending request that lives in the worker, apart from the tool call that asked.
// A Chrome notification (with buttons where the OS shows them), the side panel and a popup page all answer through approve() and deny().
// A call that stops waiting never ends the request. The same session joins it again, or reads the answer within ANSWER_KEEP_MS.
import type { ChromeApi } from "./chrome-api.ts";
import { NOTIFICATION_TITLE, SHARED_NOTE, consentText, notificationMessage } from "../shared/request.ts";
import type { PendingRequest, RequestInfo } from "../shared/request.ts";

export type PromptAnswer = "approve" | "deny" | "closed" | "timeout" | "aborted";

export const APPROVE_LABEL = "Approve";
export const DENY_LABEL = "Deny";
export const POPUP_PATH = "request.html";
export const POPUP_SIZE = { width: 420, height: 360 };
/** An answer stays readable for the asking session this long. */
export const ANSWER_KEEP_MS = 10 * 60_000;

interface Entry<M> { request: PendingRequest; sessionId: string; meta: M; done: Promise<PromptAnswer>; resolve: (answer: PromptAnswer) => void; timer: ReturnType<typeof setTimeout> }
interface Answered<M> { id: string; answer: PromptAnswer; at: number; meta: M }

export class GroupPrompt<M = unknown> {
  private readonly pending = new Map<string, Entry<M>>();
  private readonly answered = new Map<string, Answered<M>>();
  /** Popup windows that the worker opened for a request: tab id to request id. Only these tabs may answer. */
  private readonly popupTabs = new Map<number, string>();
  private readonly listeners: Array<() => void> = [];
  /** The last focused normal window. Cached so the click handler needs no await before sidePanel.open. */
  private windowId: number | undefined;

  constructor(private readonly api: ChromeApi, private readonly newId: () => string = () => crypto.randomUUID(), private readonly now: () => number = () => Date.now()) {
    // Registered when the worker starts, so the listeners exist when Chrome wakes it for a click.
    api.notifications.onButtonClicked((id, index) => this.settle(id, index === 0 ? "approve" : "deny"));
    // A close that the user did not cause (the system moved it away) leaves the request pending in the side panel.
    api.notifications.onClosed((id, byUser) => { if (byUser) this.settle(id, "closed"); });
    api.notifications.onClicked(id => { this.open(id); });
    // The side panel can open only inside the click handler, so the window id is known before the click.
    api.panel.onWindowFocused(windowId => { this.windowId = windowId; });
    api.panel.onWindowRemoved(windowId => { if (this.windowId === windowId) this.windowId = undefined; });
    void api.panel.lastFocusedWindowId().then(windowId => { if (this.windowId === undefined) this.windowId = windowId; }, () => {});
    api.tabs.onRemoved(tabId => { this.popupTabs.delete(tabId); });
  }

  /** Called after the list of pending requests changed. */
  onChange(listener: () => void): void { this.listeners.push(listener); }

  /** The requests that wait for an answer, oldest first. */
  list(): PendingRequest[] { return [...this.pending.values()].map(e => e.request); }

  /** The one answer path of every UI. False when the request has ended. */
  approve(id: string): boolean { return this.settle(id, "approve"); }
  deny(id: string): boolean { return this.settle(id, "deny"); }

  /** The request that a popup tab was opened for. */
  popupRequestId(tabId: number): string | undefined { return this.popupTabs.get(tabId); }

  /** Shows the request in the side panel of the last focused window, else in a popup window. Only a human click on the notification calls this.
   *  It must stay synchronous up to sidePanel.open: any await before it loses the user gesture. */
  open(id: string): void {
    if (!this.pending.has(id)) return;
    const windowId = this.windowId;
    if (windowId === undefined) { void this.openPopup(id, windowId); return; }
    let opened: Promise<void>;
    try { opened = this.api.panel.openSidePanel(windowId); } catch { opened = Promise.reject(new Error("refused")); }
    opened.catch(() => this.openPopup(id, windowId));
  }

  private async openPopup(id: string, windowId: number | undefined): Promise<void> {
    if (!this.pending.has(id)) return;
    const bounds = windowId === undefined ? undefined : await this.api.panel.windowBounds(windowId).catch(() => undefined);
    const place = bounds ? { left: Math.round(bounds.left + (bounds.width - POPUP_SIZE.width) / 2), top: Math.round(bounds.top + (bounds.height - POPUP_SIZE.height) / 2) } : {};
    const tabId = await this.api.panel.openPopup(`${POPUP_PATH}?id=${encodeURIComponent(id)}`, { ...POPUP_SIZE, ...place }).catch(() => undefined);
    if (tabId !== undefined) this.popupTabs.set(tabId, id);
  }

  /** The pending request of this session for this group. */
  pendingFor(sessionId: string, groupId: number): { id: string; deadline: number; meta: M } | undefined {
    for (const e of this.pending.values()) if (e.sessionId === sessionId && e.request.groupId === groupId) return { id: e.request.id, deadline: e.request.deadline, meta: e.meta };
    return undefined;
  }

  /** The answer that came after the last call of this session returned, kept for ANSWER_KEEP_MS. */
  answerFor(sessionId: string, groupId: number): { id: string; answer: PromptAnswer; meta: M } | undefined {
    const key = `${sessionId}\u0000${groupId}`;
    const a = this.answered.get(key);
    if (!a) return undefined;
    if (this.now() - a.at > ANSWER_KEEP_MS) { this.answered.delete(key); return undefined; }
    return a;
  }

  forgetAnswer(sessionId: string, groupId: number): void { this.answered.delete(`${sessionId}\u0000${groupId}`); }

  /** Ends every pending request of a session that ended. */
  cancelSession(sessionId: string): void {
    for (const [id, e] of [...this.pending]) if (e.sessionId === sessionId) this.settle(id, "aborted");
  }

  /** Shows a new request. It waits `timeoutMs` for an answer, whatever the asking call does. */
  start(sessionId: string, info: RequestInfo, timeoutMs: number, meta: M): { id: string; deadline: number } {
    const id = this.newId();
    const createdAt = this.now();
    const request: PendingRequest = { ...info, id, consent: consentText(info.allowClose), ...(info.shared ? { note: SHARED_NOTE } : {}), createdAt, deadline: createdAt + timeoutMs };
    let resolve!: (answer: PromptAnswer) => void;
    const done = new Promise<PromptAnswer>(r => { resolve = r; });
    const timer = setTimeout(() => this.settle(id, "timeout"), timeoutMs);
    this.pending.set(id, { request, sessionId, meta, done, resolve, timer });
    this.answered.delete(`${sessionId}\u0000${info.groupId}`);
    this.changed();
    // A failed notification leaves the request pending in the side panel. No window opens without a human click: the badge tells the owner.
    void this.api.notifications.create(id, { title: NOTIFICATION_TITLE, message: notificationMessage(info), buttons: [APPROVE_LABEL, DENY_LABEL] }).catch(() => {});
    return { id, deadline: request.deadline };
  }

  /** Waits up to `ms` for the answer. "waiting" means the request is still open. A call abort ends the wait only. */
  async wait(id: string, ms: number, signal: AbortSignal): Promise<PromptAnswer | "waiting"> {
    const entry = this.pending.get(id);
    if (!entry) return [...this.answered.values()].find(a => a.id === id)?.answer ?? "aborted"; // it ended just now
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stop = new Promise<"waiting">(resolve => {
      timer = setTimeout(() => resolve("waiting"), ms);
      onAbort = () => resolve("waiting");
      if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([entry.done, stop]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private settle(id: string, answer: PromptAnswer): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    this.answered.set(`${entry.sessionId}\u0000${entry.request.groupId}`, { id, answer, at: this.now(), meta: entry.meta });
    entry.resolve(answer);
    this.changed();
    void this.api.notifications.clear(id).catch(() => {});
    return true;
  }

  private changed(): void {
    void this.api.panel.setBadge(this.pending.size > 0 ? "!" : "").catch(() => {});
    for (const l of this.listeners) l();
  }
}
