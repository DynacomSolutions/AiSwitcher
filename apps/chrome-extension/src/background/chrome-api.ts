// Small injectable facade over the chrome.* APIs the extension uses. Tests fake it.

/** `splitViewId` is -1 when the tab is not in a split view (Chrome 140 and later report it). */
export interface TabInfo { id: number; windowId: number; groupId: number; url: string; title: string; active: boolean; splitViewId: number; index: number; pinned: boolean; /** Chrome unloaded the page (memory saver). It runs no script. */ discarded?: boolean; /** The page is frozen in the background. It runs no script. */ frozen?: boolean }

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

export type GroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";

export interface GroupInfo { id: number; title: string; color?: GroupColor }

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
    create(url?: string, opts?: { splitWithTabId?: number; windowId?: number }): Promise<TabInfo>;
    /** True when this Chrome has split view (Chrome 155 or later). */
    splitSupported(): boolean;
    /** Moves the tab to this index in its window. Group and window stay as they are. */
    move(tabId: number, index: number): Promise<void>;
    /** Joins two adjacent tabs into a split view and returns the splitViewId. Throws UnsupportedApiError before Chrome 155. */
    createSplit(tabIds: [number, number]): Promise<number>;
    /** Throws UnsupportedApiError before Chrome 155. */
    unsplit(splitViewId: number): Promise<void>;
    remove(tabId: number): Promise<void>;
    /** A new group is made in `windowId` when given (the window that holds the tabs). Ignored when `groupId` is given. */
    group(tabIds: number[], groupId?: number, windowId?: number): Promise<number>;
    ungroup(tabIds: number[]): Promise<void>;
    onRemoved(listener: (tabId: number) => void): void;
    /** Chrome gave a tab a new id (prerender activation, restore of a discarded tab). Everything keyed by the old id must move to the new one. */
    onReplaced(listener: (addedTabId: number, removedTabId: number) => void): void;
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
    /** A group's title or colour changed. */
    onUpdated(listener: (groupId: number) => void): void;
  };
  notifications: {
    /** Shows a notification that stays until the user answers (requireInteraction). `buttons` are the button labels. */
    create(id: string, opts: { title: string; message: string; buttons: string[] }): Promise<void>;
    clear(id: string): Promise<void>;
    onButtonClicked(listener: (id: string, buttonIndex: number) => void): void;
    onClosed(listener: (id: string, byUser: boolean) => void): void;
    /** The user clicked the body of a notification (not a button). */
    onClicked(listener: (id: string) => void): void;
  };
  /** Ways to show an extension page to the owner. */
  panel: {
    /** The last focused normal browser window, when there is one. */
    lastFocusedWindowId(): Promise<number | undefined>;
    /** Opens the side panel in a window. It calls chrome.sidePanel.open at once and returns its promise, so call it inside the user gesture handler with no await before it. Rejects when Chrome refuses. */
    openSidePanel(windowId: number): Promise<void>;
    /** A normal window got focus. Not called for no window or for other window types. */
    onWindowFocused(listener: (windowId: number) => void): void;
    /** A window closed. */
    onWindowRemoved(listener: (windowId: number) => void): void;
    /** The position and size of a window, when known. */
    windowBounds(windowId: number): Promise<{ left: number; top: number; width: number; height: number } | undefined>;
    /** Opens an extension page in a popup window (normal state, never full screen) and returns the id of its tab. `path` is relative to the extension root. `left` and `top` place it. */
    openPopup(path: string, size: { width: number; height: number; left?: number; top?: number }): Promise<number | undefined>;
    /** The text on the toolbar button. An empty text clears it. */
    setBadge(text: string): Promise<void>;
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

/**
 * Joins tab lists, keeps the first copy of each tab id and returns tab-strip order (window, then index). The real query reads both chrome.tabs.query and every window,
 * so one tab of a split view can never hide the other.
 */
export function mergeTabLists(...lists: TabInfo[][]): TabInfo[] {
  const seen = new Set<number>();
  const out: TabInfo[] = [];
  for (const list of lists) for (const t of list) if (t.id !== -1 && !seen.has(t.id)) { seen.add(t.id); out.push(t); }
  return out.sort((x, y) => x.windowId - y.windowId || x.index - y.index);
}

function toTab(t: chrome.tabs.Tab): TabInfo {
  const split = (t as { splitViewId?: unknown }).splitViewId;
  const none = (chrome.tabs as unknown as SplitTabsApi).SPLIT_VIEW_ID_NONE ?? -1;
  const splitViewId = typeof split === "number" && split !== none ? split : -1;
  return { id: t.id ?? -1, windowId: t.windowId, groupId: t.groupId ?? -1, url: t.url || t.pendingUrl || "", title: t.title ?? "", active: t.active, splitViewId, index: t.index, pinned: t.pinned, discarded: t.discarded === true, frozen: (t as { frozen?: unknown }).frozen === true };
}

/** Browser and extension pages. Agent tools never act on these, and the worker never lists them: an extension page can answer approvals. */
export function isInternalUrl(url: string): boolean {
  if (/^chrome:\/\/(newtab|new-tab-page)(\/|$|\?|#)/i.test(url)) return false; // the blank page of a tab the agent made
  return /^(chrome-extension|chrome|devtools|edge|chrome-untrusted|chrome-search):/i.test(url);
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
      query: async () => {
        const base = (await chrome.tabs.query({})).map(toTab);
        let perWindow: TabInfo[] = [];
        try { perWindow = (await chrome.windows.getAll({ populate: true })).flatMap(w => (w.tabs ?? []).map(toTab)); } catch { /* the plain query stands alone */ }
        return mergeTabLists(base, perWindow);
      },
      create: async (url, opts) => {
        const props: Record<string, unknown> = { active: false };
        if (url) props.url = url;
        if (opts?.splitWithTabId !== undefined) {
          if (typeof (chrome.tabs as unknown as SplitTabsApi).createSplit !== "function") throw splitUnsupported();
          props.splitWithTabId = opts.splitWithTabId;
        }
        if (opts?.windowId !== undefined) props.windowId = opts.windowId; // the base tab's window (split) or the window of a restored group, not the focused one
        try {
          return toTab(await chrome.tabs.create(props as chrome.tabs.CreateProperties));
        } catch (e) {
          if (opts?.splitWithTabId !== undefined && /splitWithTabId/.test(String((e as Error)?.message))) throw splitUnsupported();
          throw e;
        }
      },
      splitSupported: () => typeof (chrome.tabs as unknown as SplitTabsApi).createSplit === "function",
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
      group: (tabIds, groupId, windowId) => {
        const ids = tabIds as [number, ...number[]];
        if (groupId !== undefined) return chrome.tabs.group({ tabIds: ids, groupId });
        return chrome.tabs.group(windowId === undefined ? { tabIds: ids } : { tabIds: ids, createProperties: { windowId } });
      },
      ungroup: async tabIds => { await chrome.tabs.ungroup(tabIds as [number, ...number[]]); },
      onRemoved: listener => chrome.tabs.onRemoved.addListener(listener),
      onReplaced: listener => chrome.tabs.onReplaced.addListener(listener),
      activate: async tabId => { await chrome.tabs.update(tabId, { active: true }); },
      onCreated: listener => chrome.tabs.onCreated.addListener(t => listener(toTab(t))),
      onActivated: listener => chrome.tabs.onActivated.addListener(info => listener(info.tabId, info.windowId)),
    },
    tabGroups: {
      update: async (groupId, props) => { await chrome.tabGroups.update(groupId, props); },
      get: async groupId => {
        try { const g = await chrome.tabGroups.get(groupId); return { id: g.id, title: g.title ?? "", color: g.color }; } catch { return undefined; }
      },
      queryByTitle: async title => (await chrome.tabGroups.query({ title })).map(g => ({ id: g.id, title: g.title ?? "", color: g.color })),
      onUpdated: listener => chrome.tabGroups.onUpdated.addListener(g => listener(g.id)),
    },
    notifications: {
      create: async (id, opts) => { await chrome.notifications.create(id, { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon-128.png"), title: opts.title, message: opts.message, requireInteraction: true, buttons: opts.buttons.map(title => ({ title })) }); },
      clear: async id => { await chrome.notifications.clear(id); },
      onButtonClicked: listener => chrome.notifications.onButtonClicked.addListener((id, index) => listener(id, index)),
      onClosed: listener => chrome.notifications.onClosed.addListener((id, byUser) => listener(id, byUser)),
      onClicked: listener => chrome.notifications.onClicked.addListener(id => listener(id)),
    },
    panel: {
      lastFocusedWindowId: async () => { try { return (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id; } catch { return undefined; } },
      // No async and no await: chrome.sidePanel.open needs the user gesture of the click handler that is still running.
      openSidePanel: windowId => chrome.sidePanel.open({ windowId }),
      onWindowFocused: listener => chrome.windows.onFocusChanged.addListener(id => { if (id !== chrome.windows.WINDOW_ID_NONE) listener(id); }, { windowTypes: ["normal"] }),
      onWindowRemoved: listener => chrome.windows.onRemoved.addListener(id => listener(id)),
      windowBounds: async windowId => { try { const w = await chrome.windows.get(windowId); return w.left === undefined || w.top === undefined || w.width === undefined || w.height === undefined ? undefined : { left: w.left, top: w.top, width: w.width, height: w.height }; } catch { return undefined; } },
      openPopup: async (path, size) => (await chrome.windows.create({ url: chrome.runtime.getURL(path), type: "popup", state: "normal", ...size }))?.tabs?.[0]?.id,
      setBadge: async text => { await chrome.action.setBadgeText({ text }); },
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
