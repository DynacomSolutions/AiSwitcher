// Small injectable facade over the chrome.* APIs the extension uses. Tests fake it.

/** `splitViewId` is -1 when the tab is not in a split view (Chrome 140 and later report it). */
export interface TabInfo { id: number; windowId: number; groupId: number; url: string; title: string; active: boolean; splitViewId: number; index: number; pinned: boolean }

/** The Chrome in use lacks an API (split view needs Chrome 155). The message is fit to show to an agent. */
export class UnsupportedApiError extends Error {}

export function splitUnsupported(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): UnsupportedApiError {
  const version = /Chrome\/([\d.]+)/.exec(userAgent)?.[1];
  return new UnsupportedApiError(`Split view needs Chrome 155 or later. This Chrome is ${version ?? "of an unknown version"}.`);
}

interface SplitTabsApi {
  createSplit?: (tabIds: [number, number]) => Promise<unknown>;
  unsplit?: (splitViewId: number) => Promise<void>;
  SPLIT_VIEW_ID_NONE?: number;
}

export interface GroupInfo { id: number; title: string }

export type GroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";

export interface ChromeApi {
  storage: {
    get(keys: string[]): Promise<Record<string, unknown>>;
    set(values: Record<string, unknown>): Promise<void>;
    remove(keys: string[]): Promise<void>;
  };
  /** chrome.storage.session: survives service-worker restarts, not browser restarts. */
  sessionStorage: {
    get(keys: string[]): Promise<Record<string, unknown>>;
    set(values: Record<string, unknown>): Promise<void>;
  };
  tabs: {
    get(tabId: number): Promise<TabInfo | undefined>;
    query(): Promise<TabInfo[]>;
    /** Opens a tab in the current window. Agents never open or switch to a tab in the foreground, so it is always created inactive. */
    create(url?: string, opts?: { splitWithTabId?: number }): Promise<TabInfo>;
    /** Moves the tab to this index in its window. Group and window stay as they are. */
    move(tabId: number, index: number): Promise<void>;
    /** Joins two adjacent tabs into a split view and returns the splitViewId. Throws UnsupportedApiError before Chrome 155. */
    createSplit(tabIds: [number, number]): Promise<number>;
    /** Throws UnsupportedApiError before Chrome 155. */
    unsplit(splitViewId: number): Promise<void>;
    remove(tabId: number): Promise<void>;
    group(tabIds: number[], groupId?: number): Promise<number>;
    ungroup(tabIds: number[]): Promise<void>;
    onRemoved(listener: (tabId: number) => void): void;
    /** Makes the tab the active one in its window. Only used to give the owner back the tab they were on. */
    activate(tabId: number): Promise<void>;
    onCreated(listener: (tab: TabInfo) => void): void;
    onActivated(listener: (tabId: number, windowId: number) => void): void;
  };
  tabGroups: {
    update(groupId: number, props: { title: string; color: GroupColor }): Promise<void>;
    /** The group, or undefined when it no longer exists. */
    get(groupId: number): Promise<GroupInfo | undefined>;
    /** Live groups with exactly this title. */
    queryByTitle(title: string): Promise<GroupInfo[]>;
  };
  debugger: {
    attach(tabId: number): Promise<void>;
    detach(tabId: number): Promise<void>;
    /** `sessionId` addresses a child session of the tab (a cross-origin iframe attached through Target.setAutoAttach, flat mode). */
    send(tabId: number, method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
    /** `sessionId` is set when the event comes from a child session of the tab. */
    onEvent(listener: (tabId: number, method: string, params: Record<string, unknown>, sessionId?: string) => void): void;
    onDetach(listener: (tabId: number, reason: string) => void): void;
  };
}

function toTab(t: chrome.tabs.Tab): TabInfo {
  const split = (t as { splitViewId?: unknown }).splitViewId;
  const none = (chrome.tabs as unknown as SplitTabsApi).SPLIT_VIEW_ID_NONE ?? -1;
  const splitViewId = typeof split === "number" && split !== none ? split : -1;
  return { id: t.id ?? -1, windowId: t.windowId, groupId: t.groupId ?? -1, url: t.url ?? t.pendingUrl ?? "", title: t.title ?? "", active: t.active, splitViewId, index: t.index, pinned: t.pinned };
}

export function realChromeApi(): ChromeApi {
  return {
    storage: {
      get: keys => chrome.storage.local.get(keys),
      set: values => chrome.storage.local.set(values),
      remove: keys => chrome.storage.local.remove(keys),
    },
    sessionStorage: {
      get: keys => chrome.storage.session.get(keys),
      set: values => chrome.storage.session.set(values),
    },
    tabs: {
      get: async tabId => {
        try { return toTab(await chrome.tabs.get(tabId)); } catch { return undefined; }
      },
      query: async () => (await chrome.tabs.query({})).map(toTab),
      create: async (url, opts) => {
        const props: Record<string, unknown> = { active: false };
        if (url) props.url = url;
        if (opts?.splitWithTabId !== undefined) {
          if (typeof (chrome.tabs as unknown as SplitTabsApi).createSplit !== "function") throw splitUnsupported();
          props.splitWithTabId = opts.splitWithTabId;
        }
        try {
          return toTab(await chrome.tabs.create(props as chrome.tabs.CreateProperties));
        } catch (e) {
          if (opts?.splitWithTabId !== undefined && /splitWithTabId/.test(String((e as Error)?.message))) throw splitUnsupported();
          throw e;
        }
      },
      move: async (tabId, index) => { await chrome.tabs.move(tabId, { index }); },
      createSplit: async tabIds => {
        const api = chrome.tabs as unknown as SplitTabsApi;
        if (typeof api.createSplit !== "function") throw splitUnsupported();
        const made = await api.createSplit(tabIds);
        if (typeof made === "number" && made !== (api.SPLIT_VIEW_ID_NONE ?? -1)) return made;
        // The call may return nothing: read the id back from the tab.
        const id = toTab(await chrome.tabs.get(tabIds[0])).splitViewId;
        if (id === -1) throw new Error("Chrome did not report a split view for the tabs.");
        return id;
      },
      unsplit: async splitViewId => {
        const api = chrome.tabs as unknown as SplitTabsApi;
        if (typeof api.unsplit !== "function") throw splitUnsupported();
        await api.unsplit(splitViewId);
      },
      remove: async tabId => { await chrome.tabs.remove(tabId); },
      group: (tabIds, groupId) => { const ids = tabIds as [number, ...number[]]; return chrome.tabs.group(groupId === undefined ? { tabIds: ids } : { tabIds: ids, groupId }); },
      ungroup: async tabIds => { await chrome.tabs.ungroup(tabIds as [number, ...number[]]); },
      onRemoved: listener => chrome.tabs.onRemoved.addListener(listener),
      activate: async tabId => { await chrome.tabs.update(tabId, { active: true }); },
      onCreated: listener => chrome.tabs.onCreated.addListener(t => listener(toTab(t))),
      onActivated: listener => chrome.tabs.onActivated.addListener(info => listener(info.tabId, info.windowId)),
    },
    tabGroups: {
      update: async (groupId, props) => { await chrome.tabGroups.update(groupId, props); },
      get: async groupId => {
        try { const g = await chrome.tabGroups.get(groupId); return { id: g.id, title: g.title ?? "" }; } catch { return undefined; }
      },
      queryByTitle: async title => (await chrome.tabGroups.query({ title })).map(g => ({ id: g.id, title: g.title ?? "" })),
    },
    debugger: {
      attach: tabId => chrome.debugger.attach({ tabId }, "1.3"),
      detach: tabId => chrome.debugger.detach({ tabId }),
      send: (tabId, method, params, sessionId) => chrome.debugger.sendCommand(sessionId === undefined ? { tabId } : { tabId, sessionId }, method, params),
      onEvent: listener => chrome.debugger.onEvent.addListener((source, method, params) => {
        if (source.tabId !== undefined) listener(source.tabId, method, (params ?? {}) as Record<string, unknown>, source.sessionId);
      }),
      // A child session (an iframe) going away is not the tab's debugger detaching.
      onDetach: listener => chrome.debugger.onDetach.addListener((source, reason) => { if (source.tabId !== undefined && (source as { sessionId?: string }).sessionId === undefined) listener(source.tabId, reason); }),
    },
  };
}
