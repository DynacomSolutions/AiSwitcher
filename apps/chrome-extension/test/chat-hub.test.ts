import { describe, expect, test } from "bun:test";
import type { ChatBody, ChatFromExt, ChatSelection, ChatSummary } from "../../../src/browser/chat-protocol.ts";
import { sessionIdForChat } from "../../../src/browser/chat-protocol.ts";
import type { CallRequest } from "../../../src/browser/protocol.ts";
import { ChatHub, servePort } from "../src/background/chat.ts";
import type { PortLike } from "../src/background/chat.ts";
import { Executor } from "../src/background/executor.ts";
import { acceptPort } from "../src/background/messages.ts";
import { State } from "../src/background/state.ts";
import { TabManager } from "../src/background/tabs.ts";
import { CHAT_PALETTE } from "../src/shared/chat-palette.ts";
import { parsePanelCommand } from "../src/shared/chat.ts";
import { FakeChrome } from "./fakes.ts";

const sel: ChatSelection = { provider: "claude", identity: "alpha" };

function setup(online = true) {
  const api = new FakeChrome();
  const tabs = new TabManager(api);
  const sent: ChatFromExt[] = [];
  const resumed: string[] = [];
  const ended: string[] = [];
  let up = online;
  let id = 0;
  const make = () => new ChatHub({
    send: f => { if (!up) return false; sent.push(f); return true; },
    tabs, storage: api.sessionStorage, now: () => 1000, newId: () => `c${++id}`,
    resumeSession: s => { resumed.push(s); }, endSession: s => { ended.push(s); },
  });
  const hub = make();
  return { api, tabs, hub, sent, resumed, ended, make, setUp: (v: boolean) => { up = v; } };
}
type Env = ReturnType<typeof setup>;

const summary = (chatId: string, over: Partial<ChatSummary> = {}): ChatSummary =>
  ({ chatId, name: "Chat 1", color: CHAT_PALETTE[0]!.hex, windowId: 1, state: "idle", selection: sel, tabIds: [], lastSeq: 0, updatedAt: 1, ...over });
const ev = (chatId: string, seq: number, body: ChatBody = { k: "text", text: `t${seq}` }) => ({ t: "chat.event" as const, chatId, seq, ts: seq, body });
const create = (windowId = 1, tabIds = [5]) => ({ type: "ais-chat-create" as const, windowId, selection: sel, tabIds });

