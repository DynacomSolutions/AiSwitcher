// Tab strip logic for the side panel: which tab shows first and how the keys move between tabs.
import type { PanelStatus } from "../shared/panel.ts";

export type PanelTab = "chat" | "status";
export const PANEL_TABS: readonly PanelTab[] = ["chat", "status"];

/** Chat when the browser is signed in, else Status (it holds the sign-in form). */
export function defaultTab(s: Pick<PanelStatus, "signedIn" | "status">): PanelTab {
  return s.signedIn && s.status !== "signed_out" ? "chat" : "status";
}

/** Tab reached by an arrow, Home or End key; the arrows wrap. */
export function nextTab(current: PanelTab, key: "ArrowLeft" | "ArrowRight" | "Home" | "End"): PanelTab {
  const n = PANEL_TABS.length;
  const i = PANEL_TABS.indexOf(current);
  if (key === "Home") return PANEL_TABS[0]!;
  if (key === "End") return PANEL_TABS[n - 1]!;
  return PANEL_TABS[(i + (key === "ArrowRight" ? 1 : n - 1)) % n]!;
}

const storageKey = (windowId: number): string => `panelTab:${windowId}`;

/** Selected tab of one window, kept in session storage. */
export async function loadTab(windowId: number): Promise<PanelTab | undefined> {
  const v = (await chrome.storage.session.get(storageKey(windowId)))[storageKey(windowId)];
  return v === "chat" || v === "status" ? v : undefined;
}

export async function saveTab(windowId: number, tab: PanelTab): Promise<void> {
  await chrome.storage.session.set({ [storageKey(windowId)]: tab });
}
