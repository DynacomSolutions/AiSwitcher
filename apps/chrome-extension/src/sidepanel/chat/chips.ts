// Linked-tab chips. Pure: no DOM and no chrome API.
import type { TabInfo } from "../../background/chrome-api.ts";

const LABEL_MAX = 28;
export const MISSING_LABEL = "Closed tab";

function labelOf(t: { title: string; url: string }): string {
  const text = t.title.trim() || t.url;
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX)}...` : text;
}

export function chipsFor(links: number[], tabs: Array<{ id: number; title: string; url: string; windowId: number }>): Array<{ tabId: number; label: string; missing: boolean }> {
  return links.map(tabId => {
    const t = tabs.find(x => x.id === tabId);
    return t ? { tabId, label: labelOf(t), missing: false } : { tabId, label: MISSING_LABEL, missing: true };
  });
}

const addableUrl = (url: string): boolean => /^(https?:|file:)/i.test(url);

/** Tabs of this window that a chat can still link: web or file pages that are not linked. */
export function addableTabs(links: number[], tabs: ReadonlyArray<TabInfo>, windowId: number): TabInfo[] {
  return tabs.filter(t => t.windowId === windowId && addableUrl(t.url) && !links.includes(t.id));
}
