// Background chat hub: keeps every chat's feed, talks to the gateway and serves the side panel.
// All gateway frames reach the hub already checked by the protocol parsers.
import type { ChatCatalogProvider, ChatFromExt, ChatProvider, ChatSummary, ChatToExt } from "../../../../src/browser/chat-protocol.ts";
import { MAX_CHAT_TABS, MAX_CHATS_PER_WINDOW, parseChatFromExt, sessionIdForChat } from "../../../../src/browser/chat-protocol.ts";
import { nextChatColour } from "../shared/chat-palette.ts";
import type { ChatCommandResult, ChatItem, ChatPanelCommand, ChatPanelState, ChatView } from "../shared/chat.ts";
import { parsePanelCommand, parsePortSubscribe } from "../shared/chat.ts";
import type { ChromeApi } from "./chrome-api.ts";
import { acceptPort } from "./messages.ts";
import type { TabManager } from "./tabs.ts";

export const MAX_ITEMS = 500;
/** A listener gets this window id when a change touches every window. */
export const ALL_WINDOWS = -1;
const STORE_KEY = "chatHub";
const CAP_MESSAGE = `You can have ${MAX_CHATS_PER_WINDOW} chats in one window. Close a chat to start another.`;
export const OFFLINE_MESSAGE = "AIS is not connected to the gateway. Connect it in the extension panel, then try again.";
const PERSIST_DELAY_MS = 250;

export interface ChatHubDeps {
  /** Sends a frame to the gateway. Returns false when it cannot (offline). */
  send(f: ChatFromExt): boolean;
  tabs: TabManager;
  storage: ChromeApi["sessionStorage"];
  now(): number;
  newId(): string;
  /** Lifts the stop block of a chat session on pages. Called before a new prompt. */
  resumeSession?(sessionId: string): void;
  /** A chat ended: remove its cursor and pill from pages and clear its stop block. */
  endSession?(sessionId: string): void;
  /** Timer for coalesced writes. Tests replace it. */
  timer?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

interface Entry { view: ChatView; provisional: boolean; resumeFrom?: number }
interface Stored { chats: Array<{ view: ChatView }> }

export class ChatHub {
  private readonly chats = new Map<string, Entry>();
  private readonly listeners = new Set<(windowId: number) => void>();
  private readonly catalogReqs = new Map<string, ChatProvider | undefined>();
  private catalog: ChatCatalogProvider[] | undefined;
  private connected = false;
  /** Panel error text per window. A reject that names no chat goes in `globalError` and shows in every window. */
  private readonly errors = new Map<number, string>();
  private globalError: string | undefined;
  private persistTimer: unknown;
  private writing: Promise<void> | undefined;
  private dirty = false;

  constructor(private readonly d: ChatHubDeps) {}

  /** Restores chats after a service worker restart. Call before the tab manager loads. */
  async load(): Promise<void> {
    const raw = (await this.d.storage.get([STORE_KEY]))[STORE_KEY] as Stored | undefined;
    if (!raw || !Array.isArray(raw.chats)) return;
    for (const c of raw.chats) {
      const id = c?.view?.summary?.chatId;
      if (typeof id !== "string" || !Array.isArray(c.view.items) || this.chats.has(id)) continue;
      this.chats.set(id, { view: c.view, provisional: false });
    }
  }

  /** Writes now, without waiting for the timer. Used on chat close and when the panel disconnects. */
  async flush(): Promise<void> {
    if (this.persistTimer !== undefined) { this.clearTimer(); this.persistTimer = undefined; }
    do { await this.write(); } while (this.dirty);
  }

  // ---- panel side --------------------------------------------------------

  state(windowId: number): ChatPanelState {
    const chats = [...this.chats.values()].filter(e => e.view.summary.windowId === windowId).map(e => e.view);
    return { windowId, connected: this.connected, chats, ...(this.catalog ? { catalog: this.catalog } : {}), cap: MAX_CHATS_PER_WINDOW, ...(this.errors.get(windowId) ?? this.globalError ? { error: (this.errors.get(windowId) ?? this.globalError) as string } : {}) };
  }

  subscribe(l: (windowId: number) => void): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.changed(ALL_WINDOWS, false);
  }

  private changed(windowId: number, persist = true): void {
    if (persist) this.persist();
    for (const l of [...this.listeners]) { try { l(windowId); } catch { /* a bad listener never stops the hub */ } }
  }

  /** Writes soon. Many events in a burst make one write. */
  private persist(): void {
    this.dirty = true;
    if (this.persistTimer !== undefined) return;
    const timer = this.d.timer ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    this.persistTimer = timer.set(() => { this.persistTimer = undefined; void this.write(); }, PERSIST_DELAY_MS);
    this.clearTimer = () => timer.clear(this.persistTimer);
  }

