// Chat tab assembly: the chat list, the chat view, linked-tab chips and the composer.
// It talks to the background hub over the "ais-chat" port. Chat names and agent text go in through textContent only.
// The DOM is built once and patched in place, so focus, an open menu and a draft survive every state update.
import { CHAT_PROVIDERS, MAX_CHAT_NAME, MAX_CHAT_TABS } from "../../../../../src/browser/chat-protocol.ts";
import type { ChatSelection } from "../../../../../src/browser/chat-protocol.ts";
import type { TabInfo } from "../../background/chrome-api.ts";
import type { ChatCommandResult, ChatPanelCommand, ChatPanelState, ChatView } from "../../shared/chat.ts";
import { defaultChatTabs, splitPartners } from "../../shared/split-view.ts";
import { addableTabs, chipsFor } from "./chips.ts";
import { composerMode, createComposer } from "./composer.ts";
import type { Composer } from "./composer.ts";
import { buildFeed } from "./feed.ts";
import { renderFeed } from "./feed-view.ts";
import { buildPicker, choose } from "./picker.ts";
import { createPicker } from "./picker-view.ts";
import type { Picker } from "./picker-view.ts";
import { capState, openChats, rowFor, STATE_LABEL, turnRunning } from "./list.ts";

const RECONNECT_MS = 500;
export const LOADING_PROVIDERS = "Providers are loading. Try again in a moment.";
export const RESTARTED = "The extension restarted. Try again.";
export const AGENT_TAB = "The agent opened this page. Close the tab to remove it.";

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

/** Keeps the children of `parent` in the order of `keys`. Existing nodes stay in place. */
function syncKeyed<T extends { node: HTMLElement }>(parent: HTMLElement, items: Map<string, T>, keys: string[], make: (key: string) => T, patch: (item: T, key: string) => void): void {
  const want = new Set(keys);
  for (const [k, item] of items) if (!want.has(k)) { item.node.remove(); items.delete(k); }
  let ref: ChildNode | null = parent.firstChild;
  for (const key of keys) {
    let item = items.get(key);
    if (!item) { item = make(key); items.set(key, item); }
    patch(item, key);
    if (item.node === ref) ref = ref.nextSibling;
    else parent.insertBefore(item.node, ref);
  }
}

export interface ChatViewDeps {
  doc: Document;
  windowId: number;
  /** Opens the port to the worker. Called again after the worker restarts. */
  connect(): { postMessage(m: unknown): void; onMessage(l: (m: unknown) => void): void; onDisconnect(l: () => void): void };
  queryTabs(): Promise<TabInfo[]>;
  send(c: ChatPanelCommand): Promise<ChatCommandResult | undefined>;
  /** Last seen seq of each chat. Kept in session storage, so a reload keeps it. */
  loadSeen(): Promise<Record<string, number>>;
  saveSeen(seen: Record<string, number>): void;
  /** The last selection used for a new chat. Kept in local storage. */
  loadSelection?(): Promise<unknown>;
  saveSelection?(s: ChatSelection): void;
}

/** Accepts a stored selection only when it has the right shape. */
export function parseSelection(v: unknown): ChatSelection | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (!(CHAT_PROVIDERS as readonly unknown[]).includes(r.provider) || typeof r.identity !== "string" || r.identity === "") return undefined;
  return { provider: r.provider as ChatSelection["provider"], identity: r.identity, ...(typeof r.model === "string" ? { model: r.model } : {}), ...(typeof r.effort === "string" ? { effort: r.effort } : {}) };
}

interface Row {
  node: HTMLElement; bar: HTMLElement; open: HTMLButtonElement; title: HTMLElement; sub: HTMLElement; dot: HTMLElement;
  rename: HTMLButtonElement; close: HTMLButtonElement; renameForm: HTMLElement; renameBox: HTMLInputElement; confirm: HTMLElement;
}
interface Chip { node: HTMLElement; label: HTMLElement; remove: HTMLButtonElement; tabId: number }

export class ChatTab {
  private state: ChatPanelState | undefined;
  private tabs: TabInfo[] = [];
  private selected: string | undefined;
  private paused = false;
  private localError: string | undefined;
  private seen: Record<string, number> = {};
  private seenLoaded = false;
  private readonly expanded = new Set<string>();
  private known = new Set<string>();
  private openNew = false;
  private creating = false;
  private renaming: string | undefined;
  private closing: string | undefined;
  private removal: { chatId: string; tabId: number } | undefined;
  private shown: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private lastUsed: ChatSelection | undefined;
  private catalogAsked = false;

