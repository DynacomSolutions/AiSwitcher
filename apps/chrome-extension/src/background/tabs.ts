// Tab ownership: Map<sessionId, {groupId, tabIds}>, one Chrome tab group per agent session.
import { CHAT_PALETTE } from "../shared/chat-palette.ts";
import { UnsupportedApiError } from "./chrome-api.ts";
import type { ChromeApi, GroupColor, TabInfo } from "./chrome-api.ts";

/** `adopted` is the subset of `tabIds` the session did not create itself (adopt_tab, or tabs opened inside a user-granted group): they outlive it. */
export interface SessionTabs { groupId: number; tabIds: Set<number>; adopted: Set<number>; identity: string; label: string; chat?: true; color?: string; /** Tabs of a group the user approved with request_group: never closed and never ungrouped by the session. */ approved?: Set<number> }
export interface SessionRef { id: string; identity: string; label: string; chat?: true; color?: string }

const SESSIONS_KEY = "sessions";
const GRANTS_KEY = "grants";
const HANDOVER_KEY = "handover";
const CHAT_LINKS_KEY = "chatLinks";
const SAVED_KEY = "savedGroups";
const AGENTS_KEY = "agentGroups";
/** A group record that nobody refreshed for this long is dropped at load. */
const AGENT_MAX_AGE_MS = 14 * 24 * 3_600_000;
/** After a start, tabs that finish loading may complete a relink for this long (a browser restores tabs lazily). */
const RELINK_WINDOW_MS = 10 * 60_000;
const RELINK_DEBOUNCE_MS = 400;
/**
 * A holder session that made no call for this long, and has no call running, no longer blocks a new session of the same chat. A restart of the agent
 * (for example after context compaction) gives a new session id within minutes, long before SESSION_END_MS.
 */
export const HOLDER_LIVE_MS = 10 * 60_000;
/** Tab changes in a saved group are written to its snapshot after this quiet time, so closing a whole group never shrinks the snapshot tab by tab. */
const SAVED_REFRESH_MS = 1500;
/** A snapshot only shrinks when the group is still alive this long after the first refresh that saw the shrink. */
const SHRINK_COMMIT_MS = 10_000;
/** A handover older than this is from an earlier browser run: tab ids no longer mean anything. */
const HANDOVER_MAX_AGE_MS = 5 * 60_000;
/** No call for this long: the session is treated as ended, its grants are revoked and it is dropped when it holds no tabs. */
export const SESSION_END_MS = 30 * 60_000;
const COLORS: GroupColor[] = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

/** Stable colour per identity: FNV-1a hash into the palette. */
export function colorForIdentity(identity: string): GroupColor {
  let h = 0x811c9dc5;
  for (let i = 0; i < identity.length; i++) h = Math.imul(h ^ identity.charCodeAt(i), 0x01000193) >>> 0;
  return COLORS[h % COLORS.length]!;
}

export type RequestCheck = { ok: true; already: boolean; title: string; tabCount: number; tabIds: number[]; /** Another session made or holds this group. */ shared: boolean } | { ok: false; code: "forbidden_tab" | "bad_args"; message: string };
export type GrantResult = "ok" | "no_session" | "no_group" | "in_use";

/** One tab of a saved group. `split` is a pair label (1, 2, ...) shared by the two tabs of a split view; absent when the tab is not in one. */
export interface SavedTab { url: string; title: string; split?: number }
/** A named tab group that outlives the agent session. `groupId` is -1 while the group is closed. `tabIds` are the live tab ids, used to check that a group id still means this group. */
export interface SavedGroup { name: string; title: string; color: GroupColor; groupId: number; identity: string; tabIds: number[]; tabs: SavedTab[]; /** The session that last held the group: it regains the grant after idling out. */ holder?: string }
/** One tab of an agent group record. `owned` is false for a tab that sits in the group but never belonged to the session (a tab the user added). */
export interface AgentTab { id: number; url: string; adopted: boolean; owned: boolean; /** A tab of a group the user approved with request_group: no session of the chat closes or ungroups it. */ approved?: true }
/** A group that an agent session created. It outlives the session and the browser run, and stays with the chat (identity plus label). */
export interface AgentGroup { identity: string; label: string; title: string; color: GroupColor; groupId: number; tabs: AgentTab[]; /** The session that last held the group. */ holder: string; updatedAt: number }
export interface GroupOverview { groupId: number; title: string; tabCount: number; scope: "own" | "granted" | "saved" | "other"; /** Only for the own group of another session with the same identity. */ holderLabel?: string; holderLive?: boolean; /** Tabs of the group that no list in the response shows, because another session owns them. */ hiddenTabCount: number }
export type SaveResult = { ok: true; groupId: number; tabCount: number } | { ok: false; code: "bad_args" | "forbidden_tab" | "internal"; message: string };
export type OpenResult =
  | { ok: true; name: string; groupId: number; tabs: Array<{ tabId: number; url: string; splitViewId?: number }>; warnings: string[] }
  | { ok: false; code: "bad_args" | "forbidden_tab" | "internal"; message: string };
export type ForgetResult = { ok: true; wasOpen: boolean } | { ok: false; code: "bad_args" | "forbidden_tab" | "internal"; message: string };

export class TabManager {
  readonly sessions = new Map<string, SessionTabs>();
  /** User-granted tab groups: groupId -> session id. The group is never renamed, recoloured or closed by the session. */
  private readonly grants = new Map<number, string>();
  /** Expiry bookkeeping only: set by a call and by expireIdle. Never read for liveness. */
  private readonly lastSeen = new Map<string, number>();
  /** Time of the last real call of each session (call start, call end, touch, reclaim). The only input of holderLive. */
  private readonly lastCall = new Map<string, number>();
  /** Tabs the user linked to each chat session. A tab may be linked to several chats. */
  private readonly links = new Map<string, Set<number>>();

  // ---- chat links --------------------------------------------------------

  /** Replaces the link set of a chat session. */
  setChatLinks(sessionId: string, tabIds: number[], silent = false): void {
    if (tabIds.length === 0) this.links.delete(sessionId); else this.links.set(sessionId, new Set(tabIds));
    this.persist();
    if (!silent) this.linksChanged(sessionId);
  }

  /** Called with the new link set of a chat on every change. Set by the executor. */
  onLinksChanged?: (sessionId: string, tabIds: number[]) => void | Promise<void>;

  private linksChanged(sessionId: string): void {
    if (!this.onLinksChanged) return;
    try { void Promise.resolve(this.onLinksChanged(sessionId, this.chatLinks(sessionId))).catch(() => {}); } catch { /* a failing sender never breaks tab handling */ }
  }

  chatLinks(sessionId: string): number[] { return [...(this.links.get(sessionId) ?? [])]; }

  chatLinked(sessionId: string, tabId: number): boolean { return this.links.get(sessionId)?.has(tabId) ?? false; }

  /** The chat ended: its links go. */
  dropChat(sessionId: string): void {
    if (this.links.delete(sessionId)) { this.persist(); this.linksChanged(sessionId); }
  }
  /** Saved groups by name, shared by every session of this browser. Persisted in chrome.storage.local. */
  private readonly saved = new Map<string, SavedGroup>();
  private readonly opening = new Set<string>();
  private readonly shrinkSince = new Map<string, number>();
  private savedTimer: ReturnType<typeof setTimeout> | undefined;
  /** Agent group records by identity and label, persisted in chrome.storage.local. */
  private readonly agents = new Map<string, AgentGroup>();
  private relinkTimer: ReturnType<typeof setTimeout> | undefined;
  private startedAt: number | undefined;
  /** Set while load() runs: refreshAgents waits for it, so it never writes an incomplete record list over the stored one. */
  private loadingAgents: Promise<void> | undefined;
  /** Calls in progress per session: a holder with a long call running (wait and similar) counts as live. */
  private readonly busy = new Map<string, number>();
  private reclaiming = Promise.resolve();
  /** Groups with a request_group prompt open: one pending request per group. */
  private readonly requests = new Set<number>();

