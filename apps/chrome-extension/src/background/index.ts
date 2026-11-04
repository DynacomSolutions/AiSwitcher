// Service worker entry: wires storage, connection, executor, overlay and state together.
import { Connection } from "./connection.ts";
import type { SocketLike } from "./connection.ts";
import { realChromeApi } from "./chrome-api.ts";
import { Executor } from "./executor.ts";
import { clearToken, KEYS, loadSettings } from "./pairing.ts";
import { State } from "./state.ts";
import { colorForIdentity, TabManager } from "./tabs.ts";
import { hexForIdentity, OverlayUi } from "./ui.ts";
import type { PanelStatus } from "../shared/panel.ts";

const DISCONNECTED_KEY = "disconnected";

const api = realChromeApi();
const state = new State(api.storage);
const tabs = new TabManager(api);
const ui = new OverlayUi();
const executor = new Executor({ api, tabs, state, ui });
let disconnected = false;

const connection = new Connection({
  createSocket: url => new WebSocket(url) as unknown as SocketLike,
  version: chrome.runtime.getManifest().version,
  isPaused: () => state.paused,
  onCall: req => executor.run(req),
  onAbort: id => state.abort(id),
  onStatus: status => { void api.storage.set({ status }); },
  onSignedOut: () => { void clearToken(api.storage); },
});

async function connect(): Promise<void> {
  const s = await loadSettings(api.storage);
  if (!s.gatewayUrl || !s.token || disconnected) {
    connection.stop();
    return;
  }
  try { connection.start(s.gatewayUrl, s.token); } catch { connection.stop(); }
}

state.onChange(paused => connection.sendState(paused));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (KEYS.token in changes || KEYS.gatewayUrl in changes)) void connect();
});

// Controlled tabs that load a new page lose the overlay with the old document: draw it again.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "complete" && ui.has(tabId) && !state.paused) void ui.refresh(tabId);
});

// The panel opens from the toolbar button.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function panelStatus(): Promise<PanelStatus> {
  const s = await loadSettings(api.storage);
  return {
    status: disconnected && s.token ? "disconnected" : connection.status,
    paused: state.paused,
    signedIn: Boolean(s.token),
    ...(s.binding ? { binding: s.binding } : {}),
    ...(s.target ? { target: s.target } : {}),
    ...(s.profileLabel ? { profileLabel: s.profileLabel } : {}),
    sessions: [...tabs.sessions].map(([id, t]) => ({ id, identity: t.identity, label: t.label, tabs: t.tabIds.size, color: hexForIdentity(t.identity), group: colorForIdentity(t.identity) })),
  };
}

const startup = Promise.all([state.load(), api.storage.get([DISCONNECTED_KEY]).then(r => { disconnected = r[DISCONNECTED_KEY] === true; }), tabs.load()]).then(connect);

// Keeps the worker (and thus the socket) honest after Chrome suspends it. Waits for the startup load so it never races it.
chrome.alarms.create("ais-keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => {
  void startup.then(async () => { if (connection.needsRestart()) await connect(); });
});

// Control messages from the side panel, options page and the in-page Stop button.
chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, reply) => {
  switch (msg.type) {
    case "ais-pause": state.pause(); reply({ ok: true }); return false;
    case "ais-resume": state.resume(); reply({ ok: true }); return false;
    case "ais-stop": void state.stop().then(() => reply({ ok: true })); return true;
    case "ais-disconnect":
      disconnected = true;
      void api.storage.set({ [DISCONNECTED_KEY]: true }).then(() => connect()).then(() => reply({ ok: true }));
      return true;
    case "ais-connect":
      disconnected = false;
      void api.storage.set({ [DISCONNECTED_KEY]: false }).then(() => connect()).then(() => reply({ ok: true }));
      return true;
    case "ais-status": void panelStatus().then(reply); return true;
    default: return false;
  }
});
