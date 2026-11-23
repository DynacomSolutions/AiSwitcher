// End-to-end: the side-panel chat in real Chromium, with the built extension and an in-process gateway.
//
// Not picked up by plain `bun test` (the file name has no .test. part). Run from the repo root with:
//   bun run test:e2e            (needs Chromium; runs this file and extension.e2e.ts)
// or directly: bun test ./apps/chrome-extension/test/e2e/chat.e2e.ts
// Env: AIS_E2E_CHROMIUM (binary), AIS_E2E_EVIDENCE (dir for screenshots), AIS_E2E_TMP (scratch dir; default the OS temp dir).
//
// The gateway runs its real chat broker, but the pod is the stub ACP agent as a local process (test/gateway/fixtures). The stub agent
// calls the browser tools through the chat's own MCP URL with the chat token, so the whole path is real: panel, worker, WebSocket,
// broker, MCP route, extension executor, page overlay. The tests share one browser and run in order.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { MemoryChatStore } from "../../../../src/gateway/chat/store.ts";
import { startGateway } from "../../../../src/gateway/serve.ts";
import type { RunningGateway } from "../../../../src/gateway/serve.ts";
import { MemoryGatewayStore } from "../../../../src/gateway/store.ts";
import { StubPodTransport } from "../../../../test/gateway/fixtures/stub-transport.ts";
import { CAP_MESSAGE } from "../../src/shared/chat.ts";
import type { Cdp, Session } from "./cdp.ts";
import * as H from "./harness.ts";
import { ADMIN, chromium, dumpLogs, save, sleep, step, trustedClick, until } from "./harness.ts";

