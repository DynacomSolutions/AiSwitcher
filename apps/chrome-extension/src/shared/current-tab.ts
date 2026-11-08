// Pure mapping from the panel's active tab to the agent sessions using it.
import type { PanelSession } from "./panel.ts";

export interface ActiveTab { id: number; groupId: number }
export type TabUse = "controlling" | "idle";
export interface TabSession { session: PanelSession; use: TabUse }

/** A session uses the tab when it owns it, sits in its tab group, has it marked as controlled or has the debugger attached. */
export function usesTab(s: PanelSession, tab: ActiveTab): boolean {
  return s.tabIds.includes(tab.id)
    || (tab.groupId >= 0 && (s.groupId === tab.groupId || s.grantedGroupIds.includes(tab.groupId)))
    || s.controlledTabIds.includes(tab.id)
    || s.attachedTabIds.includes(tab.id);
}

/** Sessions using the active tab, in list order. "controlling" means an agent is driving the tab now and the profile is not paused. */
export function sessionsForTab(sessions: PanelSession[], tab: ActiveTab | undefined, paused = false): TabSession[] {
  if (!tab) return [];
  return sessions.filter(s => usesTab(s, tab)).map(session => ({
    session,
    use: !paused && (session.controlledTabIds.includes(tab.id) || session.attachedTabIds.includes(tab.id)) ? "controlling" : "idle",
  }));
}

export type GroupState =
  | { kind: "ungrouped" }
  /** An agent's own group. */
  | { kind: "agent"; session: PanelSession }
  /** A user group granted to a session. */
  | { kind: "granted"; session: PanelSession }
  /** A group no agent uses: it can be granted to one of `candidates`. */
  | { kind: "free"; candidates: PanelSession[] };

/** What the active tab's group is, for the grant / revoke controls. */
export function groupState(sessions: PanelSession[], tab: ActiveTab | undefined): GroupState {
  if (!tab || tab.groupId < 0) return { kind: "ungrouped" };
  const granted = sessions.find(s => s.grantedGroupIds.includes(tab.groupId));
  if (granted) return { kind: "granted", session: granted };
  const own = sessions.find(s => s.groupId === tab.groupId);
  if (own) return { kind: "agent", session: own };
  return { kind: "free", candidates: sessions };
}