  constructor(private readonly api: ChromeApi, private readonly now: () => number = Date.now) {
    api.tabs.onRemoved(tabId => { this.forget(tabId); this.scheduleSavedRefresh(); });
    api.tabGroups.onUpdated(() => this.scheduleSavedRefresh());
  }

  // ---- saved groups ------------------------------------------------------

  /** Saved groups of this identity with their live state. A group id that no longer means the saved group (browser restart) counts as closed. */
  async savedGroups(identity?: string): Promise<Array<{ name: string; groupId: number; open: boolean; tabCount: number }>> {
    const out = [];
    for (const g of this.saved.values()) {
      if (identity !== undefined && g.identity !== identity) continue;
      const live = await this.liveTabs(g);
      out.push({ name: g.name, groupId: live ? g.groupId : -1, open: live !== undefined, tabCount: live ? live.length : g.tabs.length });
    }
    return out;
  }

  /** The saved group that an open Chrome group belongs to, or undefined. Used to keep other sessions from adopting its tabs. */
  async savedNameOfGroup(groupId: number): Promise<string | undefined> {
    if (groupId === -1) return undefined;
    for (const g of this.saved.values()) if (g.groupId === groupId && await this.liveTabs(g)) return g.name;
    return undefined;
  }

  /** True when the tab sits in an open saved group held by a session other than this one (or by none). Sync: uses the snapshot tab ids. */
  private savedHeldElsewhere(tabId: number, sessionId: string): boolean {
    for (const g of this.saved.values()) if (g.groupId !== -1 && g.tabIds.includes(tabId)) return this.grants.get(g.groupId) !== sessionId;
    return false;
  }

  /** Removes the tab ids of a saved group from every session except `keep`: the holder is the only owner. */
  private stripSavedTabs(ids: number[], keep?: string): void {
    for (const [sid, s] of this.sessions) {
      if (sid === keep) continue;
      for (const id of ids) { s.tabIds.delete(id); s.adopted.delete(id); }
    }
  }

  /** The live tabs of a saved group in strip order, or undefined when the group is closed. */
  private async liveTabs(g: SavedGroup, all?: TabInfo[]): Promise<TabInfo[] | undefined> {
    if (g.groupId === -1 || !(await this.api.tabGroups.get(g.groupId))) return undefined;
    const members = (all ?? await this.api.tabs.query()).filter(t => t.groupId === g.groupId);
    if (members.length === 0 || !members.some(t => g.tabIds.includes(t.id))) return undefined; // the id now belongs to another group
    return members.sort((x, y) => x.windowId - y.windowId || x.index - y.index);
  }

  /** True when the saved group was linked by the unique relink. */
  private async relink(g: SavedGroup): Promise<boolean> { return (await this.relinkPool()).has(g); }

  /**
   * Links groups of saved groups and agent records whose group id is stale (a browser restart gives new ids).
   * A group is linked only when it is certainly the same one: the title matches, the tab URLs equal the stored URLs (same count, same order),
   * and no session, grant or live record or saved group claims it. The link must also be unique: when two items, of any identity,
   * match one group, or one item matches two groups, none of them links. The stored tab list is not rewritten.
   */
  private async relinkPool(): Promise<Set<SavedGroup | AgentGroup>> {
    const all = await this.api.tabs.query();
    const taken = new Set<number>();
    for (const gid of this.grants.keys()) taken.add(gid);
    for (const s of this.sessions.values()) if (s.groupId !== -1) taken.add(s.groupId);
    const items: Array<{ item: SavedGroup | AgentGroup; title: string; urls: string[] }> = [];
    for (const g of this.saved.values()) {
      if (g.groupId !== -1 && await this.liveTabs(g, all)) taken.add(g.groupId);
      else if (g.tabs.length > 0) items.push({ item: g, title: g.title, urls: g.tabs.map(t => t.url) });
    }
    for (const r of this.agents.values()) {
      if (r.groupId !== -1 && await this.liveAgent(r, all)) taken.add(r.groupId);
      else if (r.tabs.length > 0) items.push({ item: r, title: r.title, urls: r.tabs.map(t => t.url) });
    }
    const linked = new Set<SavedGroup | AgentGroup>();
    if (items.length === 0) return linked;
    const groups = new Map<number, TabInfo[]>();
    for (const t of all) if (t.groupId !== -1) groups.set(t.groupId, [...(groups.get(t.groupId) ?? []), t]);
    const candidates = new Map<(typeof items)[number], Array<{ id: number; members: TabInfo[] }>>();
    const claimants = new Map<number, number>();
    for (const it of items) {
      const found: Array<{ id: number; members: TabInfo[] }> = [];
      if (it.title !== "") {
        for (const [id, raw] of groups) {
          if (taken.has(id)) continue;
          const info = await this.api.tabGroups.get(id);
          if (!info || info.title !== it.title) continue;
          const members = raw.slice().sort((x, y) => x.windowId - y.windowId || x.index - y.index);
          if (members.length !== it.urls.length || members.some((t, i) => t.url !== it.urls[i])) continue;
          found.push({ id, members });
        }
      }
      candidates.set(it, found);
      for (const c of found) claimants.set(c.id, (claimants.get(c.id) ?? 0) + 1);
    }
    let savedChanged = false;
    let agentsChanged = false;
    for (const it of items) {
      const found = candidates.get(it)!;
      if (found.length !== 1 || claimants.get(found[0]!.id) !== 1) continue;
      const { id, members } = found[0]!;
      const item = it.item;
      if ("name" in item) { item.groupId = id; item.tabIds = members.map(t => t.id); savedChanged = true; } else { const old = item.tabs; item.tabs = members.map((t, i) => ({ ...old[i]!, id: t.id })); item.groupId = id; agentsChanged = true; }
      linked.add(it.item);
    }
    if (savedChanged) await this.persistSaved();
    if (agentsChanged) await this.persistAgents();
    return linked;
  }

  private async loadSaved(): Promise<void> {
    const raw = (await this.api.storage.get([SAVED_KEY]))[SAVED_KEY];
    if (!Array.isArray(raw)) return;
    for (const e of raw as SavedGroup[]) {
      if (typeof e?.name !== "string" || !Array.isArray(e.tabs)) continue;
      const g: SavedGroup = { ...e, identity: typeof e.identity === "string" ? e.identity : "", tabIds: Array.isArray(e.tabIds) ? e.tabIds : [] };
      // After a browser restart the ids are new. The group only counts as open when its id still names a group with the saved title.
      const info = g.groupId === -1 ? undefined : await this.api.tabGroups.get(g.groupId);
      if (!info || info.title !== g.title || !(await this.liveTabs(g))) { g.groupId = -1; this.saved.set(g.name, g); } else this.saved.set(g.name, g); // the unique relink runs after the agent records are loaded
    }
    await this.persistSaved();
  }

  private async persistSaved(): Promise<void> {
    await this.api.storage.set({ [SAVED_KEY]: [...this.saved.values()] }).catch(() => {});
  }

  /** Title and colour follow the live group. */
  private async syncLook(g: SavedGroup): Promise<void> {
    const info = await this.api.tabGroups.get(g.groupId);
    if (info) { g.title = info.title; if (info.color) g.color = info.color; }
  }

  private async snapshotOf(g: SavedGroup, members: TabInfo[]): Promise<void> {
    const labels = new Map<number, number>();
    for (const t of members) if (t.splitViewId !== -1 && !labels.has(t.splitViewId)) labels.set(t.splitViewId, labels.size + 1);
    g.tabs = members.map(t => ({ url: t.url, title: t.title, ...(t.splitViewId !== -1 ? { split: labels.get(t.splitViewId)! } : {}) }));
    g.tabIds = members.map(t => t.id);
    await this.syncLook(g);
    this.shrinkSince.delete(g.name);
  }

