import { describe, expect, test } from "bun:test";
import type { BrowserTool, CallRequest } from "../../../src/browser/protocol.ts";
import { Executor } from "../src/background/executor.ts";
import type { ExecutorDeps } from "../src/background/executor.ts";
import { State } from "../src/background/state.ts";
import { colorForIdentity, TabManager } from "../src/background/tabs.ts";
import { FakeChrome } from "./fakes.ts";

const chatA = { id: "chat:a", identity: "chat", label: "Chat A", chat: true as const };
const chatB = { id: "chat:b", identity: "chat", label: "Chat B", chat: true as const };
const external = { id: "ext1", identity: "ext", label: "ext / 1" };
let n = 0;
const call = (tool: BrowserTool, args: Record<string, unknown>, s: CallRequest["session"]): CallRequest => ({ id: `k${n++}`, session: s, tool, args });

function setup(extra: Partial<ExecutorDeps> = {}) {
  const api = new FakeChrome();
  const state = new State(api.storage);
  const tabs = new TabManager(api);
  const executor = new Executor({ api, tabs, state, defaultTimeoutMs: 500, ...extra });
  return { api, state, tabs, executor };
}
const textOf = (r: Awaited<ReturnType<Executor["run"]>>) => (r.ok && r.content[0]?.type === "text" ? r.content[0].text : "");

