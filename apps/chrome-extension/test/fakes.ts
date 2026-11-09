import type { ChromeApi, TabInfo } from "../src/background/chrome-api.ts";

export class FakeChrome implements ChromeApi {
  store: Record<string, unknown> = {};
  session: Record<string, unknown> = {};
  groupFailures = new Set<number>();
  detachListeners: Array<(tabId: number, reason: string) => void> = [];
  tabList = new Map<number, TabInfo>();
  nextTab = 100;
  nextGroup = 1;
  groups = new Map<number, { title: string; color: string }>();
  cdpLog: Array<{ tabId: number; method: string; params?: Record<string, unknown> }> = [];
  cdpResults: Record<string, unknown> = {};
  attachedTabs = new Set<number>();
  detachCalls: number[] = [];
  removedListeners: Array<(id: number) => void> = [];
  eventListeners: Array<(tabId: number, method: string, params: Record<string, unknown>) => void> = [];
  resizes: Array<[number, number, number]> = [];
  /** Every tab created, with the `active` flag it was created with (always false: agents never foreground a tab). */
  createdActive: boolean[] = [];

  addTab(id: number, url = "https://example.test/", title = "T"): TabInfo {
    const t: TabInfo = { id, windowId: 1, groupId: -1, url, title, active: false };
    this.tabList.set(id, t);
    return t;
  }
  closeTab(id: number): void {
    this.tabList.delete(id);
    for (const l of this.removedListeners) l(id);
  }
  emit(tabId: number, method: string, params: Record<string, unknown>): void {
    for (const l of this.eventListeners) l(tabId, method, params);
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
    create: async (url?: string) => {
      this.createdActive.push(false);
      return this.addTab(this.nextTab++, url ?? "chrome://newtab/");
    },
    remove: async (id: number) => { this.closeTab(id); },
    group: async (ids: number[], groupId?: number) => {
      if (groupId !== undefined && this.groupFailures.has(groupId)) throw new Error("No group with id");
      const g = groupId ?? this.nextGroup++;
      for (const id of ids) { const t = this.tabList.get(id); if (t) t.groupId = g; }
      return g;
    },
    ungroup: async (ids: number[]) => { for (const id of ids) { const t = this.tabList.get(id); if (t) t.groupId = -1; } },
    onRemoved: (l: (id: number) => void) => { this.removedListeners.push(l); },
  };
  /** Chrome drops a group when its last tab leaves, so a group exists only while a tab is in it. */
  private groupLive(id: number): boolean { return [...this.tabList.values()].some(t => t.groupId === id); }
  tabGroups = {
    update: async (id: number, p: { title: string; color: string }) => { this.groups.set(id, p); },
    get: async (id: number) => (this.groupLive(id) ? { id, title: this.groups.get(id)?.title ?? "" } : undefined),
    queryByTitle: async (title: string) => [...this.groups].filter(([id, g]) => g.title === title && this.groupLive(id)).map(([id, g]) => ({ id, title: g.title })),
  };
  windows = { resize: async (w: number, width: number, height: number) => { this.resizes.push([w, width, height]); } };
  debugger = {
    attach: async (id: number) => { this.attachedTabs.add(id); },
    detach: async (id: number) => { this.attachedTabs.delete(id); this.detachCalls.push(id); },
    send: async (tabId: number, method: string, params?: Record<string, unknown>) => {
      this.cdpLog.push({ tabId, method, ...(params ? { params } : {}) });
      const r = this.cdpResults[method];
      return typeof r === "function" ? (r as (p?: Record<string, unknown>) => unknown)(params) : (r ?? {});
    },
    onEvent: (l: (tabId: number, method: string, params: Record<string, unknown>) => void) => { this.eventListeners.push(l); },
    onDetach: (l: (tabId: number, reason: string) => void) => { this.detachListeners.push(l); },
  };
}