  /**
   * Writes the live state of every open saved group to its snapshot. A group that lost tabs keeps its last full snapshot
   * until it is still alive SHRINK_COMMIT_MS later: closing a whole group removes its tabs one by one, then the group is gone.
   */
  async refreshSaved(): Promise<void> {
    let changed = false;
    let later = false;
    for (const g of this.saved.values()) {
      const live = await this.liveTabs(g);
      if (!live) { this.shrinkSince.delete(g.name); continue; }
      await this.syncLook(g);
      changed = true;
      const liveIds = new Set(live.map(t => t.id));
      if (!g.tabIds.some(id => !liveIds.has(id))) { await this.snapshotOf(g, live); continue; }
      const since = this.shrinkSince.get(g.name);
      if (since === undefined) { this.shrinkSince.set(g.name, this.now()); later = true; } else if (this.now() - since >= SHRINK_COMMIT_MS) await this.snapshotOf(g, live); else later = true;
    }
    if (changed) await this.persistSaved();
    if (await this.refreshAgents()) later = true;
    if (later) this.scheduleSavedRefresh(SHRINK_COMMIT_MS);
  }

  /** Called after a tab or group of a saved group may have changed (created, closed, moved, navigated, renamed). Debounced. */
  scheduleSavedRefresh(delay = SAVED_REFRESH_MS): void {
    if (this.saved.size === 0 && this.agents.size === 0 && ![...this.sessions.values()].some(x => x.groupId !== -1)) return;
    if (this.savedTimer !== undefined) clearTimeout(this.savedTimer);
    this.savedTimer = setTimeout(() => { this.savedTimer = undefined; void this.refreshSaved().catch(() => {}); }, delay);
  }

  private mismatch(g: SavedGroup, ref: SessionRef): { ok: false; code: "forbidden_tab"; message: string } | undefined {
    return g.identity === ref.identity ? undefined : { ok: false, code: "forbidden_tab", message: `The name "${g.name}" belongs to a saved group of another identity.` };
  }

  /**
   * Saves the session's own group (no groupId) or a group granted to it under `name`. The group is then held for the owner:
   * the session gets it as a grant, so its end never closes or ungroups the tabs, and the session gets a fresh own group next time.
   */
  save(ref: SessionRef, name: string, groupId?: number): Promise<SaveResult> {
    return this.serial(ref.id, async () => {
      const s = this.sessions.get(ref.id);
      const noGroup: SaveResult = { ok: false, code: "bad_args", message: "This session has no tab group yet. Open a tab with tabs_create first." };
      if (!s || s.identity !== ref.identity) return noGroup;
      const same = this.saved.get(name);
      if (same) { const m = this.mismatch(same, ref); if (m) return m; }
      // The session's own group became a saved group earlier: saving it again by name refreshes that group.
      let gid = groupId;
      if (gid === undefined && s.groupId === -1 && same && this.grants.get(same.groupId) === ref.id && await this.liveTabs(same)) gid = same.groupId;
      const own = gid === undefined || gid === s.groupId;
      gid ??= s.groupId;
      if (own && s.groupId === -1) return noGroup;
      if (!own && this.grants.get(gid) !== ref.id) return { ok: false, code: "forbidden_tab", message: `Group ${gid} is not this session's own group and is not granted to it.` };
      const info = await this.api.tabGroups.get(gid);
      if (!info) return { ok: false, code: "bad_args", message: `Group ${gid} no longer exists.` };
      for (const g of this.saved.values()) {
        if (g.groupId === gid && g.name !== name && await this.liveTabs(g)) return { ok: false, code: "bad_args", message: `This group is already saved as "${g.name}". Use forget_group first to save it under another name.` };
      }
      // A name is never taken over from a different group, open or closed.
      if (same && !(same.groupId === gid && await this.liveTabs(same))) return { ok: false, code: "bad_args", message: `The name "${name}" is already used by another saved group. Choose another name, or use forget_group to delete the saved group first.` };
      const members = (await this.api.tabs.query()).filter(t => t.groupId === gid).sort((x, y) => x.windowId - y.windowId || x.index - y.index);
      const color = info.color ?? colorForIdentity(ref.identity);
      const savedAlready = same !== undefined;
      if (own && !savedAlready) await this.api.tabGroups.update(gid, { title: name, color });
      const entry: SavedGroup = same ?? { name, title: own ? name : info.title, color, groupId: gid, identity: ref.identity, tabIds: [], tabs: [] };
      entry.groupId = gid;
      entry.holder = ref.id;
      await this.snapshotOf(entry, members);
      this.saved.set(name, entry);
      this.grants.set(gid, ref.id);
      this.dropAgentGroup(gid); // the saved group keeps the group from now on
      this.stripSavedTabs(members.map(t => t.id), ref.id);
      if (own && s.groupId === gid) {
        for (const t of members) if (s.tabIds.has(t.id)) s.adopted.add(t.id); // now the owner's: they outlive the session
        s.groupId = -1;
      }
      this.persist();
      await this.persistSaved();
      return { ok: true, groupId: gid, tabCount: members.length };
    });
  }

  /** Opens a saved group for the session: grants the open group, or recreates a closed one (inactive tabs, saved order, split views). */
  open(ref: SessionRef, name: string): Promise<OpenResult> {
    return this.serial(ref.id, async () => {
      const g = this.saved.get(name);
      if (!g) return { ok: false, code: "bad_args", message: `No saved group named "${name}". See savedGroups in tabs_context.` };
      const m = this.mismatch(g, ref);
      if (m) return m;
      if (this.opening.has(name)) return { ok: false, code: "forbidden_tab", message: `Group "${name}" is in use: another session is opening it.` };
      this.opening.add(name);
      try {
        const warnings: string[] = [];
        let live = await this.liveTabs(g);
        if (!live && await this.relink(g)) live = await this.liveTabs(g);
        if (live) {
          const r = await this.grant(g.groupId, ref.id);
          if (r === "in_use") return { ok: false, code: "forbidden_tab", message: `Group "${name}" is in use by another session.` };
          if (r !== "ok") return { ok: false, code: "bad_args", message: `Group "${name}" could not be opened (${r}).` };
          g.holder = ref.id;
          this.stripSavedTabs(live.map(t => t.id), ref.id);
          this.persist();
          await this.syncLook(g);
          const liveIds = new Set(live.map(t => t.id));
          if (!g.tabIds.some(id => !liveIds.has(id))) await this.snapshotOf(g, live);
          await this.persistSaved();
          return { ok: true, name, groupId: g.groupId, tabs: live.map(t => ({ tabId: t.id, url: t.url, ...(t.splitViewId !== -1 ? { splitViewId: t.splitViewId } : {}) })), warnings };
        }
        return await this.recreate(ref, g, warnings);
      } finally {
        this.opening.delete(name);
      }
    });
  }

  /** A session that lost its grant by idling past SESSION_END_MS regains the saved groups it held, when nobody else holds them. */
  async regrant(ref: SessionRef): Promise<void> {
    for (const g of this.saved.values()) {
      if (g.holder !== ref.id || g.identity !== ref.identity || g.groupId === -1 || this.grants.has(g.groupId)) continue;
      const live = await this.liveTabs(g);
      if (!live || this.grants.has(g.groupId)) continue;
      const s = this.session(ref);
      this.grants.set(g.groupId, ref.id);
      for (const t of live) { s.tabIds.add(t.id); s.adopted.add(t.id); }
      this.stripSavedTabs(live.map(t => t.id), ref.id);
      this.persist();
    }
  }