describe("chat hub", () => {
  test("an event with a seen seq is ignored (no duplicates after a resume)", () => {
    const e = setup();
    e.hub.handleFrame({ t: "chat.state", chatId: "a", state: "idle", summary: summary("a") });
    e.hub.handleFrame(ev("a", 1));
    e.hub.handleFrame(ev("a", 2));
    e.hub.handleFrame(ev("a", 1));
    e.hub.handleFrame(ev("a", 2));
    expect(e.hub.state(1).chats[0]!.items.map(i => i.seq)).toEqual([1, 2]);
    expect(e.sent.filter(f => f.t === "chat.resume")).toHaveLength(0);
  });

  test("a gap triggers chat.resume {afterSeq: lastSeq}, once for the same position", () => {
    const e = setup();
    e.hub.handleFrame({ t: "chat.state", chatId: "a", state: "idle", summary: summary("a") });
    e.hub.handleFrame(ev("a", 1));
    e.hub.handleFrame(ev("a", 4));
    e.hub.handleFrame(ev("a", 5));
    expect(e.sent.filter(f => f.t === "chat.resume")).toEqual([{ t: "chat.resume", chatId: "a", afterSeq: 1 }]);
    expect(e.hub.state(1).chats[0]!.items.map(i => i.seq)).toEqual([1]);
    e.hub.handleFrame(ev("a", 2));
    e.hub.handleFrame(ev("a", 3));
    e.hub.handleFrame(ev("a", 4));
    expect(e.hub.state(1).chats[0]!.items.map(i => i.seq)).toEqual([1, 2, 3, 4]);
  });

  test("the feed keeps the last 500 items", () => {
    const e = setup();
    e.hub.handleFrame({ t: "chat.state", chatId: "a", state: "idle", summary: summary("a") });
    for (let i = 1; i <= 520; i++) e.hub.handleFrame(ev("a", i));
    const items = e.hub.state(1).chats[0]!.items;
    expect(items).toHaveLength(500);
    expect(items[0]!.seq).toBe(21);
    expect(items.at(-1)!.seq).toBe(520);
  });

  test("create picks the lowest free colour and refuses the seventh chat of a window with the cap message", async () => {
    const e = setup();
    for (let i = 0; i < 6; i++) expect(await e.hub.command(create())).toEqual({ ok: true });
    const colours = e.sent.filter(f => f.t === "chat.create").map(f => (f as Extract<ChatFromExt, { t: "chat.create" }>).color);
    expect(colours).toEqual(CHAT_PALETTE.map(p => p.hex));
    const r = await e.hub.command(create());
    expect(r).toEqual({ ok: false, error: "You can have 6 chats in one window. Close a chat to start another." });
    expect(e.hub.state(1).error).toContain("6 chats");
    expect(e.sent.filter(f => f.t === "chat.create")).toHaveLength(6);
    // another window has its own six
    expect(await e.hub.command(create(2))).toEqual({ ok: true });
  });

  test("a closed chat leaves the list and the cap, and does not come back after a worker restart", async () => {
    const e = setup();
    e.hub.handleFrame({ t: "chat.state", chatId: "a", state: "idle", summary: summary("a") });
    e.hub.handleFrame({ t: "chat.state", chatId: "b", state: "idle", summary: summary("b", { name: "Chat 2" }) });
    e.hub.handleFrame({ t: "chat.state", chatId: "a", state: "closed", summary: summary("a", { state: "closed" }) });
    expect(e.hub.state(1).chats.map(c => c.summary.chatId)).toEqual(["b"]);
    // A closed chat in a list from the gateway is skipped too.
    e.hub.handleFrame({ t: "chat.list", chats: [summary("b", { name: "Chat 2" }), summary("z", { state: "closed" })] });
    expect(e.hub.state(1).chats.map(c => c.summary.chatId)).toEqual(["b"]);
    await e.hub.flush();
    // An older copy on disk may still hold a closed chat. It is dropped on load.
    await e.api.sessionStorage.set({ chatHub: { chats: [{ view: { summary: summary("b", { name: "Chat 2" }), items: [] } }, { view: { summary: summary("a", { state: "closed" }), items: [] } }] } });
    const again = e.make();
    await again.load();
    expect(again.state(1).chats.map(c => c.summary.chatId)).toEqual(["b"]);
  });

  test("create reuses the colour of a closed chat", async () => {
    const e = setup();
    await e.hub.command(create());
    await e.hub.command(create());
    await e.hub.command({ type: "ais-chat-close", chatId: "c1" });
    await e.hub.command(create());
    const last = e.sent.filter(f => f.t === "chat.create").at(-1) as Extract<ChatFromExt, { t: "chat.create" }>;
    expect(last.color).toBe(CHAT_PALETTE[0]!.hex);
  });

  test("create sends chat.create with the default linked tabs and sets the local links", async () => {
    const e = setup();
    await e.hub.command({ ...create(1, [5, 6]), text: "hello" });
    expect(e.sent[0]).toEqual({ t: "chat.create", chatId: "c1", name: "Chat 1", color: CHAT_PALETTE[0]!.hex, windowId: 1, selection: sel, tabIds: [5, 6] });
    expect(e.sent[1]).toEqual({ t: "chat.prompt", chatId: "c1", text: "hello" });
    expect(e.tabs.chatLinks(sessionIdForChat("c1"))).toEqual([5, 6]);
    expect(e.hub.state(1).chats[0]!.summary.tabIds).toEqual([5, 6]);
  });

  test("create offline fails with a clear message and keeps no chat", async () => {
    const e = setup(false);
    const r = await e.hub.command(create());
    expect(r).toEqual({ ok: false, error: "AIS is not connected to the gateway. Connect it in the extension panel, then try again." });
    expect(e.hub.state(1).chats).toHaveLength(0);
  });

  test("onWelcome sends list, resume and link frames in that order", async () => {
    const e = setup();
    e.hub.handleFrame({ t: "chat.state", chatId: "a", state: "idle", summary: summary("a") });
    e.hub.handleFrame({ t: "chat.state", chatId: "b", state: "idle", summary: summary("b", { color: CHAT_PALETTE[1]!.hex }) });
    e.hub.handleFrame(ev("a", 1));
    e.hub.handleFrame(ev("a", 2));
    e.tabs.setChatLinks(sessionIdForChat("a"), [7], true);
    e.sent.length = 0;
    e.hub.onWelcome();
    expect(e.sent).toEqual([
      { t: "chat.list" }, { t: "chat.fav.list" },
      { t: "chat.resume", chatId: "a", afterSeq: 2 }, { t: "chat.resume", chatId: "b", afterSeq: 0 },
      { t: "chat.link", chatId: "a", tabIds: [7] }, { t: "chat.link", chatId: "b", tabIds: [] },
    ]);
  });

  test("the list after a welcome does not repeat a resume already sent", () => {
    const e = setup();
    e.hub.handleFrame({ t: "chat.state", chatId: "a", state: "idle", summary: summary("a") });
    e.hub.handleFrame(ev("a", 1));
    e.hub.onWelcome();
    e.sent.length = 0;
    e.hub.handleFrame({ t: "chat.list", chats: [summary("a", { lastSeq: 3 })] });
    expect(e.sent).toEqual([]);
  });

  test("a chat.reject with window_cap or unavailable becomes panel error text", () => {
    const e = setup();
    e.hub.handleFrame({ t: "chat.state", chatId: "a", state: "idle", summary: summary("a", { windowId: 1 }) });
    e.hub.handleFrame({ t: "chat.reject", chatId: "a", code: "window_cap", message: "Too many chats in this window." });
    expect(e.hub.state(1).error).toBe("Too many chats in this window.");
    expect(e.hub.state(2).error).toBeUndefined();
    // a reject that names no chat shows in every window
    e.hub.handleFrame({ t: "chat.reject", code: "unavailable", message: "Chat is not available." });
    expect(e.hub.state(9).error).toBe("Chat is not available.");
  });

  test("an error stays in its window: a refused create in window 1 does not show in window 2, and a success in window 2 keeps it", async () => {
    const e = setup();
    for (let i = 0; i < 6; i++) await e.hub.command(create(1));
    expect((await e.hub.command(create(1))).ok).toBe(false);
    expect(e.hub.state(1).error).toContain("6 chats");
    expect(e.hub.state(2).error).toBeUndefined();
    expect(await e.hub.command(create(2))).toEqual({ ok: true });
    expect(e.hub.state(1).error).toContain("6 chats");
    expect(await e.hub.command({ type: "ais-chat-prompt", chatId: "c1", text: "go" })).toEqual({ ok: true });
    expect(e.hub.state(1).error).toBeUndefined();
  });

  test("a failed resume does not freeze the feed: the next gap asks again", () => {
    const e = setup();
    e.hub.handleFrame({ t: "chat.state", chatId: "a", state: "idle", summary: summary("a") });
    e.hub.handleFrame(ev("a", 1));
    e.hub.handleFrame(ev("a", 4));
    e.hub.handleFrame({ t: "chat.reject", chatId: "a", code: "resume_failed", message: "Resume failed." });
    e.hub.handleFrame(ev("a", 5));
    expect(e.sent.filter(f => f.t === "chat.resume")).toEqual([{ t: "chat.resume", chatId: "a", afterSeq: 1 }, { t: "chat.resume", chatId: "a", afterSeq: 1 }]);
  });

  test("writes to session storage are coalesced and flush writes at once", async () => {
    const api = new FakeChrome();
    let writes = 0;
    const storage = { get: api.sessionStorage.get, set: async (v: Record<string, unknown>) => { writes++; await api.sessionStorage.set(v); } };
    let fire: (() => void) | undefined;
    let timers = 0;
    const hub = new ChatHub({ send: () => true, tabs: new TabManager(api), storage, now: () => 0, newId: () => "x", timer: { set: fn => { timers++; fire = fn; return 1; }, clear: () => { fire = undefined; } } });
    hub.handleFrame({ t: "chat.state", chatId: "a", state: "idle", summary: summary("a") });
    for (let i = 1; i <= 50; i++) hub.handleFrame(ev("a", i));
    expect(timers).toBe(1);
    expect(writes).toBe(0);
    fire!();
    await hub.flush();
    expect(writes).toBe(1);
    hub.handleFrame(ev("a", 51));
    await hub.flush();
    expect(writes).toBe(2);
    expect(timers).toBe(2);
    expect(fire).toBeUndefined();
  });

  test("one tab create by a chat sends one chat.link frame", async () => {
    const e = setup();
    const state = new State(e.api.storage);
    const executor = new Executor({ api: e.api, tabs: e.tabs, state, defaultTimeoutMs: 500, onLinks: (s, ids) => e.hub.onLinks(s, ids) });
    await e.hub.command(create(1, [5]));
    e.sent.length = 0;
    const r = await executor.run({ id: "k1", session: { id: "chat:c1", identity: "chat", label: "Chat 1", chat: true }, tool: "tabs_create", args: { url: "https://example.test/new" } } as CallRequest);
    expect(r.ok).toBe(true);
    expect(e.sent.filter(f => f.t === "chat.link")).toHaveLength(1);
  });

  test("a rejected create removes the local chat and its links", async () => {
    const e = setup();
    await e.hub.command(create());
    e.hub.handleFrame({ t: "chat.reject", chatId: "c1", code: "window_cap", message: "No." });
    expect(e.hub.state(1).chats).toHaveLength(0);
    expect(e.tabs.chatLinks(sessionIdForChat("c1"))).toEqual([]);
  });

  test("a list from the gateway keeps a chat that was just created and drops one the gateway forgot", async () => {
    const e = setup();
    e.hub.handleFrame({ t: "chat.state", chatId: "old", state: "idle", summary: summary("old", { color: CHAT_PALETTE[1]!.hex }) });
    await e.hub.command(create());
    e.hub.handleFrame({ t: "chat.list", chats: [] });
    expect(e.hub.state(1).chats.map(c => c.summary.chatId)).toEqual(["c1"]);
  });

  test("state(windowId) returns only that window's chats", () => {
    const e = setup();
    e.hub.handleFrame({ t: "chat.state", chatId: "a", state: "idle", summary: summary("a", { windowId: 1 }) });
    e.hub.handleFrame({ t: "chat.state", chatId: "b", state: "idle", summary: summary("b", { windowId: 2 }) });
    expect(e.hub.state(1).chats.map(c => c.summary.chatId)).toEqual(["a"]);
    expect(e.hub.state(2).chats.map(c => c.summary.chatId)).toEqual(["b"]);
    expect(e.hub.state(3).chats).toEqual([]);
    expect(e.hub.state(1).cap).toBe(6);
  });

  test("a pending permission shows in the view until it is resolved", () => {
    const e = setup();
    e.hub.handleFrame({ t: "chat.state", chatId: "a", state: "waiting", summary: summary("a") });
    e.hub.handleFrame(ev("a", 1, { k: "permission", requestId: "r1", rpcId: 1, title: "Run", options: [] }));
    expect(e.hub.state(1).chats[0]!.pending).toEqual({ permission: "r1" });
    e.hub.handleFrame(ev("a", 2, { k: "permission_resolved", requestId: "r1", cancelled: true }));
    expect(e.hub.state(1).chats[0]!.pending).toBeUndefined();
  });

  test("the worker restart restores chats and the last seq from session storage", async () => {
    const e = setup();
    e.hub.handleFrame({ t: "chat.state", chatId: "a", state: "idle", summary: summary("a") });
    e.hub.handleFrame(ev("a", 1));
    e.hub.handleFrame(ev("a", 2));
    await e.hub.flush();
    const again = e.make();
    await again.load();
    expect(again.state(1).chats[0]!.items.map(i => i.seq)).toEqual([1, 2]);
    again.handleFrame(ev("a", 2));
    again.handleFrame(ev("a", 3));
    expect(again.state(1).chats[0]!.items.map(i => i.seq)).toEqual([1, 2, 3]);
    e.sent.length = 0;
    again.onWelcome();
    expect(e.sent).toContainEqual({ t: "chat.resume", chatId: "a", afterSeq: 3 });
  });

  test("subscribers hear a change with the window id and can stop", () => {
    const e = setup();
    const heard: number[] = [];
    const off = e.hub.subscribe(w => heard.push(w));
    e.hub.handleFrame({ t: "chat.state", chatId: "a", state: "idle", summary: summary("a", { windowId: 4 }) });
    off();
    e.hub.handleFrame(ev("a", 1));
    expect(heard).toEqual([4]);
  });
});

