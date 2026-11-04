// Side panel: connection status, binding, agent sessions and the Pause / Resume / Stop controls. Plain DOM.
import type { PanelMessage, PanelSession, PanelStatus } from "../shared/panel.ts";
import { targetText } from "../shared/panel.ts";

type Tone = "ok" | "warn" | "bad" | "idle";
interface View { tone: Tone; chip: string; busy?: boolean; title: string; text: string; actions: Array<{ label: string; send?: PanelMessage; kind?: "primary" | "danger" | "quiet"; open?: boolean; signOut?: boolean }> }

/** Pure mapping from status to what the panel shows; exported for tests. */
export function viewFor(s: PanelStatus): View {
  if (!s.signedIn || s.status === "signed_out") {
    return { tone: "idle", chip: "Signed out", title: "Not signed in", text: "Pair this Chrome profile with an AIS identity or pool. Agents cannot reach it until then.", actions: [{ label: "Sign in", open: true, kind: "primary" }] };
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

export function render(s: PanelStatus, root: HTMLElement, chip: HTMLElement): void {
  const v = viewFor(s);
  chip.textContent = v.chip;
  chip.className = `chip ${v.tone === "idle" ? "" : v.tone}${v.busy ? " busy" : ""}`.trim();

  const actions = h("div", { class: "actions" }, ...v.actions.map(a => {
    const b = h("button", { type: "button", class: a.kind ?? "" }, a.label);
    b.addEventListener("click", () => {
      if (a.open) void chrome.runtime.openOptionsPage();
      else if (a.send) void send(a.send).then(refresh);
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
  const s = (await chrome.runtime.sendMessage({ type: "ais-status" })) as PanelStatus | undefined;
  if (s) render(s, document.getElementById("root")!, document.getElementById("chip")!);
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  void refresh();
  chrome.storage.onChanged.addListener(() => void refresh());
  setInterval(() => { if (!document.hidden) void refresh(); }, 1500); // sessions live in the worker, not in storage
}