  private async recreate(ref: SessionRef, g: SavedGroup, warnings: string[]): Promise<OpenResult> {
    const s = this.session(ref);
    const made: Array<{ id: number; saved: SavedTab }> = [];
    let windowId: number | undefined;
    for (const saved of g.tabs) {
      try {
        const tab = await this.api.tabs.create(saved.url === "" ? undefined : saved.url, windowId === undefined ? undefined : { windowId });
        windowId ??= tab.windowId;
        made.push({ id: tab.id, saved });
      } catch (e) {
        warnings.push(`Could not open ${saved.url}: ${e instanceof Error ? e.message : "unknown error"}`);
      }
    }
    if (made.length === 0) return { ok: false, code: "bad_args", message: `Group "${g.name}" has no tab that could be opened again.` };
    let groupId: number;
    try {
      groupId = await this.api.tabs.group(made.map(m => m.id), undefined, windowId);
      await this.api.tabGroups.update(groupId, { title: g.title, color: g.color });
    } catch (e) {
      // Close only the tabs this call made. Nothing is saved or granted.
      for (const m of made) await this.api.tabs.remove(m.id).catch(() => {});
      return { ok: false, code: "internal", message: `Group "${g.name}" could not be opened: ${e instanceof Error ? e.message : "grouping failed"}.` };
    }
    for (const m of made) { s.tabIds.add(m.id); s.adopted.add(m.id); } // in a group held for the owner: stays open when the session ends
    const pairs = new Map<number, number[]>();
    for (const m of made) if (m.saved.split !== undefined) pairs.set(m.saved.split, [...(pairs.get(m.saved.split) ?? []), m.id]);
    let splitSkipped = false;
    for (const ids of pairs.values()) {
      if (ids.length !== 2) continue;
      if (!this.api.tabs.splitSupported()) { splitSkipped = true; continue; }
      try { await this.api.tabs.createSplit([ids[0]!, ids[1]!]); } catch (e) {
        if (e instanceof UnsupportedApiError) splitSkipped = true;
        else warnings.push(`Could not restore a split view: ${e instanceof Error ? e.message : "unknown error"}`);
      }
    }
    if (splitSkipped) warnings.push("Split views were not restored: this Chrome has no split view support (Chrome 155 or later).");
    g.groupId = groupId;
    g.holder = ref.id;
    this.grants.set(groupId, ref.id);
    const members = (await this.api.tabs.query()).filter(t => t.groupId === groupId).sort((x, y) => x.windowId - y.windowId || x.index - y.index);
    g.tabIds = members.map(t => t.id); // the saved tab list and its split pairing stay as saved, even when a tab or a split view could not be restored
    this.persist();
    await this.persistSaved();
    return { ok: true, name: g.name, groupId, tabs: members.map(t => ({ tabId: t.id, url: t.url, ...(t.splitViewId !== -1 ? { splitViewId: t.splitViewId } : {}) })), warnings };
  }

  /** Deletes a saved group. An open group is released to the user (grant revoked); its tabs are never closed. */
  async forgetSaved(ref: SessionRef, name: string): Promise<ForgetResult> {
    const g = this.saved.get(name);
    if (!g) return { ok: false, code: "bad_args", message: `No saved group named "${name}".` };
    const m = this.mismatch(g, ref);
    if (m) return m;
    const open = (await this.liveTabs(g)) !== undefined;
    const holder = open ? this.grants.get(g.groupId) : undefined;
    if (holder !== undefined && holder !== ref.id) return { ok: false, code: "forbidden_tab", message: `Group "${name}" is in use by another session.` };
    this.saved.delete(name);
    this.shrinkSince.delete(name);
    if (open && holder === ref.id) this.revoke(g.groupId);
    await this.persistSaved();
    return { ok: true, wasOpen: open };
  }


  // ---- agent groups ------------------------------------------------------

  private static agentTab(t: TabInfo, owned: boolean, adopted: boolean, approved: boolean): AgentTab {
    return { id: t.id, url: t.url, owned, adopted, ...(approved ? { approved: true as const } : {}) };
  }

  private static agentKey(identity: string, label: string): string { return `${identity}\u0000${label}`; }

  /** A key for a record: one chat may have several records (an unlinked old one next to a new one). */
  private freeKey(r: { identity: string; label: string }): string {
    const base = TabManager.agentKey(r.identity, r.label);
    let key = base;
    for (let i = 2; this.agents.has(key); i++) key = `${base}\u0000#${i}`;
    return key;
  }

  private chatRecords(identity: string, label: string): AgentGroup[] {
    return [...this.agents.values()].filter(r => r.identity === identity && r.label === label);
  }

  /** True when the session made a call within HOLDER_LIVE_MS. A session that is unknown (after a reload), ended or expired is not live. */
  private holderLive(sessionId: string): boolean {
    if ((this.busy.get(sessionId) ?? 0) > 0) return true;
    const seen = this.lastCall.get(sessionId);
    return seen !== undefined && this.now() - seen <= HOLDER_LIVE_MS;
  }

  private savedClaims(groupId: number): boolean {
    for (const g of this.saved.values()) if (g.groupId === groupId) return true;
    return false;
  }

  /** The live tabs of an agent group in strip order, or undefined when the group id no longer means this group. */
  private async liveAgent(r: AgentGroup, all?: TabInfo[]): Promise<TabInfo[] | undefined> {
    if (r.groupId === -1 || !(await this.api.tabGroups.get(r.groupId))) return undefined;
    const members = (all ?? await this.api.tabs.query()).filter(t => t.groupId === r.groupId);
    if (members.length === 0 || !members.some(t => r.tabs.some(x => x.id === t.id))) return undefined;
    return members.sort((x, y) => x.windowId - y.windowId || x.index - y.index);
  }

  private async persistAgents(): Promise<void> {
    await this.api.storage.set({ [AGENTS_KEY]: [...this.agents.values()] }).catch(() => {});
  }

  /** Forgets the record of this group: a saved or granted group is held by other means. */
  private dropAgentGroup(groupId: number): void {
    let any = false;
    for (const [k, r] of [...this.agents]) if (r.groupId === groupId) { this.agents.delete(k); this.shrinkSince.delete(`agent:${k}`); any = true; }
    if (any) void this.persistAgents();
  }

  private async loadAgents(): Promise<void> {
    const raw = (await this.api.storage.get([AGENTS_KEY]))[AGENTS_KEY];
    if (!Array.isArray(raw)) return;
    for (const e of raw as AgentGroup[]) {
      if (typeof e?.identity !== "string" || typeof e.label !== "string" || e.label === "" || !Array.isArray(e.tabs) || typeof e.holder !== "string") continue;
      const updatedAt = typeof e.updatedAt === "number" ? e.updatedAt : this.now();
      if (this.now() - updatedAt > AGENT_MAX_AGE_MS) continue;
      const r: AgentGroup = { ...e, updatedAt, title: typeof e.title === "string" ? e.title : e.label, color: e.color ?? colorForIdentity(e.identity), groupId: typeof e.groupId === "number" ? e.groupId : -1 };
      // After a browser restart the ids are new: the record only counts as live when its id still names a group with the stored title.
      const info = r.groupId === -1 ? undefined : await this.api.tabGroups.get(r.groupId);
      if (!info || info.title !== r.title || !(await this.liveAgent(r))) { r.groupId = -1; this.agents.set(this.freeKey(r), r); } else this.agents.set(this.freeKey(r), r);
    }
    await this.persistAgents();
  }