  private readonly rows = new Map<string, Row>();
  private readonly feeds = new Map<string, HTMLElement>();
  private readonly composers = new Map<string, Composer>();
  private readonly chips = new Map<string, Chip>();

  // Persistent nodes.
  private readonly loading: HTMLElement;
  private readonly connBanner: HTMLElement;
  private readonly errBanner: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly newBtn: HTMLButtonElement;
  private readonly capHint: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly ul: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly detailBar: HTMLElement;
  private readonly detailName: HTMLElement;
  private readonly detailState: HTMLElement;
  private readonly chipsEl: HTMLElement;
  private readonly addSelect: HTMLSelectElement;
  private addSig = "";
  private readonly feedSlot: HTMLElement;
  private readonly composerSlot: HTMLElement;
  private readonly listPicker: Picker;
  private readonly detailPicker: Picker;

  constructor(private readonly d: ChatViewDeps, private readonly root: HTMLElement) {
    const doc = d.doc;
    this.loading = el(doc, "p", "hint", "Loading");
    this.connBanner = el(doc, "p", "banner bad", "AIS is not connected to the gateway. Connect it in the Status tab.");
    this.errBanner = el(doc, "p", "banner bad");
    for (const b of [this.connBanner, this.errBanner]) { b.setAttribute("role", "alert"); b.hidden = true; }

    this.listEl = el(doc, "div", "chat-list");
    this.newBtn = button(doc, "New chat", "primary-small", () => void this.newChat());
    const head = el(doc, "div", "list-head");
    head.append(el(doc, "h2", undefined, "Chats"), this.newBtn);
    this.capHint = el(doc, "p", "hint");
    this.empty = el(doc, "p", "empty", "No chats yet. Start one to ask an agent about your open pages.");
    this.ul = el(doc, "ul", "sessions chat-rows");
    this.listPicker = createPicker(doc, {
      onOpen: () => this.askCatalog(),
      onPick: p => this.pickNew(p),
      onEffort: effort => { const cur = this.newSelection(); if (cur) this.setNew({ ...cur, effort }); },
    }, "Provider and model for new chats");
    this.listEl.append(head, this.listPicker.root, this.capHint, this.empty, this.ul);

    this.detailEl = el(doc, "div", "chat-detail");
    const dhead = el(doc, "div", "list-head");
    this.detailBar = el(doc, "span", "bar dot-bar");
    this.detailName = el(doc, "h2", "chat-name");
    this.detailState = el(doc, "span", "sub");
    dhead.append(button(doc, "Back", "small quiet", () => { this.selected = undefined; this.paint(); }), this.detailBar, this.detailName, this.detailState);
    this.chipsEl = el(doc, "div", "chips");
    this.addSelect = el(doc, "select", "chip-add");
    this.addSelect.setAttribute("aria-label", "Link a page");
    this.addSelect.addEventListener("change", () => this.addTab());
    this.detailPicker = createPicker(doc, {
      onOpen: () => this.askCatalog(),
      onPick: p => { const c = this.selectedChat(); if (c && p.model !== undefined) void this.run({ type: "ais-chat-config", chatId: c.summary.chatId, model: p.model }); },
      onEffort: effort => { const c = this.selectedChat(); if (c) void this.run({ type: "ais-chat-config", chatId: c.summary.chatId, effort }); },
    }, "Model for this chat");
    this.feedSlot = el(doc, "div", "feed-slot");
    this.composerSlot = el(doc, "div", "composer-slot");
    this.detailEl.append(dhead, this.chipsEl, this.feedSlot, this.detailPicker.root, this.composerSlot);
    this.detailEl.hidden = true;
    this.listEl.hidden = true;
  }

  start(): void {
    this.root.replaceChildren(this.loading, this.connBanner, this.errBanner, this.listEl, this.detailEl);
    void this.d.loadSeen().then(s => { this.seen = { ...s }; this.seenLoaded = true; this.noteSeen(); this.paint(); }, () => { this.seenLoaded = true; });
    void this.d.loadSelection?.().then(v => { this.lastUsed = parseSelection(v); this.paint(); }, () => { /* no stored selection */ });
    this.open();
    void this.refreshTabs();
  }

