import { describe, expect, test } from "bun:test";
import { MAX_CHAT_NAME, MAX_CHAT_TABS, MAX_CHAT_TEXT } from "../../../src/browser/chat-protocol.ts";
import type { TabInfo } from "../src/background/chrome-api.ts";
import type { ChatCommandResult, ChatPanelCommand, ChatPanelState, ChatView } from "../src/shared/chat.ts";
import { AGENT_TAB, ChatTab, checkSelection, parseSelection, LOADING_PROVIDERS, onlyOwnKeys, RESTARTED } from "../src/sidepanel/chat/chat-view.ts";
import { asDoc, asEl, fakeDoc, walk } from "./fake-dom.ts";
import type { FakeNode } from "./fake-dom.ts";

const view = (id: string, over: Partial<ChatView["summary"]> = {}, items: ChatView["items"] = []): ChatView => ({
  summary: { chatId: id, name: `Chat ${id}`, color: "#3b82f6", windowId: 1, state: "idle", selection: { provider: "claude", identity: "a" }, tabIds: [5], lastSeq: items.length, updatedAt: 0, ...over },
  items,
});
const stateOf = (chats: ChatView[], over: Partial<ChatPanelState> = {}): ChatPanelState => ({ windowId: 1, connected: true, chats, cap: 6, ...over });
const tab = (id: number, over: Partial<TabInfo> = {}): TabInfo => ({ id, windowId: 1, groupId: -1, url: `https://t${id}.test/`, title: `T${id}`, active: false, ...over });

function setup(chats: ChatView[], opts: { tabs?: TabInfo[]; result?: () => ChatCommandResult | undefined; seen?: Record<string, number> } = {}) {
  const doc = fakeDoc();
  const root = doc.createElement("section");
  const sent: ChatPanelCommand[] = [];
  const saved: Array<Record<string, number>> = [];
  let push: (m: unknown) => void = () => {};
  const t = new ChatTab({
    doc: asDoc(doc), windowId: 1,
    connect: () => ({ postMessage: () => {}, onMessage: l => { push = l; }, onDisconnect: () => {} }),
    queryTabs: async () => opts.tabs ?? [tab(5)],
    send: async c => { sent.push(c); return opts.result ? opts.result() : { ok: true }; },
    loadSeen: async () => opts.seen ?? {},
    saveSeen: s => { saved.push(s); },
  }, asEl(root));
  t.start();
  return { doc, root, t, sent, saved, push: (s: ChatPanelState) => push(s), chats, flush: () => new Promise(r => setTimeout(r, 0)) };
}
const all = (root: FakeNode): FakeNode[] => walk(root);
const byClass = (root: FakeNode, cls: string): FakeNode[] => all(root).filter(n => n.className.split(" ").includes(cls));
const byText = (root: FakeNode, tag: string, text: string): FakeNode | undefined => all(root).find(n => n.tag === tag && n.textContent === text);
const byLabel = (root: FakeNode, label: string): FakeNode | undefined => all(root).find(n => n.attrs["aria-label"] === label);

