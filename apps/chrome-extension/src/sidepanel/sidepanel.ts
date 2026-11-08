// Side panel: connection status, binding and the agent sessions using the active tab, with Pause / Resume / Stop. Plain DOM.
import type { PanelMessage, PanelStatus } from "../shared/panel.ts";
import { targetText } from "../shared/panel.ts";
import { groupState, sessionsForTab } from "../shared/current-tab.ts";
import type { ActiveTab, TabSession } from "../shared/current-tab.ts";
import { KEYS, PairingError, parseConsoleUrl, signIn, UNREACHABLE_MESSAGE } from "../background/pairing.ts";
import { realChromeApi } from "../background/chrome-api.ts";

type Tone = "ok" | "warn" | "bad" | "idle";
interface View { tone: Tone; chip: string; busy?: boolean; title: string; text: string; actions: Array<{ label: string; send?: PanelMessage; kind?: "primary" | "danger" | "quiet"; open?: boolean; signOut?: boolean }> }

/** Pure mapping from status to what the panel shows; exported for tests. */
export function viewFor(s: PanelStatus): View {
  if (!s.signedIn || s.status === "signed_out") {
    return { tone: "idle", chip: "Not connected", title: "Connect this browser", text: "Enter the address of your AIS and approve the connection. Agents cannot reach this browser until then.", actions: [] };
  }
  if (s.status === "disconnected") {
    return { tone: "idle", chip: "Disconnected", title: "Disconnected", text: "This profile is paired but not connected. Agents cannot reach it.", actions: [{ label: "Connect", send: "ais-connect", kind: "primary" }] };
  }
  if (s.status === "replaced") {
    return { tone: "bad", chip: "Replaced", title: "Another browser took over", text: "A different Chrome profile connected with this binding. Reconnect to take it back.", actions: [{ label: "Reconnect", send: "ais-connect", kind: "primary" }] };
  }
  if (s.paused) {
    return { tone: "warn", chip: "Paused", title: "Paused", text: "Agents are blocked from this browser. Nothing runs until you resume.", actions: [{ label: "Resume", send: "ais-resume", kind: "primary" }] };
  }
  if (s.status === "connected") {
    return { tone: "ok", chip: "Connected", title: "Agents can use this browser", text: "Each agent session gets its own tab group. You stay in charge: pause or stop at any time.", actions: [{ label: "Pause all", send: "ais-pause" }, { label: "Stop", send: "ais-stop", kind: "danger" }] };
  }
  return { tone: "warn", chip: s.status === "connecting" ? "Connecting" : "Reconnecting", busy: true, title: s.status === "connecting" ? "Connecting to the gateway" : "Reconnecting to the gateway", text: "Agents cannot reach this browser until the connection is back.", actions: [{ label: "Pause all", send: "ais-pause" }] };
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v; else el.setAttribute(k, v);
  }
  el.append(...kids);
  return el;
}

function send(type: PanelMessage, extra: Record<string, unknown> = {}): Promise<unknown> { return chrome.runtime.sendMessage({ type, ...extra }); }

/** Active tab of the window this panel lives in; undefined until known. */
let activeTab: ActiveTab | undefined;

function tabSessionRow(t: TabSession, paused: boolean, tab: ActiveTab | undefined): HTMLElement {
  const { session: s } = t;
  const bar = h("span", { class: "bar" });
  bar.style.background = s.color;
  const state = h("span", { class: `use ${t.use}` }, t.use === "controlling" ? "Controlling this tab" : "Idle");
  const btn = (label: string, msg: PanelMessage, kind = "") => {
    const b = h("button", { type: "button", class: `small ${kind}`.trim(), title: "Applies to every agent in this browser" }, label);
    b.addEventListener("click", () => void send(msg).then(refresh));
    return b;
  };
  const controls = h("div", { class: "row-actions" }, paused ? btn("Resume", "ais-resume") : btn("Pause", "ais-pause"), btn("Stop", "ais-stop", "danger"));
  return h("li", { class: "tab-row" }, bar, h("div", {}, h("div", { class: "title" }, s.label), h("div", { class: "sub" }, state, tab && s.grantedGroupIds.includes(tab.groupId) ? " \u00b7 granted group" : "")), controls);
}

/** Session picked in the grant form; kept across the timed re-renders. */
let pickedSession = "";
let grantError = "";

const GRANT_ERRORS: Record<string, string> = {
  no_session: "That session has ended.",
  no_group: "That tab group no longer exists.",
  in_use: "An agent is already using this group.",
};