  private clearTimer: () => void = () => {};

  private write(): Promise<void> {
    if (this.writing) return this.writing;
    const run = async (): Promise<void> => {
      while (this.dirty) {
        this.dirty = false;
        const data: Stored = { chats: [...this.chats.values()].filter(e => !e.provisional).map(e => ({ view: e.view })) };
        try { await this.d.storage.set({ [STORE_KEY]: data }); } catch { /* storage full: the feed stays in memory */ }
      }
    };
    this.writing = run().finally(() => { this.writing = undefined; });
    return this.writing;
  }

  // ---- gateway side ------------------------------------------------------

  /** A new connection is ready: ask for the list, replay what is missing, then publish the links. */
  onWelcome(): void {
    this.connected = true;
    this.d.send({ t: "chat.list" });
    for (const [chatId, e] of this.chats) { e.resumeFrom = lastSeq(e.view); this.d.send({ t: "chat.resume", chatId, afterSeq: e.resumeFrom }); }
    for (const chatId of this.chats.keys()) this.sendLinks(chatId);
    this.changed(ALL_WINDOWS, false);
  }

  /** The link set of a chat session changed (a tab closed, moved or was created by the agent). */
  onLinks(sessionId: string, tabIds: number[]): void {
    const chatId = chatIdOf(sessionId);
    const e = chatId === undefined ? undefined : this.chats.get(chatId);
    if (chatId === undefined || !e) return;
    e.view.summary = { ...e.view.summary, tabIds: [...tabIds] };
    this.d.send({ t: "chat.link", chatId, tabIds: tabIds.slice(0, MAX_CHAT_TABS) });
    this.changed(e.view.summary.windowId);
  }

  /** The user stopped the agent of this chat on a page: the turn stops too. */
  onSessionStopped(sessionId: string): void {
    const chatId = chatIdOf(sessionId);
    if (chatId !== undefined && this.chats.has(chatId)) this.d.send({ t: "chat.cancel", chatId });
  }

  /** The full Stop: cancel the turn of every chat that has one running. */
  cancelRunning(): void {
    for (const [chatId, e] of this.chats) if (e.view.summary.state === "thinking" || e.view.summary.state === "waiting") this.d.send({ t: "chat.cancel", chatId });
  }

  private sendLinks(chatId: string): void {
    this.d.send({ t: "chat.link", chatId, tabIds: this.d.tabs.chatLinks(sessionIdForChat(chatId)).slice(0, MAX_CHAT_TABS) });
  }

  handleFrame(f: ChatToExt): void {
    switch (f.t) {
      case "chat.event": return this.onEvent(f.chatId, f.seq, f.ts, f.body);
      case "chat.state": return this.onState(f.summary);
      case "chat.list": return this.onList(f.chats);
      case "chat.catalog": {
        const had = this.catalogReqs.has(f.reqId);
        const provider = this.catalogReqs.get(f.reqId);
        this.catalogReqs.delete(f.reqId);
        if (!had) return;
        this.catalog = provider === undefined ? f.providers : [...(this.catalog ?? []).filter(p => p.provider !== provider), ...f.providers];
        this.changed(ALL_WINDOWS, false);
        return;
      }
      case "chat.reject": return this.onReject(f);
    }
  }

  private onEvent(chatId: string, seq: number, ts: number, body: ChatItem["body"]): void {
    const e = this.chats.get(chatId);
    if (!e) return;
    const last = lastSeq(e.view);
    if (seq <= last) return; // seen: a replay after a resume
    if (seq > last + 1) {
      // A gap. Drop the event and ask for the missing ones once for this position.
      if (e.resumeFrom !== last) { e.resumeFrom = last; this.d.send({ t: "chat.resume", chatId, afterSeq: last }); }
      return;
    }
    e.resumeFrom = undefined;
    e.provisional = false;
    const items = [...e.view.items, { seq, ts, body }];
    if (items.length > MAX_ITEMS) items.splice(0, items.length - MAX_ITEMS);
    let pending = e.view.pending;
    if (body.k === "permission") pending = { permission: body.requestId };
    else if (body.k === "permission_resolved" && pending?.permission === body.requestId) pending = undefined;
    e.view = { summary: e.view.summary, items, ...(pending ? { pending } : {}) };
    this.changed(e.view.summary.windowId);
  }

  private onState(summary: ChatSummary): void {
    const e = this.chats.get(summary.chatId);
    if (e) { e.view = { ...e.view, summary }; e.provisional = false; } else this.chats.set(summary.chatId, { view: { summary, items: [] }, provisional: false });
    if (summary.state === "closed") this.d.tabs.setChatLinks(sessionIdForChat(summary.chatId), [], true);
    this.catchUp(summary.chatId);
    this.changed(summary.windowId);
  }

