// Side panel: connection status, binding, agent sessions and the Pause / Resume / Stop controls. Plain DOM.
import type { PanelMessage, PanelSession, PanelStatus } from "../shared/panel.ts";
import { targetText } from "../shared/panel.ts";
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

function send(type: PanelMessage): Promise<unknown> { return chrome.runtime.sendMessage({ type }); }

function sessionRow(s: PanelSession): HTMLElement {
  const bar = h("span", { class: "bar" });
  bar.style.background = s.color;
  return h("li", {}, bar, h("div", {}, h("div", { class: "title" }, s.label), h("div", { class: "sub" }, s.identity)), h("span", { class: "count" }, `${s.tabs} ${s.tabs === 1 ? "tab" : "tabs"}`));
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

export function render(s: PanelStatus, root: HTMLElement, chip: HTMLElement): void {
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

  const out: HTMLElement[] = [hero];
  if (s.signedIn) {
    out.push(h("section", { class: "card" }, h("h2", {}, "Binding"), h("dl", { class: "kv" },
      h("dt", {}, "Name"), h("dd", {}, s.binding ?? "unknown"),
      h("dt", {}, "Bound to"), h("dd", {}, targetText(s.target)),
      h("dt", {}, "Profile"), h("dd", {}, s.profileLabel ?? "Chrome profile"))));
    const list = s.sessions.length
      ? h("ul", { class: "sessions" }, ...s.sessions.map(sessionRow))
      : h("p", { class: "empty" }, "No agent sessions yet. They appear here when an agent opens a tab.");
    out.push(h("section", { class: "card" }, h("h2", {}, `Agent sessions (${s.sessions.length})`), list));
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

async function refresh(): Promise<void> {
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
  setInterval(() => { if (!document.hidden) void refresh(); }, 1500); // sessions live in the worker, not in storage
}