function groupControls(s: PanelStatus, tab: ActiveTab | undefined): HTMLElement | undefined {
  const g = groupState(s.sessions, tab);
  if (g.kind === "ungrouped" || g.kind === "agent" || !tab) return undefined;
  if (g.kind === "granted") {
    const revoke = h("button", { type: "button", class: "small" }, "Revoke access");
    revoke.addEventListener("click", () => void send("ais-revoke", { groupId: tab.groupId }).then(refresh));
    return h("div", { class: "grant" }, h("div", { class: "sub" }, "This tab group is granted to ", h("strong", {}, g.session.label), "."), h("div", { class: "row-actions" }, revoke));
  }
  const title = h("div", { class: "grant-title" }, "Let an agent use this group");
  if (g.candidates.length === 0) return h("div", { class: "grant" }, title, h("p", { class: "empty" }, "No active agent sessions to grant it to."));
  if (!g.candidates.some(c => c.id === pickedSession)) pickedSession = g.candidates[0]!.id;
  const select = h("select", { "aria-label": "Agent session" }, ...g.candidates.map(c => h("option", { value: c.id }, c.label)));
  select.value = pickedSession;
  select.addEventListener("change", () => { pickedSession = select.value; });
  const grant = h("button", { type: "button", class: "small primary-small" }, "Grant");
  grant.addEventListener("click", () => {
    grantError = "";
    void send("ais-grant", { groupId: tab.groupId, sessionId: pickedSession }).then(r => { const e = (r as { error?: string } | undefined)?.error; if (e) grantError = GRANT_ERRORS[e] ?? "Could not grant access."; }).then(refresh);
  });
  const err = h("p", { class: "banner bad", role: "alert" }, grantError);
  err.hidden = grantError === "";
  return h("div", { class: "grant" }, title, h("p", { class: "hint" }, "The agent can use and open tabs in it. It cannot rename or close the group."), h("div", { class: "grant-form" }, select, grant), err);
}

function thisTabCard(s: PanelStatus, tab: ActiveTab | undefined): HTMLElement {
  const using = sessionsForTab(s.sessions, tab, s.paused);
  const body = using.length
    ? h("ul", { class: "sessions" }, ...using.map(t => tabSessionRow(t, s.paused, tab)))
    : h("p", { class: "empty" }, "No agent is using this tab.");
  const controls = groupControls(s, tab);
  return h("section", { class: "card", id: "this-tab" }, h("h2", {}, using.length ? `This tab (${using.length})` : "This tab"), body, ...(controls ? [controls] : []));
}

/** Sign-in form state. The panel re-renders on a timer, so the form is built once and only patched afterwards. */
const form: { draft: string; error: string; busy: boolean; loaded: boolean } = { draft: "", error: "", busy: false, loaded: false };

function chromeEmail(): Promise<string | undefined> {
  return new Promise(resolve => {
    try { chrome.identity.getProfileUserInfo({ accountStatus: "ANY" as chrome.identity.AccountStatus }, info => resolve(info?.email || undefined)); } catch { resolve(undefined); }
  });
}

async function connectClicked(): Promise<void> {
  form.error = "";
  form.busy = true;
  patchForm();
  try {
    const api = realChromeApi();
    await signIn({
      storage: api.storage,
      launch: url => chrome.identity.launchWebAuthFlow({ url, interactive: true }),
      redirectUri: chrome.identity.getRedirectURL("cb"),
      getEmail: chromeEmail,
      platform: (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "",
    }, form.draft);
  } catch (e) {
    form.error = e instanceof PairingError ? e.message : UNREACHABLE_MESSAGE;
  }
  form.busy = false;
  patchForm();
  await refresh();
}

/** Applies the form state to the existing form elements without rebuilding them (keeps focus and caret). */
function patchForm(): void {
  const input = document.getElementById("ais-url") as HTMLInputElement | null;
  const button = document.getElementById("ais-connect") as HTMLButtonElement | null;
  const err = document.getElementById("ais-error");
  if (!input || !button || !err) return;
  input.disabled = form.busy;
  button.disabled = form.busy || !parseConsoleUrl(form.draft);
  button.textContent = form.busy ? "Waiting for approval..." : "Connect";
  err.textContent = form.error;
  err.hidden = form.error === "";
  const hint = document.getElementById("ais-hint");
  if (hint) hint.hidden = form.draft === "" || Boolean(parseConsoleUrl(form.draft)) || form.error !== "";
}

function signInCard(v: View): HTMLElement {
  const input = h("input", { id: "ais-url", type: "text", inputmode: "url", spellcheck: "false", autocomplete: "off", placeholder: "https://ais.example.com", "aria-label": "AIS address" });
  input.value = form.draft;
  input.addEventListener("input", () => { form.draft = input.value; form.error = ""; patchForm(); });
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !form.busy && parseConsoleUrl(form.draft)) void connectClicked(); });
  const button = h("button", { id: "ais-connect", type: "button", class: "primary" }, "Connect");
  button.addEventListener("click", () => void connectClicked());
  const error = h("p", { id: "ais-error", class: "banner bad", role: "alert", hidden: "" });
  const hint = h("p", { id: "ais-hint", class: "hint", hidden: "" }, "Use the full https address, for example https://ais.example.com");
  return h("section", { id: "signin-card", class: "card hero idle" }, h("h1", {}, v.title), h("p", {}, v.text), h("label", { class: "field" }, h("span", {}, "AIS address"), input), hint, error, h("div", { class: "actions" }, button));
}