  private selectedChat(): ChatView | undefined { return this.selected ? this.state?.chats.find(x => x.summary.chatId === this.selected) : undefined; }

  /** Asks for the catalogue once per panel session, when a menu first opens. */
  private askCatalog(): void {
    if (this.catalogAsked || this.state?.catalog) return;
    this.catalogAsked = true;
    void this.d.send({ type: "ais-chat-catalog" });
  }

  /** The selection for a new chat: the last one used when it still exists, else the last chat, else the first identity. */
  private newSelection(): ChatSelection | undefined {
    const s = this.state;
    if (!s) return undefined;
    const catalog = s.catalog;
    const exists = (x: ChatSelection | undefined): x is ChatSelection => x !== undefined && (catalog === undefined || catalog.some(p => p.provider === x.provider && p.identities.some(i => i.name === x.identity)));
    const mine = openChats(s.chats, this.d.windowId).at(-1)?.summary.selection;
    const first = catalog?.find(p => p.identities.length > 0);
    return [this.lastUsed, mine].find(exists) ?? (first ? { provider: first.provider, identity: first.identities[0]!.name } : undefined);
  }

  private setNew(sel: ChatSelection): void {
    this.lastUsed = sel;
    this.d.saveSelection?.(sel);
    this.paint();
  }

  private pickNew(p: { provider: ChatSelection["provider"]; identity: string; model?: string }): void {
    this.setNew(choose(this.newSelection(), p, this.state?.catalog ?? []));
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

  /** Test hook: the current selection. */
  get selectedId(): string | undefined { return this.selected; }

  select(chatId: string | undefined): void {
    this.selected = chatId;
    this.paint();
  }

  onState(s: ChatPanelState): void {
    if (!s || !Array.isArray(s.chats) || s.windowId !== this.d.windowId) return;
    if (this.openNew) {
      const fresh = s.chats.find(c => !this.known.has(c.summary.chatId));
      if (fresh) { this.selected = fresh.summary.chatId; this.openNew = false; }
    }
    this.known = new Set(s.chats.map(c => c.summary.chatId));
    this.state = s;
    if (this.localError === LOADING_PROVIDERS && s.catalog?.some(p => p.identities.length > 0)) this.localError = undefined;
    if (this.selected && !s.chats.some(c => c.summary.chatId === this.selected)) this.selected = undefined;
    this.prune(s);
    this.noteSeen();
    this.checkRemoval();
    this.paint();
  }

  private prune(s: ChatPanelState): void {
    const ids = new Set(s.chats.map(c => c.summary.chatId));
    for (const map of [this.feeds, this.composers] as Array<Map<string, unknown>>) for (const k of [...map.keys()]) if (!ids.has(k)) map.delete(k);
    if (this.renaming && !ids.has(this.renaming)) this.renaming = undefined;
    if (this.closing && !ids.has(this.closing)) this.closing = undefined;
  }

  /** Records the seq of the open chat, and of a chat seen for the first time. A reload then keeps the unread marks. */
  private noteSeen(): void {
    if (!this.seenLoaded || !this.state) return;
    let changed = false;
    for (const c of this.state.chats) {
      const id = c.summary.chatId;
      if (id === this.selected || this.seen[id] === undefined) {
        if (this.seen[id] !== c.summary.lastSeq) { this.seen[id] = c.summary.lastSeq; changed = true; }
      }
    }
    if (changed) this.d.saveSeen({ ...this.seen });
  }

  private checkRemoval(): void {
    const r = this.removal;
    if (!r || !this.state) return;
    const c = this.state.chats.find(x => x.summary.chatId === r.chatId);
    this.removal = undefined;
    if (c?.summary.tabIds.includes(r.tabId)) this.localError = AGENT_TAB;
  }

  private async run(c: ChatPanelCommand): Promise<boolean> {
    const r = await this.d.send(c);
    const ok = r?.ok === true;
    // The state for a link command can arrive before its reply. Keep the note it set.
    if (!ok) this.localError = r ? r.error : RESTARTED;
    else if (!(c.type === "ais-chat-link" && this.localError === AGENT_TAB)) this.localError = undefined;
    if (!ok) { this.openNew = false; this.removal = undefined; }
    this.paint();
    return ok;
  }

  // ---- painting -----------------------------------------------------------

  private paint(): void {
    const s = this.state;
    this.loading.hidden = s !== undefined;
    if (!s) return;
    const chat = this.selected ? s.chats.find(c => c.summary.chatId === this.selected) : undefined;
    const error = this.localError ?? s.error;
    this.connBanner.hidden = s.connected;
    this.errBanner.hidden = !error;
    if (this.errBanner.textContent !== (error ?? "")) this.errBanner.textContent = error ?? "";
    this.listEl.hidden = chat !== undefined;
    this.detailEl.hidden = chat === undefined;
    if (chat) this.paintDetail(chat); else this.paintList(s);
  }

  private setText(node: HTMLElement, text: string): void { if (node.textContent !== text) node.textContent = text; }

  private paintList(s: ChatPanelState): void {
    const cap = capState(s.chats, this.d.windowId);
    this.newBtn.disabled = cap.full || this.creating;
    this.capHint.hidden = cap.message === undefined;
    this.setText(this.capHint, cap.message ?? "");
    this.listPicker.update(buildPicker(s.catalog, this.newSelection()));
    const chats = openChats(s.chats, this.d.windowId);
    this.empty.hidden = chats.length > 0;
    const byId = new Map(chats.map(c => [c.summary.chatId, c]));
    syncKeyed(this.ul, this.rows, chats.map(c => c.summary.chatId), id => this.makeRow(id), (row, id) => this.patchRow(row, byId.get(id)!));
  }

  private makeRow(chatId: string): Row {
    const doc = this.d.doc;
    const node = el(doc, "li", "chat-row");
    const bar = el(doc, "span", "bar");
    const main = el(doc, "div", "row-main");
    const open = button(doc, "", "row-open", () => { this.selected = chatId; this.localError = undefined; this.noteSeen(); this.paint(); });
    const title = el(doc, "span", "title"), sub = el(doc, "span", "sub"), dot = el(doc, "span", "dot", "New");
    open.append(title, sub, dot);
    const renameBox = el(doc, "input", "rename-box");
    renameBox.type = "text";
    renameBox.maxLength = MAX_CHAT_NAME;
    renameBox.setAttribute("aria-label", "Chat name");
    const renameForm = el(doc, "div", "inline-form");
    const save = (): void => {
      const name = renameBox.value.trim();
      this.renaming = undefined;
      if (name) void this.run({ type: "ais-chat-rename", chatId, name });
      else this.paint();
      row.rename.focus();
    };
    const cancel = (): void => { this.renaming = undefined; this.paint(); row.rename.focus(); };
    renameBox.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); save(); } else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    renameForm.append(renameBox, button(doc, "Save", "small primary-small", save), button(doc, "Cancel", "small quiet", cancel));
    const confirm = el(doc, "div", "inline-form");
    const closeNow = (): void => { this.closing = undefined; void this.run({ type: "ais-chat-close", chatId }); };
    const cancelClose = (): void => { this.closing = undefined; this.paint(); row.close.focus(); };
    confirm.append(el(doc, "span", "hint", "Close this chat? The agent stops."), button(doc, "Close", "small danger", closeNow), button(doc, "Cancel", "small quiet", cancelClose));
    main.append(open, renameForm, confirm);
    const rename = button(doc, "Rename", "small quiet", () => {
      const c = this.state?.chats.find(x => x.summary.chatId === chatId);
      if (!c) return;
      this.renaming = chatId; this.closing = undefined;
      renameBox.value = c.summary.name;
      this.paint();
      renameBox.focus();
    });
    const close = button(doc, "Close chat", "small quiet", () => {
      const c = this.state?.chats.find(x => x.summary.chatId === chatId);
      if (!c) return;
      if (turnRunning(c)) { this.closing = chatId; this.renaming = undefined; this.paint(); } else void this.run({ type: "ais-chat-close", chatId });
    });
    const actions = el(doc, "div", "row-actions");
    actions.append(rename, close);
    node.append(bar, main, actions);
    const row: Row = { node, bar, open, title, sub, dot, rename, close, renameForm, renameBox, confirm };
    return row;
  }

  private patchRow(row: Row, c: ChatView): void {
    const id = c.summary.chatId;
    const r = rowFor(c, this.seenLoaded ? this.seen[id] : undefined);
    row.node.className = r.unread ? "chat-row unread" : "chat-row";
    row.bar.style.background = r.colour;
    this.setText(row.title, r.name);
    this.setText(row.sub, `${r.provider} / ${STATE_LABEL[r.state]}`);
    row.dot.hidden = !r.unread;
    row.rename.setAttribute("aria-label", `Rename ${r.name}`);
    row.close.setAttribute("aria-label", `Close ${r.name}`);
    row.renameForm.hidden = this.renaming !== id;
    row.confirm.hidden = this.closing !== id;
  }

  private feedFor(chatId: string): HTMLElement {
    let f = this.feeds.get(chatId);
    if (!f) { f = el(this.d.doc, "div", "feed"); this.feeds.set(chatId, f); }
    return f;
  }

  private composerFor(chatId: string): Composer {
    let c = this.composers.get(chatId);
    if (!c) {
      c = createComposer(this.d.doc, { onSend: text => this.run({ type: "ais-chat-prompt", chatId, text }), onStop: () => void this.run({ type: "ais-chat-cancel", chatId }) });
      this.composers.set(chatId, c);
    }
    return c;
  }

  private paintDetail(c: ChatView): void {
    const chatId = c.summary.chatId;
    this.detailBar.style.background = c.summary.color;
    this.setText(this.detailName, c.summary.name);
    this.setText(this.detailState, STATE_LABEL[rowFor(c).state]);
    const feed = this.feedFor(chatId);
    const composer = this.composerFor(chatId);
    if (this.shown !== chatId) {
      this.shown = chatId;
      this.feedSlot.replaceChildren(feed);
      this.composerSlot.replaceChildren(composer.root);
      this.chips.clear();
      this.chipsEl.replaceChildren();
      this.addSig = "";
    }
    this.paintChips(c);
    renderFeed(this.d.doc, feed, buildFeed(c.items), { expanded: this.expanded, onPermission: (requestId, optionId) => void this.run({ type: "ais-chat-permission", chatId, requestId, ...(optionId !== undefined ? { optionId } : {}) }) });
    composer.update(composerMode(c, this.paused));
    const sel = c.summary.selection;
    const group = this.state?.catalog?.find(p => p.provider === sel.provider);
    const own = group ? [{ ...group, identities: group.identities.filter(i => i.name === sel.identity) }] : this.state?.catalog === undefined ? undefined : [];
    const cfg = [...c.items].reverse().find(i => i.body.k === "config")?.body;
    this.detailPicker.update(buildPicker(own, sel, cfg && cfg.k === "config" ? cfg : undefined));
  }

  // ---- chips --------------------------------------------------------------

  private paintChips(c: ChatView): void {
    const doc = this.d.doc;
    const links = c.summary.tabIds;
    const list = chipsFor(links, this.tabs);
    const byId = new Map(list.map(x => [String(x.tabId), x]));
    const holder = this.chipsEl;
    // The add menu is the last child. Chips go before it.
    const addable = addableTabs(links, this.tabs, this.d.windowId);
    syncChips(holder, this.chips, list.map(x => String(x.tabId)), key => {
      const node = el(doc, "span", "chip-tab");
      const label = el(doc, "span", "chip-label");
      const remove = button(doc, "x", "chip-x", () => this.unlink(chip.tabId));
      node.append(label, remove);
      const chip: Chip = { node, label, remove, tabId: Number(key) };
      return chip;
    }, (chip, key) => {
      const v = byId.get(key)!;
      chip.node.className = v.missing ? "chip-tab missing" : "chip-tab";
      this.setText(chip.label, v.label);
      chip.remove.setAttribute("aria-label", `Unlink ${v.label}`);
    });
    const sig = addable.map(t => `${t.id}:${t.title || t.url}`).join("|");
    if (sig !== this.addSig) {
      this.addSig = sig;
      const opts: HTMLElement[] = [];
      const first = el(doc, "option", undefined, "Add a page");
      first.value = "";
      opts.push(first);
      for (const t of addable) { const o = el(doc, "option", undefined, (t.title || t.url).slice(0, 40)); o.value = String(t.id); opts.push(o); }
      this.addSelect.replaceChildren(...opts);
      this.addSelect.value = "";
    }
    this.addSelect.hidden = addable.length === 0;
    if (this.addSelect.parentNode !== holder) holder.append(this.addSelect);
  }

  private unlink(tabId: number): void {
    const c = this.selected ? this.state?.chats.find(x => x.summary.chatId === this.selected) : undefined;
    if (!c) return;
    this.removal = { chatId: c.summary.chatId, tabId };
    void this.run({ type: "ais-chat-link", chatId: c.summary.chatId, tabIds: c.summary.tabIds.filter(t => t !== tabId) });
  }

  private addTab(): void {
    const c = this.selected ? this.state?.chats.find(x => x.summary.chatId === this.selected) : undefined;
    const raw = this.addSelect.value;
    const id = Number(raw);
    this.addSelect.value = "";
    if (!c || raw === "" || !Number.isSafeInteger(id)) return;
    const links = c.summary.tabIds;
    const allowed = new Set(addableTabs(links, this.tabs, this.d.windowId).map(t => t.id));
    if (!allowed.has(id)) return;
    // A tab in a split view brings its partner.
    const partners = splitPartners(this.tabs, id).filter(p => allowed.has(p));
    const next = [...new Set([...links, id, ...partners])].slice(0, MAX_CHAT_TABS);
    void this.run({ type: "ais-chat-link", chatId: c.summary.chatId, tabIds: next });
  }

  // ---- new chat -----------------------------------------------------------

  private async newChat(): Promise<void> {
    const s = this.state;
    if (!s || this.creating) return;
    const selection = this.newSelection();
    if (!selection) {
      this.localError = LOADING_PROVIDERS;
      void this.d.send({ type: "ais-chat-catalog" });
      this.paint();
      return;
    }
    const active = this.tabs.find(t => t.active && t.windowId === this.d.windowId);
    const tabIds = active ? defaultChatTabs(this.tabs.filter(t => t.windowId === this.d.windowId), active.id) : [];
    this.d.saveSelection?.(selection);
    this.openNew = true;
    this.creating = true;
    this.paint();
    try { await this.run({ type: "ais-chat-create", windowId: this.d.windowId, selection, tabIds }); } finally { this.creating = false; this.paint(); }
  }
}