  private onList(list: ChatSummary[]): void {
    const seen = new Set<string>();
    for (const summary of list) {
      seen.add(summary.chatId);
      const e = this.chats.get(summary.chatId);
      if (e) { e.view = { ...e.view, summary }; e.provisional = false; } else this.chats.set(summary.chatId, { view: { summary, items: [] }, provisional: false });
      this.catchUp(summary.chatId);
    }
    // The gateway no longer knows these chats (closed or expired).
    for (const [id, e] of [...this.chats]) {
      if (seen.has(id) || e.provisional) continue;
      this.chats.delete(id);
      this.d.tabs.setChatLinks(sessionIdForChat(id), [], true);
    }
    this.changed(ALL_WINDOWS);
  }

  /** The gateway is ahead of the feed: ask once for the items after the last one seen. */
  private catchUp(chatId: string): void {
    const e = this.chats.get(chatId);
    if (!e) return;
    const last = lastSeq(e.view);
    if (e.view.summary.lastSeq <= last || e.resumeFrom === last) return;
    e.resumeFrom = last;
    this.d.send({ t: "chat.resume", chatId, afterSeq: last });
  }

  private onReject(f: Extract<ChatToExt, { t: "chat.reject" }>): void {
    if (f.reqId !== undefined) this.catalogReqs.delete(f.reqId);
    const e = f.chatId === undefined ? undefined : this.chats.get(f.chatId);
    if (e) { this.errors.set(e.view.summary.windowId, f.message); e.resumeFrom = undefined; } else this.globalError = f.message;
    if (f.chatId !== undefined && e?.provisional) {
      this.chats.delete(f.chatId);
      this.d.tabs.setChatLinks(sessionIdForChat(f.chatId), [], true);
    }
    this.changed(e?.view.summary.windowId ?? ALL_WINDOWS);
  }

  // ---- commands from the panel ------------------------------------------

  async command(c: ChatPanelCommand): Promise<ChatCommandResult> {
    const windowId = c.type === "ais-chat-create" ? c.windowId : "chatId" in c ? this.chats.get(c.chatId)?.view.summary.windowId : undefined;
    const r = this.run(c);
    if (r.ok) {
      const had = this.errors.delete(windowId ?? ALL_WINDOWS) || (windowId === undefined && this.globalError !== undefined);
      if (windowId === undefined) this.globalError = undefined;
      if (had) this.changed(windowId ?? ALL_WINDOWS, false);
    } else if (windowId !== undefined) { this.errors.set(windowId, r.error); this.changed(windowId, false); } else { this.globalError = r.error; this.changed(ALL_WINDOWS, false); }
    return r;
  }

  private fail(error: string): ChatCommandResult { return { ok: false, error }; }

  private known(chatId: string): Entry | undefined { return this.chats.get(chatId); }

  private send(f: ChatFromExt): ChatCommandResult {
    return this.d.send(f) ? { ok: true } : this.fail(OFFLINE_MESSAGE);
  }

  private run(c: ChatPanelCommand): ChatCommandResult {
    switch (c.type) {
      case "ais-chat-create": return this.create(c);
      case "ais-chat-prompt": {
        if (!this.known(c.chatId)) return this.fail("This chat no longer exists.");
        if (c.text.length === 0) return this.fail("Write a message first.");
        const r = this.send({ t: "chat.prompt", chatId: c.chatId, text: c.text });
        // A page Stop blocked this agent. The user speaks to it again, so the block ends.
        if (r.ok) this.d.resumeSession?.(sessionIdForChat(c.chatId));
        return r;
      }
      case "ais-chat-cancel": return this.known(c.chatId) ? this.send({ t: "chat.cancel", chatId: c.chatId }) : this.fail("This chat no longer exists.");
      case "ais-chat-permission": {
        if (!this.known(c.chatId)) return this.fail("This chat no longer exists.");
        return this.send({ t: "chat.permission", chatId: c.chatId, requestId: c.requestId, ...(c.optionId !== undefined ? { optionId: c.optionId } : {}) });
      }
      case "ais-chat-link": return this.link(c.chatId, c.tabIds);
      case "ais-chat-config": {
        if (!this.known(c.chatId)) return this.fail("This chat no longer exists.");
        return this.send({ t: "chat.config", chatId: c.chatId, ...(c.model !== undefined ? { model: c.model } : {}), ...(c.effort !== undefined ? { effort: c.effort } : {}) });
      }
      case "ais-chat-rename": return this.known(c.chatId) ? this.send({ t: "chat.rename", chatId: c.chatId, name: c.name }) : this.fail("This chat no longer exists.");
      case "ais-chat-close": return this.close(c.chatId);
      case "ais-chat-catalog": {
        const reqId = this.d.newId();
        const r = this.send({ t: "chat.catalog", reqId, ...(c.provider !== undefined ? { provider: c.provider } : {}) });
        if (r.ok) this.catalogReqs.set(reqId, c.provider);
        return r;
      }
    }
  }