  /**
   * Writes the live state of every agent group to its record: creates the record for the own group of a session, then follows the group.
   * A record never shrinks while the group closes: the same hold as for saved groups. Returns true when a later pass is needed.
   */
  async refreshAgents(): Promise<boolean> {
    if (this.loadingAgents) await this.loadingAgents;
    let changed = false;
    let later = false;
    const all = await this.api.tabs.query(); // one query for the whole pass
    for (const [sid, s] of this.sessions) {
      if (s.chat || s.label === "" || s.groupId === -1 || this.grants.has(s.groupId) || this.savedClaims(s.groupId)) continue;
      let r = this.chatRecords(s.identity, s.label).find(x => x.groupId === s.groupId);
      if (!r) {
        const main = this.agents.get(TabManager.agentKey(s.identity, s.label));
        if (main) {
          const live = await this.liveAgent(main, all);
          if (live && main.holder !== sid) continue; // another session of the same chat holds a live group
          if (live) { this.agents.delete(TabManager.agentKey(s.identity, s.label)); } // this session moved to a new group
          // An unlinked record of the chat stays: its restored tabs can still link later.
        }
        const info = await this.api.tabGroups.get(s.groupId);
        if (!info) continue;
        for (const [k, o] of [...this.agents]) if (o.groupId === s.groupId) this.agents.delete(k); // the chat was renamed
        const members = all.filter(t => t.groupId === s.groupId).sort((x, y) => x.windowId - y.windowId || x.index - y.index);
        if (members.length === 0) continue;
        r = { identity: s.identity, label: s.label, title: info.title, color: info.color ?? colorForIdentity(s.identity), groupId: s.groupId, tabs: members.map(t => TabManager.agentTab(t, s.tabIds.has(t.id), s.adopted.has(t.id), s.approved?.has(t.id) === true)), holder: sid, updatedAt: this.now() };
        this.agents.set(this.freeKey(r), r);
        changed = true;
      }
      r.holder = sid;
    }
    for (const [key, r] of this.agents) {
      const live = await this.liveAgent(r, all);
      if (!live) { this.shrinkSince.delete(`agent:${key}`); continue; }
      const hs = this.sessions.get(r.holder);
      const mine = hs !== undefined && hs.groupId === r.groupId ? hs : undefined;
      const next: AgentTab[] = live.map(t => {
        const prev = r.tabs.find(x => x.id === t.id);
        const inSession = mine?.tabIds.has(t.id) === true;
        const owned = inSession || (prev?.owned ?? false); // a tab once owned stays owned while it lives: a join by title must not clear it
        return TabManager.agentTab(t, owned, inSession ? mine!.adopted.has(t.id) : (prev?.adopted ?? false), mine?.approved?.has(t.id) === true || prev?.approved === true);
      });
      const info = await this.api.tabGroups.get(r.groupId);
      if (info) { r.title = info.title; if (info.color) r.color = info.color; }
      changed = true;
      const liveIds = new Set(live.map(t => t.id));
      const commit = (): void => { r.tabs = next; r.updatedAt = this.now(); this.shrinkSince.delete(`agent:${key}`); };
      if (!r.tabs.some(x => !liveIds.has(x.id))) { commit(); continue; }
      const since = this.shrinkSince.get(`agent:${key}`);
      if (since === undefined) { this.shrinkSince.set(`agent:${key}`, this.now()); later = true; } else if (this.now() - since >= SHRINK_COMMIT_MS) commit(); else later = true;
    }
    if (changed) await this.persistAgents();
    return later;
  }

  /**
   * The session makes a call: when it has the identity and the label of a chat that owned a group, and the earlier holder is not live,
   * the group becomes the session's own group. No tab is moved, closed, reloaded or activated. A live holder keeps the group.
   */
  reclaim(ref: SessionRef): Promise<boolean> {
    // One chain for all sessions: two sessions of the same chat can never both take the group.
    const run = this.reclaiming.then(() => this.serial(ref.id, () => this.reclaimNow(ref)), () => this.serial(ref.id, () => this.reclaimNow(ref)));
    this.reclaiming = run.then(() => {}, () => {});
    return run;
  }

  private async reclaimNow(ref: SessionRef): Promise<boolean> {
    {
      this.markCall(ref.id);
      if (ref.label === "" || ref.chat === true) return false;
      if (await this.reclaimSession(ref)) return true;
      for (const r of this.chatRecords(ref.identity, ref.label)) if (await this.reclaimRecord(ref, r)) return true;
      return false;
    }
  }

  /** A call happened: the session is live and is not idle. */
  private markCall(id: string): void {
    this.lastCall.set(id, this.now());
    this.lastSeen.set(id, this.now());
  }

  /**
   * Reclaim from known session state: the caller has no own group with tabs, and another session of the same identity and label
   * has an own group with tabs and is not live. The caller takes that group over with the adopted, approved and owned flags.
   * The old session is dropped. No tab is closed, moved, ungrouped, reloaded or activated.
   */
  private async reclaimSession(ref: SessionRef): Promise<boolean> {
    const s = this.session(ref);
    if (s.groupId !== -1 && s.tabIds.size > 0 && await this.api.tabGroups.get(s.groupId)) return false;
    for (const [oid, o] of [...this.sessions]) {
      if (oid === ref.id || o.chat || o.identity !== ref.identity || o.label !== ref.label || o.groupId === -1 || o.tabIds.size === 0) continue;
      if (this.holderLive(oid) || this.queues.has(oid) || this.grantedGroups(oid).length > 0) continue;
      if (this.grants.has(o.groupId) || this.savedClaims(o.groupId)) continue;
      if (!(await this.api.tabGroups.get(o.groupId))) continue;
      const members = new Set((await this.api.tabs.query()).filter(t => t.groupId === o.groupId).map(t => t.id));
      const ids = [...o.tabIds].filter(id => members.has(id));
      if (ids.length === 0) continue;
      s.groupId = o.groupId;
      s.tabIds = new Set(ids);
      s.adopted = new Set(ids.filter(id => o.adopted.has(id)));
      const approved = ids.filter(id => o.approved?.has(id));
      if (approved.length > 0) s.approved = new Set(approved); else delete s.approved;
      this.sessions.delete(oid);
      this.lastSeen.delete(oid);
      this.lastCall.delete(oid);
      this.persist();
      await this.refreshAgents();
      return true;
    }
    return false;
  }

  private async reclaimRecord(ref: SessionRef, r: AgentGroup): Promise<boolean> {
    {
      if (r.holder !== ref.id && this.holderLive(r.holder)) return false;
      let live = await this.liveAgent(r);
      if (!live && (await this.relinkPool()).has(r)) live = await this.liveAgent(r);
      if (!live) return false;
      const s = this.session(ref);
      if (s.groupId === r.groupId) return false;
      if (s.groupId !== -1 && await this.api.tabGroups.get(s.groupId)) return false; // the session has its own live group already
      if (this.grants.has(r.groupId) || this.savedClaims(r.groupId)) return false;
      const liveIds = new Set(live.map(t => t.id));
      const owned = r.tabs.filter(x => x.owned && liveIds.has(x.id));
      if (owned.length === 0) return false;
      for (const [id, o] of [...this.sessions]) {
        if (id === ref.id) continue;
        if (o.groupId === r.groupId) o.groupId = -1;
        for (const x of owned) { o.tabIds.delete(x.id); o.adopted.delete(x.id); }
        if (o.tabIds.size === 0 && o.groupId === -1 && !this.queues.has(id) && this.grantedGroups(id).length === 0) this.sessions.delete(id);
      }
      s.groupId = r.groupId;
      s.tabIds = new Set(owned.map(x => x.id));
      s.adopted = new Set(owned.filter(x => x.adopted).map(x => x.id));
      const approved = owned.filter(x => x.approved).map(x => x.id);
      if (approved.length > 0) s.approved = new Set(approved); else delete s.approved;
      r.holder = ref.id;
      r.tabs = live.map(t => TabManager.agentTab(t, s.tabIds.has(t.id), s.adopted.has(t.id), s.approved?.has(t.id) === true));
      r.updatedAt = this.now();
      this.persist();
      await this.persistAgents();
      return true;
    }
  }

  /** A tab changed (url, loading state, group). Within the first minutes after a start, a relink that failed on a half-loaded tab is tried again. */
  tabUpdated(info: { url?: string; status?: string; groupId?: number }): void {
    if (this.startedAt === undefined || this.now() - this.startedAt > RELINK_WINDOW_MS) return;
    if (info.status !== "complete" && info.url === undefined && info.groupId === undefined) return;
    if (![...this.agents.values()].some(r => r.groupId === -1) && ![...this.saved.values()].some(g => g.groupId === -1)) return;
    if (this.relinkTimer !== undefined) clearTimeout(this.relinkTimer);
    this.relinkTimer = setTimeout(() => { this.relinkTimer = undefined; void this.retryRelink().catch(() => {}); }, RELINK_DEBOUNCE_MS);
  }

  /** Tries to link every saved group and agent group whose group is not open. Returns true when one linked. */
  async retryRelink(): Promise<boolean> {
    return (await this.relinkPool()).size > 0;
  }

