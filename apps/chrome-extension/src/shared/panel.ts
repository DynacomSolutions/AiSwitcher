// Message shapes shared by the service worker, side panel and options page.
import type { BrowserTarget } from "../../../../src/browser/types.ts";

export interface PanelSession { id: string; identity: string; label: string; tabs: number; color: string; group: string }

export interface PanelStatus {
  status: "idle" | "connecting" | "connected" | "reconnecting" | "signed_out" | "replaced" | "disconnected";
  paused: boolean;
  signedIn: boolean;
  binding?: string;
  target?: BrowserTarget;
  profileLabel?: string;
  sessions: PanelSession[];
}

export type PanelMessage = "ais-pause" | "ais-resume" | "ais-stop" | "ais-disconnect" | "ais-connect";

export const targetText = (t: BrowserTarget | undefined): string =>
  t ? (t.kind === "pool" ? `Pool ${t.pool}` : `Identity ${t.identity}`) : "Not bound";