const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:0;padding:48px;background:#f7f6f3;color:#222}h1{margin:0 0 24px}
button{font:inherit;padding:12px 22px;border-radius:10px;border:1px solid #bbb;background:#fff;margin:0 12px 12px 0}
#save{position:absolute;left:520px;top:300px}#go{position:absolute;left:120px;top:200px}#out{position:absolute;left:120px;top:120px}</style>${body}`;

let gateway: RunningGateway;
let gatewayPorts = { port: 0, adminPort: 0 };
let site: ReturnType<typeof Bun.serve>;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let runDir = "";
let cdp: Cdp;
let extId = "";
let sw: Session;
let ctl: Session;
let transport: StubPodTransport;
const store = new MemoryGatewayStore();
const chatStore = new MemoryChatStore();

const logFiles = (): string[] => (runDir ? [join(runDir, "logs", "chromium.log")] : []);
const siteUrl = (path: string) => `http://127.0.0.1:${site.port}${path}`;

/** A test that prints the Chromium log tail when it fails. The tests are slow on a loaded host, so the default limit is generous. */
function it(name: string, fn: () => Promise<void>, ms = 600_000): void {
  test(name, async () => {
    try { await fn(); } catch (e) { await dumpLogs(logFiles()); await dumpChats(); throw e; }
  }, ms);
}

/** On a failure: the state and the last feed items of every chat the worker holds. */
async function dumpChats(): Promise<void> {
  try {
    const r = await sw.eval<{ chatHub?: { chats: Array<{ view: HubChat }> } }>(`chrome.storage.session.get("chatHub")`);
    for (const c of r.chatHub?.chats ?? []) console.error(`chat ${c.view.summary.name}: ${c.view.summary.state} links=${JSON.stringify(c.view.summary.tabIds)} last=${JSON.stringify(c.view.items.slice(-3).map(i => i.body))}`);
  } catch { /* the worker is gone */ }
}

const shot = async (name: string, s: Session): Promise<void> => {
  await s.send("Page.bringToFront");
  await sleep(400);
  await save(`${name}.png`, await s.screenshot());
};

async function boot(ports: { port: number; adminPort: number }): Promise<RunningGateway> {
  const g = await startGateway({ port: ports.port, adminPort: ports.adminPort, databaseUrl: "postgres://unused", adminToken: ADMIN, handleSignals: false }, {
    host: "127.0.0.1",
    migrate: async () => {},
    openStore: () => store,
    browserPoolMembers: async p => (p === "main" ? ["id1"] : undefined),
    browserIdentityExists: async i => (i === "id1" ? i : undefined),
    poolMembers: async () => ["id1"],
    usageFor: async () => undefined,
    notify: () => {},
    refreshIntervalMs: 3_600_000,
    ledger: { max: 1000, flushMs: 3_600_000 },
    exit: () => {},
    noHeartbeat: true,
    chatTransport: transport,
    chatStore,
  });
  await step("gateway ready", 30_000, until("gateway ready", () => g.ready(), 30_000));
  return g;
}

// ---- the page overlay and the worker -----------------------------------------------------------------

/** Calls a method of the in-page overlay (isolated world), through the worker. */
const ov = <T = unknown>(tabId: number, method: string, arg: unknown = null): Promise<T> =>
  sw.eval<T>(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: (m, a) => globalThis.__aisOverlay?.[m]?.(a), args: [${JSON.stringify(method)}, ${JSON.stringify(arg)}] }).then(r => r[0]?.result)`);
interface Rect { x: number; y: number; w: number; h: number }
interface Snapshot { pill: string; pillOn: boolean; hostVisibility: string; cursors: Array<{ sessionId: string; rect: Rect | null; colour: string; tag: string }>; stops: Array<{ label: string; text: string; rect: Rect | null }> }
const snapshot = (tabId: number): Promise<Snapshot | null> => ov<Snapshot | null>(tabId, "snapshot");
const centreOf = (s: Session, id: string) => s.eval<{ x: number; y: number }>(`(() => { const { left, top, width, height } = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: left + width / 2, y: top + height / 2 }; })()`);
const status = () => ctl.eval<{ paused: boolean; inflight: number; status: string }>(`chrome.runtime.sendMessage({ type: "ais-status" })`);
const activate = async (tabId: number): Promise<void> => { await sw.eval(`chrome.tabs.update(${tabId}, { active: true })`); await sleep(500); };
const newTab = async (path: string): Promise<{ id: number; session: Session }> => {
  const id = await sw.eval<number>(`chrome.tabs.create({ url: ${JSON.stringify(siteUrl(path))}, active: false }).then(t => t.id)`);
  const session = await H.pageSession(cdp, u => u === siteUrl(path));
  return { id, session };
};

// ---- what the hub holds (the persisted copy in session storage is the raw feed, before any markdown) -------

interface HubItem { seq: number; body: { k: string; text?: string; requestId?: string; stopReason?: string } }
interface HubChat { summary: { chatId: string; name: string; state: string; tabIds: number[]; color: string }; items: HubItem[] }
const hubChat = async (name: string): Promise<HubChat | undefined> => {
  const r = await sw.eval<{ chatHub?: { chats: Array<{ view: HubChat }> } }>(`chrome.storage.session.get("chatHub")`);
  // A closed chat keeps its row in the worker, and its name is free again: the newest open chat of that name is the one meant.
  return r.chatHub?.chats.map(c => c.view).filter(v => v.summary.name === name && v.summary.state !== "closed").at(-1);
};
/** True when the last turn of the chat ended because it was cancelled (the pill Stop or the composer Stop). */
const cancelledTurn = async (name: string): Promise<boolean> => {
  const items = (await hubChat(name))?.items ?? [];
  const lastUser = items.map(i => i.body.k).lastIndexOf("user");
  return items.slice(lastUser + 1).some(i => i.body.k === "turn_end" && i.body.stopReason === "cancelled");
};
/** The agent text after the last prompt of the user. */
const replyOf = async (name: string): Promise<string> => {
  const items = (await hubChat(name))?.items ?? [];
  const lastUser = items.map(i => i.body.k).lastIndexOf("user");
  return items.slice(lastUser + 1).filter(i => i.body.k === "text").map(i => i.body.text).join("");
};
const noticesOf = async (name: string): Promise<string[]> => ((await hubChat(name))?.items ?? []).filter(i => i.body.k === "notice").map(i => i.body.text ?? "");
const stateOf = async (name: string): Promise<string | undefined> => (await hubChat(name))?.summary.state;

// ---- the side panel ---------------------------------------------------------------------------------------

async function openPanel(): Promise<Session> {
  const p = await H.extensionPage(cdp, extId, "sidepanel.html");
  await p.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 760, deviceScaleFactor: 2, mobile: false });
  await p.send("Emulation.setFocusEmulationEnabled", { enabled: true }); // the panel is a tab here: it must act as focused even when another tab is active
  await until("chat list", () => p.eval<boolean>(`document.querySelector("#chat .chat-list") !== null && !document.querySelector("#chat .chat-list").hidden || (document.querySelector("#chat .chat-detail") !== null && !document.querySelector("#chat .chat-detail").hidden)`), 120_000);
  return p;
}
const clickIn = (p: Session, selector: string, text?: string) => p.eval<boolean>(`(() => {
  const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => ${text === undefined ? "true" : `e.textContent === ${JSON.stringify(text)}`} && !e.hidden && !e.disabled);
  if (!b) return false; b["click"](); return true; })()`);
const clickUntil = (p: Session, what: string, selector: string, text?: string) => until(what, () => clickIn(p, selector, text), 30_000);

/** Opens the named chat from the list, or stays in it when it is open already. */
const openChat = (p: Session, name: string) => until(`open ${name}`, () => p.eval<boolean>(`(() => {
  const d = document.querySelector(".chat-detail");
  if (!d.hidden) { if (d.querySelector(".chat-name").textContent === ${JSON.stringify(name)}) return true; [...d.querySelectorAll("button")].find(b => b.textContent === "Back").click(); }
  const row = [...document.querySelectorAll(".chat-row .row-open")].find(b => b.querySelector(".title").textContent === ${JSON.stringify(name)});
  if (!row) return false; row["click"](); return true; })()`), 30_000);
const backToList = (p: Session) => p.eval(`(() => { const d = document.querySelector(".chat-detail"); if (!d.hidden) [...d.querySelectorAll("button")].find(b => b.textContent === "Back").click(); })()`);

/** Types a message in the open chat and presses Enter. Send is disabled while the box is empty, so the text goes in first. */
async function say(p: Session, name: string, text: string): Promise<void> {
  await openChat(p, name);
  const type = `(() => { const box = document.querySelector(".chat-detail:not([hidden]) .composer-box"); box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event("input", { bubbles: true })); })()`;
  try {
    await until("send enabled", () => p.eval<boolean>(`(() => { ${type}; const b = document.querySelector(".chat-detail:not([hidden]) .composer .composer-send"); return b !== null && !b.hidden && !b.disabled; })()`), 240_000); // a loaded host needs minutes for a pod
  } catch (e) {
    console.error(`composer of ${name}:`, await p.eval<string>(`(document.querySelector(".chat-detail .composer")?.outerHTML ?? "none").slice(0, 600)`), JSON.stringify((await hubChat(name))?.summary), JSON.stringify((await hubChat(name))?.items.slice(-4)));
    throw e;
  }
  sent.set(name, (sent.get(name) ?? 0) + 1);
  await p.eval(`(() => { const box = document.querySelector(".chat-detail:not([hidden]) .composer-box"); box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); })()`);
}
const run = (steps: Array<{ tool: string; args?: Record<string, unknown> }>, extra: { repeat?: boolean; gapMs?: number } = {}): string => `run:${JSON.stringify({ steps, ...extra })}`;
/** How many messages each chat was given, so turnDone waits for the turn of the last one and not for an older one. */
const sent = new Map<string, number>();
const turnDone = (name: string, ms = 120_000) => until(`${name} idle`, async () => {
  const c = await hubChat(name);
  return c !== undefined && c.items.filter(i => i.body.k === "user").length === sent.get(name) && c.summary.state === "idle" && c.items.at(-1)?.body.k === "turn_end";
}, ms);

/** Types a message in the box of the list screen and waits until Send is enabled for it. */
const typeInList = (p: Session, text: string) => until("list Send enabled", () => p.eval<boolean>(`(() => {
  const l = document.querySelector(".chat-list"); if (l.hidden) return false;
  const box = l.querySelector(".composer-box"); box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event("input", { bubbles: true }));
  return !l.querySelector(".composer-send").disabled; })()`), 60_000);
const pressEnterInList = (p: Session) => p.eval(`document.querySelector(".chat-list .composer-box").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))`);

/** Starts a chat from the list: types the first message with the tab that is active now and sends it. Returns the chat name. */
async function newChat(p: Session, first = "say:ready"): Promise<string> {
  await backToList(p);
  await typeInList(p, first);
  await pressEnterInList(p);
  await until("new chat open", () => p.eval<boolean>(`(() => { const d = document.querySelector(".chat-detail"); return !d.hidden && d.querySelector(".chat-name").textContent !== ""; })()`), 60_000);
  const name = await p.eval<string>(`document.querySelector(".chat-detail .chat-name").textContent`);
  sent.set(name, 1);
  return name;
}
const chips = (p: Session) => p.eval<string[]>(`[...document.querySelectorAll(".chat-detail:not([hidden]) .chip-tab .chip-label")].map(e => e.textContent)`);

async function key(p: Session, k: "ArrowDown" | "Enter" | "Escape"): Promise<void> {
  const code = { ArrowDown: 40, Enter: 13, Escape: 27 }[k];
  const base = { key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await p.send("Input.dispatchKeyEvent", { type: k === "Enter" ? "keyDown" : "rawKeyDown", ...base, ...(k === "Enter" ? { text: "\r" } : {}) });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

describe.skipIf(!chromium)("Side-panel chat in real Chromium", () => {
  let P: Session;
  let tabA = 0;
  let tabB = 0;
  let pageA: Session;

  beforeAll(async () => {
    try {
      runDir = await H.makeRunDir();
      const extDir = await H.buildExtension(runDir);
      site = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          const u = new URL(req.url);
          const body = u.pathname === "/a"
            ? `<h1>Page A</h1><p id="out">idle</p><button id="go" onclick="window.clicks=(window.clicks||0)+1;out.textContent='go '+window.clicks">Go</button><button id="save">Save</button>`
            : u.pathname === "/b" ? `<h1>Page B</h1><button id="other">Other</button>`
            : u.pathname === "/s1" ? `<h1>Split one</h1>`
            : u.pathname === "/s2" ? `<h1>Split two</h1>`
            : `<h1>Fixture</h1>`;
          const title = u.pathname === "/a" ? "Page A" : u.pathname === "/b" ? "Page B" : u.pathname === "/s1" ? "Split one" : u.pathname === "/s2" ? "Split two" : "Fixture";
          return new Response(page(title, body), { headers: { "content-type": "text/html" } });
        },
      });
      transport = new StubPodTransport({ env: { STUB_ACP_STATE: join(runDir, "stub-agent.state") } });
      gateway = await boot({ port: 0, adminPort: 0 });
      gatewayPorts = { port: gateway.port, adminPort: gateway.adminPort };
      const b = await H.launchChromium(runDir, extDir);
      proc = b.proc;
      cdp = b.cdp;
      extId = b.extId;
    } catch (e) {
      await dumpLogs(logFiles());
      throw e;
    }
  }, 300_000);

  afterAll(async () => {
    try { cdp?.close(); } catch { /* gone */ }
    if (proc) { proc.kill(); await proc.exited; }
    transport?.killAll();
    await gateway?.stop().catch(() => {});
    site?.stop(true);
    if (runDir) await rm(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); // Chromium helper processes may still be writing for a moment
  }, 120_000);

  it("signs in, then the chat tab is the default and Status still shows the connection card", async () => {
    const signed = await H.signIn({ cdp, extId, gatewayPort: gatewayPorts.port, adminPort: gatewayPorts.adminPort });
    sw = signed.sw;
    ctl = signed.panel; // stays open: the control page messages the worker for status
    const a = await newTab("/a");
    const b = await newTab("/b");
    tabA = a.id; tabB = b.id; pageA = a.session;
    P = await openPanel();
    expect(await P.eval<string>(`document.getElementById("tab-chat").getAttribute("aria-selected")`)).toBe("true");
    expect(await P.eval<boolean>(`document.getElementById("chat").hidden`)).toBe(false);
    expect(await P.eval<boolean>(`document.getElementById("status").hidden`)).toBe(true);
    await P.eval(`document.getElementById("tab-status").click()`);
    await until("Status card", () => P.eval<boolean>(`document.getElementById("status").innerText.includes("Agents can use this browser")`));
    expect(await P.eval<string>(`document.getElementById("chip").textContent`)).toBe("Connected");
    expect(await P.eval<boolean>(`document.getElementById("chat").hidden`)).toBe(true);
    await P.eval(`document.getElementById("tab-chat").click()`);
    await until("Chat tab back", () => P.eval<boolean>(`!document.getElementById("chat").hidden`));
  }, 480_000);

  it("a new chat from the picker streams the stub reply in the feed (markdown bold rendered, no raw HTML)", async () => {
    await activate(tabA);
    await clickUntil(P, "picker button", ".chat-list .picker-button");
    await until("catalogue in the popover", () => P.eval<boolean>(`[...document.querySelectorAll(".chat-list .picker-heading")].some(b => b.textContent.includes("alpha"))`), 60_000);
    await clickUntil(P, "pick alpha", ".chat-list .picker-option");
    expect(await newChat(P, "say:**Bold words** and <b>raw html</b> end")).toBe("Chat 1");
    await until("assistant message", () => P.eval<boolean>(`document.querySelector(".chat-detail:not([hidden]) .msg.assistant strong") !== null`), 90_000);
    const view = await P.eval<{ strong: string; rawB: boolean; text: string }>(`(() => { const m = document.querySelector(".chat-detail:not([hidden]) .msg.assistant"); return { strong: m.querySelector("strong").textContent, rawB: m.querySelector("b") !== null, text: m.textContent }; })()`);
    expect(view.strong).toBe("Bold words");
    expect(view.rawB).toBe(false);
    expect(view.text).toContain("<b>raw html</b>");
    await turnDone("Chat 1");
    await say(P, "Chat 1", "tool");
    await until("tool card", () => P.eval<boolean>(`document.querySelector(".chat-detail:not([hidden]) .msg.tool") !== null`), 90_000);
    await turnDone("Chat 1");
    await shot("chat-feed-v2", P);
  });

  it("the linked chip shows the active tab, removing it makes the agent's tabs_context empty", async () => {
    expect(await chips(P)).toEqual(["Page A"]);
    await say(P, "Chat 1", run([{ tool: "tabs_context" }]));
    await turnDone("Chat 1");
    const before = await replyOf("Chat 1");
    expect(before).toContain("tabs_context=ok");
    expect(before).toContain(String(tabA));
    await clickUntil(P, "unlink chip", ".chat-detail:not([hidden]) .chip-x");
    await until("no chips", async () => (await hubChat("Chat 1"))?.summary.tabIds.length === 0);
    expect(await chips(P)).toEqual([]);
    await until("link prompt", () => P.eval<boolean>(`document.querySelector(".chat-detail:not([hidden]) .chip-prompt")?.hidden === false`));
    await say(P, "Chat 1", run([{ tool: "tabs_context" }]));
    await turnDone("Chat 1");
    const after = await replyOf("Chat 1");
    expect(after).toContain("tabs_context=ok");
    expect(after).toContain('"sessionTabs":[]');
    // Link the page again through the add menu, as a user would.
    await P.eval(`(() => { const s = document.querySelector(".chat-detail:not([hidden]) select.chip-add"); s.value = String([...s.options].find(o => o.textContent === "Page A").value); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await until("linked again", async () => ((await hubChat("Chat 1"))?.summary.tabIds ?? []).includes(tabA));
  });

  it("a chat can read a linked tab and gets forbidden_tab on an unlinked one", async () => {
    await say(P, "Chat 1", run([{ tool: "read_page", args: { tabId: tabA } }]));
    await turnDone("Chat 1");
    const linked = await replyOf("Chat 1");
    expect(linked).toContain("read_page=ok");
    expect(linked).toContain("Go");
    await say(P, "Chat 1", run([{ tool: "read_page", args: { tabId: tabB } }]));
    await turnDone("Chat 1");
    const refused = await replyOf("Chat 1");
    expect(refused).toContain("read_page=ERR");
    expect(refused).toContain("forbidden_tab");
    expect(refused).toContain(String(tabB));
  });

  it("two chats on one tab show two cursors with two colours and two name tags, and the pill lists both", async () => {
    await activate(tabA);
    expect(await newChat(P)).toBe("Chat 2");
    expect(await chips(P)).toEqual(["Page A"]);
    const go = await centreOf(pageA, "go");
    const save2 = await centreOf(pageA, "save");
    await say(P, "Chat 1", run([{ tool: "screenshot", args: { tabId: tabA } }, { tool: "click", args: { tabId: tabA, coordinate: [Math.round(go.x), Math.round(go.y)] } }]));
    await say(P, "Chat 2", run([{ tool: "screenshot", args: { tabId: tabA } }, { tool: "click", args: { tabId: tabA, coordinate: [Math.round(save2.x), Math.round(save2.y)] } }]));
    await turnDone("Chat 1");
    await turnDone("Chat 2");
    expect(await replyOf("Chat 1")).toContain("click=ok");
    expect(await replyOf("Chat 2")).toContain("click=ok");
    const snap = await until("two cursors", async () => { const s = await snapshot(tabA); return s && s.cursors.length === 2 ? s : undefined; }, 30_000);
    expect(new Set(snap.cursors.map(c => c.colour)).size).toBe(2);
    expect(snap.cursors.map(c => c.tag).sort()).toEqual(["Chat 1", "Chat 2"]);
    expect(snap.cursors.every(c => c.sessionId.startsWith("chat:"))).toBe(true);
    expect(snap.pill).toContain("Chat 1");
    expect(snap.pill).toContain("Chat 2");
    expect(snap.pillOn).toBe(true);
    // Each cursor sits on its own target.
    const near = (r: Rect | null, t: { x: number; y: number }) => r !== null && Math.abs(r.x - t.x) < 40 && Math.abs(r.y - t.y) < 40;
    const tagged = (tag: string) => snap.cursors.find(c => c.tag === tag)!.rect;
    expect(near(tagged("Chat 1"), go)).toBe(true);
    expect(near(tagged("Chat 2"), save2)).toBe(true);
    await activate(tabA);
    await pageA.send("Page.bringToFront");
    await sleep(700);
    await save("two-cursors-v2.png", await pageA.screenshot());
  });

  it("pill Stop on one agent aborts only that chat's call; Stop all aborts both (real CDP clicks)", async () => {
    const go = await centreOf(pageA, "go");
    const clicks = () => pageA.eval<number>(`window.clicks || 0`);
    const states = async () => [await stateOf("Chat 1"), await stateOf("Chat 2")];
    // Chat 1 waits for a long time. Chat 2 sends an action every 200 ms.
    await say(P, "Chat 1", run([{ tool: "screenshot", args: { tabId: tabA } }, { tool: "wait", args: { seconds: 25 } }]));
    await until("Chat 1 waiting", async () => (await status()).inflight >= 1, 60_000);
    await say(P, "Chat 2", run([{ tool: "click", args: { tabId: tabA, coordinate: [Math.round(go.x), Math.round(go.y)] } }], { repeat: true, gapMs: 200 }));
    const both = await until("both agents in the pill", async () => {
      const s = await snapshot(tabA);
      return s && ["Stop Chat 1", "Stop Chat 2", "Stop all agents on this tab"].every(l => s.stops.some(b => b.label === l)) ? s : undefined;
    }, 60_000);
    expect(both.pill).toContain("Chat 1");
    // A synthetic click, from the page or from the overlay's own world, aborts nothing.
    const c0 = await clicks();
    await pageA.eval(`(() => { const h = document.getElementById("ais-browser-overlay"); HTMLElement.prototype.click.call(h); h.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true })); })()`);
    await ov(tabA, "untrustedStopClick", "Stop Chat 1");
    await ov(tabA, "untrustedStopClick", "Stop all agents on this tab");
    await sleep(1500);
    expect(await states()).toEqual(["thinking", "thinking"]);
    expect(await clicks()).toBeGreaterThan(c0);
    expect((await status()).paused).toBe(false);

    // A real click on "Stop Chat 1": only Chat 1's call ends. Chat 2 keeps acting.
    const stop1 = await until("Stop Chat 1 button", async () => (await snapshot(tabA))?.stops.find(b => b.label === "Stop Chat 1")?.rect ?? undefined, 15_000);
    await trustedClick(pageA, stop1.x + stop1.w / 2, stop1.y + stop1.h / 2);
    const t0 = Date.now();
    await until("Chat 1 stopped", async () => (await cancelledTurn("Chat 1")) || /wait=(ERR|ABORTED)/.test(await replyOf("Chat 1")), 30_000);
    expect(Date.now() - t0).toBeLessThan(20_000); // the call had 25 s to go
    expect(await replyOf("Chat 1")).not.toContain("wait=ok");
    const c1 = await clicks();
    await sleep(1500);
    expect(await clicks()).toBeGreaterThan(c1);
    expect(await stateOf("Chat 2")).toBe("thinking");
    expect(await replyOf("Chat 2")).toBe("");

    // Chat 1 works again. Now "Stop all" ends both calls. The click lands while Chat 2 acts every 200 ms.
    await turnDone("Chat 1");
    await say(P, "Chat 1", run([{ tool: "screenshot", args: { tabId: tabA } }, { tool: "wait", args: { seconds: 25 } }]));
    await until("both agents in the pill again", async () => {
      const s = await snapshot(tabA);
      return s && ["Stop Chat 1", "Stop Chat 2", "Stop all agents on this tab"].every(l => s.stops.some(b => b.label === l)) && (await status()).inflight >= 1 ? s : undefined;
    }, 60_000);
    let landed = false;
    for (let attempt = 0; attempt < 3 && !landed; attempt++) {
      const all = (await snapshot(tabA))?.stops.find(b => b.label === "Stop all agents on this tab")?.rect;
      if (!all) break;
      await trustedClick(pageA, all.x + all.w / 2, all.y + all.h / 2);
      landed = await until("Chat 2 stopped", async () => (await cancelledTurn("Chat 2")) || /click=(ERR|ABORTED)/.test(await replyOf("Chat 2")), attempt === 2 ? 30_000 : 8_000).then(() => true, () => false);
    }
    expect(landed).toBe(true);
    await until("Chat 1 stopped again", async () => (await cancelledTurn("Chat 1")) || /wait=(ERR|ABORTED)/.test(await replyOf("Chat 1")), 30_000);
    const c2 = await clicks();
    await sleep(1200);
    expect(await clicks()).toBe(c2); // nothing acts any more
    await turnDone("Chat 1");
    await turnDone("Chat 2");
  });

  it("a permission ask shows its two choices and the stub reports the choice", async () => {
    await say(P, "Chat 1", "ask");
    await until("permission card", () => P.eval<boolean>(`document.querySelectorAll(".chat-detail:not([hidden]) .msg.permission .actions button").length === 2`), 90_000);
    const labels = await P.eval<string[]>(`[...document.querySelectorAll(".chat-detail:not([hidden]) .msg.permission .actions button")].map(b => b.textContent + ":" + b.className)`);
    expect(labels).toEqual(["Allow once:primary", "Reject:secondary"]);
    await clickIn(P, ".chat-detail:not([hidden]) .msg.permission .actions button", "Allow once");
    await turnDone("Chat 1");
    expect(await replyOf("Chat 1")).toBe("chose:allow");
    await say(P, "Chat 1", "ask");
    await until("second card", () => P.eval<boolean>(`document.querySelectorAll(".chat-detail:not([hidden]) .msg.permission .actions button").length === 2`), 90_000);
    await clickIn(P, ".chat-detail:not([hidden]) .msg.permission .actions button", "Reject");
    await turnDone("Chat 1");
    expect(await replyOf("Chat 1")).toBe("chose:deny");
    expect(await P.eval<number>(`document.querySelectorAll(".chat-detail:not([hidden]) .msg.permission .perm-done").length`)).toBe(2);
  });

  it("Stop in the composer cancels a slow turn and the chat stays usable", async () => {
    await say(P, "Chat 1", "slow");
    await until("composer shows Stop", () => P.eval<boolean>(`document.querySelector(".chat-detail:not([hidden]) .composer .composer-stop")?.hidden === false`), 90_000);
    await clickIn(P, ".chat-detail:not([hidden]) .composer .composer-stop", "Stop");
    await until("idle after Stop", async () => (await stateOf("Chat 1")) === "idle", 60_000);
    await say(P, "Chat 1", "say:still here");
    await until("reply after Stop", async () => (await replyOf("Chat 1")) === "still here", 60_000);
    await turnDone("Chat 1");
  });

  it("closing the panel mid-stream and reopening it restores the feed with no duplicate items", async () => {
    await activate(tabA);
    expect(await newChat(P, "wait:3000")).toBe("Chat 3");
    await until("Chat 3 running", async () => (await stateOf("Chat 3")) === "thinking", 60_000);
    await cdp.send("Target.closeTarget", { targetId: P.targetId });
    await until("turn ends while the panel is closed", async () => (await replyOf("Chat 3")) === "waited" && (await stateOf("Chat 3")) === "idle", 90_000);
    P = await openPanel();
    await openChat(P, "Chat 3");
    const feed = await P.eval<Array<{ cls: string; text: string }>>(`[...document.querySelectorAll(".chat-detail:not([hidden]) .feed .msg")].map(m => ({ cls: m.className.replace(" streaming", ""), text: m.textContent }))`);
    expect(feed.filter(m => m.cls === "msg user")).toEqual([{ cls: "msg user", text: "wait:3000" }]);
    expect(feed.filter(m => m.cls === "msg assistant")).toEqual([{ cls: "msg assistant", text: "waited" }]);
    expect(new Set(feed.map(m => `${m.cls}|${m.text}`)).size).toBe(feed.length);
    expect(await P.eval<number>(`document.querySelectorAll(".chat-detail:not([hidden]) .msg.assistant.streaming").length`)).toBe(0);
  });

  it("the seventh chat is refused with the cap message", async () => {
    await activate(tabA);
    for (const n of [4, 5, 6]) expect(await newChat(P)).toBe(`Chat ${n}`);
    await backToList(P);
    // With six chats open Send stays disabled even for a typed message, and the cap message shows under the card.
    const typeOnly = () => P.eval<boolean>(`(() => { const box = document.querySelector(".chat-list .composer-box"); box.value = "one more"; box.dispatchEvent(new Event("input", { bubbles: true })); return document.querySelector(".chat-list .composer-send").disabled; })()`);
    await until("Send disabled at the cap", typeOnly, 30_000);
    expect(await P.eval<string>(`[...document.querySelectorAll(".chat-list .hint")].map(h => h.textContent).join("|")`)).toContain(CAP_MESSAGE);
    // The worker refuses a seventh create too, whatever the panel does.
    const refused = await P.eval<{ ok: boolean; error?: string }>(`chrome.windows.getCurrent().then(w => chrome.runtime.sendMessage({ type: "ais-chat-create", windowId: w.id, selection: { provider: "claude", identity: "alpha" }, tabIds: [] }))`);
    expect(refused).toEqual({ ok: false, error: CAP_MESSAGE });
    await shot("chat-cap-v2", P);
    // Close the extra chats again.
    for (const n of [6, 5, 4]) {
      const id = (await hubChat(`Chat ${n}`))!.summary.chatId;
      expect(await P.eval<{ ok: boolean }>(`chrome.runtime.sendMessage({ type: "ais-chat-close", chatId: ${JSON.stringify(id)} })`)).toEqual({ ok: true });
    }
    await until("Send enabled again", async () => !(await typeOnly()), 30_000);
    await P.eval(`(() => { const box = document.querySelector(".chat-list .composer-box"); box.value = ""; box.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  });

  it("the picker is keyboard operable (ArrowDown, Enter, Escape) and returns focus to its button", async () => {
    await backToList(P);
    await P.send("Page.bringToFront");
    const focusButton = () => P.eval(`document.querySelector(".chat-list .picker-button").focus()`);
    const expanded = () => P.eval<string>(`document.querySelector(".chat-list .picker-button").getAttribute("aria-expanded")`);
    const onButton = () => P.eval<boolean>(`document.activeElement === document.querySelector(".chat-list .picker-button")`);
    await focusButton();
    expect(await onButton()).toBe(true);
    await key(P, "ArrowDown");
    await until("popover open", async () => (await expanded()) === "true");
    expect(await P.eval<boolean>(`document.activeElement?.classList.contains("picker-search-input") === true`)).toBe(true);
    await sleep(300);
    await shot("picker-v3", P);
    await key(P, "ArrowDown");
    await key(P, "Enter");
    await until("menu closed after Enter", async () => (await expanded()) === "false");
    expect(await onButton()).toBe(true);
    await key(P, "ArrowDown");
    await until("menu open again", async () => (await expanded()) === "true");
    await key(P, "Escape");
    await until("menu closed after Escape", async () => (await expanded()) === "false");
    expect(await onButton()).toBe(true);
  });


  it("without splitViewId the default link is the active tab only", async () => {
    await activate(tabB);
    expect(await newChat(P)).toBe("Chat 4");
    expect(await chips(P)).toEqual(["Page B"]);
    const four = await until("Chat 4 in the worker", () => hubChat("Chat 4"));
    expect(four.summary.tabIds).toEqual([tabB]);
    await backToList(P);
    const id = four.summary.chatId;
    await P.eval(`chrome.runtime.sendMessage({ type: "ais-chat-close", chatId: ${JSON.stringify(id)} })`);
  });

  it("a split pair links both tabs by default", async () => {
    const hasSplit = await sw.eval<boolean>(`typeof chrome.tabs.createSplit === "function"`);
    if (!hasSplit) { console.warn("chrome.tabs.createSplit is not in this Chromium: the split view case is skipped"); return; }
    const one = await newTab("/s1");
    const two = await newTab("/s2");
    await sw.eval(`chrome.tabs.createSplit([${one.id}, ${two.id}])`);
    await until("split ids", async () => {
      const ts = await sw.eval<Array<{ id: number; splitViewId?: number }>>(`chrome.tabs.query({}).then(ts => ts.filter(t => t.id === ${one.id} || t.id === ${two.id}).map(t => ({ id: t.id, splitViewId: t.splitViewId })))`);
      return ts.length === 2 && ts.every(t => t.splitViewId !== undefined && t.splitViewId !== -1) && ts[0]!.splitViewId === ts[1]!.splitViewId;
    });
    await activate(one.id);
    await backToList(P);
    const name = await newChat(P);
    const split = await until(`${name} in the worker`, () => hubChat(name));
    expect([...split.summary.tabIds].sort()).toEqual([one.id, two.id].sort());
    expect((await chips(P)).sort()).toEqual(["Split one", "Split two"]);
    await shot("split-view-v2", P);
    const id = split.summary.chatId;
    await P.eval(`chrome.runtime.sendMessage({ type: "ais-chat-close", chatId: ${JSON.stringify(id)} })`);
  });

  it("a gateway stop() mid-turn: the feed shows the turn end and the next prompt resumes with a notice", async () => {
    await activate(tabA);
    await backToList(P);
    const name = await newChat(P, "say:before the restart");
    await turnDone(name);
    await say(P, name, "wait:2500");
    await until("turn running", async () => (await stateOf(name)) === "thinking", 60_000);
    await gateway.stop(); // drains: the turn finishes, then the pod ends and the sockets closed with 1012 at once
    gateway = await boot(gatewayPorts);
    // The extension reconnects, asks for what it missed and shows the end of the turn.
    await until("turn end after the restart", async () => (await replyOf(name)) === "waited" && (await stateOf(name)) === "idle", 120_000);
    expect(await P.eval<number>(`document.querySelectorAll(".chat-detail:not([hidden]) .msg.assistant").length`)).toBeGreaterThanOrEqual(2);
    await say(P, name, "say:back again");
    await until("reply after the restart", async () => (await replyOf(name)) === "back again", 120_000);
    const notices = await noticesOf(name);
    expect(notices.some(n => n === "The agent resumed this chat." || n === "This chat restarted. The agent does not remember earlier messages.")).toBe(true);
    expect(await P.eval<boolean>(`[...document.querySelectorAll(".chat-detail:not([hidden]) .msg.notice")].some(n => /resumed this chat|chat restarted/.test(n.textContent))`)).toBe(true);
  });

  // ---- the composer: one box, the picker inside it (screenshots for the owner) -------------------------------------

  it("the composer is one rounded box with the model picker and Send inside, the picker works like the T3 one", async () => {
    // A stub catalogue: 3 providers, two with 2 identities (one a pool), several models each. The panel gets it in place of the real one.
    const model = (id: string, name: string) => ({ id, name });
    const claude = [model("claude-fable-5-2", "Claude Fable 5.2"), model("claude-opus-5-5", "Claude Opus 5.5"), model("claude-sonnet-5-5", "Claude Sonnet 5.5"), model("claude-haiku-5-5", "Claude Haiku 5.5")];
    const codex = [model("gpt-5-3-codex", "GPT 5.3 Codex"), model("gpt-5-3-codex-spark", "GPT 5.3 Codex Spark"), model("gpt-5-2", "GPT 5.2"), model("gpt-5-mini", "GPT 5 Mini")];
    const kimi = [model("kimi-k2", "Kimi K2"), model("kimi-k2-thinking", "Kimi K2 Thinking")];
    const catalog = [
      { provider: "claude", efforts: [], identities: [{ name: "alpha", kind: "identity", models: claude }, { name: "beta", kind: "identity", models: claude.slice(0, 3) }] },
      { provider: "codex", efforts: [], identities: [{ name: "gamma", kind: "identity", models: codex }, { name: "delta", kind: "pool", models: codex.slice(1) }] },
      { provider: "kimi", efforts: [], identities: [{ name: "epsilon", kind: "identity", models: kimi }] },
    ];
    const patch = `(() => {
      const CATALOG = ${JSON.stringify(catalog)};
      const MODELS = ${JSON.stringify(claude)};
      const fix = m => {
        if (!m || !Array.isArray(m.chats)) return m;
        return { ...m, catalog: CATALOG, chats: m.chats.map(c => ({ ...c, items: c.items.map(i => (i.body && i.body.k === "config" ? { ...i, body: { ...i.body, models: MODELS, current: { ...i.body.current, model: "claude-sonnet-5-5" } } } : i)) })) };
      };
      const orig = chrome.runtime.connect.bind(chrome.runtime);
      chrome.runtime.connect = info => {
        const port = orig(info);
        if (!info || info.name !== "ais-chat") return port;
        const add = port.onMessage.addListener.bind(port.onMessage);
        port.onMessage.addListener = l => add(m => l(fix(m)));
        return port;
      };
    })()`;
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const Q = await cdp.attach(targetId);
    try {
      await Q.send("Page.enable");
      await Q.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 760, deviceScaleFactor: 2, mobile: false });
      await Q.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await Q.send("Page.addScriptToEvaluateOnNewDocument", { source: patch });
      await Q.send("Page.navigate", { url: `chrome-extension://${extId}/sidepanel.html` });
      await until("chat list", () => Q.eval<boolean>(`document.querySelector("#chat .chat-list") !== null && !document.querySelector("#chat .chat-list").hidden`), 120_000);
      // Start from an empty list: close the chats of the earlier cases.
      const open = (await sw.eval<{ chatHub?: { chats: Array<{ view: HubChat }> } }>(`chrome.storage.session.get("chatHub")`)).chatHub?.chats.map(c => c.view.summary).filter(x => x.state !== "closed") ?? [];
      for (const c of open) expect(await Q.eval<{ ok: boolean }>(`chrome.runtime.sendMessage({ type: "ais-chat-close", chatId: ${JSON.stringify(c.chatId)} })`)).toEqual({ ok: true });
      await until("no chat rows", () => Q.eval<boolean>(`document.querySelectorAll(".chat-list .chat-row").length === 0 && !document.querySelector(".chat-list .empty").hidden`), 30_000);
      await activate(tabA);
      await Q.send("Page.bringToFront");

      // The new-chat screen is a composer: no New chat button, the picker and Send inside one card at the bottom of the panel.
      await typeInList(Q, "x"); // Send enables once the catalogue and a selection are in
      await Q.eval(`(() => { const box = document.querySelector(".chat-list .composer-box"); box.value = ""; box.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      const list = ".chat-list";
      const lrect = (sel: string) => Q.eval<{ x: number; y: number; w: number; h: number; r: number; b: number }>(`(() => { const e = document.querySelector(${JSON.stringify(`${list} ${sel}`)}); const { left, top, width, height, right, bottom } = e.getBoundingClientRect(); return { x: left, y: top, w: width, h: height, r: right, b: bottom }; })()`);
      expect(await Q.eval<boolean>(`[...document.querySelectorAll("${list} button")].some(b => b.textContent === "New chat" || b.textContent === "Choose a model" && !b.classList.contains("picker-button"))`)).toBe(false);
      expect(await Q.eval<string>(`document.querySelector("${list} .composer-box").placeholder`)).toBe("Ask about the open pages");
      const lcard = await lrect(".composer-card");
      const lbox = await lrect(".composer-box");
      const lpick = await lrect(".composer .picker-button");
      const lsend = await lrect(".composer .composer-send");
      expect(lpick.y).toBeGreaterThan(lbox.b - 1);
      expect(lsend.y).toBeGreaterThan(lbox.b - 1);
      expect(lpick.x).toBeLessThan(lsend.x);
      for (const r of [lbox, lpick, lsend]) expect(r.x >= lcard.x && r.r <= lcard.r && r.y >= lcard.y && r.b <= lcard.b).toBe(true);
      expect(lcard.b).toBeGreaterThan(600); // the card sits at the bottom of the 760 px panel
      expect(await Q.eval<boolean>(`document.querySelector("${list} .composer-send").disabled`)).toBe(true); // empty box
      await sleep(300);
      await shot("composer-g-new-chat-r4", Q);

      // The picker opens above the card, inside the panel. Choose Claude Sonnet 5.5 of alpha.
      await clickUntil(Q, "list picker button", ".chat-list .picker-button");
      await until("stub catalogue in the list picker", () => Q.eval<boolean>(`[...document.querySelectorAll(".chat-list .picker-tab")].map(t => t.getAttribute("aria-label")).join() === "Favourites,Claude,Codex,Kimi"`), 60_000);
      await sleep(300);
      const lpop = await lrect(".picker-pop");
      expect(lpop.b).toBeLessThanOrEqual(lcard.y + 1);
      expect(lpop.y).toBeGreaterThanOrEqual(0);
      expect(lpop.x).toBeGreaterThanOrEqual(0);
      expect(lpop.r).toBeLessThanOrEqual(400);
      await shot("composer-h-new-chat-picker-r4", Q);
      await Q.eval(`[...document.querySelectorAll(".chat-list .picker-option")].find(b => b.textContent.startsWith("Claude Sonnet 5.5")).click()`);
      await until("Sonnet chosen", () => Q.eval<boolean>(`document.querySelector(".chat-list .picker-button").textContent.includes("Claude Sonnet 5.5")`));

      // The page the user looks at is linked by default: make tab A the active one, as it is in real use.
      await activate(tabA);
      await sleep(500);
      // Type and send: the chat opens and its feed shows the message as the first prompt.
      const name = await newChat(Q, "say:Hello from the new chat screen");
      await until("user message in the feed", () => Q.eval<boolean>(`[...document.querySelectorAll(".chat-detail:not([hidden]) .feed .msg.user")].some(m => m.textContent === "say:Hello from the new chat screen")`), 120_000);
      expect(await Q.eval<number>(`document.querySelectorAll(".chat-detail:not([hidden]) .feed .msg.user").length`)).toBe(1);
      expect(await Q.eval<string>(`document.querySelector(".chat-detail:not([hidden]) .composer .picker-button").textContent`)).toContain("Claude Sonnet 5.5");
      expect(await chips(Q)).toEqual(["Page A"]);
      await until("reply to the first prompt", async () => (await replyOf(name)) === "Hello from the new chat screen", 240_000);
      await turnDone(name);
      await shot("composer-i-new-chat-sent-r4", Q);

      const detail = ".chat-detail:not([hidden])";
      const rect = (sel: string) => Q.eval<{ x: number; y: number; w: number; h: number; r: number; b: number }>(`(() => { const e = document.querySelector(${JSON.stringify(`${detail} ${sel}`)}); const { left, top, width, height, right, bottom } = e.getBoundingClientRect(); return { x: left, y: top, w: width, h: height, r: right, b: bottom }; })()`);

      // (a) the empty composer: the textarea on top, the picker on the left of the bottom row and Send on the right, all inside one rounded box.
      const card = await rect(".composer-card");
      const box = await rect(".composer-box");
      const pick = await rect(".composer .picker-button");
      const send = await rect(".composer .composer-send");
      expect(pick.y).toBeGreaterThan(box.b - 1);
      expect(send.y).toBeGreaterThan(box.b - 1);
      expect(pick.x).toBeLessThan(send.x);
      for (const r of [box, pick, send]) expect(r.x >= card.x && r.r <= card.r && r.y >= card.y && r.b <= card.b).toBe(true);
      expect(await Q.eval<string>(`getComputedStyle(document.querySelector("${detail} .composer-card")).borderRadius`)).toBe("16px");
      expect(await Q.eval<string>(`document.querySelector("${detail} .composer .picker-button").textContent`)).toContain("Claude Sonnet 5.5");
      await shot("composer-a-empty-r4", Q);

      // (b) the picker open on a provider tab: the popover is above the box and inside the panel.
      await clickIn(Q, `${detail} .composer .picker-button`);
      await until("picker open", () => Q.eval<boolean>(`!document.querySelector("${detail} .picker-pop").hidden`));
      await sleep(300);
      const pop = await rect(".picker-pop");
      expect(pop.b).toBeLessThanOrEqual(card.y + 1);
      expect(pop.y).toBeGreaterThanOrEqual(0);
      expect(pop.x).toBeGreaterThanOrEqual(0);
      expect(pop.r).toBeLessThanOrEqual(400);
      expect(await Q.eval<boolean>(`document.activeElement.classList.contains("picker-search-input")`)).toBe(true);
      expect(await Q.eval<string[]>(`[...document.querySelectorAll("${detail} .picker-tab")].map(t => t.getAttribute("aria-label") + ":" + t.getAttribute("aria-selected"))`)).toEqual(["Favourites:false", "Claude:true", "Codex:false", "Kimi:false"]);
      expect(await Q.eval<string>(`document.querySelector("${detail} .picker-row[data-highlighted='true']").textContent`)).toContain("Claude Sonnet 5.5");
      await shot("composer-b-picker-open-r4", Q);

      // (c) a search: results from two providers under headers. Typed with the keyboard, the box has focus.
      await Q.send("Input.insertText", { text: "5" });
      await until("search results", () => Q.eval<boolean>(`document.querySelectorAll("${detail} .picker-heading").length >= 3`));
      const heads = await Q.eval<string[]>(`[...document.querySelectorAll("${detail} .picker-heading")].map(h => h.textContent)`);
      expect(heads.some(h => h.startsWith("Claude"))).toBe(true);
      expect(heads.some(h => h.startsWith("Codex"))).toBe(true);
      await sleep(300);
      await shot("composer-c-search-r4", Q);

      // (d) one favourite, shown on the Favourites tab and kept in local storage.
      await Q.eval(`document.querySelector("${detail} [aria-label='Add Claude Opus 5.5 to favourites']").click()`);
      await until("favourite stored", async () => { const f = (await sw.eval<{ chatFavourites?: Array<{ provider: string; identity: string; model: string }> }>(`chrome.storage.local.get("chatFavourites")`)).chatFavourites; return f?.length === 1 && f[0]!.provider === "claude" && f[0]!.identity === "alpha" && f[0]!.model === "claude-opus-5-5"; });
      await clickIn(Q, `${detail} .picker-tab`, "Favourites");
      await until("favourite listed", () => Q.eval<boolean>(`[...document.querySelectorAll("${detail} .picker-option")].map(o => o.textContent).join() === "Claude Opus 5.5claude-opus-5-5"`));
      await sleep(300);
      await shot("composer-d-favourites-r4", Q);
      // Keyboard: ArrowRight switches the tab, Escape closes the popover and returns the focus to the button.
      await key(Q, "Escape");
      await until("picker closed", () => Q.eval<boolean>(`document.querySelector("${detail} .picker-pop").hidden`));
      expect(await Q.eval<boolean>(`document.activeElement === document.querySelector("${detail} .composer .picker-button")`)).toBe(true);

      // (f) a running turn: Stop takes the place of Send.
      await say(Q, name, "slow");
      await until("Stop shown", () => Q.eval<boolean>(`document.querySelector("${detail} .composer .composer-stop")?.hidden === false && document.querySelector("${detail} .composer .composer-send").hidden === true`), 90_000);
      await sleep(300);
      await shot("composer-f-running-stop-r4", Q);
      await clickIn(Q, `${detail} .composer .composer-stop`, "Stop");
      await until("idle after Stop", async () => (await stateOf(name)) === "idle", 60_000);

      // (e) the effort menu: a second small button next to the picker, with the efforts of the live config.
      const effort = await until("effort button", () => Q.eval<string | false>(`(() => { const w = document.querySelector("${detail} .picker-effort-wrap"); return w && !w.hidden ? w.textContent : false; })()`), 30_000);
      expect(effort.length).toBeGreaterThan(0);
      await clickIn(Q, `${detail} .composer .picker-effort`);
      await until("effort menu", () => Q.eval<boolean>(`!document.querySelector("${detail} .picker-effort-menu").hidden`));
      expect(await Q.eval<string[]>(`[...document.querySelectorAll("${detail} .picker-effort-menu [role=menuitemradio]")].map(i => i.textContent)`)).toEqual(["low", "high"]);
      await sleep(300);
      await shot("composer-e-effort-menu-r4", Q);
      await key(Q, "Escape");
      await until("effort menu closed", () => Q.eval<boolean>(`document.querySelector("${detail} .picker-effort-menu").hidden`));

      // Tidy up: the star goes, the chat closes.
      await clickIn(Q, `${detail} .composer .picker-button`);
      await Q.eval(`document.querySelector("${detail} [aria-label='Remove Claude Opus 5.5 from favourites']")?.click() ?? document.querySelector("${detail} [aria-label='Add Claude Opus 5.5 to favourites']") === null`);
      await until("favourite removed", async () => ((await sw.eval<{ chatFavourites?: unknown[] }>(`chrome.storage.local.get("chatFavourites")`)).chatFavourites ?? []).length === 0);
      const id = (await hubChat(name))!.summary.chatId;
      await Q.eval(`chrome.runtime.sendMessage({ type: "ais-chat-close", chatId: ${JSON.stringify(id)} })`);
    } finally {
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  });
});
