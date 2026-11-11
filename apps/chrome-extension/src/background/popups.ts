// Tabs that a page in an agent tab opens itself (target=_blank link, window.open after a CDP click) are foreground
// tabs: the click counts as a user gesture, so Chrome activates them and the owner is pulled away from their tab.
// The guard hands such a tab to the agent's session and gives the owner back the tab they were on.
//
// The source is known from CDP `Page.windowOpen` on the attached agent tab. `openerTabId` cannot be used: Chrome sets it
// to the tab the owner is viewing, not to the background tab whose page opened the new one.
import type { ChromeApi, TabInfo } from "./chrome-api.ts";
import type { TabManager } from "./tabs.ts";

/** A new tab created this long after an agent page asked for one is that page's tab. */
export const MATCH_WINDOW_MS = 5_000;
/** onCreated can arrive before Page.windowOpen: wait this long for it before deciding the tab is the owner's. */
export const LATE_EVENT_WAIT_MS = 300;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class PopupGuard {
  /** Active tab per window, and the one active before it. */
  private readonly active = new Map<number, number>();
  private readonly previous = new Map<number, number>();
  /** Agent tabs whose page asked for a new tab, oldest first. */
  private readonly pending: Array<{ source: number; at: number }> = [];

  constructor(private readonly api: ChromeApi, private readonly tabs: TabManager, private readonly now: () => number = Date.now, private readonly wait = sleep) {
    api.tabs.onActivated((tabId, windowId) => this.activated(tabId, windowId));
    api.tabs.onCreated(tab => { void this.created(tab).catch(() => {}); });
    api.debugger.onEvent((tabId, method) => { if (method === "Page.windowOpen") this.windowOpen(tabId); });
  }

  /** Learns the active tab of every window (worker start). */
  async load(): Promise<void> {
    for (const t of await this.api.tabs.query()) if (t.active && !this.active.has(t.windowId)) this.active.set(t.windowId, t.id);
  }

  activated(tabId: number, windowId: number): void {
    const current = this.active.get(windowId);
    if (current === tabId) return;
    if (current !== undefined) this.previous.set(windowId, current);
    this.active.set(windowId, tabId);
  }

  windowOpen(tabId: number): void {
    if (this.tabs.ownerOf(tabId) !== undefined) this.pending.push({ source: tabId, at: this.now() });
  }

  private take(): number | undefined {
    while (this.pending.length > 0 && this.now() - this.pending[0]!.at > MATCH_WINDOW_MS) this.pending.shift();
    return this.pending.shift()?.source;
  }

  async created(tab: TabInfo): Promise<void> {
    // The tab the owner had in front before this one, read before any await; onActivated may come before or after onCreated.
    const viewing = this.active.get(tab.windowId) === tab.id ? this.previous.get(tab.windowId) : this.active.get(tab.windowId);
    let source = this.take();
    if (source === undefined) {
      await this.wait(LATE_EVENT_WAIT_MS);
      source = this.take();
    }
    if (source === undefined) return;
    // The owner is looking at the agent tab: a link they click there opens as usual.
    if (viewing === source) return;
    const opener = await this.api.tabs.get(source);
    if (!opener || (await this.tabs.claimOpened(tab, opener)) === undefined) return;
    const now = await this.api.tabs.get(tab.id);
    if (now?.active && viewing !== undefined && viewing !== tab.id) await this.api.tabs.activate(viewing).catch(() => {});
  }
}