describe("chat hub commands", () => {
  test("prompt lifts the stop block first, and an unknown chat is refused", async () => {
    const e = setup();
    expect((await e.hub.command({ type: "ais-chat-prompt", chatId: "zz", text: "x" })).ok).toBe(false);
    e.hub.handleFrame({ t: "chat.state", chatId: "a", state: "idle", summary: summary("a") });
    expect(await e.hub.command({ type: "ais-chat-prompt", chatId: "a", text: "go" })).toEqual({ ok: true });
    expect(e.resumed).toEqual(["chat:a"]);
    expect(e.sent.at(-1)).toEqual({ t: "chat.prompt", chatId: "a", text: "go" });
  });

  test("a page Stop of the chat agent sends chat.cancel; an external agent does not", () => {
    const e = setup();
    e.hub.handleFrame({ t: "chat.state", chatId: "a", state: "thinking", summary: summary("a") });
    e.hub.onSessionStopped("chat:a");
    e.hub.onSessionStopped("ext1");
    e.hub.onSessionStopped("chat:unknown");
    expect(e.sent).toEqual([{ t: "chat.cancel", chatId: "a" }]);
  });

  test("close sends chat.close, drops links, ends the session on pages and removes the chat", async () => {
    const e = setup();
    e.hub.handleFrame({ t: "chat.state", chatId: "a", state: "idle", summary: summary("a") });
    e.tabs.setChatLinks("chat:a", [5], true);
    expect(await e.hub.command({ type: "ais-chat-close", chatId: "a" })).toEqual({ ok: true });
    expect(e.sent.at(-1)).toEqual({ t: "chat.close", chatId: "a" });
    expect(e.tabs.chatLinks("chat:a")).toEqual([]);
    expect(e.ended).toEqual(["chat:a"]);
    expect(e.hub.state(1).chats).toEqual([]);
    // the link notice from dropChat did not reach the gateway for the closed chat
    expect(e.sent.filter(f => f.t === "chat.link")).toEqual([]);
  });

  test("config, permission, rename and cancel become frames", async () => {
    const e = setup();
    e.hub.handleFrame({ t: "chat.state", chatId: "a", state: "idle", summary: summary("a") });
    await e.hub.command({ type: "ais-chat-config", chatId: "a", model: "m1" });
    await e.hub.command({ type: "ais-chat-permission", chatId: "a", requestId: "r", optionId: "o" });
    await e.hub.command({ type: "ais-chat-rename", chatId: "a", name: "New" });
    await e.hub.command({ type: "ais-chat-cancel", chatId: "a" });
    expect(e.sent).toEqual([
      { t: "chat.config", chatId: "a", model: "m1" }, { t: "chat.permission", chatId: "a", requestId: "r", optionId: "o" },
      { t: "chat.rename", chatId: "a", name: "New" }, { t: "chat.cancel", chatId: "a" },
    ]);
  });

  test("a catalog reply fills the panel state; a second provider request merges", async () => {
    const e = setup();
    await e.hub.command({ type: "ais-chat-catalog" });
    const first = e.sent[0] as Extract<ChatFromExt, { t: "chat.catalog" }>;
    e.hub.handleFrame({ t: "chat.catalog", reqId: first.reqId, providers: [{ provider: "claude", identities: [], efforts: [] }, { provider: "codex", identities: [], efforts: [] }] });
    await e.hub.command({ type: "ais-chat-catalog", provider: "codex" });
    const second = e.sent[1] as Extract<ChatFromExt, { t: "chat.catalog" }>;
    e.hub.handleFrame({ t: "chat.catalog", reqId: second.reqId, providers: [{ provider: "codex", identities: [], efforts: ["high"] }] });
    expect(e.hub.state(1).catalog?.map(p => p.provider)).toEqual(["claude", "codex"]);
    expect(e.hub.state(1).catalog?.[1]!.efforts).toEqual(["high"]);
    // an answer nobody asked for is ignored
    e.hub.handleFrame({ t: "chat.catalog", reqId: "other", providers: [] });
    expect(e.hub.state(1).catalog).toHaveLength(2);
  });

  test("panel commands are checked for shape", () => {
    expect(parsePanelCommand({ type: "ais-chat-prompt", chatId: "a", text: 5 })).toBeUndefined();
    expect(parsePanelCommand({ type: "ais-chat-create", windowId: 1, tabIds: [1], selection: { provider: "nope", identity: "x" } })).toBeUndefined();
    expect(parsePanelCommand({ type: "ais-pause" })).toBeUndefined();
    expect(parsePanelCommand({ type: "ais-chat-close", chatId: "a" })).toEqual({ type: "ais-chat-close", chatId: "a" });
  });

  test("an invalid frame is never sent", async () => {
    const e = setup();
    e.hub.handleFrame({ t: "chat.state", chatId: "a", state: "idle", summary: summary("a") });
    const r = await e.hub.command({ ...create(), selection: { provider: "claude", identity: "bad identity!" } });
    expect(r.ok).toBe(false);
    expect(e.sent).toEqual([]);
  });
});