  /** Every live group in every window, with the part it has for this session. */
  async groupsOverview(sessionId: string): Promise<GroupOverview[]> {
    const all = await this.api.tabs.query();
    const ids = new Map<number, number>();
    for (const t of all) if (t.groupId !== -1) ids.set(t.groupId, (ids.get(t.groupId) ?? 0) + 1);
    const me = this.sessions.get(sessionId);
    const mine = me?.groupId;
    const grantedMine = new Set(this.grantedGroups(sessionId));
    const out: GroupOverview[] = [];
    for (const [groupId, tabCount] of ids) {
      const info = await this.api.tabGroups.get(groupId);
      const members = all.filter(t => t.groupId === groupId);
      const scope = groupId === mine ? "own" : this.grants.get(groupId) === sessionId ? "granted" : [...this.saved.values()].some(g => g.groupId === groupId && members.some(t => g.tabIds.includes(t.id))) ? "saved" : "other";
      let holder: { label: string; live: boolean } | undefined;
      if (me && groupId !== mine) for (const [oid, o] of this.sessions) if (oid !== sessionId && o.groupId === groupId && o.identity === me.identity && !o.chat) { holder = { label: o.label, live: this.holderLive(oid) }; break; }
      const hiddenTabCount = grantedMine.has(groupId) ? 0 : members.filter(t => { const o = this.ownerOf(t.id); return o !== undefined && o !== sessionId; }).length;
      out.push({ groupId, title: info?.title ?? "", tabCount, scope, ...(holder ? { holderLabel: holder.label, holderLive: holder.live } : {}), hiddenTabCount });
    }
    return out;
  }

  // ---- one-time approval (request_group) ---------------------------------

  beginRequest(groupId: number): boolean {
    if (this.requests.has(groupId)) return false;
    this.requests.add(groupId);
    return true;
  }

  endRequest(groupId: number): void { this.requests.delete(groupId); }

  /** True when the tab sits in a group the user approved for this session: the session never closes or ungroups it. */
  isApproved(sessionId: string, tabId: number): boolean { return this.sessions.get(sessionId)?.approved?.has(tabId) ?? false; }

  /** Every refusal rule of request_group. It runs before the prompt and again after the click. */
  async checkRequest(ref: SessionRef, groupId: number): Promise<RequestCheck> {
    const s = this.sessions.get(ref.id);
    if (s && s.groupId === groupId && await this.api.tabGroups.get(groupId)) return { ok: true, already: true, title: s.label, tabCount: s.tabIds.size, tabIds: [...s.tabIds], shared: false };
    const info = await this.api.tabGroups.get(groupId);
    if (!info) return { ok: false, code: "bad_args", message: `Group ${groupId} no longer exists.` };
    if (this.grants.has(groupId)) return { ok: false, code: "forbidden_tab", message: `Group ${groupId} is granted to a session. It cannot be given to another one.` };
    if (this.savedClaims(groupId)) return { ok: false, code: "forbidden_tab", message: `Group ${groupId} is a saved group. Use open_group.` };
    for (const [id, o] of this.sessions) if (id !== ref.id && o.groupId === groupId && this.holderLive(id)) return { ok: false, code: "forbidden_tab", message: `Group ${groupId} is the own group of another live session.` };
    const deadSameIdentity = [...this.sessions].some(([id, o]) => id !== ref.id && o.groupId === groupId && o.identity === ref.identity && !o.chat);
    for (const r of this.agents.values()) if (r.groupId === groupId && !(r.identity === ref.identity && (r.label === ref.label || deadSameIdentity))) return { ok: false, code: "forbidden_tab", message: `Group ${groupId} belongs to another chat.` };
    let shared = false;
    for (const [id, o] of this.sessions) {
      if (id === ref.id || o.groupId !== groupId) continue;
      if (o.identity !== ref.identity) return { ok: false, code: "forbidden_tab", message: `Group ${groupId} was made by a session of another identity.` };
      shared = true;
    }
    for (const r of this.agents.values()) if (r.groupId === groupId && r.holder !== ref.id) shared = true;
    if (s && s.groupId !== -1 && s.tabIds.size > 0 && await this.api.tabGroups.get(s.groupId)) return { ok: false, code: "bad_args", message: "This session already has an own group with tabs. This session already has its own group. Save it with save_group, then use another chat for the other group." };
    const tabIds = (await this.api.tabs.query()).filter(t => t.groupId === groupId).map(t => t.id);
    return { ok: true, already: false, title: info.title, tabCount: tabIds.length, tabIds, shared };
  }

  /**
   * The user approved: checks every rule again, then the group becomes the own group of the session. Every tab is adopted and approved.
   * No tab is moved, closed, reloaded or activated. The agent record is written at once.
   */
  takeGroup(ref: SessionRef, groupId: number, counted: number[]): Promise<RequestCheck> {
    const run = this.reclaiming.then(() => this.serial(ref.id, () => this.takeNow(ref, groupId, counted)), () => this.serial(ref.id, () => this.takeNow(ref, groupId, counted)));
    this.reclaiming = run.then(() => {}, () => {});
    return run;
  }

  private async takeNow(ref: SessionRef, groupId: number, counted: number[]): Promise<RequestCheck> {
    this.session(ref);
    const c = await this.checkRequest(ref, groupId);
    if (!c.ok || c.already) return c;
    const members = (await this.api.tabs.query()).filter(t => t.groupId === groupId);
    if (members.length === 0) return { ok: false, code: "bad_args", message: `Group ${groupId} has no tab.` };
    // Only the tabs the user saw in the prompt may be taken. Removed tabs are fine. A new tab means the user approved something else.
    if (members.some(t => !counted.includes(t.id))) return { ok: false, code: "forbidden_tab", message: "The group changed while the prompt was open. Ask again." };
    const created = new Set<number>(); // tabs the old own-group session made itself: they stay owned, not adopted
    for (const [id, o] of [...this.sessions]) {
      if (id === ref.id) continue;
      if (o.groupId === groupId && o.identity === ref.identity) for (const t of members) if (o.tabIds.has(t.id) && !o.adopted.has(t.id)) created.add(t.id);
      if (o.groupId === groupId) o.groupId = -1;
      for (const t of members) { o.tabIds.delete(t.id); o.adopted.delete(t.id); o.approved?.delete(t.id); }
      if (o.tabIds.size === 0 && o.groupId === -1 && !this.queues.has(id) && this.grantedGroups(id).length === 0) this.sessions.delete(id);
    }
    const s = this.session(ref);
    s.groupId = groupId;
    s.approved ??= new Set();
    for (const t of members) { s.tabIds.add(t.id); if (!created.has(t.id)) s.adopted.add(t.id); s.approved.add(t.id); }
    this.persist();
    await this.refreshAgents();
    return c;
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
    this.dropAgentGroup(groupId);
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
    for (const [gid, sid] of [...this.grants]) {
      if (sid !== id) continue;
      const saved = [...this.saved.values()].find(g => g.groupId === gid);
      if (saved) this.stripSavedTabs(saved.tabIds); // a saved group nobody holds has no session owner
      this.grants.delete(gid);
    }
    if (this.sessions.get(id)?.tabIds.size === 0) this.sessions.delete(id);
    this.lastSeen.delete(id);
    this.lastCall.delete(id);
    this.persist();
  }

  /**
   * The session ended for good: closes the tabs it created, releases the ones it adopted (ungrouped only when they sit in its own group),
   * revokes its grants and drops it. Tabs in a user-granted group are never touched.
   */
  closeSession(id: string, identity?: string): Promise<void> {
    return this.serial(id, async () => {
      const s = this.sessions.get(id);
      if (s) {
        const granted = new Set(this.grantedGroups(id));
        const adopted = [...s.tabIds].filter(t => s.adopted.has(t));
        const created = [...s.tabIds].filter(t => !s.adopted.has(t));
        if (s.groupId !== -1 && !granted.has(s.groupId)) {
          const release: number[] = [];
          for (const tabId of adopted) {
            const tab = await this.api.tabs.get(tabId).catch(() => undefined);
            if (tab && tab.groupId === s.groupId && !s.approved?.has(tabId)) release.push(tabId); // an approved group stays grouped
          }
          if (release.length > 0) await this.api.tabs.ungroup(release).catch(() => {});
        }
        for (const tabId of created) await this.api.tabs.remove(tabId).catch(() => {}); // already closed by the user: fine
      }
      this.sessions.delete(id);
      this.endSession(id);
      let dropped = false;
      for (const [k, r] of [...this.agents]) if (r.holder === id && (identity === undefined || r.identity === identity)) { this.agents.delete(k); dropped = true; }
      if (dropped) await this.persistAgents();
    });
  }

