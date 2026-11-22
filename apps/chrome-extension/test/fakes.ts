import { splitUnsupported } from "../src/background/chrome-api.ts";
import type { ChromeApi, GroupColor, TabInfo } from "../src/background/chrome-api.ts";

export class FakeChrome implements ChromeApi {
  store: Record<string, unknown> = {};
  session: Record<string, unknown> = {};
  groupFailures = new Set<number>();
  detachListeners: Array<(tabId: number, reason: string) => void> = [];
  tabList = new Map<number, TabInfo>();
  nextTab = 100;
  nextGroup = 1;
  groups = new Map<number, { title: string; color: string }>();
  cdpLog: Array<{ tabId: number; method: string; params?: Record<string, unknown>; sessionId?: string }> = [];
  cdpResults: Record<string, unknown> = {};
  attachedTabs = new Set<number>();
  detachCalls: number[] = [];
  removedListeners: Array<(id: number) => void> = [];
  eventListeners: Array<(tabId: number, method: string, params: Record<string, unknown>, sessionId?: string) => void> = [];
  createdListeners: Array<(tab: TabInfo) => void> = [];
  activatedListeners: Array<(tabId: number, windowId: number) => void> = [];
  /** Tabs the extension made active (only ever to give the owner their tab back). */
  activations: number[] = [];
  /** Every tab created, with the `active` flag it was created with (always false: agents never foreground a tab). */
  createdActive: boolean[] = [];

  /** Simulates a Chrome before 155: no createSplit, unsplit or splitWithTabId. */
  oldChrome = false;
  nextSplit = 1;
  /** When set, createSplit throws this message. */
  splitFailure: string | undefined;
  splitCalls: Array<[number, number]> = [];
  unsplitCalls: number[] = [];
  /** The windowId each tabs.create call was given (undefined when none). */
  createWindowIds: Array<number | undefined> = [];
  /** The windowId each grouping call was given. */
  groupWindowIds: Array<number | undefined> = [];
  /** When set, creating a group fails with this message. */
  groupNewFailure: string | undefined;
  groupUpdatedListeners: Array<(groupId: number) => void> = [];
  moveCalls: Array<{ tabId: number; index: number }> = [];

  addTab(id: number, url = "https://example.test/", title = "T", where: number | { splitViewId?: number; windowId?: number } = 1): TabInfo {
    const extra = typeof where === "number" ? { windowId: where } : where;
    const windowId = extra.windowId ?? 1;
    const index = [...this.tabList.values()].filter(t => t.windowId === windowId).length;
    const t: TabInfo = { id, windowId, groupId: -1, url, title, active: false, splitViewId: extra.splitViewId ?? -1, index, pinned: false };
    this.tabList.set(id, t);
    return t;
  }
  /** Tab ids of one window in tab-strip order. */
  order(windowId = 1): number[] {
    return [...this.tabList.values()].filter(t => t.windowId === windowId).sort((x, y) => x.index - y.index).map(t => t.id);
  }
  private reindex(ids: number[]): void {
    ids.forEach((id, i) => { this.tabList.get(id)!.index = i; });
  }
  /** Tabs of a split view, in tab-strip order. */
  splitMembers(splitViewId: number): TabInfo[] {
    return [...this.tabList.values()].filter(t => t.splitViewId === splitViewId).sort((x, y) => x.index - y.index);
  }
  closeTab(id: number): void {
    const gone = this.tabList.get(id);
    this.tabList.delete(id);
    if (gone) {
      this.reindex(this.order(gone.windowId));
      if (gone.splitViewId !== -1) for (const t of this.splitMembers(gone.splitViewId)) t.splitViewId = -1;
    }
    for (const l of this.removedListeners) l(id);
  }
  /** `sessionId`: the event comes from a child session (a cross-origin iframe). */
  emit(tabId: number, method: string, params: Record<string, unknown>, sessionId?: string): void {
    for (const l of this.eventListeners) l(tabId, method, params, sessionId);
  }

