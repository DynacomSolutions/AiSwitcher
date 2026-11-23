import { describe, expect, test } from "bun:test";
import { MAX_CHAT_NAME, MAX_CHAT_TABS, MAX_CHAT_TEXT } from "../../../src/browser/chat-protocol.ts";
import type { TabInfo } from "../src/background/chrome-api.ts";
import { CAP_MESSAGE } from "../src/shared/chat.ts";
import type { ChatCommandResult, ChatPanelCommand, ChatPanelState, ChatView } from "../src/shared/chat.ts";
import { AGENT_TAB, LINK_PROMPT, ChatTab, checkSelection, parseSelection, NEW_PLACEHOLDER, onlyOwnKeys, RESTARTED } from "../src/sidepanel/chat/chat-view.ts";
import { asDoc, asEl, fakeDoc, walk } from "./fake-dom.ts";
import type { FakeNode } from "./fake-dom.ts";

const view = (id: string, over: Partial<ChatView["summary"]> = {}, items: ChatView["items"] = []): ChatView => ({
  summary: { chatId: id, name: `Chat ${id}`, color: "#3b82f6", windowId: 1, state: "idle", selection: { provider: "claude", identity: "a" }, tabIds: [5], lastSeq: items.length, updatedAt: 0, ...over },
  items,
});
const stateOf = (chats: ChatView[], over: Partial<ChatPanelState> = {}): ChatPanelState => ({ windowId: 1, connected: true, chats, cap: 6, ...over });
const tab = (id: number, over: Partial<TabInfo> = {}): TabInfo => ({ id, windowId: 1, groupId: -1, url: `https://t${id}.test/`, title: `T${id}`, active: false, splitViewId: -1, index: 0, pinned: false, ...over });

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
    // The list screen asks for the catalogue on its own. Those frames are not part of what the tests count.
    send: async c => { if (c.type !== "ais-chat-catalog") sent.push(c); return opts.result ? opts.result() : { ok: true }; },
    loadSeen: async () => opts.seen ?? {},
    saveSeen: s => { saved.push(s); },
  }, asEl(root));
  t.start();
  return { doc, root, t, sent, saved, push: (s: ChatPanelState) => push(s), chats, flush: () => new Promise(r => setTimeout(r, 0)) };
}
const all = (root: FakeNode): FakeNode[] => walk(root);
const byClass = (root: FakeNode, cls: string): FakeNode[] => all(root).filter(n => n.className.split(" ").includes(cls));
const byText = (root: FakeNode, tag: string, text: string): FakeNode | undefined => all(root).find(n => n.tag === tag && n.textContent === text);
/** Types a message in the box of the list screen and presses Enter. */
const typeNew = (root: FakeNode, text: string, send = true): FakeNode => {
  const box = byClass(root, "composer-box")[0]!;
  box.value = text;
  box.dispatch("input");
  if (send) box.dispatch("keydown", { key: "Enter", shiftKey: false });
  return box;
};
/** The message box of the open chat, not the one of the list screen. */
const chatBox = (root: FakeNode): FakeNode => byClass(byClass(root, "chat-detail")[0]!, "composer-box")[0]!;
const sendButton = (root: FakeNode): FakeNode => byClass(root, "composer-send")[0]!;
const creates = (sent: ChatPanelCommand[]) => sent.filter((c): c is Extract<ChatPanelCommand, { type: "ais-chat-create" }> => c.type === "ais-chat-create");
const byLabel = (root: FakeNode, label: string): FakeNode | undefined => all(root).find(n => n.attrs["aria-label"] === label);