/** Like syncKeyed, but the add menu (the last child) stays last: a chip goes before it. */
function syncChips(parent: HTMLElement, items: Map<string, Chip>, keys: string[], make: (key: string) => Chip, patch: (item: Chip, key: string) => void): void {
  const want = new Set(keys);
  for (const [k, item] of items) if (!want.has(k)) { item.node.remove(); items.delete(k); }
  let ref: ChildNode | null = parent.firstChild;
  for (const key of keys) {
    let item = items.get(key);
    if (!item) { item = make(key); items.set(key, item); }
    patch(item, key);
    if (item.node === ref) ref = ref.nextSibling;
    else parent.insertBefore(item.node, ref);
  }
}

/** Starts the Chat tab in the real side panel. */
export function initChatTab(root: HTMLElement, windowId: number, paused: () => Promise<boolean>): ChatTab {
  const seenKey = `chatSeen:${windowId}`;
  const tab = new ChatTab({
    doc: document,
    windowId,
    connect: () => {
      const port = chrome.runtime.connect({ name: "ais-chat" });
      return { postMessage: m => port.postMessage(m), onMessage: l => port.onMessage.addListener(l), onDisconnect: l => port.onDisconnect.addListener(l) };
    },
    queryTabs: async () => (await chrome.tabs.query({ windowId })).filter(t => t.id !== undefined).map(t => ({ id: t.id!, windowId: t.windowId, groupId: t.groupId, url: t.url ?? "", title: t.title ?? "", active: t.active, ...(t.splitViewId !== undefined ? { splitViewId: t.splitViewId } : {}) })),
    send: async c => { try { return (await chrome.runtime.sendMessage(c)) as ChatCommandResult | undefined; } catch { return undefined; } },
    loadSeen: async () => ((await chrome.storage.session.get(seenKey))[seenKey] as Record<string, number> | undefined) ?? {},
    saveSeen: seen => { void chrome.storage.session.set({ [seenKey]: seen }); },
    loadSelection: async () => (await chrome.storage.local.get("chatSelection")).chatSelection,
    saveSelection: sel => { void chrome.storage.local.set({ chatSelection: sel }); },
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
