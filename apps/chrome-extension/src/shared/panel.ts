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

/** Self-update state for the side panel. */
export interface UpdateInfo {
  /** Version running now. */
  running: string;
  /** Latest release, once checked. */
  latest?: string;
  checkedAt?: number;
  /** Automatic updates on (default). */
  auto: boolean;
  /** The AIS helper is not registered on this computer (`ais update` registers it). */
  hostMissing?: boolean;
  error?: string;
  updating?: boolean;
  /** Installed; the reload waits for running agent calls to finish. */
  waitingForIdle?: boolean;
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
  update?: UpdateInfo;
}

export type PanelMessage = "ais-pause" | "ais-resume" | "ais-stop" | "ais-disconnect" | "ais-connect" | "ais-grant" | "ais-revoke" | "ais-update-check" | "ais-update-now" | "ais-update-auto";

export const targetText = (t: BrowserTarget | undefined): string =>
  t ? (t.kind === "pool" ? `Pool ${t.pool}` : `Identity ${t.identity}`) : "Not bound";
