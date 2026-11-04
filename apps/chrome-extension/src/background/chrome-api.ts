// Small injectable facade over the chrome.* APIs the extension uses. Tests fake it.

export interface TabInfo { id: number; windowId: number; groupId: number; url: string; title: string; active: boolean }

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
    /** Opens a tab in the current window; `active` brings it to the front of that window (never raises the window). */
    create(url?: string, active?: boolean): Promise<TabInfo>;
    /** Makes the tab the active one in its window. */
    activate(tabId: number): Promise<void>;
    remove(tabId: number): Promise<void>;
    group(tabIds: number[], groupId?: number): Promise<number>;
    onRemoved(listener: (tabId: number) => void): void;
  };
  tabGroups: { update(groupId: number, props: { title: string; color: GroupColor }): Promise<void> };
  windows: { resize(windowId: number, width: number, height: number): Promise<void> };
  debugger: {
    attach(tabId: number): Promise<void>;
    detach(tabId: number): Promise<void>;
    send(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown>;
    onEvent(listener: (tabId: number, method: string, params: Record<string, unknown>) => void): void;
    onDetach(listener: (tabId: number, reason: string) => void): void;
  };
}

function toTab(t: chrome.tabs.Tab): TabInfo {
  return { id: t.id ?? -1, windowId: t.windowId, groupId: t.groupId ?? -1, url: t.url ?? t.pendingUrl ?? "", title: t.title ?? "", active: t.active };
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
      create: async (url, active = false) => toTab(await chrome.tabs.create(url ? { url, active } : { active })),
      activate: async tabId => { await chrome.tabs.update(tabId, { active: true }); },
      remove: async tabId => { await chrome.tabs.remove(tabId); },
      group: (tabIds, groupId) => { const ids = tabIds as [number, ...number[]]; return chrome.tabs.group(groupId === undefined ? { tabIds: ids } : { tabIds: ids, groupId }); },
      onRemoved: listener => chrome.tabs.onRemoved.addListener(listener),
    },
    tabGroups: { update: async (groupId, props) => { await chrome.tabGroups.update(groupId, props); } },
    windows: { resize: async (windowId, width, height) => { await chrome.windows.update(windowId, { width, height }); } },
    debugger: {
      attach: tabId => chrome.debugger.attach({ tabId }, "1.3"),
      detach: tabId => chrome.debugger.detach({ tabId }),
      send: (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params),
      onEvent: listener => chrome.debugger.onEvent.addListener((source, method, params) => {
        if (source.tabId !== undefined) listener(source.tabId, method, (params ?? {}) as Record<string, unknown>);
      }),
      onDetach: listener => chrome.debugger.onDetach.addListener((source, reason) => { if (source.tabId !== undefined) listener(source.tabId, reason); }),
    },
  };
}