describe("chat links to the gateway", () => {
  const chat = { id: "chat:c1", identity: "chat", label: "Chat 1", chat: true as const };

  test("link merges chat-created tabs back in, and sends one chat.link", async () => {
    const e = setup();
    e.api.addTab(5);
    e.api.addTab(6);
    const state = new State(e.api.storage);
    const executor = new Executor({ api: e.api, tabs: e.tabs, state, defaultTimeoutMs: 500, onLinks: (s, ids) => e.hub.onLinks(s, ids) });
    await e.hub.command(create(1, [5]));
    const r = await executor.run({ id: "k1", session: chat, tool: "tabs_create", args: { url: "https://example.test/new" } } as CallRequest);
    expect(r.ok).toBe(true);
    const created = e.tabs.chatLinks("chat:c1").find(t => t !== 5)!;
    e.sent.length = 0;
    expect(await e.hub.command({ type: "ais-chat-link", chatId: "c1", tabIds: [6] })).toEqual({ ok: true });
    expect(e.tabs.chatLinks("chat:c1").sort()).toEqual([6, created].sort());
    expect(e.sent).toEqual([{ t: "chat.link", chatId: "c1", tabIds: e.tabs.chatLinks("chat:c1") }]);
  });

  test("a link change while offline is not lost: the welcome sends the current links", () => {
    const e = setup();
    e.hub.handleFrame({ t: "chat.state", chatId: "a", state: "idle", summary: summary("a") });
    e.setUp(false);
    e.tabs.onLinksChanged = (s, ids) => e.hub.onLinks(s, ids);
    e.tabs.setChatLinks("chat:a", [8, 9]);
    expect(e.sent).toEqual([]);
    e.setUp(true);
    e.hub.onWelcome();
    expect(e.sent.at(-1)).toEqual({ t: "chat.link", chatId: "a", tabIds: [8, 9] });
  });

  test("a tab closed in the browser reaches the gateway as a new link set", () => {
    const e = setup();
    e.hub.handleFrame({ t: "chat.state", chatId: "a", state: "idle", summary: summary("a") });
    e.tabs.onLinksChanged = (s, ids) => e.hub.onLinks(s, ids);
    e.tabs.setChatLinks("chat:a", [5, 6], true);
    e.api.closeTab(5);
    expect(e.sent.at(-1)).toEqual({ t: "chat.link", chatId: "a", tabIds: [6] });
    expect(e.hub.state(1).chats[0]!.summary.tabIds).toEqual([6]);
  });
});