  storage = {
    get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in this.store).map(k => [k, this.store[k]])),
    set: async (v: Record<string, unknown>) => { Object.assign(this.store, v); },
    remove: async (keys: string[]) => { for (const k of keys) delete this.store[k]; },
  };
  sessionStorage = {
    get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in this.session).map(k => [k, this.session[k]])),
    set: async (v: Record<string, unknown>) => { Object.assign(this.session, JSON.parse(JSON.stringify(v))); },
  };
  tabs = {
    get: async (id: number) => this.tabList.get(id),
    query: async () => [...this.tabList.values()],
    create: async (url?: string, opts?: { splitWithTabId?: number; windowId?: number }) => {
      this.createWindowIds.push(opts?.windowId);
      if (opts?.splitWithTabId !== undefined && this.oldChrome) throw splitUnsupported("Mozilla/5.0 Chrome/140 Safari/537.36");
      this.createdActive.push(false);
      const base = opts?.splitWithTabId === undefined ? undefined : this.tabList.get(opts.splitWithTabId);
      if (opts?.splitWithTabId !== undefined && (!base || base.splitViewId !== -1)) throw new Error("Cannot split with this tab.");
      const t = this.addTab(this.nextTab++, url ?? "chrome://newtab/", "T", opts?.windowId ?? 1);
      if (base) {
        // Chrome opens the new tab right after the base tab, in its group, in a split with it.
        const ids = this.order(base.windowId).filter(id => id !== t.id);
        ids.splice(base.index + 1, 0, t.id);
        this.reindex(ids);
        t.groupId = base.groupId;
        t.pinned = base.pinned;
        t.splitViewId = base.splitViewId = this.nextSplit++;
      }
      return t;
    },
    splitSupported: () => !this.oldChrome,
    move: async (id: number, index: number) => {
      const t = this.tabList.get(id);
      if (!t) throw new Error("No tab with id");
      this.moveCalls.push({ tabId: id, index });
      const ids = this.order(t.windowId).filter(x => x !== id);
      ids.splice(Math.max(0, Math.min(index, ids.length)), 0, id);
      this.reindex(ids);
    },
    createSplit: async (ids: [number, number]) => {
      if (this.splitFailure) throw new Error(this.splitFailure);
      if (this.oldChrome) throw splitUnsupported("Mozilla/5.0 Chrome/140 Safari/537.36");
      this.splitCalls.push([ids[0], ids[1]]);
      const [a, b] = ids.map(id => this.tabList.get(id));
      if (!a || !b || a === b) throw new Error("Invalid tabs for a split view.");
      if (a.windowId !== b.windowId) throw new Error("Tabs must be in the same window.");
      if (a.pinned !== b.pinned) throw new Error("Tabs must have the same pinned state.");
      if (a.groupId !== b.groupId) throw new Error("Tabs must be in the same group.");
      if (a.splitViewId !== -1 || b.splitViewId !== -1) throw new Error("A tab is already in a split view.");
      if (Math.abs(a.index - b.index) !== 1) throw new Error("Tabs must be adjacent.");
      a.splitViewId = b.splitViewId = this.nextSplit++;
      return a.splitViewId;
    },
    unsplit: async (splitViewId: number) => {
      if (this.oldChrome) throw splitUnsupported("Mozilla/5.0 Chrome/140 Safari/537.36");
      this.unsplitCalls.push(splitViewId);
      const members = this.splitMembers(splitViewId);
      if (members.length === 0) throw new Error("No split view with this id.");
      for (const t of members) t.splitViewId = -1;
    },
    remove: async (id: number) => { this.closeTab(id); },
    group: async (ids: number[], groupId?: number, windowId?: number) => {
      this.groupWindowIds.push(windowId);
      if (this.groupNewFailure && groupId === undefined) throw new Error(this.groupNewFailure);
      if (groupId !== undefined && this.groupFailures.has(groupId)) throw new Error("No group with id");
      const g = groupId ?? this.nextGroup++;
      for (const id of ids) { const t = this.tabList.get(id); if (t) t.groupId = g; }
      return g;
    },
    ungroup: async (ids: number[]) => { for (const id of ids) { const t = this.tabList.get(id); if (t) t.groupId = -1; } },
    onRemoved: (l: (id: number) => void) => { this.removedListeners.push(l); },
    activate: async (id: number) => { this.activations.push(id); this.setActive(id); },
    onCreated: (l: (tab: TabInfo) => void) => { this.createdListeners.push(l); },
    onActivated: (l: (tabId: number, windowId: number) => void) => { this.activatedListeners.push(l); },
  };
  /** Makes the tab the active one in its window and fires onActivated. */
  setActive(id: number): void {
    const t = this.tabList.get(id);
    if (!t) return;
    for (const o of this.tabList.values()) if (o.windowId === t.windowId) o.active = o.id === id;
    for (const l of this.activatedListeners) l(id, t.windowId);
  }
  /**
   * A page in `opener` opened a tab, as Chrome does for a target=_blank click: Page.windowOpen on the opener (when attached),
   * then a tab in the same window, foreground unless `background`. Chrome puts it next to the active tab, outside the opener's group.
   */
  openFromPage(opener: number, background = false, attached = true): TabInfo {
    const o = this.tabList.get(opener)!;
    if (attached) this.emit(opener, "Page.windowOpen", { url: "https://opened.example.com/", userGesture: true });
    const t: TabInfo = { id: this.nextTab++, windowId: o.windowId, groupId: -1, url: "https://opened.example.com/", title: "Opened", active: !background, splitViewId: -1, index: this.order(o.windowId).length, pinned: false };
    this.tabList.set(t.id, t);
    for (const l of this.createdListeners) l({ ...t });
    if (!background) this.setActive(t.id);
    return t;
  }
  /** Chrome drops a group when its last tab leaves, so a group exists only while a tab is in it. */
  private groupLive(id: number): boolean { return [...this.tabList.values()].some(t => t.groupId === id); }
  tabGroups = {
    update: async (id: number, p: { title: string; color: string }) => { this.groups.set(id, p); for (const l of this.groupUpdatedListeners) l(id); },
    onUpdated: (l: (groupId: number) => void) => { this.groupUpdatedListeners.push(l); },
    get: async (id: number) => (this.groupLive(id) ? { id, title: this.groups.get(id)?.title ?? "", color: this.groups.get(id)?.color as GroupColor | undefined } : undefined),
    queryByTitle: async (title: string) => [...this.groups].filter(([id, g]) => g.title === title && this.groupLive(id)).map(([id, g]) => ({ id, title: g.title })),
  };
  debugger = {
    attach: async (id: number) => { this.attachedTabs.add(id); },
    detach: async (id: number) => { this.attachedTabs.delete(id); this.detachCalls.push(id); },
    send: async (tabId: number, method: string, params?: Record<string, unknown>, sessionId?: string) => {
      this.cdpLog.push({ tabId, method, ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) });
      const r = this.cdpResults[method];
      return typeof r === "function" ? (r as (p?: Record<string, unknown>, s?: string) => unknown)(params, sessionId) : (r ?? {});
    },
    onEvent: (l: (tabId: number, method: string, params: Record<string, unknown>, sessionId?: string) => void) => { this.eventListeners.push(l); },
    onDetach: (l: (tabId: number, reason: string) => void) => { this.detachListeners.push(l); },
  };
}