describe("chat tab", () => {
  test("a focused row Close button keeps focus across a state update", async () => {
    const s = setup([view("a"), view("b")]);
    s.push(stateOf([view("a"), view("b")]));
    await s.flush();
    const close = byLabel(s.root, "Close Chat a")!;
    expect(close).toBeDefined();
    close.focus();
    s.push(stateOf([view("a", { state: "thinking" }), view("b", { name: "Renamed" })]));
    expect(s.doc.activeElement).toBe(close);
    expect(byLabel(s.root, "Close Chat a")).toBe(close);
    expect(byLabel(s.root, "Rename Renamed")).toBeDefined();
  });

  test("rename and close buttons have accessible names", async () => {
    const s = setup([view("a")]);
    s.push(stateOf([view("a")]));
    await s.flush();
    expect(byLabel(s.root, "Rename Chat a")).toBeDefined();
    expect(byLabel(s.root, "Close Chat a")).toBeDefined();
  });

  test("the draft stays when send fails and clears when it works", async () => {
    let result: ChatCommandResult | undefined = { ok: false, error: "Offline" };
    const s = setup([view("a")], { result: () => result });
    s.push(stateOf([view("a")]));
    s.t.select("a");
    await s.flush();
    const box = byClass(s.root, "composer-box")[0]!;
    expect(box.maxLength).toBe(MAX_CHAT_TEXT);
    box.value = "hello";
    box.dispatch("keydown", { key: "Enter", shiftKey: false });
    await s.flush();
    expect(box.value).toBe("hello");
    expect(byClass(s.root, "banner").find(b => b.textContent === "Offline")).toBeDefined();
    result = undefined;
    box.dispatch("keydown", { key: "Enter", shiftKey: false });
    await s.flush();
    expect(box.value).toBe("hello");
    expect(byClass(s.root, "banner").find(b => b.textContent === RESTARTED)).toBeDefined();
    result = { ok: true };
    box.dispatch("keydown", { key: "Enter", shiftKey: false });
    await s.flush();
    expect(box.value).toBe("");
    expect(s.sent.filter(c => c.type === "ais-chat-prompt").length).toBe(3);
  });

  test("a message over the limit is not sent and Shift+Enter does not send", async () => {
    const s = setup([view("a")]);
    s.push(stateOf([view("a")]));
    s.t.select("a");
    await s.flush();
    const box = byClass(s.root, "composer-box")[0]!;
    box.value = "x".repeat(MAX_CHAT_TEXT + 1);
    box.dispatch("keydown", { key: "Enter", shiftKey: false });
    box.value = "short";
    box.dispatch("keydown", { key: "Enter", shiftKey: true });
    await s.flush();
    expect(s.sent.length).toBe(0);
  });

  test("Back keeps the draft of the chat", async () => {
    const s = setup([view("a")]);
    s.push(stateOf([view("a")]));
    s.t.select("a");
    await s.flush();
    const box = byClass(s.root, "composer-box")[0]!;
    box.value = "draft";
    s.t.select(undefined);
    s.t.select("a");
    expect(byClass(s.root, "composer-box")[0]).toBe(box);
    expect(box.value).toBe("draft");
  });

  test("two paints of the same chat use the same feed element and keep focus on Show more", async () => {
    const long = "r".repeat(600);
    const items: ChatView["items"] = [{ seq: 1, ts: 0, body: { k: "tool", toolCallId: "t1", title: "Read", status: "done", result: long } }];
    const s = setup([view("a", {}, items)]);
    s.push(stateOf([view("a", {}, items)]));
    s.t.select("a");
    await s.flush();
    const feed = byClass(s.root, "feed")[0]!;
    const more = byText(s.root, "button", "Show more")!;
    expect(more).toBeDefined();
    more.focus();
    s.push(stateOf([view("a", { updatedAt: 5 }, items)]));
    expect(byClass(s.root, "feed")[0]).toBe(feed);
    expect(s.doc.activeElement).toBe(more);
  });

  test("rename is inline: Enter saves, Escape cancels, and the box has a length limit", async () => {
    const s = setup([view("a")]);
    s.push(stateOf([view("a")]));
    await s.flush();
    byLabel(s.root, "Rename Chat a")!.click();
    const box = byClass(s.root, "rename-box")[0]!;
    expect(box.maxLength).toBe(MAX_CHAT_NAME);
    expect(box.value).toBe("Chat a");
    box.dispatch("keydown", { key: "Escape" });
    expect(s.sent.length).toBe(0);
    byLabel(s.root, "Rename Chat a")!.click();
    box.value = "  New name ";
    box.dispatch("keydown", { key: "Enter" });
    expect(s.sent).toEqual([{ type: "ais-chat-rename", chatId: "a", name: "New name" }]);
  });

  test("close asks inline only while a turn runs", async () => {
    const s = setup([view("a"), view("b", { state: "thinking" })]);
    s.push(stateOf([view("a"), view("b", { state: "thinking" })]));
    await s.flush();
    byLabel(s.root, "Close Chat a")!.click();
    expect(s.sent).toEqual([{ type: "ais-chat-close", chatId: "a" }]);
    byLabel(s.root, "Close Chat b")!.click();
    expect(s.sent.length).toBe(1);
    const confirm = byClass(s.root, "inline-form").find(f => f.textContent.includes("Close this chat? The agent stops.") && !f.hidden)!;
    expect(confirm).toBeDefined();
    byText(confirm, "button", "Close")!.click();
    expect(s.sent[1]).toEqual({ type: "ais-chat-close", chatId: "b" });
  });

  test("adding a tab in a split view adds its partner, removing removes only that tab", async () => {
    const tabs = [tab(5), tab(6, { splitViewId: 9 }), tab(7, { splitViewId: 9 }), tab(8)];
    const s = setup([view("a")], { tabs });
    s.push(stateOf([view("a")]));
    s.t.select("a");
    await s.flush();
    const select = byClass(s.root, "chip-add")[0]!;
    select.value = "6";
    select.dispatch("change");
    expect(s.sent[0]).toEqual({ type: "ais-chat-link", chatId: "a", tabIds: [5, 6, 7] });
    s.push(stateOf([view("a", { tabIds: [5, 6, 7] })]));
    await s.flush();
    byLabel(s.root, "Unlink T6")!.click();
    expect(s.sent[1]).toEqual({ type: "ais-chat-link", chatId: "a", tabIds: [5, 7] });
  });

  test("an agent-created tab that comes back shows the explanation", async () => {
    const s = setup([view("a", { tabIds: [5, 6] })], { tabs: [tab(5), tab(6)] });
    s.push(stateOf([view("a", { tabIds: [5, 6] })]));
    s.t.select("a");
    await s.flush();
    byLabel(s.root, "Unlink T6")!.click();
    s.push(stateOf([view("a", { tabIds: [5, 6] })]));
    await s.flush();
    expect(byClass(s.root, "banner").find(b => b.textContent === AGENT_TAB)).toBeDefined();
  });

  test("New chat is disabled while a create is in flight and the loading line clears with the catalogue", async () => {
    let release: (r: ChatCommandResult) => void = () => {};
    const doc = fakeDoc();
    const root = doc.createElement("section");
    let push: (m: unknown) => void = () => {};
    const sent: ChatPanelCommand[] = [];
    const t = new ChatTab({
      doc: asDoc(doc), windowId: 1,
      connect: () => ({ postMessage: () => {}, onMessage: l => { push = l; }, onDisconnect: () => {} }),
      queryTabs: async () => [tab(5, { active: true })],
      send: c => { sent.push(c); return c.type === "ais-chat-create" ? new Promise(r => { release = r; }) : Promise.resolve({ ok: true }); },
      loadSeen: async () => ({}), saveSeen: () => {},
    }, asEl(root));
    t.start();
    push(stateOf([]));
    const btn = byText(root, "button", "New chat")!;
    btn.click();
    await new Promise(r => setTimeout(r, 0));
    expect(byClass(root, "banner").find(b => b.textContent === LOADING_PROVIDERS)).toBeDefined();
    expect(byClass(root, "banner").find(b => b.textContent === LOADING_PROVIDERS)!.attrs.role).toBe("alert");
    push(stateOf([], { catalog: [{ provider: "claude", identities: [{ name: "a", kind: "identity", models: [] }], efforts: [] }] }));
    expect(byClass(root, "banner").find(b => b.textContent === LOADING_PROVIDERS)?.hidden ?? true).toBe(true);
    btn.click();
    await new Promise(r => setTimeout(r, 0));
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(sent.filter(c => c.type === "ais-chat-create").length).toBe(1);
    release({ ok: true });
    await new Promise(r => setTimeout(r, 0));
    expect(btn.disabled).toBe(false);
  });

  test("a reload keeps the seen marks from session storage", async () => {
    const s = setup([view("a", {}, [{ seq: 1, ts: 0, body: { k: "notice", text: "x" } }, { seq: 2, ts: 0, body: { k: "notice", text: "y" } }])], { seen: { a: 1 } });
    await s.flush();
    s.push(stateOf(s.chats));
    await s.flush();
    expect(byClass(s.root, "chat-row")[0]!.className).toContain("unread");
    const t2 = setup(s.chats, { seen: { a: 2 } });
    await t2.flush();
    t2.push(stateOf(s.chats));
    expect(byClass(t2.root, "chat-row")[0]!.className).not.toContain("unread");
  });

  test("N1: the close confirm moves focus to Cancel, Escape returns it, Close moves it to the next row", async () => {
    const chats = [view("a", { state: "thinking" }), view("b"), view("c")];
    const s = setup(chats);
    s.push(stateOf(chats));
    await s.flush();
    byLabel(s.root, "Close Chat a")!.click();
    const confirm = byClass(s.root, "inline-form").find(f => f.textContent.includes("Close this chat?") && !f.hidden)!;
    expect(confirm.attrs.role).toBe("alert");
    expect(s.doc.activeElement).toBe(byText(confirm, "button", "Cancel"));
    confirm.dispatch("keydown", { key: "Escape" });
    expect(confirm.hidden).toBe(true);
    expect(s.doc.activeElement).toBe(byLabel(s.root, "Close Chat a"));
    byLabel(s.root, "Close Chat a")!.click();
    byText(confirm, "button", "Close")!.click();
    expect(s.doc.activeElement).toBe(byClass(s.root, "row-open")[1]);
    // The last row has no next row: focus goes to New chat.
    byLabel(s.root, "Close Chat c")!.click();
    expect(s.doc.activeElement).toBe(byText(s.root, "button", "New chat"));
  });

  test("N2: a tab title change keeps the same option nodes and adds only the new one", async () => {
    const s = setup([view("a")], { tabs: [tab(5), tab(6), tab(7)] });
    s.push(stateOf([view("a")]));
    s.t.select("a");
    await s.flush();
    const select = byClass(s.root, "chip-add")[0]!;
    const opt = (id: string) => select.children.find(o => o.value === id)!;
    const six = opt("6"), seven = opt("7");
    expect(six.textContent).toBe("T6");
    (s as unknown as { t: ChatTab }).t.refreshTabs();
    await s.flush();
    // Same options after a refresh.
    expect(opt("6")).toBe(six);
    expect(opt("7")).toBe(seven);
  });

  test("N2: a title change patches the text in place, also while the menu has focus", async () => {
    let tabs = [tab(5), tab(6), tab(7)];
    const doc = fakeDoc();
    const root = doc.createElement("section");
    let push: (m: unknown) => void = () => {};
    const t = new ChatTab({
      doc: asDoc(doc), windowId: 1,
      connect: () => ({ postMessage: () => {}, onMessage: l => { push = l; }, onDisconnect: () => {} }),
      queryTabs: async () => tabs, send: async () => ({ ok: true }), loadSeen: async () => ({}), saveSeen: () => {},
    }, asEl(root));
    t.start();
    push(stateOf([view("a")]));
    t.select("a");
    await new Promise(r => setTimeout(r, 0));
    const select = byClass(root, "chip-add")[0]!;
    const six = select.children.find(o => o.value === "6")!;
    tabs = [tab(5), tab(6, { title: "New title" }), tab(7), tab(8)];
    select.focus();
    await t.refreshTabs();
    expect(select.children.find(o => o.value === "6")).toBe(six);
    expect(six.textContent).toBe("New title");
    expect(select.children.some(o => o.value === "8")).toBe(false); // structure waits for blur
    doc.activeElement = undefined;
    select.dispatch("blur");
    expect(select.children.some(o => o.value === "8")).toBe(true);
    expect(select.children.find(o => o.value === "6")).toBe(six);
  });

  test("N3: Enter during IME composition does not save the rename", async () => {
    const s = setup([view("a")]);
    s.push(stateOf([view("a")]));
    await s.flush();
    byLabel(s.root, "Rename Chat a")!.click();
    const box = byClass(s.root, "rename-box")[0]!;
    box.value = "Nom";
    box.dispatch("keydown", { key: "Enter", isComposing: true });
    expect(s.sent.length).toBe(0);
    box.dispatch("keydown", { key: "Enter", isComposing: false });
    expect(s.sent).toEqual([{ type: "ais-chat-rename", chatId: "a", name: "Nom" }]);
  });

  test("N4: a removed chat loses its seen mark, and saves are debounced", async () => {
    const s = setup([view("a"), view("b")], { seen: { a: 0, b: 0, gone: 4 } });
    await s.flush();
    s.push(stateOf([view("a", { lastSeq: 1 }), view("b")]));
    s.push(stateOf([view("a", { lastSeq: 1 }), view("b")]));
    s.t.select("a");
    s.push(stateOf([view("a", { lastSeq: 2 }), view("b")]));
    expect(s.saved.length).toBe(0);
    await new Promise(r => setTimeout(r, 320));
    expect(s.saved.length).toBe(1);
    expect(s.saved[0]).toEqual({ a: 2, b: 0 });
    s.push(stateOf([view("a", { lastSeq: 2 })]));
    await new Promise(r => setTimeout(r, 320));
    expect(s.saved.at(-1)).toEqual({ a: 2 });
  });

  test("N5: a reorder moves one row, not all of them, and a moved focused row keeps focus", async () => {
    const abc = [view("a"), view("b"), view("c")];
    const s = setup(abc);
    s.push(stateOf(abc));
    await s.flush();
    const ul = byClass(s.root, "chat-rows")[0]!;
    let moves = 0;
    const orig = ul.insertBefore.bind(ul);
    ul.insertBefore = (n, ref) => { moves++; return orig(n, ref); };
    const closeA = byLabel(s.root, "Close Chat a")!;
    closeA.focus();
    s.push(stateOf([view("b"), view("c"), view("a")]));
    expect(moves).toBe(1);
    expect(ul.children.map(r => r.textContent.includes("Chat a"))).toEqual([false, false, true]);
    expect(s.doc.activeElement).toBe(closeA);
    moves = 0;
    s.push(stateOf([view("b"), view("c"), view("a")]));
    expect(moves).toBe(0);
  });

  test("N6: the agent-tab note waits for the link reply, then shows when the chip is still present", async () => {
    let release: (r: ChatCommandResult) => void = () => {};
    const doc = fakeDoc();
    const root = doc.createElement("section");
    let push: (m: unknown) => void = () => {};
    const t = new ChatTab({
      doc: asDoc(doc), windowId: 1,
      connect: () => ({ postMessage: () => {}, onMessage: l => { push = l; }, onDisconnect: () => {} }),
      queryTabs: async () => [tab(5), tab(6)],
      send: () => new Promise(r => { release = r; }), loadSeen: async () => ({}), saveSeen: () => {},
    }, asEl(root));
    t.start();
    push(stateOf([view("a", { tabIds: [5, 6] })]));
    t.select("a");
    await new Promise(r => setTimeout(r, 0));
    byLabel(root, "Unlink T6")!.click();
    push(stateOf([view("a", { tabIds: [5, 6] })]));
    expect(byClass(root, "banner").some(b => b.textContent === AGENT_TAB)).toBe(false);
    release({ ok: true });
    await new Promise(r => setTimeout(r, 0));
    expect(byClass(root, "banner").some(b => b.textContent === AGENT_TAB && !b.hidden)).toBe(true);
  });

  test("N6: no note when the chip is gone after the reply", async () => {
    const s = setup([view("a", { tabIds: [5, 6] })], { tabs: [tab(5), tab(6)] });
    s.push(stateOf([view("a", { tabIds: [5, 6] })]));
    s.t.select("a");
    await s.flush();
    byLabel(s.root, "Unlink T6")!.click();
    s.push(stateOf([view("a", { tabIds: [5] })]));
    await s.flush();
    expect(byClass(s.root, "banner").some(b => b.textContent === AGENT_TAB)).toBe(false);
  });

  test("N7: the tab limit shows a message instead of dropping tabs", async () => {
    const many = Array.from({ length: MAX_CHAT_TABS }, (_, i) => i + 100);
    const s = setup([view("a", { tabIds: many })], { tabs: [tab(5), ...many.map(i => tab(i))] });
    s.push(stateOf([view("a", { tabIds: many })]));
    s.t.select("a");
    await s.flush();
    const select = byClass(s.root, "chip-add")[0]!;
    select.value = "5";
    select.dispatch("change");
    expect(s.sent.length).toBe(0);
    expect(byClass(s.root, "banner").some(b => b.textContent === `A chat can use up to ${MAX_CHAT_TABS} pages.`)).toBe(true);
  });

  test("N8: opening a chat focuses its message box and Back focuses the row left", async () => {
    const s = setup([view("a"), view("b")]);
    s.push(stateOf([view("a"), view("b")]));
    await s.flush();
    byClass(s.root, "row-open")[1]!.click();
    expect(s.doc.activeElement).toBe(byClass(s.root, "composer-box")[0]);
    byText(s.root, "button", "Back")!.click();
    expect(s.doc.activeElement).toBe(byClass(s.root, "row-open")[1]);
  });

  test("N9: storage changes of the panel's own keys do not count", () => {
    expect(onlyOwnKeys({ "chatSeen:1": {} }, ["chatSeen:1", "chatSelection"])).toBe(true);
    expect(onlyOwnKeys({ "chatSeen:1": {}, paused: {} }, ["chatSeen:1", "chatSelection"])).toBe(false);
    expect(onlyOwnKeys({}, ["chatSeen:1"])).toBe(false);
  });
});