describe("chat port", () => {
  const RID = "ext-id";
  const fakePort = (over: Partial<PortLike> = {}) => {
    let onMsg: (m: unknown) => void = () => {};
    const posted: unknown[] = [];
    let disconnected = false;
    const port: PortLike = {
      name: "ais-chat", sender: { id: RID, origin: `chrome-extension://${RID}` },
      postMessage: m => { posted.push(m); }, disconnect: () => { disconnected = true; },
      onMessage: { addListener: l => { onMsg = l; } }, onDisconnect: { addListener: () => {} },
      ...over,
    };
    return { port, posted, say: (m: unknown) => onMsg(m), wasDisconnected: () => disconnected };
  };

  test("a port from a web page origin is refused", () => {
    expect(acceptPort({ name: "ais-chat", sender: { id: RID, origin: "https://example.test" } }, RID)).toBe(false);
    expect(acceptPort({ name: "ais-chat", sender: { id: "other", origin: "chrome-extension://other" } }, RID)).toBe(false);
    expect(acceptPort({ name: "ais-chat" }, RID)).toBe(false);
    expect(acceptPort({ name: "other", sender: { id: RID, origin: `chrome-extension://${RID}` } }, RID)).toBe(false);
    expect(acceptPort({ name: "ais-chat", sender: { id: RID, origin: `chrome-extension://${RID}` } }, RID)).toBe(true);
    const e = setup();
    const p = fakePort({ sender: { id: RID, origin: "https://example.test" } });
    expect(servePort(p.port, e.hub, RID)).toBe(false);
    expect(p.wasDisconnected()).toBe(true);
    expect(p.posted).toEqual([]);
  });

  test("the panel gets its window's state at once and on every change", async () => {
    const e = setup();
    const p = fakePort();
    expect(servePort(p.port, e.hub, RID)).toBe(true);
    p.say({ type: "ais-chat-subscribe", windowId: 1 });
    expect(p.posted).toHaveLength(1);
    await e.hub.command(create(1));
    await e.hub.command(create(2));
    expect(p.posted.length).toBeGreaterThanOrEqual(2);
    const last = p.posted.at(-1) as { windowId: number; chats: unknown[] };
    expect(last.windowId).toBe(1);
    expect(last.chats).toHaveLength(1);
  });

  test("a panel command on the port reaches the hub; junk is ignored", () => {
    const e = setup();
    const p = fakePort();
    servePort(p.port, e.hub, RID);
    p.say({ type: "ais-chat-subscribe", windowId: 1 });
    p.say({ type: "ais-chat-create", windowId: 1, selection: sel, tabIds: [5] });
    p.say({ type: "ais-chat-create", windowId: "x" });
    p.say("junk");
    expect(e.sent.filter(f => f.t === "chat.create")).toHaveLength(1);
  });
});