  private create(c: Extract<ChatPanelCommand, { type: "ais-chat-create" }>): ChatCommandResult {
    const inWindow = [...this.chats.values()].map(e => e.view.summary).filter(s => s.windowId === c.windowId && s.state !== "closed");
    if (inWindow.length >= MAX_CHATS_PER_WINDOW) return this.fail(CAP_MESSAGE);
    const color = nextChatColour(inWindow.map(s => s.color));
    if (color === undefined) return this.fail(CAP_MESSAGE);
    const names = new Set(inWindow.map(s => s.name));
    let n = 1;
    while (names.has(`Chat ${n}`)) n++;
    const chatId = this.d.newId();
    const tabIds = [...new Set(c.tabIds)].slice(0, MAX_CHAT_TABS);
    const frame: ChatFromExt = { t: "chat.create", chatId, name: `Chat ${n}`, color, windowId: c.windowId, selection: c.selection, tabIds };
    if (!parseChatFromExt(frame)) return this.fail("The chat request is not valid.");
    if (!this.d.send(frame)) return this.fail(OFFLINE_MESSAGE);
    const summary: ChatSummary = { chatId, name: frame.name, color, windowId: c.windowId, state: "starting", selection: c.selection, tabIds, lastSeq: 0, updatedAt: this.d.now() };
    this.chats.set(chatId, { view: { summary, items: [] }, provisional: true });
    this.d.tabs.setChatLinks(sessionIdForChat(chatId), tabIds, true);
    this.changed(c.windowId);
    if (c.text !== undefined && c.text.length > 0) this.d.send({ t: "chat.prompt", chatId, text: c.text });
    return { ok: true };
  }

  private link(chatId: string, tabIds: number[]): ChatCommandResult {
    const e = this.known(chatId);
    if (!e) return this.fail("This chat no longer exists.");
    const sessionId = sessionIdForChat(chatId);
    // The panel sends the tabs the user picked. Tabs the agent created stay linked.
    const s = this.d.tabs.sessions.get(sessionId);
    const created = s ? [...s.tabIds].filter(t => !s.adopted.has(t)) : [];
    const merged = [...new Set([...tabIds, ...created])].slice(0, MAX_CHAT_TABS);
    this.d.tabs.setChatLinks(sessionId, merged, true);
    e.view.summary = { ...e.view.summary, tabIds: merged };
    this.changed(e.view.summary.windowId);
    return this.send({ t: "chat.link", chatId, tabIds: merged });
  }

  private close(chatId: string): ChatCommandResult {
    const e = this.known(chatId);
    if (!e) return this.fail("This chat no longer exists.");
    const r = this.send({ t: "chat.close", chatId });
    if (!r.ok) return r;
    this.chats.delete(chatId);
    this.d.tabs.dropChat(sessionIdForChat(chatId));
    this.d.endSession?.(sessionIdForChat(chatId));
    this.changed(e.view.summary.windowId);
    void this.flush();
    return r;
  }
}

const lastSeq = (v: ChatView): number => v.items.at(-1)?.seq ?? 0;

function chatIdOf(sessionId: string): string | undefined {
  return sessionId.startsWith("chat:") ? sessionId.slice(5) : undefined;
}

// ---- runtime port --------------------------------------------------------

export interface PortLike {
  name: string;
  sender?: { id?: string; origin?: string };
  postMessage(m: unknown): void;
  disconnect(): void;
  onMessage: { addListener(l: (m: unknown) => void): void };
  onDisconnect: { addListener(l: () => void): void };
}

/** Serves one panel. The panel names its window, and the hub pushes that window's state on every change. */
export function servePort(port: PortLike, hub: ChatHub, runtimeId: string): boolean {
  if (!acceptPort(port, runtimeId)) { try { port.disconnect(); } catch { /* already closed */ } return false; }
  let windowId: number | undefined;
  const push = (): void => { if (windowId !== undefined) { try { port.postMessage(hub.state(windowId)); } catch { /* the panel went away */ } } };
  const off = hub.subscribe(w => { if (w === ALL_WINDOWS || w === windowId) push(); });
  port.onMessage.addListener(m => {
    const sub = parsePortSubscribe(m);
    if (sub) { windowId = sub.windowId; push(); return; }
    const cmd = parsePanelCommand(m);
    if (cmd) void hub.command(cmd);
  });
  port.onDisconnect.addListener(() => { off(); void hub.flush(); });
  return true;
}
