// Chat tab assembly: the chat list, the chat view, linked-tab chips and the composer.
// It talks to the background hub over the "ais-chat" port. Chat names and agent text go in through textContent only.
import type { TabInfo } from "../../background/chrome-api.ts";
import type { ChatCommandResult, ChatPanelCommand, ChatPanelState, ChatView } from "../../shared/chat.ts";
import { defaultChatTabs } from "../../shared/split-view.ts";
import { addableTabs, chipsFor } from "./chips.ts";
import { composerMode, createComposer } from "./composer.ts";
import type { Composer } from "./composer.ts";
import { buildFeed } from "./feed.ts";
import { renderFeed } from "./feed-view.ts";
import { capState, openChats, rowFor, STATE_LABEL, turnRunning } from "./list.ts";

const RECONNECT_MS = 500;
const LOADING_PROVIDERS = "Providers are loading. Try again in a moment.";

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(doc: Document, label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el(doc, "button", cls, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

export interface ChatViewDeps {
  doc: Document;
  windowId: number;
  /** Opens the port to the worker. Called again after the worker restarts. */
  connect(): { postMessage(m: unknown): void; onMessage(l: (m: unknown) => void): void; onDisconnect(l: () => void): void };
  queryTabs(): Promise<TabInfo[]>;
  send(c: ChatPanelCommand): Promise<ChatCommandResult | undefined>;
  confirm(text: string): boolean;
  ask(text: string, value: string): string | null;
}

export class ChatTab {
  private state: ChatPanelState | undefined;
  private tabs: TabInfo[] = [];
  private selected: string | undefined;
  private paused = false;
  private localError: string | undefined;
  private readonly seen = new Map<string, number>();
  private readonly expanded = new Set<string>();
  private known = new Set<string>();
  private openNew = false;
  private composer: Composer | undefined;
  private composerFor: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly d: ChatViewDeps, private readonly root: HTMLElement) {}

  start(): void {
    this.open();
    void this.refreshTabs();
    this.paint();
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.paint();
  }

  async refreshTabs(): Promise<void> {
    try { this.tabs = await this.d.queryTabs(); } catch { this.tabs = []; }
    this.paint();
  }

  private open(): void {
    const port = this.d.connect();
    port.onMessage(m => this.onState(m as ChatPanelState));
    port.onDisconnect(() => { this.reconnectTimer = setTimeout(() => this.open(), RECONNECT_MS); });
    port.postMessage({ type: "ais-chat-subscribe", windowId: this.d.windowId });
  }

  private onState(s: ChatPanelState): void {
    if (!s || !Array.isArray(s.chats) || s.windowId !== this.d.windowId) return;
    if (this.openNew) {
      const fresh = s.chats.find(c => !this.known.has(c.summary.chatId));
      if (fresh) { this.selected = fresh.summary.chatId; this.openNew = false; }
    }
    this.known = new Set(s.chats.map(c => c.summary.chatId));
    this.state = s;
    if (this.selected && !s.chats.some(c => c.summary.chatId === this.selected)) this.selected = undefined;
    if (this.selected) this.markSeen(this.selected);
    this.paint();
  }

  private markSeen(chatId: string): void {
    const c = this.state?.chats.find(x => x.summary.chatId === chatId);
    if (c) this.seen.set(chatId, c.summary.lastSeq);
  }

  private async run(c: ChatPanelCommand): Promise<void> {
    const r = await this.d.send(c);
    this.localError = r && !r.ok ? r.error : undefined;
    if (this.localError !== undefined) { this.openNew = false; this.paint(); }
  }

  private paint(): void {
    const s = this.state;
    if (!s) { this.root.replaceChildren(el(this.d.doc, "p", "hint", "Loading")); return; }
    const chat = this.selected ? s.chats.find(c => c.summary.chatId === this.selected) : undefined;
    const error = this.localError ?? s.error;
    const nodes: Node[] = [];
    if (!s.connected) nodes.push(el(this.d.doc, "p", "banner bad", "AIS is not connected to the gateway. Connect it in the Status tab."));
    if (error) nodes.push(el(this.d.doc, "p", "banner bad", error));
    const hadFocus = this.composer !== undefined && this.composer.root.contains(this.d.doc.activeElement);
    nodes.push(chat ? this.chatView(chat) : this.listView(s));
    this.root.replaceChildren(...nodes);
    if (chat && hadFocus) this.composer?.focus();
  }

  // ---- list ---------------------------------------------------------------

  private listView(s: ChatPanelState): HTMLElement {
    const doc = this.d.doc;
    const wrap = el(doc, "div", "chat-list");
    const cap = capState(s.chats, this.d.windowId);
    const head = el(doc, "div", "list-head");
    const create = button(doc, "New chat", "primary-small", () => void this.newChat(s));
    create.disabled = cap.full;
    head.append(el(doc, "h2", undefined, "Chats"), create);
    wrap.append(head);
    if (cap.message) wrap.append(el(doc, "p", "hint", cap.message));
    const chats = openChats(s.chats, this.d.windowId);
    if (chats.length === 0) { wrap.append(el(doc, "p", "empty", "No chats yet. Start one to ask an agent about your open pages.")); return wrap; }
    const ul = el(doc, "ul", "sessions chat-rows");
    for (const c of chats) ul.append(this.row(c));
    wrap.append(ul);
    return wrap;
  }

  private row(c: ChatView): HTMLElement {
    const doc = this.d.doc;
    const r = rowFor(c, this.seen.get(c.summary.chatId) ?? 0);
    const li = el(doc, "li", `chat-row${r.unread ? " unread" : ""}`);
    const bar = el(doc, "span", "bar");
    bar.style.background = r.colour;
    const open = button(doc, "", "row-open", () => { this.selected = c.summary.chatId; this.markSeen(c.summary.chatId); this.paint(); });
    open.append(el(doc, "span", "title", r.name), el(doc, "span", "sub", `${r.provider} / ${STATE_LABEL[r.state]}`));
    if (r.unread) open.append(el(doc, "span", "dot", "New"));
    const actions = el(doc, "div", "row-actions");
    actions.append(button(doc, "Rename", "small quiet", () => this.rename(c)), button(doc, "Close chat", "small quiet", () => this.close(c)));
    li.append(bar, open, actions);
    return li;
  }

  private async newChat(s: ChatPanelState): Promise<void> {
    const mine = openChats(s.chats, this.d.windowId);
    const last = mine.at(-1)?.summary.selection;
    const first = s.catalog?.find(p => p.identities.length > 0);
    const selection = last ?? (first ? { provider: first.provider, identity: first.identities[0]!.name } : undefined);
    if (!selection) {
      this.localError = LOADING_PROVIDERS;
      void this.d.send({ type: "ais-chat-catalog" });
      this.paint();
      return;
    }
    const active = this.tabs.find(t => t.active && t.windowId === this.d.windowId);
    const tabIds = active ? defaultChatTabs(this.tabs.filter(t => t.windowId === this.d.windowId), active.id) : [];
    this.openNew = true;
    await this.run({ type: "ais-chat-create", windowId: this.d.windowId, selection, tabIds });
  }

  private rename(c: ChatView): void {
    const name = this.d.ask("Chat name", c.summary.name)?.trim();
    if (name) void this.run({ type: "ais-chat-rename", chatId: c.summary.chatId, name });
  }

  private close(c: ChatView): void {
    if (turnRunning(c) && !this.d.confirm("The agent is still working. Close this chat?")) return;
    void this.run({ type: "ais-chat-close", chatId: c.summary.chatId });
  }

  // ---- chat ---------------------------------------------------------------

  private chatView(c: ChatView): HTMLElement {
    const doc = this.d.doc;
    const chatId = c.summary.chatId;
    const wrap = el(doc, "div", "chat-detail");
    const head = el(doc, "div", "list-head");
    const bar = el(doc, "span", "bar dot-bar");
    bar.style.background = c.summary.color;
    head.append(button(doc, "Back", "small quiet", () => { this.selected = undefined; this.composer = undefined; this.paint(); }), bar, el(doc, "h2", "chat-name", c.summary.name), el(doc, "span", "sub", STATE_LABEL[rowFor(c).state]));
    wrap.append(head, this.chips(c));
    const feed = el(doc, "div", "feed");
    renderFeed(doc, feed, buildFeed(c.items), { expanded: this.expanded, onPermission: (requestId, optionId) => void this.run({ type: "ais-chat-permission", chatId, requestId, ...(optionId !== undefined ? { optionId } : {}) }) });
    wrap.append(feed);
    if (!this.composer || this.composerFor !== chatId) {
      this.composerFor = chatId;
      this.composer = createComposer(doc, { onSend: text => void this.run({ type: "ais-chat-prompt", chatId, text }), onStop: () => void this.run({ type: "ais-chat-cancel", chatId }) });
    }
    this.composer.update(composerMode(c, this.paused));
    wrap.append(this.composer.root);
    return wrap;
  }

  private chips(c: ChatView): HTMLElement {
    const doc = this.d.doc;
    const links = c.summary.tabIds;
    const row = el(doc, "div", "chips");
    for (const chip of chipsFor(links, this.tabs)) {
      const span = el(doc, "span", chip.missing ? "chip-tab missing" : "chip-tab");
      span.append(el(doc, "span", "chip-label", chip.label));
      const x = button(doc, "x", "chip-x", () => void this.run({ type: "ais-chat-link", chatId: c.summary.chatId, tabIds: links.filter(t => t !== chip.tabId) }));
      x.setAttribute("aria-label", `Unlink ${chip.label}`);
      span.append(x);
      row.append(span);
    }
    const addable = addableTabs(links, this.tabs, this.d.windowId);
    if (addable.length > 0) {
      const pick = el(doc, "select", "chip-add");
      pick.setAttribute("aria-label", "Link a page");
      pick.append(new Option("Add a page", ""));
      for (const t of addable) pick.append(new Option((t.title || t.url).slice(0, 40), String(t.id)));
      pick.addEventListener("change", () => {
        const id = Number(pick.value);
        if (Number.isSafeInteger(id) && pick.value !== "") void this.run({ type: "ais-chat-link", chatId: c.summary.chatId, tabIds: [...links, id] });
      });
      row.append(pick);
    }
    return row;
  }
}

/** Starts the Chat tab in the real side panel. */
export function initChatTab(root: HTMLElement, windowId: number, paused: () => Promise<boolean>): ChatTab {
  const tab = new ChatTab({
    doc: document,
    windowId,
    connect: () => {
      const port = chrome.runtime.connect({ name: "ais-chat" });
      return { postMessage: m => port.postMessage(m), onMessage: l => port.onMessage.addListener(l), onDisconnect: l => port.onDisconnect.addListener(l) };
    },
    queryTabs: async () => (await chrome.tabs.query({ windowId })).filter(t => t.id !== undefined).map(t => ({ id: t.id!, windowId: t.windowId, groupId: t.groupId, url: t.url ?? "", title: t.title ?? "", active: t.active, ...(t.splitViewId !== undefined ? { splitViewId: t.splitViewId } : {}) })),
    send: async c => { try { return (await chrome.runtime.sendMessage(c)) as ChatCommandResult | undefined; } catch { return undefined; } },
    confirm: t => window.confirm(t),
    ask: (t, v) => window.prompt(t, v),
  }, root);
  const refreshPaused = (): void => { void paused().then(p => tab.setPaused(p)); };
  const refreshTabs = (): void => { void tab.refreshTabs(); };
  tab.start();
  refreshPaused();
  chrome.storage.onChanged.addListener(refreshPaused);
  chrome.tabs.onActivated.addListener(refreshTabs);
  chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status !== undefined || info.url !== undefined || info.title !== undefined) refreshTabs(); });
  chrome.tabs.onRemoved.addListener(refreshTabs);
  chrome.tabs.onCreated.addListener(refreshTabs);
  chrome.tabs.onAttached.addListener(refreshTabs);
  chrome.tabs.onDetached.addListener(refreshTabs);
  return tab;
}