describe("favourites", () => {
  const fav = (model: string, identity = "alpha") => ({ provider: "claude" as const, identity, model });
  const FAV_KEY = "chatFavourites";
  const SYNCED_KEY = "chatFavouritesSynced";
  function withLocal(local: Record<string, unknown> = {}, online = true) {
    const api = new FakeChrome();
    const sent: ChatFromExt[] = [];
    let up = online;
    const store: Record<string, unknown> = { ...local };
    let clock = 5000;
    const hub = new ChatHub({
      send: f => { if (!up) return false; sent.push(f); return true; },
      tabs: new TabManager(api), storage: api.sessionStorage, now: () => clock, newId: () => "x",
      local: { get: async keys => Object.fromEntries(keys.filter(k => k in store).map(k => [k, store[k]])), set: async v => { Object.assign(store, v); }, remove: async () => {} },
    });
    return { hub, sent, store, setUp: (v: boolean) => { up = v; }, setNow: (v: number) => { clock = v; }, sets: () => sent.filter(f => f.t === "chat.fav.set") };
  }
  const list = (items: ReturnType<typeof fav>[], seq = 1, epoch?: string) => ({ t: "chat.fav.list" as const, seq, items, ...(epoch !== undefined ? { epoch } : {}) });
  const EPOCH_KEY = "chatFavouritesEpoch";

  test("a welcome asks for the list, and the state shows what the gateway lists", () => {
    const e = withLocal();
    e.hub.onWelcome();
    expect(e.sent.filter(f => f.t === "chat.fav.list")).toHaveLength(1);
    e.hub.handleFrame(list([fav("m1")]));
    expect(e.hub.state(1).favourites).toEqual([fav("m1")]);
    e.hub.handleFrame(list([fav("m1"), fav("m2")], 2));
    expect(e.hub.state(1).favourites).toEqual([fav("m1"), fav("m2")]);
    e.hub.handleFrame(list([fav("m2")], 3));
    expect(e.hub.state(1).favourites).toEqual([fav("m2")]);
  });

  test("a star refused for the cap is not kept and the state names why; a stale refusal needs no message", async () => {
    const e = withLocal();
    e.hub.onWelcome();
    const full = Array.from({ length: 200 }, (_, i) => fav(`g${i}`));
    e.hub.handleFrame(list(full));
    await e.hub.command({ type: "ais-chat-favourite", op: "add", ...fav("extra") });
    expect(e.hub.state(1).favourites).toHaveLength(200);
    expect(e.hub.state(1).favourites?.some(f => f.model === "extra")).toBe(true);
    // The gateway answers with its list (200 stars) and refuses the add for the cap.
    e.hub.handleFrame({ ...list(full, 2), refused: [{ ...fav("extra"), reason: "cap" as const }] });
    const s = e.hub.state(1);
    expect(s.favourites?.some(f => f.model === "extra")).toBe(false);
    expect(s.favourites).toHaveLength(200);
    expect(s.favouritesNotice).toBe("You have 200 favourites. Remove one to add another.");
    // The notice stays through a push that changes nothing, and the lost star is not sent again by a later list.
    e.hub.handleFrame(list(full, 3));
    expect(e.hub.state(1).favouritesNotice).toBeDefined();
    expect(e.sets()).toHaveLength(1);
    // The next click clears it. A stale refusal sets no notice, and the star is not shown.
    await e.hub.command({ type: "ais-chat-favourite", op: "remove", ...fav("g0") });
    expect(e.hub.state(1).favouritesNotice).toBeUndefined();
    await e.hub.command({ type: "ais-chat-favourite", op: "add", ...fav("late") });
    e.hub.handleFrame({ ...list(full.slice(1), 4), refused: [{ ...fav("late"), reason: "stale" as const }] });
    expect(e.hub.state(1).favouritesNotice).toBeUndefined();
    expect(e.hub.state(1).favourites?.some(f => f.model === "late")).toBe(false);
  });

  test("a star in the panel shows at once, is cached and is sent with its time", async () => {
    const e = withLocal();
    e.hub.onWelcome();
    e.hub.handleFrame(list([]));
    await e.hub.command({ type: "ais-chat-favourite", op: "add", ...fav("m1") });
    expect(e.hub.state(1).favourites).toEqual([fav("m1")]);
    expect(e.sets()).toEqual([{ t: "chat.fav.set", changes: [{ ...fav("m1"), op: "add", at: 5000 }] }]);
    await Bun.sleep(0);
    expect(e.store[FAV_KEY]).toEqual([fav("m1")]);
    await e.hub.command({ type: "ais-chat-favourite", op: "remove", ...fav("m1") });
    expect(e.hub.state(1).favourites).toEqual([]);
    expect(e.sets()[1]).toEqual({ t: "chat.fav.set", changes: [{ ...fav("m1"), op: "remove", at: 5000 }] });
  });

  test("the first list after a connect sends up a star the gateway never saw, once", async () => {
    // The old build kept stars in this same key and no synced list: all of them are local only.
    const e = withLocal({ [FAV_KEY]: [fav("local1"), fav("both")] });
    await e.hub.load();
    expect(e.hub.state(1).favourites).toEqual([fav("local1"), fav("both")]);
    e.hub.onWelcome();
    e.hub.handleFrame(list([fav("both"), fav("remote")]));
    expect(e.sets()).toEqual([{ t: "chat.fav.set", changes: [{ ...fav("local1"), op: "add", at: 5000 }] }]);
    expect(e.hub.state(1).favourites?.map(f => f.model).sort()).toEqual(["both", "local1", "remote"]);
    // The reply and a later push do not send it again.
    e.hub.handleFrame(list([fav("both"), fav("remote"), fav("local1")], 2));
    e.hub.handleFrame(list([fav("both"), fav("local1")], 3));
    expect(e.sets()).toHaveLength(1);
    expect(e.hub.state(1).favourites?.map(f => f.model)).toEqual(["both", "local1"]);
  });

  test("a star taken away while offline is removed at the gateway on the next connect", async () => {
    const e = withLocal({ [FAV_KEY]: [fav("keep")], [SYNCED_KEY]: [fav("keep"), fav("gone")] });
    await e.hub.load();
    e.hub.onWelcome();
    e.hub.handleFrame(list([fav("keep"), fav("gone")]));
    expect(e.sets()).toEqual([{ t: "chat.fav.set", changes: [{ ...fav("gone"), op: "remove", at: 5000 }] }]);
    expect(e.hub.state(1).favourites).toEqual([fav("keep")]);
  });

  test("a star the gateway dropped while this browser was offline is not sent up again", async () => {
    const e = withLocal({ [FAV_KEY]: [fav("m1")], [SYNCED_KEY]: [fav("m1")] });
    await e.hub.load();
    e.hub.onWelcome();
    e.hub.handleFrame(list([]));
    expect(e.sets()).toEqual([]);
    expect(e.hub.state(1).favourites).toEqual([]);
    await Bun.sleep(0);
    expect(e.store[FAV_KEY]).toEqual([]);
    expect(e.store[SYNCED_KEY]).toEqual([]);
  });

  test("a star made offline stays, survives a worker restart and goes up on the next connect", async () => {
    const e = withLocal({}, false);
    await e.hub.command({ type: "ais-chat-favourite", op: "add", ...fav("m1") });
    expect(e.sent).toEqual([]);
    expect(e.hub.state(1).favourites).toEqual([fav("m1")]);
    await Bun.sleep(0);
    const again = withLocal(e.store);
    await again.hub.load();
    again.hub.onWelcome();
    again.hub.handleFrame(list([]));
    expect(again.sets()).toEqual([{ t: "chat.fav.set", changes: [{ ...fav("m1"), op: "add", at: 5000 }] }]);
  });

  test("a gateway with a new epoch is a reset: every known star goes up again and none is dropped", async () => {
    const e = withLocal({ [FAV_KEY]: [fav("a"), fav("b")], [SYNCED_KEY]: [fav("a"), fav("b")], [EPOCH_KEY]: "e1" });
    await e.hub.load();
    e.hub.onWelcome();
    e.hub.handleFrame(list([], 1, "e2"));
    expect(e.sets()).toEqual([{ t: "chat.fav.set", changes: [{ ...fav("a"), op: "add", at: 5000 }, { ...fav("b"), op: "add", at: 5000 }] }]);
    expect(e.hub.state(1).favourites).toEqual([fav("a"), fav("b")]);
    await Bun.sleep(0);
    expect(e.store[EPOCH_KEY]).toBe("e2");
  });

  test("a new epoch in the middle of a session is handled the same way, and the same epoch is not a reset", async () => {
    const e = withLocal();
    e.hub.onWelcome();
    e.hub.handleFrame(list([fav("a")], 1, "e1"));
    e.hub.handleFrame(list([], 2, "e1"));
    expect(e.hub.state(1).favourites).toEqual([]);
    expect(e.sets()).toEqual([]);
    e.hub.handleFrame(list([fav("a")], 3, "e1"));
    e.hub.handleFrame(list([], 1, "e2"));
    expect(e.sets()).toEqual([{ t: "chat.fav.set", changes: [{ ...fav("a"), op: "add", at: 5000 }] }]);
    expect(e.hub.state(1).favourites).toEqual([fav("a")]);
  });

  test("a gateway without an epoch, or a store from before the epoch, keeps the old rules", async () => {
    const e = withLocal({ [FAV_KEY]: [fav("m1")], [SYNCED_KEY]: [fav("m1")] });
    await e.hub.load();
    e.hub.onWelcome();
    e.hub.handleFrame(list([], 1, "e1"));
    expect(e.sets()).toEqual([]);
    expect(e.hub.state(1).favourites).toEqual([]);
  });

  test("a star made offline goes up with the time of the click, also after a worker restart", async () => {
    const e = withLocal({}, false);
    await e.hub.command({ type: "ais-chat-favourite", op: "add", ...fav("m1") });
    await Bun.sleep(0);
    e.setNow(9000);
    const again = withLocal(e.store);
    again.setNow(9000);
    await again.hub.load();
    again.hub.onWelcome();
    again.hub.handleFrame(list([]));
    expect(again.sets()).toEqual([{ t: "chat.fav.set", changes: [{ ...fav("m1"), op: "add", at: 5000 }] }]);
  });

  test("a star taken away offline goes up with the time of the click", async () => {
    const e = withLocal({ [FAV_KEY]: [fav("gone")], [SYNCED_KEY]: [fav("gone")] }, false);
    await e.hub.load();
    await e.hub.command({ type: "ais-chat-favourite", op: "remove", ...fav("gone") });
    e.setNow(9000);
    e.setUp(true);
    e.hub.onWelcome();
    e.hub.handleFrame(list([fav("gone")]));
    expect(e.sets()).toEqual([{ t: "chat.fav.set", changes: [{ ...fav("gone"), op: "remove", at: 5000 }] }]);
  });

  test("a click time is dropped once the gateway list agrees with it", async () => {
    const e = withLocal();
    e.hub.onWelcome();
    e.hub.handleFrame(list([]));
    await e.hub.command({ type: "ais-chat-favourite", op: "add", ...fav("m1") });
    e.hub.handleFrame(list([fav("m1")], 2));
    await Bun.sleep(0);
    expect(e.store["chatFavouritesAt"]).toEqual({});
  });

  test("a bad stored list is dropped, and an invalid command is refused", async () => {
    const e = withLocal({ [FAV_KEY]: [fav("ok"), { provider: "claude", identity: "a", model: "bad id" }, "x", fav("ok")] });
    await e.hub.load();
    expect(e.hub.state(1).favourites).toEqual([fav("ok")]);
    expect(parsePanelCommand({ type: "ais-chat-favourite", op: "toggle", ...fav("m") })).toBeUndefined();
    expect(parsePanelCommand({ type: "ais-chat-favourite", op: "add", provider: "bash", identity: "a", model: "m" })).toBeUndefined();
    expect(await e.hub.command({ type: "ais-chat-favourite", op: "add", ...fav("bad id") })).toMatchObject({ ok: false });
  });
});