  /** Records that the session just made a call, registering it when it has no tabs yet (so it can be granted a group). */
  /** A call of the session starts: the session is live until the call ends, however long it runs. */
  callStarted(sessionId: string): void {
    this.busy.set(sessionId, (this.busy.get(sessionId) ?? 0) + 1);
    this.markCall(sessionId);
  }

  callEnded(sessionId: string): void {
    const n = (this.busy.get(sessionId) ?? 1) - 1;
    if (n <= 0) this.busy.delete(sessionId); else this.busy.set(sessionId, n);
    this.markCall(sessionId);
  }

  /** Records a call from the session. Returns true when the session's name changed (e.g. after /rename). */
  touch(ref: SessionRef): boolean {
    this.markCall(ref.id);
    const before = this.sessions.get(ref.id)?.label;
    this.session(ref);
    // An empty label (a caller that does not know the name) never renames the group.
    const renamed = before !== undefined && ref.label !== "" && before !== ref.label;
    if (renamed) void this.retitle(ref).catch(() => {});
    return renamed;
  }

  /** Retitles the session's OWN group. A group the user granted keeps the user's title. */
  private retitle(ref: SessionRef): Promise<void> {
    return this.serial(ref.id, async () => {
      const s = this.sessions.get(ref.id);
      if (!s || s.groupId === -1 || this.grants.has(s.groupId)) return;
      if (!(await this.api.tabGroups.get(s.groupId))) return;
      await this.api.tabGroups.update(s.groupId, { title: ref.label, color: this.groupColour(ref, this.sessions.get(ref.id)) });
    });
  }

  /** Called with the id of a session that expired from idleness. The state clears its stop block there. */
  onExpired?: (sessionId: string) => void;

  /** Ends sessions that made no call for SESSION_END_MS. */
  expireIdle(): void {
    for (const id of [...this.sessions.keys()]) {
      const seen = this.lastSeen.get(id);
      if (seen === undefined) this.lastSeen.set(id, this.now());
      else if (this.now() - seen > SESSION_END_MS) { this.endSession(id); this.onExpired?.(id); }
    }
  }

  /** True when the tab sits in a group the user granted to this session. */
  inGrantedGroup(sessionId: string, identity: string, tab: TabInfo): boolean {
    const s = this.sessions.get(sessionId);
    return s !== undefined && s.identity === identity && tab.groupId !== -1 && this.grants.get(tab.groupId) === sessionId;
  }

  /** Opens a tab inside a granted group. The group keeps its title and colour. */
  createInGranted(ref: SessionRef, groupId: number, url?: string, opts?: { splitWithTabId?: number; windowId?: number }): Promise<TabInfo | undefined> {
    return this.serial(ref.id, async () => {
      if (this.grants.get(groupId) !== ref.id || !(await this.api.tabGroups.get(groupId))) return undefined;
      const tab = await this.api.tabs.create(url, opts);
      const s = this.session(ref);
      s.tabIds.add(tab.id);
      s.adopted.add(tab.id); // sits in the user's group: stays open when the session ends
      try { await this.api.tabs.group([tab.id], groupId); } finally { this.persist(); }
      this.scheduleSavedRefresh();
      return tab;
    });
  }

  /** True only when the session id AND the identity that created it both match. */
  owns(sessionId: string, tabId: number, identity: string): boolean {
    const s = this.sessions.get(sessionId);
    return s !== undefined && s.identity === identity && s.tabIds.has(tabId) && !this.savedHeldElsewhere(tabId, sessionId);
  }

  /** True when the tab sits in an open saved group (held or not). */
  inSavedGroup(tabId: number): boolean {
    for (const g of this.saved.values()) if (g.groupId !== -1 && g.tabIds.includes(tabId)) return true;
    return false;
  }

  ownerOf(tabId: number): string | undefined {
    for (const [id, s] of this.sessions) if (s.tabIds.has(tabId) && !this.savedHeldElsewhere(tabId, id)) return id;
    return undefined;
  }

  /** Drop a tab from every session (tab closed, by the user or by us). */
  forget(tabId: number): void {
    for (const [id, s] of this.sessions) {
      s.tabIds.delete(tabId);
      s.adopted.delete(tabId);
      s.approved?.delete(tabId);
      if (s.tabIds.size === 0 && !this.queues.has(id) && this.grantedGroups(id).length === 0) this.sessions.delete(id); // session over: Chrome drops the empty group itself
    }
    const changed: string[] = [];
    for (const [id, set] of this.links) if (set.delete(tabId)) { changed.push(id); if (set.size === 0) this.links.delete(id); }
    this.persist();
    for (const id of changed) this.linksChanged(id);
  }

  private snapshot(): Record<string, unknown> {
    const data = [...this.sessions].map(([id, s]) => ({ id, groupId: s.groupId, identity: s.identity, label: s.label, tabIds: [...s.tabIds], adoptedTabIds: [...s.adopted], ...(s.approved && s.approved.size > 0 ? { approvedTabIds: [...s.approved] } : {}), ...(s.chat ? { chat: true } : {}), ...(s.color !== undefined ? { color: s.color } : {}) }));
    const grants = [...this.grants].map(([groupId, sessionId]) => ({ groupId, sessionId }));
    const chatLinks = [...this.links].map(([sessionId, tabIds]) => ({ sessionId, tabIds: [...tabIds] }));
    return { [SESSIONS_KEY]: data, [GRANTS_KEY]: grants, [CHAT_LINKS_KEY]: chatLinks };
  }

  private persist(): void {
    void this.api.sessionStorage.set(this.snapshot()).catch(() => {});
  }

  /**
   * Before the extension reloads itself (self-update): chrome.storage.session is cleared by a reload, so the sessions
   * and grants are handed to the next instance through chrome.storage.local. Tab and group ids stay valid.
   */
  async handover(): Promise<void> {
    await this.api.storage.set({ [HANDOVER_KEY]: { at: this.now(), ...this.snapshot() } });
  }

  /** Rebuild ownership and grants after a service-worker restart or a self-update reload; tabs and groups that no longer exist are dropped. */
  async load(): Promise<void> {
    let done!: () => void;
    this.loadingAgents = new Promise<void>(r => { done = r; });
    try {
      await this.loadSessions();
      await this.loadSaved(); // after the sessions, so a session's own group is never linked to a saved group
      await this.loadAgents(); // after the saved groups: an explicit save wins
      await this.relinkPool();
      this.startedAt = this.now();
    } finally {
      this.loadingAgents = undefined;
      done();
    }
  }

  private async loadSessions(): Promise<void> {
    let stored = await this.api.sessionStorage.get([SESSIONS_KEY, GRANTS_KEY, CHAT_LINKS_KEY]);
    const handed = (await this.api.storage.get([HANDOVER_KEY]))[HANDOVER_KEY] as ({ at?: number } & Record<string, unknown>) | undefined;
    if (handed) {
      await this.api.storage.remove([HANDOVER_KEY]);
      if (!Array.isArray(stored[SESSIONS_KEY]) && typeof handed.at === "number" && this.now() - handed.at < HANDOVER_MAX_AGE_MS) {
        stored = handed;
        await this.api.sessionStorage.set({ [SESSIONS_KEY]: handed[SESSIONS_KEY], [GRANTS_KEY]: handed[GRANTS_KEY], [CHAT_LINKS_KEY]: handed[CHAT_LINKS_KEY] ?? [] });
      }
    }
    const raw = stored[SESSIONS_KEY];
    if (!Array.isArray(raw)) return;
    const live = new Set((await this.api.tabs.query()).map(t => t.id));
    const storedLinks = stored[CHAT_LINKS_KEY];
    if (Array.isArray(storedLinks)) {
      for (const e of storedLinks as Array<{ sessionId?: unknown; tabIds?: unknown }>) {
        if (typeof e.sessionId !== "string" || !Array.isArray(e.tabIds)) continue;
        const ids = e.tabIds.filter((t): t is number => typeof t === "number" && live.has(t));
        if (ids.length > 0) this.links.set(e.sessionId, new Set(ids));
        if (ids.length !== e.tabIds.length) this.linksChanged(e.sessionId);
      }
    }
    const grants = Array.isArray(stored[GRANTS_KEY]) ? stored[GRANTS_KEY] as Array<{ groupId: number; sessionId: string }> : [];
    for (const e of raw as Array<{ id: string; groupId: number; identity: string; label: string; tabIds: number[]; adoptedTabIds?: number[]; approvedTabIds?: number[]; chat?: boolean; color?: string }>) {
      const tabIds = new Set(e.tabIds.filter(id => live.has(id)));
      const adopted = new Set((e.adoptedTabIds ?? []).filter(id => tabIds.has(id))); // older data has no split: every tab counts as created
      if (tabIds.size > 0 || grants.some(g => g.sessionId === e.id)) this.sessions.set(e.id, { groupId: e.groupId, tabIds, adopted, ...(e.approvedTabIds?.some(id => tabIds.has(id)) ? { approved: new Set(e.approvedTabIds.filter(id => tabIds.has(id))) } : {}), identity: e.identity, label: e.label, ...(e.chat ? { chat: true as const } : {}), ...(typeof e.color === "string" ? { color: e.color } : {}) });
    }
    for (const g of grants) if (this.sessions.has(g.sessionId)) this.grants.set(g.groupId, g.sessionId);
    await this.pruneGrants();
  }

