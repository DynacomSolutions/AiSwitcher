import type { TabInfo } from "../background/chrome-api.ts";

/** Same value as chrome.tabs.SPLIT_VIEW_ID_NONE. Not read at runtime, so Chrome below 140 works. */
export const SPLIT_VIEW_NONE = -1;

/** Other tabs in the same window with the same split view id. Empty when the id is absent or none. */
export function splitPartners(tabs: ReadonlyArray<Pick<TabInfo, "id" | "windowId" | "splitViewId">>, tabId: number): number[] {
  const me = tabs.find(t => t.id === tabId);
  if (!me || me.splitViewId === undefined || me.splitViewId === SPLIT_VIEW_NONE) return [];
  return tabs.filter(t => t.id !== tabId && t.windowId === me.windowId && t.splitViewId === me.splitViewId).map(t => t.id);
}

const linkable = (url: string): boolean => /^(https?|file):/i.test(url);

/** The default chat context: the active tab first, then its split partners. Only http, https and file tabs. */
export function defaultChatTabs(tabs: ReadonlyArray<TabInfo>, activeTabId: number): number[] {
  const ids = [activeTabId, ...splitPartners(tabs, activeTabId)];
  const out: number[] = [];
  for (const id of ids) {
    const t = tabs.find(x => x.id === id);
    if (t && linkable(t.url) && !out.includes(id)) out.push(id);
  }
  return out;
}
