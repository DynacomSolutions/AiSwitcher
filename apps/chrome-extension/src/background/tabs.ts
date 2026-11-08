// Tab ownership: Map<sessionId, {groupId, tabIds}>, one Chrome tab group per agent session.
import type { ChromeApi, GroupColor, TabInfo } from "./chrome-api.ts";

export interface SessionTabs { groupId: number; tabIds: Set<number>; identity: string; label: string }
export interface SessionRef { id: string; identity: string; label: string }

const SESSIONS_KEY = "sessions";
const GRANTS_KEY = "grants";
/** No call for this long: the session is treated as ended, its grants are revoked and it is dropped when it holds no tabs. */
export const SESSION_END_MS = 30 * 60_000;
const COLORS: GroupColor[] = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

/** Stable colour per identity: FNV-1a hash into the palette. */
export function colorForIdentity(identity: string): GroupColor {
  let h = 0x811c9dc5;
  for (let i = 0; i < identity.length; i++) h = Math.imul(h ^ identity.charCodeAt(i), 0x01000193) >>> 0;
  return COLORS[h % COLORS.length]!;
}

export type GrantResult = "ok" | "no_session" | "no_group" | "in_use";

export class TabManager {
  readonly sessions = new Map<string, SessionTabs>();
  /** User-granted tab groups: groupId -> session id. The group is never renamed, recoloured or closed by the session. */
  private readonly grants = new Map<number, string>();
  private readonly lastSeen = new Map<string, number>();

  constructor(private readonly api: ChromeApi, private readonly now: () => number = Date.now) {
    api.tabs.onRemoved(tabId => this.forget(tabId));
  }

  // ---- grants ------------------------------------------------------------

  grantee(groupId: number): string | undefined { return this.grants.get(groupId); }

  grantedGroups(sessionId: string): number[] {
    return [...this.grants].filter(([, sid]) => sid === sessionId).map(([gid]) => gid);
  }

  /** A group no agent uses may be granted to one live session. */
  async grant(groupId: number, sessionId: string): Promise<GrantResult> {
    if (!this.sessions.has(sessionId)) return "no_session";
    if (groupId < 0 || !(await this.api.tabGroups.get(groupId))) return "no_group";
    const current = this.grants.get(groupId);
    if ((current !== undefined && current !== sessionId) || [...this.sessions.values()].some(x => x.groupId === groupId)) return "in_use";
    this.grants.set(groupId, sessionId);
    this.persist();
    return "ok";
  }

  revoke(groupId: number): void {
    if (this.grants.delete(groupId)) this.persist();
  }

  revokeAll(): void {
    if (this.grants.size === 0) return;
    this.grants.clear();
    this.persist();
  }

  /** Revokes grants whose group is gone (closed by the user). */
  async pruneGrants(): Promise<void> {
    for (const gid of [...this.grants.keys()]) if (!(await this.api.tabGroups.get(gid))) this.grants.delete(gid);
    this.persist();
  }

  /** The session ended: its grants go and it is dropped when it holds no tabs. */
  endSession(id: string): void {
    for (const [gid, sid] of [...this.grants]) if (sid === id) this.grants.delete(gid);
    if (this.sessions.get(id)?.tabIds.size === 0) this.sessions.delete(id);
    this.lastSeen.delete(id);
    this.persist();
  }

  /** Records that the session just made a call, registering it when it has no tabs yet (so it can be granted a group). */
  touch(ref: SessionRef): void {
    this.lastSeen.set(ref.id, this.now());
    this.session(ref);
  }

  /** Ends sessions that made no call for SESSION_END_MS. */
  expireIdle(): void {
    for (const id of [...this.sessions.keys()]) {
      const seen = this.lastSeen.get(id);
      if (seen === undefined) this.lastSeen.set(id, this.now());
      else if (this.now() - seen > SESSION_END_MS) this.endSession(id);
    }
  }

  /** True when the tab sits in a group the user granted to this session. */
  inGrantedGroup(sessionId: string, identity: string, tab: TabInfo): boolean {
    const s = this.sessions.get(sessionId);
    return s !== undefined && s.identity === identity && tab.groupId !== -1 && this.grants.get(tab.groupId) === sessionId;
  }

  /** Opens a tab inside a granted group. The group keeps its title and colour. */
  createInGranted(ref: SessionRef, groupId: number, url?: string): Promise<TabInfo | undefined> {
    return this.serial(ref.id, async () => {
      if (this.grants.get(groupId) !== ref.id || !(await this.api.tabGroups.get(groupId))) return undefined;
      const tab = await this.api.tabs.create(url);
      const s = this.session(ref);
      s.tabIds.add(tab.id);
      try { await this.api.tabs.group([tab.id], groupId); } finally { this.persist(); }
      return tab;
    });
  }

  /** True only when the session id AND the identity that created it both match. */
  owns(sessionId: string, tabId: number, identity: string): boolean {
    const s = this.sessions.get(sessionId);
    return s !== undefined && s.identity === identity && s.tabIds.has(tabId);
  }

  ownerOf(tabId: number): string | undefined {
    for (const [id, s] of this.sessions) if (s.tabIds.has(tabId)) return id;
    return undefined;
  }