  private session(ref: SessionRef): SessionTabs {
    let s = this.sessions.get(ref.id);
    if (!s) {
      s = { groupId: -1, tabIds: new Set(), adopted: new Set(), identity: ref.identity, label: ref.label };
      this.sessions.set(ref.id, s);
    }
    if (ref.label !== "") s.label = ref.label;
    if (ref.chat === true) s.chat = true;
    if (ref.color !== undefined) s.color = ref.color;
    return s;
  }

  /** A chat group takes the chat's palette colour. Every other session keeps its identity colour. */
  private groupColour(ref: SessionRef, s?: SessionTabs): GroupColor {
    const chat = ref.chat === true || s?.chat === true;
    const hex = ref.color ?? s?.color;
    return (chat && hex !== undefined ? CHAT_PALETTE.find(p => p.hex === hex)?.group : undefined) ?? colorForIdentity(ref.identity);
  }

  private async newGroup(ref: SessionRef, s: SessionTabs, tabId: number): Promise<void> {
    s.groupId = await this.api.tabs.group([tabId]);
    await this.api.tabGroups.update(s.groupId, { title: ref.label || s.label, color: this.groupColour(ref, s) });
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
  private claimed(except: string, own?: { identity: string; label: string }): Set<number> {
    const out = new Set<number>();
    // A group of an agent record belongs to its chat. Only that chat may join it by title.
    for (const r of this.agents.values()) if (r.groupId !== -1 && !(own && r.identity === own.identity && r.label === own.label)) out.add(r.groupId);
    for (const [id, s] of this.sessions) if (id !== except && s.groupId !== -1) out.add(s.groupId);
    for (const gid of this.grants.keys()) out.add(gid); // a granted group belongs to the user, never adopted as an agent group
    for (const g of this.saved.values()) if (g.groupId !== -1) out.add(g.groupId); // a saved group is held for the owner, never re-adopted by a session with the same title
    return out;
  }

  /** Titles of saved groups and agent records whose group is not open. */
  private async unlinkedTitles(): Promise<Set<string>> {
    const out = new Set<string>();
    const all = await this.api.tabs.query();
    for (const g of this.saved.values()) if (!(g.groupId !== -1 && await this.liveTabs(g, all))) out.add(g.title);
    for (const r of this.agents.values()) if (!(r.groupId !== -1 && await this.liveAgent(r, all))) out.add(r.title);
    return out;
  }

  /** Reuses the session's live group, else re-adopts a live unclaimed group with the same title, else creates one. */
  private async placeInGroup(ref: SessionRef, s: SessionTabs, tabId: number): Promise<void> {
    if (s.groupId !== -1 && await this.api.tabGroups.get(s.groupId)) {
      try { await this.api.tabs.group([tabId], s.groupId); return; } catch { /* group vanished between the check and the call */ }
    }
    s.groupId = -1;
    const taken = this.claimed(ref.id, { identity: ref.identity, label: ref.label });
    // While a record or saved group with this title is not linked (tabs still loading), a live group with the title may be theirs: no join.
    const adopt = (await this.unlinkedTitles()).has(ref.label) ? undefined : (await this.api.tabGroups.queryByTitle(ref.label)).find(g => !taken.has(g.id));
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
  addToSession(ref: SessionRef, tabId: number, adopted = true): Promise<void> {
    return this.serial(ref.id, async () => {
      const s = this.session(ref);
      s.tabIds.add(tabId); // owned even if grouping fails
      if (adopted) s.adopted.add(tabId); else s.adopted.delete(tabId);
      try {
        await this.placeInGroup(ref, s, tabId);
      } finally {
        this.persist();
        this.scheduleSavedRefresh();
      }
    });
  }

  /**
   * A page in a session tab opened `tab` (target=_blank link, window.open): it belongs to the same session.
   * In a user-granted group it stays there and outlives the session; otherwise it joins the session's own group
   * and is closed with it. Returns the session id, or undefined when the opener is not a session tab.
   */
  async claimOpened(tab: TabInfo, opener: TabInfo): Promise<string | undefined> {
    // A tab of a saved group: the popup joins that group, under its current holder, or alone in the group when nobody holds it. Never another session's group.
    const saved = opener.groupId === -1 ? undefined : [...this.saved.values()].find(g => g.groupId === opener.groupId && g.tabIds.includes(opener.id));
    if (saved) {
      const holder = this.grants.get(saved.groupId);
      const hs = holder === undefined ? undefined : this.sessions.get(holder);
      if (tab.groupId !== saved.groupId) await this.api.tabs.group([tab.id], saved.groupId).catch(() => {});
      if (hs) { hs.tabIds.add(tab.id); hs.adopted.add(tab.id); this.persist(); }
      this.scheduleSavedRefresh();
      return holder ?? "saved-group";
    }
    const owner = this.ownerOf(opener.id);
    const s = owner === undefined ? undefined : this.sessions.get(owner);
    if (owner === undefined || !s) return undefined;
    if (opener.groupId !== -1 && this.grants.get(opener.groupId) === owner) {
      await this.serial(owner, async () => {
        s.tabIds.add(tab.id);
        s.adopted.add(tab.id);
        if (tab.groupId !== opener.groupId) await this.api.tabs.group([tab.id], opener.groupId).catch(() => {});
        this.persist();
      });
      return owner;
    }
    await this.addToSession({ id: owner, identity: s.identity, label: s.label, ...(s.chat ? { chat: true as const } : {}), ...(s.color !== undefined ? { color: s.color } : {}) }, tab.id, false);
    if (s.chat) {
      // A page of a chat opened this tab: the chat may use it, so the gateway must hear of it.
      this.setChatLinks(owner, [...new Set([...this.chatLinks(owner), tab.id])]);
    }
    return owner;
  }

  async create(ref: SessionRef, url?: string, opts?: { splitWithTabId?: number; windowId?: number }): Promise<TabInfo> {
    // Inactive: an agent must never pull the owner away from the tab they are using.
    const tab = await this.api.tabs.create(url, opts);
    await this.addToSession(ref, tab.id, false);
    return tab;
  }

  /** Session tabs that still exist (own, plus those in granted groups); prunes the ones the user closed. */
  async list(sessionId: string): Promise<{ own: TabInfo[]; granted: TabInfo[]; other: TabInfo[] }> {
    await this.pruneGrants();
    const all = await this.api.tabs.query();
    const live = new Set(all.map(t => t.id));
    const s = this.sessions.get(sessionId);
    if (s) for (const id of [...s.tabIds]) if (!live.has(id)) { s.tabIds.delete(id); s.adopted.delete(id); }
    const mine = new Set(this.grantedGroups(sessionId));
    const own = all.filter(t => s?.tabIds.has(t.id));
    const granted = all.filter(t => mine.has(t.groupId) && !s?.tabIds.has(t.id));
    const other = all.filter(t => this.ownerOf(t.id) === undefined && !mine.has(t.groupId));
    return { own, granted, other };
  }
}
