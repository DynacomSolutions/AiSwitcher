// Service worker entry: wires storage, connection, executor, overlay and state together.
import { Connection } from "./connection.ts";
import type { SocketLike } from "./connection.ts";
import { realChromeApi } from "./chrome-api.ts";
import { Executor } from "./executor.ts";
import { clearToken, KEYS, loadSettings } from "./pairing.ts";
import { State } from "./state.ts";
import { colorForIdentity, TabManager } from "./tabs.ts";
import { handleMessage } from "./messages.ts";
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
// Stop ends every grant: the user takes the groups back.
state.onStop(() => tabs.revokeAll());
// A granted group the user closed or dissolved is no longer granted.
chrome.tabGroups.onRemoved.addListener(() => { void tabs.pruneGrants(); });

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
  tabs.expireIdle();
  await tabs.pruneGrants();
  const attached = new Set(executor.attachedTabIds());
  const s = await loadSettings(api.storage);
  return {
    status: disconnected && s.token ? "disconnected" : connection.status,
    paused: state.paused,
    inflight: state.inflightCount,
    signedIn: Boolean(s.token),
    ...(s.binding ? { binding: s.binding } : {}),
    ...(s.target ? { target: s.target } : {}),
    ...(s.profileLabel ? { profileLabel: s.profileLabel } : {}),
    sessions: [...tabs.sessions].map(([id, t]) => ({
      id, identity: t.identity, label: t.label, tabs: t.tabIds.size, color: hexForIdentity(t.identity), group: colorForIdentity(t.identity),
      groupId: t.groupId, tabIds: [...t.tabIds], controlledTabIds: ui.markedTabs(id), attachedTabIds: [...t.tabIds].filter(x => attached.has(x)), grantedGroupIds: tabs.grantedGroups(id),
    })),
  };
}

const startup = Promise.all([state.load(), api.storage.get([DISCONNECTED_KEY]).then(r => { disconnected = r[DISCONNECTED_KEY] === true; }), tabs.load()]).then(connect);

// Keeps the worker (and thus the socket) honest after Chrome suspends it. Waits for the startup load so it never races it.
chrome.alarms.create("ais-keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => {
  void startup.then(async () => { tabs.expireIdle(); if (connection.needsRestart()) await connect(); });
});

// Control messages from the side panel and the in-page Stop button (see messages.ts for who may send what).
chrome.runtime.onMessage.addListener((msg: unknown, sender, reply) => handleMessage(msg, sender, reply, {
  runtimeId: chrome.runtime.id,
  state,
  status: panelStatus,
  setDisconnected: async value => {
    disconnected = value;
    await api.storage.set({ [DISCONNECTED_KEY]: value });
    await connect();
  },
  isMarked: tabId => ui.has(tabId),
  grant: (groupId, sessionId) => tabs.grant(groupId, sessionId),
  revoke: async groupId => { tabs.revoke(groupId); },
}));