  /** Drop a tab from every session (tab closed, by the user or by us). */
  forget(tabId: number): void {
    for (const [id, s] of this.sessions) {
      s.tabIds.delete(tabId);
      if (s.tabIds.size === 0 && !this.queues.has(id) && this.grantedGroups(id).length === 0) this.sessions.delete(id); // session over: Chrome drops the empty group itself
    }
    this.persist();
  }

  private persist(): void {
    const data = [...this.sessions].map(([id, s]) => ({ id, groupId: s.groupId, identity: s.identity, label: s.label, tabIds: [...s.tabIds] }));
    const grants = [...this.grants].map(([groupId, sessionId]) => ({ groupId, sessionId }));
    void this.api.sessionStorage.set({ [SESSIONS_KEY]: data, [GRANTS_KEY]: grants }).catch(() => {});
  }

  /** Rebuild ownership and grants after a service-worker restart; tabs and groups that no longer exist are dropped. */
  async load(): Promise<void> {
    const stored = await this.api.sessionStorage.get([SESSIONS_KEY, GRANTS_KEY]);
    const raw = stored[SESSIONS_KEY];
    if (!Array.isArray(raw)) return;
    const live = new Set((await this.api.tabs.query()).map(t => t.id));
    const grants = Array.isArray(stored[GRANTS_KEY]) ? stored[GRANTS_KEY] as Array<{ groupId: number; sessionId: string }> : [];
    for (const e of raw as Array<{ id: string; groupId: number; identity: string; label: string; tabIds: number[] }>) {
      const tabIds = new Set(e.tabIds.filter(id => live.has(id)));
      if (tabIds.size > 0 || grants.some(g => g.sessionId === e.id)) this.sessions.set(e.id, { groupId: e.groupId, tabIds, identity: e.identity, label: e.label });
    }
    for (const g of grants) if (this.sessions.has(g.sessionId)) this.grants.set(g.groupId, g.sessionId);
    await this.pruneGrants();
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

  private async newGroup(ref: SessionRef, s: SessionTabs, tabId: number): Promise<void> {
    s.groupId = await this.api.tabs.group([tabId]);
    await this.api.tabGroups.update(s.groupId, { title: ref.label, color: colorForIdentity(ref.identity) });
  }

  /** One queue per session id: group creation for a session is strictly serial, so concurrent first calls cannot make two groups. */
  private readonly queues = new Map<string, Promise<void>>();

  private serial<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(sessionId) ?? Promise.resolve();
    const run = prev.then(work, work);
    const tail = run.then(() => {}, () => {});
    this.queues.set(sessionId, tail);
    void tail.then(() => { if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId); });
    return run;
  }

  /** Group ids claimed by sessions other than this one. */
  private claimed(except: string): Set<number> {
    const out = new Set<number>();
    for (const [id, s] of this.sessions) if (id !== except && s.groupId !== -1) out.add(s.groupId);
    for (const gid of this.grants.keys()) out.add(gid); // a granted group belongs to the user, never adopted as an agent group
    return out;
  }

  /** Reuses the session's live group, else re-adopts a live unclaimed group with the same title, else creates one. */
  private async placeInGroup(ref: SessionRef, s: SessionTabs, tabId: number): Promise<void> {
    if (s.groupId !== -1 && await this.api.tabGroups.get(s.groupId)) {
      try { await this.api.tabs.group([tabId], s.groupId); return; } catch { /* group vanished between the check and the call */ }
    }
    s.groupId = -1;
    const taken = this.claimed(ref.id);
    const adopt = (await this.api.tabGroups.queryByTitle(ref.label)).find(g => !taken.has(g.id));
    if (adopt) {
      try {
        await this.api.tabs.group([tabId], adopt.id);
        s.groupId = adopt.id;
        return;
      } catch { /* fall through to a new group */ }
    }
    await this.newGroup(ref, s, tabId);
  }

  /** Put a tab into the session's group, creating the group on first use (or after the user dissolved it). */
  addToSession(ref: SessionRef, tabId: number): Promise<void> {
    return this.serial(ref.id, async () => {
      const s = this.session(ref);
      s.tabIds.add(tabId); // owned even if grouping fails
      try {
        await this.placeInGroup(ref, s, tabId);
      } finally {
        this.persist();
      }
    });
  }

  async create(ref: SessionRef, url?: string): Promise<TabInfo> {
    // Inactive: an agent must never pull the owner away from the tab they are using.
    const tab = await this.api.tabs.create(url);
    await this.addToSession(ref, tab.id);
    return tab;
  }

  /** Session tabs that still exist (own, plus those in granted groups); prunes the ones the user closed. */
  async list(sessionId: string): Promise<{ own: TabInfo[]; granted: TabInfo[]; other: TabInfo[] }> {
    await this.pruneGrants();
    const all = await this.api.tabs.query();
    const live = new Set(all.map(t => t.id));
    const s = this.sessions.get(sessionId);
    if (s) for (const id of [...s.tabIds]) if (!live.has(id)) s.tabIds.delete(id);
    const mine = new Set(this.grantedGroups(sessionId));
    const own = all.filter(t => s?.tabIds.has(t.id));
    const granted = all.filter(t => mine.has(t.groupId) && !s?.tabIds.has(t.id));
    const other = all.filter(t => this.ownerOf(t.id) === undefined && !mine.has(t.groupId));
    return { own, granted, other };
  }
}