export function render(s: PanelStatus, root: HTMLElement, chip: HTMLElement, tab: ActiveTab | undefined = activeTab): void {
  const v = viewFor(s);
  chip.textContent = v.chip;
  chip.className = `chip ${v.tone === "idle" ? "" : v.tone}${v.busy ? " busy" : ""}`.trim();
  if (!s.signedIn || s.status === "signed_out") {
    if (!root.querySelector("#signin-card")) { root.replaceChildren(signInCard(v)); }
    patchForm();
    return;
  }

  const actions = h("div", { class: "actions" }, ...v.actions.map(a => {
    const b = h("button", { type: "button", class: a.kind ?? "" }, a.label);
    b.addEventListener("click", () => {
      if (a.send) void send(a.send).then(refresh);
    });
    return b;
  }));
  const hero = h("section", { class: `card hero ${v.tone}` }, h("h1", {}, v.title), h("p", {}, v.text), actions);

  const out: HTMLElement[] = [];
  if (s.signedIn) {
    out.push(thisTabCard(s, tab), hero);
    out.push(h("section", { class: "card" }, h("h2", {}, "Binding"), h("dl", { class: "kv" },
      h("dt", {}, "Name"), h("dd", {}, s.binding ?? "unknown"),
      h("dt", {}, "Bound to"), h("dd", {}, targetText(s.target)),
      h("dt", {}, "Profile"), h("dd", {}, s.profileLabel ?? "Chrome profile"))));
    const foot = h("div", { class: "foot" });
    if (s.status !== "disconnected") {
      const d = h("button", { type: "button", class: "quiet" }, "Disconnect");
      d.addEventListener("click", () => void send("ais-disconnect").then(refresh));
      foot.append(d);
    }
    const so = h("button", { type: "button", class: "quiet" }, "Sign out");
    so.addEventListener("click", () => void chrome.storage.local.remove(["token", "binding", "target"]).then(refresh));
    foot.append(so);
    out.push(foot);
  }
  root.replaceChildren(...out);
}

async function readActiveTab(): Promise<void> {
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = t?.id === undefined ? undefined : { id: t.id, groupId: t.groupId ?? -1 };
  } catch { activeTab = undefined; }
}

async function refresh(): Promise<void> {
  await readActiveTab();
  if (!form.loaded) {
    form.loaded = true;
    const saved = (await chrome.storage.local.get([KEYS.consoleUrl]))[KEYS.consoleUrl];
    if (typeof saved === "string" && !form.draft) form.draft = saved;
  }
  const s = (await chrome.runtime.sendMessage({ type: "ais-status" })) as PanelStatus | undefined;
  if (s) render(s, document.getElementById("root")!, document.getElementById("chip")!);
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  void refresh();
  chrome.storage.onChanged.addListener(() => void refresh());
  // The tab under the panel changes without any storage write: follow tabs, groups and window focus.
  chrome.tabs.onActivated.addListener(() => void refresh());
  chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status !== undefined || info.groupId !== undefined || info.url !== undefined) void refresh(); });
  chrome.tabs.onAttached.addListener(() => void refresh());
  chrome.tabs.onRemoved.addListener(() => void refresh());
  chrome.tabGroups?.onUpdated.addListener(() => void refresh());
  chrome.tabGroups?.onRemoved.addListener(() => void refresh());
  chrome.windows.onFocusChanged.addListener(() => void refresh());
  // The worker pushes nothing, so session state (controlling now, pause) comes from the poll below.
  setInterval(() => { if (!document.hidden) void refresh(); }, 1500); // sessions live in the worker, not in storage
}