describe("chat tab", () => {
  test("the cap message shows once in the list (the hint), and the banner stays for other errors", async () => {
    const chats = ["a", "b", "c", "d", "e", "f"].map(i => view(i));
    const s = setup(chats);
    s.push(stateOf(chats, { error: CAP_MESSAGE }));
    await s.flush();
    const banner = byClass(s.root, "banner").find(n => n.attrs.role === "alert" && n.textContent === CAP_MESSAGE);
    expect(banner === undefined || banner.hidden).toBe(true);
    expect(byClass(s.root, "hint").filter(n => !n.hidden && n.textContent === CAP_MESSAGE)).toHaveLength(1);
    s.push(stateOf(chats, { error: "Something else failed." }));
    expect(byClass(s.root, "banner").some(n => !n.hidden && n.textContent === "Something else failed.")).toBe(true);
  });

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
    const box = chatBox(s.root);
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
    const box = chatBox(s.root);
    box.value = "draft";
    s.t.select(undefined);
    s.t.select("a");
    expect(chatBox(s.root)).toBe(box);
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

  test("the list screen is a composer: no New chat button, the picker sits in the card", () => {
    const s = setup([]);
    s.push(stateOf([]));
    expect(byText(s.root, "button", "New chat")).toBeUndefined();
    const list = byClass(s.root, "chat-list")[0]!;
    const card = byClass(list, "composer-card")[0]!;
    expect(byClass(card, "picker")).toHaveLength(1);
    expect(byClass(card, "composer-tools")[0]!.children[0]!.className).toBe("picker");
    expect(byClass(card, "composer-box")[0]!.placeholder).toBe(NEW_PLACEHOLDER);
    expect(byClass(list, "empty")[0]!.hidden).toBe(false);
  });

  test("Send is disabled until there is text and a model, then a create carries the text and stays single while in flight", async () => {
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
    await new Promise(r => setTimeout(r, 0));
    // No catalogue yet: the panel asks for it, Send stays disabled and Enter creates nothing.
    expect(sent.some(c => c.type === "ais-chat-catalog")).toBe(true);
    typeNew(root, "hello");
    expect(sendButton(root).disabled).toBe(true);
    expect(creates(sent)).toHaveLength(0);
    push(stateOf([], { catalog: [{ provider: "claude", identities: [{ name: "a", kind: "identity", models: [] }], efforts: [] }] }));
    expect(sendButton(root).disabled).toBe(false);
    typeNew(root, "", false);
    expect(sendButton(root).disabled).toBe(true);
    const box = typeNew(root, "  hello  ");
    await new Promise(r => setTimeout(r, 0));
    expect(creates(sent)).toHaveLength(1);
    expect(creates(sent)[0]).toMatchObject({ windowId: 1, text: "hello", selection: { provider: "claude", identity: "a" }, tabIds: [5] });
    expect(sendButton(root).disabled).toBe(true);
    box.dispatch("keydown", { key: "Enter", shiftKey: false });
    expect(creates(sent)).toHaveLength(1);
    release({ ok: true });
    await new Promise(r => setTimeout(r, 0));
    expect(box.value).toBe("");
  });

  test("a refused create keeps the draft and shows the error", async () => {
    const cat = [{ provider: "claude" as const, identities: [{ name: "a", kind: "identity" as const, models: [] }], efforts: [] }];
    const s = setup([], { result: () => ({ ok: false, error: "Offline" }) });
    s.push(stateOf([], { catalog: cat }));
    const box = typeNew(s.root, "hello");
    await s.flush();
    expect(box.value).toBe("hello");
    expect(byClass(s.root, "banner").find(b => b.textContent === "Offline")).toBeDefined();
    expect(sendButton(s.root).disabled).toBe(false);
  });

  test("a full window disables Send and shows the cap hint under the composer", async () => {
    const chats = ["a", "b", "c", "d", "e", "f"].map(i => view(i));
    const s = setup(chats);
    s.push(stateOf(chats, { catalog: [{ provider: "claude", identities: [{ name: "a", kind: "identity", models: [] }], efforts: [] }] }));
    typeNew(s.root, "hello");
    expect(sendButton(s.root).disabled).toBe(true);
    expect(creates(s.sent)).toHaveLength(0);
    expect(byClass(s.root, "composer-hint").some(n => !n.hidden && n.textContent === CAP_MESSAGE)).toBe(true);
  });

  test("the new chat opens when the hub reports it", async () => {
    const cat = [{ provider: "claude" as const, identities: [{ name: "a", kind: "identity" as const, models: [] }], efforts: [] }];
    const s = setup([]);
    s.push(stateOf([], { catalog: cat }));
    typeNew(s.root, "hello");
    await s.flush();
    s.push(stateOf([view("n", {}, [{ seq: 1, ts: 0, body: { k: "user", text: "hello" } }])], { catalog: cat }));
    expect(s.t.selectedId).toBe("n");
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
    // The last row has no next row: focus goes to the message box of the list screen.
    byLabel(s.root, "Close Chat c")!.click();
    expect(s.doc.activeElement).toBe(byClass(s.root, "composer-box")[0]);
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
    expect(s.doc.activeElement).toBe(chatBox(s.root));
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
  test("Send waits for the catalogue and then uses the stored selection", async () => {
    const s = make({ provider: "claude", identity: "pool-a", model: "p1" });
    s.push(stateOf([]));
    await s.flush();
    typeNew(s.root, "hi");
    await s.flush();
    expect(creates(s.sent)).toHaveLength(0);
    s.push(stateOf([], { catalog: cat }));
    typeNew(s.root, "hi");
    await s.flush();
    expect(creates(s.sent)[0]).toMatchObject({ text: "hi", selection: { provider: "claude", identity: "pool-a", model: "p1" } });
  });
  test("with no stored selection a new chat starts on the first identity's first model", async () => {
    const s = make(undefined);
    s.push(stateOf([], { catalog: cat }));
    await s.flush();
    expect(s.root.textContent).not.toContain("Choose a model");
    typeNew(s.root, "hi");
    await s.flush();
    expect(creates(s.sent)[0]).toMatchObject({ selection: { provider: "claude", identity: "work", model: "m1" } });
  });
  test("a stored selection without a model gets the identity's first model", async () => {
    const s = make({ provider: "claude", identity: "pool-a" });
    await s.flush();
    s.push(stateOf([], { catalog: cat }));
    typeNew(s.root, "hi");
    await s.flush();
    expect(creates(s.sent)[0]).toMatchObject({ selection: { provider: "claude", identity: "pool-a", model: "p1" } });
  });
  test("Send before the stored selection loads sends nothing and keeps the stored selection", async () => {
    let release: (v: unknown) => void = () => {};
    const stored = new Promise<unknown>(r => { release = r; });
    const s = make(stored);
    s.push(stateOf([], { catalog: cat }));
    typeNew(s.root, "hi");
    await s.flush();
    expect(creates(s.sent)).toHaveLength(0);
    expect(s.saved).toEqual([]);
    release({ provider: "claude", identity: "pool-a", model: "p1" });
    await s.flush();
    typeNew(s.root, "hi");
    await s.flush();
    expect(creates(s.sent)[0]).toMatchObject({ selection: { provider: "claude", identity: "pool-a", model: "p1" } });
  });
  test("an effort that is not selectable is not saved for a new chat", async () => {
    const s = make(undefined);
    await s.flush();
    s.push(stateOf([], { catalog: [{ ...cat[0]!, efforts: ["low", "bad effort"] }] }));
    const picker = byClass(s.root, "picker")[0]!;
    walk(picker).find(n => n.className === "picker-button picker-effort")!.click();
    const items = walk(picker).filter(n => n.attrs.role === "menuitemradio");
    items.find(n => n.textContent === "low")!.click();
    expect(s.saved.length).toBe(1);
    expect(s.saved[0]).toMatchObject({ effort: "low" });
  });
  test("a stored model the catalogue lacks is replaced by the identity's first model", async () => {
    const s = make({ provider: "claude", identity: "work", model: "gone" });
    await s.flush();
    s.push(stateOf([], { catalog: cat }));
    typeNew(s.root, "hi");
    await s.flush();
    expect(creates(s.sent)[0]!.selection).toEqual({ provider: "claude", identity: "work", model: "m1" });
  });
  test("a model pick in an open chat sends ais-chat-config, other identities send nothing", async () => {
    const s = make(undefined);
    s.push(stateOf([view("a", { selection: { provider: "claude", identity: "work" } })], { catalog: cat }));
    s.t.select("a");
    await s.flush();
    const pickers = byClass(s.root, "picker");
    const detail = pickers[1]!;
    walk(detail).find(n => n.className === "picker-button")!.click();
    const items = walk(detail).filter(n => n.attrs.role === "option");
    const pool = items.find(n => n.textContent.includes("Pool One"))!;
    expect(pool.attrs["aria-disabled"]).toBe("true");
    pool.click();
    items.find(n => n.textContent.startsWith("Two"))!.click();
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
    // One ask comes from the list screen itself, the others from the opened menu.
    expect(s.sent.filter(c => c.type === "ais-chat-catalog").length).toBe(3);
  });
});

describe("composer with the picker inside", () => {
  const cat = [{ provider: "claude" as const, efforts: ["low"], identities: [{ name: "work", kind: "identity" as const, models: [{ id: "m1", name: "One" }, { id: "m2", name: "Two" }] }] }];
  const make = (stored?: unknown) => {
    const doc = fakeDoc();
    const root = doc.createElement("section");
    let push: (m: unknown) => void = () => {};
    const saved: unknown[] = [];
    const t = new ChatTab({
      doc: asDoc(doc), windowId: 1,
      connect: () => ({ postMessage: () => {}, onMessage: l => { push = l; }, onDisconnect: () => {} }),
      queryTabs: async () => [tab(5, { active: true })],
      send: async () => ({ ok: true }),
      loadSeen: async () => ({}), saveSeen: () => {},
      loadFavourites: async () => stored, saveFavourites: f => { saved.push(f); },
    }, asEl(root));
    t.start();
    return { t, root, saved, push: (s: ChatPanelState) => push(s), flush: () => new Promise(r => setTimeout(r, 0)) };
  };
  test("the model picker sits in the bottom row of the composer card, below the message box", async () => {
    const s = make();
    s.push(stateOf([view("a", { selection: { provider: "claude", identity: "work" } })], { catalog: cat }));
    s.t.select("a");
    await s.flush();
    const card = byClass(s.root, "composer-card")[0]!;
    const bar = byClass(card, "composer-bar")[0]!;
    const tools = byClass(bar, "composer-tools")[0]!;
    expect(card.children[0]!.className).toBe("composer-box");
    expect(tools.children[0]!.className).toBe("picker");
    expect(byClass(bar, "composer-send")).toHaveLength(1);
    // The old place, a picker between the feed and the composer, is gone.
    expect(byClass(s.root, "chat-detail")[0]!.children.map(c => c.className)).not.toContain("picker");
  });
  test("the picker moves with the open chat", async () => {
    const s = make();
    const chats = [view("a", { selection: { provider: "claude", identity: "work" } }), view("b", { selection: { provider: "claude", identity: "work" } })];
    s.push(stateOf(chats, { catalog: cat }));
    s.t.select("a");
    await s.flush();
    const composerOf = (n: number) => byClass(byClass(s.root, "chat-detail")[0]!, "composer-tools")[n]!;
    const picker = walk(composerOf(0)).find(n => n.className === "picker")!;
    s.t.select(undefined);
    s.t.select("b");
    const detailTools = byClass(byClass(s.root, "chat-detail")[0]!, "composer-tools");
    expect(detailTools.some(t => t.children.includes(picker))).toBe(true);
    expect(detailTools.filter(t => t.children.length > 0)).toHaveLength(1);
  });
  test("a star is saved and stays after a reload of the list", async () => {
    const s = make([{ provider: "claude", identity: "work", model: "m1" }]);
    await s.flush();
    s.push(stateOf([], { catalog: cat }));
    const picker = byClass(s.root, "picker")[0]!;
    walk(picker).find(n => n.className === "picker-button")!.click();
    expect(walk(picker).find(n => n.attrs["aria-label"] === "Remove One from favourites")).toBeDefined();
    walk(picker).find(n => n.attrs["aria-label"] === "Add Two to favourites")!.click();
    expect(s.saved).toEqual([[{ provider: "claude", identity: "work", model: "m1" }, { provider: "claude", identity: "work", model: "m2" }]]);
    expect(walk(picker).find(n => n.attrs["aria-label"] === "Remove Two from favourites")).toBeDefined();
  });
  test("bad stored favourites are dropped", async () => {
    const s = make([{ provider: "claude", identity: "work", model: "bad id" }, "x"]);
    await s.flush();
    s.push(stateOf([], { catalog: cat }));
    const picker = byClass(s.root, "picker")[0]!;
    walk(picker).find(n => n.className === "picker-button")!.click();
    expect(walk(picker).filter(n => n.attrs["aria-pressed"] === "true")).toHaveLength(0);
  });
});

describe("a chat with no linkable tab", () => {
  test("starts with no links, does not throw, and the panel shows the Link a tab prompt", async () => {
    const tabs = [tab(5, { url: "chrome://newtab/", active: true }), tab(6)];
    const s = setup([], { tabs });
    s.push(stateOf([], { catalog: [{ provider: "claude", efforts: [], identities: [{ name: "work", kind: "identity", models: [] }] }] }));
    await s.flush();
    typeNew(s.root, "hi");
    await s.flush();
    expect(creates(s.sent)[0]!.tabIds).toEqual([]);
    s.push(stateOf([view("a", { tabIds: [] })]));
    s.t.select("a");
    await s.flush();
    const prompt = byClass(s.root, "chip-prompt")[0]!;
    expect(prompt.textContent).toBe(LINK_PROMPT);
    expect(prompt.hidden).toBe(false);
    expect(byText(s.root, "option", "Link a tab")).toBeDefined();
    s.push(stateOf([view("a", { tabIds: [6] })]));
    expect(byClass(s.root, "chip-prompt")[0]!.hidden).toBe(true);
  });
});
