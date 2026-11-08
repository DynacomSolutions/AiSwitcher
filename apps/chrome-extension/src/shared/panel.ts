// Message shapes shared by the service worker and side panel.
import type { BrowserTarget } from "../../../../src/browser/types.ts";

export interface PanelSession { id: string; identity: string; label: string; tabs: number; color: string; group: string;
  /** Chrome tab group id of the session, -1 when ungrouped. */
  groupId: number;
  /** Tabs the session owns (it created or adopted them). */
  tabIds: number[];
  /** Tabs the overlay currently marks as controlled by this session. */
  controlledTabIds: number[];
  /** Tabs the debugger is attached to for this session. */
  attachedTabIds: number[];
  /** Tab groups the user granted to this session. */
  grantedGroupIds: number[];
}

export interface PanelStatus {
  status: "idle" | "connecting" | "connected" | "reconnecting" | "signed_out" | "replaced" | "disconnected";
  paused: boolean;
  /** Tool calls running right now. */
  inflight: number;
  signedIn: boolean;
  binding?: string;
  target?: BrowserTarget;
  profileLabel?: string;
  sessions: PanelSession[];
}

export type PanelMessage = "ais-pause" | "ais-resume" | "ais-stop" | "ais-disconnect" | "ais-connect" | "ais-grant" | "ais-revoke";

export const targetText = (t: BrowserTarget | undefined): string =>
  t ? (t.kind === "pool" ? `Pool ${t.pool}` : `Identity ${t.identity}`) : "Not bound";