describe("picker wiring", () => {
  const cat = [{ provider: "claude" as const, efforts: ["low"], identities: [{ name: "work", kind: "identity" as const, models: [{ id: "m1", name: "One" }, { id: "m2", name: "Two" }] }, { name: "pool-a", kind: "pool" as const, models: [{ id: "p1", name: "Pool One" }] }] }];
  const make = (stored: unknown, over: { send?: (c: ChatPanelCommand) => Promise<ChatCommandResult | undefined> } = {}) => {
    const doc = fakeDoc();
    const root = doc.createElement("section");
    let push: (m: unknown) => void = () => {};
    const sent: ChatPanelCommand[] = [];
    const saved: unknown[] = [];
    const t = new ChatTab({
      doc: asDoc(doc), windowId: 1,
      connect: () => ({ postMessage: () => {}, onMessage: l => { push = l; }, onDisconnect: () => {} }),
      queryTabs: async () => [tab(5, { active: true })],
      send: c => { sent.push(c); return over.send ? over.send(c) : Promise.resolve({ ok: true }); },
      loadSeen: async () => ({}), saveSeen: () => {},
      loadSelection: async () => stored, saveSelection: s => { saved.push(s); },
    }, asEl(root));
    t.start();
    return { t, root, sent, saved, push: (s: ChatPanelState) => push(s), flush: () => new Promise(r => setTimeout(r, 0)) };
  };
  test("parseSelection applies selectable to every field", () => {
    expect(parseSelection({ provider: "claude", identity: "work", model: "a b", effort: "low" })).toEqual({ provider: "claude", identity: "work", effort: "low" });
    expect(parseSelection({ provider: "claude", identity: "bad name" })).toBeUndefined();
    expect(parseSelection({ provider: "nope", identity: "work" })).toBeUndefined();
  });
  test("checkSelection drops what the catalogue lacks", () => {
    expect(checkSelection({ provider: "claude", identity: "work", model: "zz", effort: "max" }, cat)).toEqual({ provider: "claude", identity: "work" });
    expect(checkSelection({ provider: "claude", identity: "gone" }, cat)).toBeUndefined();
  });
  test("New chat waits for the catalogue and then uses the stored selection", async () => {
    const s = make({ provider: "claude", identity: "pool-a", model: "p1" });
    s.push(stateOf([]));
    await s.flush();
    byText(s.root, "button", "New chat")!.click();
    await s.flush();
    expect(s.sent.some(c => c.type === "ais-chat-create")).toBe(false);
    expect(byClass(s.root, "banner").find(b => b.textContent === LOADING_PROVIDERS)).toBeDefined();
    s.push(stateOf([], { catalog: cat }));
    byText(s.root, "button", "New chat")!.click();
    await s.flush();
    const create = s.sent.find(c => c.type === "ais-chat-create");
    expect(create && create.type === "ais-chat-create" ? create.selection : undefined).toEqual({ provider: "claude", identity: "pool-a", model: "p1" });
  });
  test("a stored model the catalogue lacks is dropped", async () => {
    const s = make({ provider: "claude", identity: "work", model: "gone" });
    await s.flush();
    s.push(stateOf([], { catalog: cat }));
    byText(s.root, "button", "New chat")!.click();
    await s.flush();
    const create = s.sent.find(c => c.type === "ais-chat-create");
    expect(create && create.type === "ais-chat-create" ? create.selection : undefined).toEqual({ provider: "claude", identity: "work" });
  });
  test("a model pick in an open chat sends ais-chat-config, other identities send nothing", async () => {
    const s = make(undefined);
    s.push(stateOf([view("a", { selection: { provider: "claude", identity: "work" } })], { catalog: cat }));
    s.t.select("a");
    await s.flush();
    const pickers = byClass(s.root, "picker");
    const detail = pickers[1]!;
    const items = walk(detail).filter(n => n.attrs.role === "menuitemradio");
    const pool = items.find(n => n.textContent.includes("pool-a"))!;
    expect(pool.attrs["aria-disabled"]).toBe("true");
    pool.click();
    items.find(n => n.textContent === "Two")!.click();
    await s.flush();
    expect(s.sent.filter(c => c.type === "ais-chat-config")).toEqual([{ type: "ais-chat-config", chatId: "a", model: "m2" }]);
  });
  test("opening a menu asks for the catalogue and asks again after a failed send", async () => {
    const s = make(undefined, { send: () => Promise.resolve(undefined) });
    s.push(stateOf([]));
    await s.flush();
    const btn = walk(byClass(s.root, "picker")[0]!).find(n => n.className === "picker-button")!;
    btn.click();
    await s.flush();
    btn.click();
    btn.click();
    await s.flush();
    expect(s.sent.filter(c => c.type === "ais-chat-catalog").length).toBe(2);
  });
});
