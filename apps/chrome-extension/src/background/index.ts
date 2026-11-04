// Service worker entry: wires storage, connection, executor and state together.
import { Connection } from "./connection.ts";
import type { SocketLike } from "./connection.ts";
import { realChromeApi } from "./chrome-api.ts";
import { Executor } from "./executor.ts";
import { clearToken, KEYS, loadSettings } from "./pairing.ts";
import { State } from "./state.ts";
import { TabManager } from "./tabs.ts";
import { noopUi } from "./ui.ts";

const api = realChromeApi();
const state = new State(api.storage);
const tabs = new TabManager(api);
const executor = new Executor({ api, tabs, state, ui: noopUi });

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
  if (!s.gatewayUrl || !s.token) {
    connection.stop();
    return;
  }
  try { connection.start(s.gatewayUrl, s.token); } catch { connection.stop(); }
}

state.onChange(paused => connection.sendState(paused));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (KEYS.token in changes || KEYS.gatewayUrl in changes)) void connect();
});

// Keeps the worker (and thus the socket) honest after Chrome suspends it.
chrome.alarms.create("ais-keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => {
  if (connection.needsRestart()) void connect();
});

// Control messages for the popup / overlay (visuals task).
chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, reply) => {
  if (msg.type === "ais-pause") state.pause();
  else if (msg.type === "ais-resume") state.resume();
  else if (msg.type === "ais-stop") void state.stop();
  else if (msg.type === "ais-status") { reply({ status: connection.status, paused: state.paused }); return false; }
  return false;
});

void Promise.all([state.load(), tabs.load()]).then(connect);
