// Side panel shell: a Chat tab and a Status tab. The status code lives in status.ts.
import type { PanelStatus } from "../shared/panel.ts";
import { initStatus } from "./status.ts";
import { defaultTab, loadTab, nextTab, PANEL_TABS, saveTab } from "./tabs.ts";
import type { PanelTab } from "./tabs.ts";

export { viewFor, updateView, render } from "./status.ts";

function select(tab: PanelTab, focus = false): void {
  document.getElementById("panel-loading")?.setAttribute("hidden", "");
  for (const t of PANEL_TABS) {
    const btn = document.getElementById(`tab-${t}`) as HTMLButtonElement | null;
    const panel = document.getElementById(t);
    if (!btn || !panel) continue;
    btn.setAttribute("aria-selected", String(t === tab));
    btn.tabIndex = t === tab ? 0 : -1;
    panel.hidden = t !== tab;
    if (t === tab && focus) btn.focus();
  }
}

async function initTabs(): Promise<void> {
  const win = await chrome.windows.getCurrent();
  const windowId = win.id ?? -1;
  let chosen = await loadTab(windowId);
  const choose = (tab: PanelTab, focus = false): void => {
    chosen = tab;
    select(tab, focus);
    void saveTab(windowId, tab);
  };
  for (const t of PANEL_TABS) {
    const btn = document.getElementById(`tab-${t}`)!;
    btn.addEventListener("click", () => choose(t));
    btn.addEventListener("keydown", e => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
        e.preventDefault();
        choose(nextTab(t, e.key), true);
      }
    });
  }
  // Show no panel until the saved tab or the status is known.
  if (chosen) { select(chosen); return; }
  let status: PanelStatus | undefined;
  try { status = (await chrome.runtime.sendMessage({ type: "ais-status" })) as PanelStatus | undefined; } catch { status = undefined; }
  if (!chosen) select(status ? defaultTab(status) : "status");
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  initStatus();
  void initTabs();
}