describe("chat links", () => {
  test("a chat call on a linked tab runs", async () => {
    const { api, tabs, executor } = setup();
    api.addTab(5);
    tabs.setChatLinks(chatA.id, [5]);
    const r = await executor.run(call("get_console", { tabId: 5 }, chatA));
    expect(r.ok).toBe(true);
  });

  test("a chat call on an unlinked tab is forbidden_tab and issues no CDP command", async () => {
    const { api, tabs, executor } = setup();
    api.addTab(5);
    api.addTab(6);
    tabs.setChatLinks(chatA.id, [6]);
    const r = await executor.run(call("screenshot", { tabId: 5 }, chatA));
    expect(r).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(api.cdpLog).toHaveLength(0);
  });

  test("tabs_context for a chat lists linked tabs and returns no otherTabs", async () => {
    const { api, tabs, executor } = setup();
    api.addTab(5);
    api.addTab(6);
    api.addTab(7);
    tabs.setChatLinks(chatA.id, [5, 6]);
    const body = JSON.parse(textOf(await executor.run(call("tabs_context", {}, chatA))));
    expect(body.sessionTabs.map((t: { tabId: number }) => t.tabId)).toEqual([5, 6]);
    expect(body.otherTabs).toEqual([]);
    expect(body.grantedGroups).toEqual([]);
  });

  test("adopt_tab of an unlinked tab is forbidden_tab", async () => {
    const { api, executor } = setup();
    api.addTab(5);
    const r = await executor.run(call("adopt_tab", { tabId: 5 }, chatA));
    expect(r).toMatchObject({ ok: false, error: "forbidden_tab", message: "Only tabs you linked to this chat can be used. Link it in the side panel." });
  });

  test("two chats may link the same tab and each can act on it", async () => {
    const { api, tabs, executor } = setup();
    api.addTab(5);
    tabs.setChatLinks(chatA.id, [5]);
    tabs.setChatLinks(chatB.id, [5]);
    expect((await executor.run(call("get_console", { tabId: 5 }, chatA))).ok).toBe(true);
    expect((await executor.run(call("get_console", { tabId: 5 }, chatB))).ok).toBe(true);
  });

  test("an external agent can still adopt that tab", async () => {
    const { api, tabs, executor } = setup();
    api.addTab(5);
    tabs.setChatLinks(chatA.id, [5]);
    const r = await executor.run(call("adopt_tab", { tabId: 5 }, external));
    expect(r.ok).toBe(true);
    expect(tabs.owns(external.id, 5, "ext")).toBe(true);
  });

  test("a linked tab the user closes is removed from the links and the call fails tab_closed", async () => {
    const { api, tabs, executor } = setup();
    api.addTab(5);
    tabs.setChatLinks(chatA.id, [5]);
    api.tabList.delete(5); // closed, the removal event not yet seen
    const r = await executor.run(call("read_page", { tabId: 5 }, chatA));
    expect(r).toMatchObject({ ok: false, error: "tab_closed" });
    expect(tabs.chatLinks(chatA.id)).toEqual([]);
  });

  test("a link survives a service-worker restart (session storage and handover)", async () => {
    const { api, tabs } = setup();
    api.addTab(5);
    api.addTab(6);
    tabs.setChatLinks(chatA.id, [5, 6]);
    await Promise.resolve();
    const fromSession = new TabManager(api);
    await fromSession.load();
    expect(fromSession.chatLinks(chatA.id)).toEqual([5, 6]);

    await tabs.handover();
    api.session = {}; // a reload clears session storage
    const fromHandover = new TabManager(api);
    await fromHandover.load();
    expect(fromHandover.chatLinks(chatA.id)).toEqual([5, 6]);
    expect(fromHandover.chatLinked(chatA.id, 5)).toBe(true);
  });

  test("tabs_create by a chat links the new tab and calls onLinks before the result is returned", async () => {
    const order: string[] = [];
    const seen: Array<[string, number[]]> = [];
    const { tabs, executor } = setup({ onLinks: async (id, ids) => { await Promise.resolve(); order.push("links"); seen.push([id, ids]); } });
    const p = executor.run(call("tabs_create", { url: "example.test" }, chatA)).then(r => { order.push("result"); return r; });
    const r = await p;
    expect(order).toEqual(["links", "result"]);
    const { tabId } = JSON.parse(textOf(r));
    expect(tabs.chatLinked(chatA.id, tabId)).toBe(true);
    expect(seen).toEqual([[chatA.id, [tabId]]]);
  });

  test("tabs_create with groupId is forbidden_tab for a chat", async () => {
    const { executor } = setup();
    const r = await executor.run(call("tabs_create", { groupId: 3 }, chatA));
    expect(r).toMatchObject({ ok: false, error: "forbidden_tab" });
  });

  test("close_tab on a linked tab the chat did not create is forbidden_tab", async () => {
    const { api, tabs, executor } = setup();
    api.addTab(5);
    tabs.setChatLinks(chatA.id, [5]);
    const r = await executor.run(call("close_tab", { tabId: 5 }, chatA));
    expect(r).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(api.tabList.has(5)).toBe(true);
  });

  test("calls from two chats on one tab never overlap", async () => {
    const { api, tabs, executor } = setup();
    api.addTab(5);
    tabs.setChatLinks(chatA.id, [5]);
    tabs.setChatLinks(chatB.id, [5]);
    const log: string[] = [];
    let open = 0, maxOpen = 0;
    api.cdpResults["Runtime.evaluate"] = async (p?: Record<string, unknown>) => {
      const tag = String(p?.expression);
      log.push(`start ${tag}`);
      open++; maxOpen = Math.max(maxOpen, open);
      await new Promise(r => setTimeout(r, 20));
      open--;
      log.push(`end ${tag}`);
      return { result: { value: tag } };
    };
    const rs = await Promise.all([
      executor.run(call("javascript", { tabId: 5, code: "A" }, chatA)),
      executor.run(call("javascript", { tabId: 5, code: "B" }, chatB)),
    ]);
    expect(rs.every(r => r.ok)).toBe(true);
    expect(maxOpen).toBe(1);
    expect(log).toEqual(["start A", "end A", "start B", "end B"]);
  });

  test("session_end for a chat closes created tabs, keeps linked user tabs, and clears the links", async () => {
    const { api, tabs, executor } = setup();
    api.addTab(5);
    tabs.setChatLinks(chatA.id, [5]);
    const made = JSON.parse(textOf(await executor.run(call("tabs_create", {}, chatA)))).tabId as number;
    expect(tabs.chatLinks(chatA.id).sort()).toEqual([5, made].sort());
    const r = await executor.run(call("session_end" as BrowserTool, {}, chatA));
    expect(r.ok).toBe(true);
    expect(api.tabList.has(made)).toBe(false);
    expect(api.tabList.has(5)).toBe(true);
    expect(tabs.chatLinks(chatA.id)).toEqual([]);
  });
  test("a hung call releases the tab lock when it is aborted", async () => {
    const { api, state, tabs, executor } = setup({ defaultTimeoutMs: 5000 });
    api.addTab(5);
    tabs.setChatLinks(chatA.id, [5]);
    tabs.setChatLinks(chatB.id, [5]);
    api.cdpResults["Runtime.evaluate"] = () => new Promise(() => {});
    const reqA = call("javascript", { tabId: 5, code: "A" }, chatA);
    const a = executor.run(reqA);
    await new Promise(r => setTimeout(r, 20));
    const b = executor.run(call("get_console", { tabId: 5 }, chatB));
    await new Promise(r => setTimeout(r, 20));
    state.abort(reqA.id); // no timer involved: the order is fixed
    expect((await b).ok).toBe(true);
    expect(await a).toMatchObject({ ok: false });
  });

  test("an aborted queued call does not free the lock held by the call before it", async () => {
    const { api, state, tabs, executor } = setup({ defaultTimeoutMs: 5000 });
    api.addTab(5);
    tabs.setChatLinks(chatA.id, [5]);
    tabs.setChatLinks(chatB.id, [5]);
    const chatC = { ...chatA, id: "chat:c" };
    tabs.setChatLinks(chatC.id, [5]);
    let release!: () => void;
    api.cdpResults["Runtime.evaluate"] = (_p?: Record<string, unknown>) => new Promise(r => { release = () => r({ result: { value: 1 } }); });
    const a = executor.run(call("javascript", { tabId: 5, code: "A" }, chatA));
    await new Promise(r => setTimeout(r, 20));
    const reqB = call("key", { tabId: 5, key: "a" }, chatB);
    const b = executor.run(reqB);
    await new Promise(r => setTimeout(r, 20));
    const c = executor.run(call("key", { tabId: 5, key: "b" }, chatC));
    await new Promise(r => setTimeout(r, 20));
    state.abort(reqB.id);
    await b;
    await new Promise(r => setTimeout(r, 30));
    expect(api.cdpLog.filter(l => l.method === "Input.dispatchKeyEvent")).toHaveLength(0);
    release();
    expect((await a).ok).toBe(true);
    expect((await c).ok).toBe(true);
    expect(api.cdpLog.filter(l => l.method === "Input.dispatchKeyEvent").length).toBeGreaterThan(0);
  });

  test("a dialog that opens after an abort names the running tool, not the aborted one", async () => {
    const { api, state, tabs, executor } = setup({ defaultTimeoutMs: 5000 });
    api.addTab(5);
    tabs.setChatLinks(chatA.id, [5]);
    tabs.setChatLinks(chatB.id, [5]);
    api.cdpResults["Runtime.evaluate"] = () => new Promise(() => {});
    api.cdpResults["Input.dispatchKeyEvent"] = () => {
      api.emit(5, "Page.javascriptDialogOpening", { type: "alert", message: "hi", url: "https://example.test/" });
      return new Promise(() => {});
    };
    const reqA = call("javascript", { tabId: 5, code: "A" }, chatA);
    const a = executor.run(reqA);
    await new Promise(r => setTimeout(r, 20));
    const b = executor.run(call("key", { tabId: 5, key: "a" }, chatB));
    await new Promise(r => setTimeout(r, 20));
    state.abort(reqA.id);
    await a;
    expect(await b).toMatchObject({ ok: false, error: "dialog_open" });
    expect(executor.pendingDialog(5)?.openedDuring).toBe("key");
  });

  test("stopSession aborts only that chat's calls and stopTab aborts both", async () => {
    const { api, state, tabs, executor } = setup({ defaultTimeoutMs: 5000 });
    api.addTab(5);
    tabs.setChatLinks(chatA.id, [5]);
    tabs.setChatLinks(chatB.id, [5]);
    api.cdpResults["Runtime.evaluate"] = () => new Promise(() => {});
    const a = executor.run(call("javascript", { tabId: 5, code: "A" }, chatA));
    const b = executor.run(call("javascript", { tabId: 5, code: "B" }, chatB));
    await new Promise(r => setTimeout(r, 20));
    state.stopSession(chatA.id);
    expect(await a).toMatchObject({ ok: false, error: "stopped_by_user" });
    expect(state.inflightCount).toBe(1);
    state.setSessionsOnTab(() => [chatA.id, chatB.id]);
    state.stopTab(5);
    expect(await b).toMatchObject({ ok: false, error: "stopped_by_user" });
  });

  test("a chat popup is linked after a service-worker restart", async () => {
    const { api, tabs, executor } = setup();
    const opener = JSON.parse(textOf(await executor.run(call("tabs_create", {}, { ...chatA, color: "#f97316" })))).tabId as number;
    await Promise.resolve();
    const fresh = new TabManager(api);
    await fresh.load();
    const popup = api.addTab(300);
    await fresh.claimOpened(popup, api.tabList.get(opener)!);
    expect(fresh.chatLinks(chatA.id)).toContain(300);
  });

  test("a dialog opened by an earlier call is seen by the next chat call on the tab", async () => {
    const { api, tabs, executor } = setup();
    api.addTab(5);
    tabs.setChatLinks(chatA.id, [5]);
    tabs.setChatLinks(chatB.id, [5]);
    let first = true;
    api.cdpResults["Runtime.evaluate"] = async () => {
      if (!first) return new Promise(() => {}); // a call that wrongly ignores the open dialog hangs
      first = false;
      api.emit(5, "Page.javascriptDialogOpening", { type: "alert", message: "hi", url: "https://example.test/" });
      await new Promise(r => setTimeout(r, 10));
      return { result: { value: 1 } };
    };
    const rs = await Promise.all([
      executor.run(call("javascript", { tabId: 5, code: "A" }, chatA)),
      executor.run(call("javascript", { tabId: 5, code: "B" }, chatB)),
    ]);
    expect(rs[1]).toMatchObject({ ok: false, error: "dialog_open" });
    const h = await executor.run(call("handle_dialog", { tabId: 5, accept: true }, chatA));
    expect(h.ok).toBe(true);
  });

  test("a chat group takes the mapped palette colour and an external session keeps its identity colour", async () => {
    const { api, executor } = setup();
    const coloured = { ...chatA, color: "#f97316" };
    const made = JSON.parse(textOf(await executor.run(call("tabs_create", {}, coloured)))).tabId as number;
    expect(api.groups.get(api.tabList.get(made)!.groupId)!.color).toBe("orange");
    const ext = JSON.parse(textOf(await executor.run(call("tabs_create", {}, external)))).tabId as number;
    expect(api.groups.get(api.tabList.get(ext)!.groupId)!.color).toBe(colorForIdentity("ext"));
  });

  test("a popup opened from a chat-created tab is linked and reported through onLinks", async () => {
    const seen: Array<[string, number[]]> = [];
    const { api, tabs, executor } = setup({ onLinks: (id, ids) => { seen.push([id, ids]); } });
    const opener = JSON.parse(textOf(await executor.run(call("tabs_create", {}, chatA)))).tabId as number;
    seen.length = 0;
    const popup = api.addTab(300);
    await tabs.claimOpened(popup, api.tabList.get(opener)!);
    expect(tabs.chatLinks(chatA.id)).toContain(300);
    expect(seen.at(-1)).toEqual([chatA.id, [opener, 300]]);
  });

  test("closing a linked tab reports the reduced link set", async () => {
    const seen: Array<[string, number[]]> = [];
    const { api, tabs } = setup({ onLinks: (id, ids) => { seen.push([id, ids]); } });
    api.addTab(5);
    api.addTab(6);
    tabs.setChatLinks(chatA.id, [5, 6]);
    seen.length = 0;
    api.closeTab(5);
    expect(seen).toEqual([[chatA.id, [6]]]);
  });

  test("adopt_tab of a missing unlinked tab is forbidden_tab", async () => {
    const { executor } = setup();
    const r = await executor.run(call("adopt_tab", { tabId: 999 }, chatA));
    expect(r).toMatchObject({ ok: false, error: "forbidden_tab" });
  });
});
