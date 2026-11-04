// Tab ownership: Map<sessionId, {groupId, tabIds}>, one Chrome tab group per agent session.
import type { ChromeApi, GroupColor, TabInfo } from "./chrome-api.ts";

export interface SessionTabs { groupId: number; tabIds: Set<number>; identity: string; label: string }
export interface SessionRef { id: string; identity: string; label: string }

const COLORS: GroupColor[] = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

/** Stable colour per identity: FNV-1a hash into the palette. */
export function colorForIdentity(identity: string): GroupColor {
  let h = 0x811c9dc5;
  for (let i = 0; i < identity.length; i++) h = Math.imul(h ^ identity.charCodeAt(i), 0x01000193) >>> 0;
  return COLORS[h % COLORS.length]!;
}

export class TabManager {
  readonly sessions = new Map<string, SessionTabs>();

  constructor(private readonly api: ChromeApi) {
    api.tabs.onRemoved(tabId => this.forget(tabId));
  }

  owns(sessionId: string, tabId: number): boolean {
    return this.sessions.get(sessionId)?.tabIds.has(tabId) ?? false;
  }

  ownerOf(tabId: number): string | undefined {
    for (const [id, s] of this.sessions) if (s.tabIds.has(tabId)) return id;
    return undefined;
  }

  /** Drop a tab from every session (tab closed, by the user or by us). */
  forget(tabId: number): void {
    for (const s of this.sessions.values()) s.tabIds.delete(tabId);
  }

  private session(ref: SessionRef): SessionTabs {
    let s = this.sessions.get(ref.id);
    if (!s) {
      s = { groupId: -1, tabIds: new Set(), identity: ref.identity, label: ref.label };
      this.sessions.set(ref.id, s);
    }
    s.label = ref.label;
    return s;
  }

  /** Put a tab into the session's group, creating the group on first use (or after the user dissolved it). */
  async addToSession(ref: SessionRef, tabId: number): Promise<void> {
    const s = this.session(ref);
    if (s.tabIds.size === 0) s.groupId = -1;
    if (s.groupId === -1) {
      s.groupId = await this.api.tabs.group([tabId]);
      await this.api.tabGroups.update(s.groupId, { title: ref.label, color: colorForIdentity(ref.identity) });
    } else {
      await this.api.tabs.group([tabId], s.groupId);
    }
    s.tabIds.add(tabId);
  }

  async create(ref: SessionRef, url?: string): Promise<TabInfo> {
    const tab = await this.api.tabs.create(url);
    await this.addToSession(ref, tab.id);
    return tab;
  }

  /** Session tabs that still exist; prunes the ones the user closed. */
  async list(sessionId: string): Promise<{ own: TabInfo[]; other: TabInfo[] }> {
    const all = await this.api.tabs.query();
    const live = new Set(all.map(t => t.id));
    const s = this.sessions.get(sessionId);
    if (s) for (const id of [...s.tabIds]) if (!live.has(id)) s.tabIds.delete(id);
    const own = all.filter(t => s?.tabIds.has(t.id));
    const other = all.filter(t => this.ownerOf(t.id) === undefined);
    return { own, other };
  }
}
