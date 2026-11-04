import { describe, expect, test } from "bun:test";
import type { BrowserTool, CallRequest } from "../../../src/browser/protocol.ts";
import { TOOL_SCHEMAS, validateToolArgs } from "../../../src/browser/tool-args.ts";
import { capText, Executor, jpegSize } from "../src/background/executor.ts";
import type { ExecutorDeps } from "../src/background/executor.ts";
import { State } from "../src/background/state.ts";
import { colorForIdentity, TabManager } from "../src/background/tabs.ts";
import type { Ui } from "../src/background/ui.ts";
import { FakeChrome } from "./fakes.ts";

const session = { id: "s1", identity: "dyn", label: "dyn / s1" };
let n = 0;
const call = (tool: BrowserTool, args: Record<string, unknown> = {}, s = session): CallRequest => ({ id: `c${n++}`, session: s, tool, args });

function setup(ui?: Ui, extra: Partial<ExecutorDeps> = {}) {
  const api = new FakeChrome();
  const state = new State(api.storage);
  const tabs = new TabManager(api);
  const executor = new Executor({ api, tabs, state, ...(ui ? { ui } : {}), defaultTimeoutMs: 200, ...extra });
  return { api, state, tabs, executor };
}

const textOf = (r: Awaited<ReturnType<Executor["run"]>>) => (r.ok && r.content[0]?.type === "text" ? r.content[0].text : "");

describe("tab ownership", () => {
  test("tab not in session is forbidden_tab", async () => {
    const { api, executor } = setup();
    api.addTab(5);
    const r = await executor.run(call("screenshot", { tabId: 5 }));
    expect(r).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(api.cdpLog).toHaveLength(0);
  });

  test("tab closed by the user is tab_closed and removed from the map", async () => {
    const { api, tabs, executor } = setup();
    await tabs.create(session, "https://example.test/");
    const id = [...tabs.sessions.get("s1")!.tabIds][0]!;
    api.tabList.delete(id); // closed without the onRemoved event reaching us
    const r = await executor.run(call("read_page", { tabId: id }));
    expect(r).toMatchObject({ ok: false, error: "tab_closed" });
    expect(tabs.owns("s1", id, "dyn")).toBe(false);
  });

  test("tabs_create groups with session label and a stable colour per identity", async () => {
    const { api, tabs, executor } = setup();
    const r = await executor.run(call("tabs_create", { url: "example.test" }));
    expect(r.ok).toBe(true);
    const { tabId } = JSON.parse(textOf(r));
    expect(tabs.owns("s1", tabId, "dyn")).toBe(true);
    const group = api.groups.get(api.tabList.get(tabId)!.groupId)!;
    expect(group.title).toBe("dyn / s1");
    expect(group.color).toBe(colorForIdentity("dyn"));
    expect(colorForIdentity("dyn")).toBe(colorForIdentity("dyn"));
    expect(api.tabList.get(tabId)!.url).toBe("https://example.test/");
  });

  test("tabs_context lists own tabs and other tabs; adopt_tab moves one; another session's tab is forbidden", async () => {
    const { api, executor } = setup();
    api.addTab(7, "https://mine.test/");
    const mine = await executor.run(call("tabs_create"));
    const ownId = JSON.parse(textOf(mine)).tabId;
    let ctx = JSON.parse(textOf(await executor.run(call("tabs_context"))));
    expect(ctx.sessionTabs.map((t: { tabId: number }) => t.tabId)).toEqual([ownId]);
    expect(ctx.otherTabs.map((t: { tabId: number }) => t.tabId)).toEqual([7]);
    expect((await executor.run(call("adopt_tab", { tabId: 7 }))).ok).toBe(true);
    ctx = JSON.parse(textOf(await executor.run(call("tabs_context"))));
    expect(ctx.sessionTabs.map((t: { tabId: number }) => t.tabId).sort()).toEqual([7, ownId].sort());
    const other = { id: "s2", identity: "x", label: "x / s2" };
    expect(await executor.run(call("adopt_tab", { tabId: 7 }, other))).toMatchObject({ ok: false, error: "forbidden_tab" });
    const sameIdOtherIdentity = { id: "s1", identity: "x", label: "x / s1" };
    expect(await executor.run(call("adopt_tab", { tabId: 7 }, sameIdOtherIdentity))).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await executor.run(call("screenshot", { tabId: 7 }, sameIdOtherIdentity))).toMatchObject({ ok: false, error: "forbidden_tab" });
    ctx = JSON.parse(textOf(await executor.run(call("tabs_context", {}, other))));
    expect(ctx.otherTabs.map((t: { tabId: number }) => t.tabId)).not.toContain(7);
  });
});

describe("tab persistence and groups", () => {
  test("ownership survives a worker restart; vanished tabs are dropped", async () => {
    const { api, tabs } = setup();
    const a = await tabs.create(session, "https://a.test/");
    const b = await tabs.create(session, "https://b.test/");
    const gid = tabs.sessions.get("s1")!.groupId;
    api.tabList.delete(b.id);
    const tabs2 = new TabManager(api);
    await tabs2.load();
    expect(tabs2.owns("s1", a.id, "dyn")).toBe(true);
    expect(tabs2.owns("s1", b.id, "dyn")).toBe(false);
    expect(tabs2.sessions.get("s1")).toMatchObject({ groupId: gid, label: "dyn / s1", identity: "dyn" });
  });

  test("stale groupId gets a fresh group and the tab stays owned", async () => {
    const { api, tabs, executor } = setup();
    const first = await tabs.create(session);
    api.groupFailures.add(tabs.sessions.get("s1")!.groupId);
    const r = await executor.run(call("tabs_create"));
    expect(r.ok).toBe(true);
    const { tabId } = JSON.parse(textOf(r));
    expect(tabs.owns("s1", tabId, "dyn")).toBe(true);
    expect(tabs.owns("s1", first.id, "dyn")).toBe(true);
    expect(api.groups.get(tabs.sessions.get("s1")!.groupId)?.title).toBe("dyn / s1");
  });
});

describe("pause and stop", () => {
  test("paused replies paused_by_user without touching the browser", async () => {
    const { api, state, executor } = setup();
    state.pause();
    const r = await executor.run(call("tabs_context"));
    expect(r).toMatchObject({ ok: false, error: "paused_by_user" });
    expect(api.store.paused).toBe(true);
    state.resume();
    expect((await executor.run(call("tabs_context"))).ok).toBe(true);
  });

  test("pause state loads from storage and is reported via onChange", async () => {
    const api = new FakeChrome();
    api.store.paused = true;
    const state = new State(api.storage);
    await state.load();
    expect(state.paused).toBe(true);
    const seen: boolean[] = [];
    state.onChange(p => seen.push(p));
    state.resume();
    state.resume();
    expect(seen).toEqual([false]);
  });

  test("stop aborts in-flight calls with stopped_by_user and detaches the debugger", async () => {
    const { api, state, tabs, executor } = setup();
    const tab = await tabs.create(session, "https://example.test/");
    await executor.run(call("read_page", { tabId: tab.id })); // attaches
    expect(api.attachedTabs.has(tab.id)).toBe(true);
    const pending = executor.run(call("wait", { seconds: 100 }));
    await new Promise(r => setTimeout(r, 5));
    await state.stop();
    expect(await pending).toMatchObject({ ok: false, error: "stopped_by_user" });
    expect(api.attachedTabs.size).toBe(0);
    expect(state.paused).toBe(true);
    expect(api.store.paused).toBe(true);
  });

  test("stop during a multi-step click dispatches no input and leaves nothing attached", async () => {
    const { api, state, tabs, executor } = setup();
    const tab = await tabs.create(session, "https://example.test/");
    api.cdpResults["Accessibility.getFullAXTree"] = { nodes: [{ nodeId: "1", role: { value: "button" }, name: { value: "Go" }, backendDOMNodeId: 9 }] };
    await executor.run(call("read_page", { tabId: tab.id }));
    api.cdpResults["DOM.getContentQuads"] = async () => { await state.stop(); return { quads: [[0, 0, 2, 0, 2, 2, 0, 2]] }; };
    const r = await executor.run(call("click", { tabId: tab.id, ref: "ref_1" }));
    expect(r).toMatchObject({ ok: false, error: "stopped_by_user" });
    await new Promise(res => setTimeout(res, 10));
    expect(api.cdpLog.some(l => l.method === "Input.dispatchMouseEvent")).toBe(false);
    expect(api.attachedTabs.size).toBe(0);
    // paused now, further calls refused
    expect(await executor.run(call("tabs_context"))).toMatchObject({ ok: false, error: "paused_by_user" });
  });

  test("stop while the debugger is attaching detaches again and never enables domains", async () => {
    const { api, state, tabs, executor } = setup();
    const tab = await tabs.create(session);
    const attach = api.debugger.attach;
    api.debugger.attach = async id => { await state.stop(); await attach(id); };
    expect(await executor.run(call("read_page", { tabId: tab.id }))).toMatchObject({ ok: false, error: "stopped_by_user" });
    expect(api.attachedTabs.size).toBe(0);
    expect(api.cdpLog).toHaveLength(0);
  });

  test("user cancelling the debugger bar acts as Stop", async () => {
    const { api, state, tabs, executor } = setup();
    const tab = await tabs.create(session);
    const pending = executor.run(call("wait", { seconds: 100 }));
    await new Promise(r => setTimeout(r, 5));
    for (const l of api.detachListeners) l(tab.id, "canceled_by_user");
    expect(await pending).toMatchObject({ ok: false, error: "stopped_by_user" });
    expect(state.paused).toBe(true);
  });

  test("gateway abort and call timeout yield timeout", async () => {
    const { api, state, tabs, executor } = setup();
    const req = call("wait", { seconds: 100 });
    const pending = executor.run(req);
    await new Promise(r => setTimeout(r, 5));
    state.abort(req.id);
    expect(await pending).toMatchObject({ ok: false, error: "timeout" });
    const tab = await tabs.create(session);
    api.cdpResults["Runtime.evaluate"] = () => new Promise(() => {});
    expect(await executor.run(call("javascript", { tabId: tab.id, code: "x" }))).toMatchObject({ ok: false, error: "timeout" });
  });
});

describe("args and tools", () => {
  test("bad args are rejected before any action", async () => {
    const { executor } = setup();
    expect(await executor.run(call("navigate", { tabId: "x" }))).toMatchObject({ ok: false, error: "bad_args" });
    expect(await executor.run(call("wait", { seconds: 500 }))).toMatchObject({ ok: false, error: "bad_args" });
    expect(await executor.run(call("list_browsers"))).toMatchObject({ ok: false, error: "bad_args" });
  });

  test("every tool except list_browsers has a schema", () => {
    expect(Object.keys(TOOL_SCHEMAS)).toHaveLength(19);
    expect(Object.keys(TOOL_SCHEMAS)).not.toContain("upload_file");
    expect(validateToolArgs("click", { tabId: 1, coordinate: [1, 2] })).toBeUndefined();
    expect(validateToolArgs("click", { tabId: 1, coordinate: [1] })).toBeDefined();
    expect(validateToolArgs("click", { tabId: 1, junk: 1 })).toBeDefined();
  });

  test("read_page yields refs; click on a ref calls the ui hooks and dispatches trusted mouse events", async () => {
    const events: string[] = [];
    const ui: Ui = {
      beforeAction: (tabId, p) => { events.push(`before:${tabId}:${p.kind}:${p.x},${p.y}`); },
      markControlled: (tabId, s) => { events.push(`mark:${tabId}:${s.id}`); },
      unmark() {},
      unmarkAll() {},
      suspend() {},
      restore() {},
    };
    const { api, tabs, executor } = setup(ui);
    const tab = await tabs.create(session, "https://example.test/");
    api.cdpResults["Accessibility.getFullAXTree"] = { nodes: [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "3"] },
      { nodeId: "2", role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 40 },
      { nodeId: "3", role: { value: "paragraph" }, name: { value: "x" }, backendDOMNodeId: 41 },
    ] };
    api.cdpResults["DOM.getContentQuads"] = { quads: [[10, 10, 30, 10, 30, 30, 10, 30]] };
    const page = textOf(await executor.run(call("read_page", { tabId: tab.id })));
    expect(page).toBe('button "Save" [ref_1]');
    const r = await executor.run(call("click", { tabId: tab.id, ref: "ref_1" }));
    expect(r.ok).toBe(true);
    expect(events).toContain(`before:${tab.id}:click:20,20`);
    expect(events).toContain(`mark:${tab.id}:s1`);
    const types = api.cdpLog.filter(l => l.method === "Input.dispatchMouseEvent").map(l => l.params!.type);
    expect(types).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(await executor.run(call("click", { tabId: tab.id, ref: "ref_99" }))).toMatchObject({ ok: false, error: "bad_args" });
  });

  test("screenshot is scaled to the cap and its scale maps coordinates back", async () => {
    const { api, tabs, executor } = setup();
    const tab = await tabs.create(session, "https://example.test/");
    api.cdpResults["Page.getLayoutMetrics"] = { cssVisualViewport: { clientWidth: 3136, clientHeight: 1000, pageX: 0, pageY: 0 } };
    // minimal JPEG header: SOI, SOF0 with 1568x500
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x01, 0xf4, 0x06, 0x20, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    const b64 = btoa(String.fromCharCode(...bytes));
    expect(jpegSize(b64)).toEqual({ width: 1568, height: 500 });
    api.cdpResults["Page.captureScreenshot"] = { data: b64 };
    const shot = await executor.run(call("screenshot", { tabId: tab.id }));
    expect(shot).toMatchObject({ ok: true, content: [{ type: "image", mimeType: "image/jpeg" }] });
    const cap = api.cdpLog.find(l => l.method === "Page.captureScreenshot")!.params as { quality: number; clip: { scale: number } };
    expect(cap.quality).toBe(80);
    expect(cap.clip.scale).toBeCloseTo(0.5, 3);
    await executor.run(call("hover", { tabId: tab.id, coordinate: [100, 50] }));
    const move = api.cdpLog.filter(l => l.method === "Input.dispatchMouseEvent").at(-1)!.params!;
    expect(move.x).toBeCloseTo(200, 3);
    expect(move.y).toBeCloseTo(100, 3);
  });

  test("coordinate without a screenshot is bad_args", async () => {
    const { tabs, executor } = setup();
    const tab = await tabs.create(session);
    const r = await executor.run(call("click", { tabId: tab.id, coordinate: [1, 2] }));
    expect(r).toMatchObject({ ok: false, error: "bad_args" });
    expect(r.ok ? "" : r.message).toMatch(/screenshot first/);
  });

  test("unknown tool replies bad_args instead of throwing", async () => {
    const { executor } = setup();
    expect(await executor.run({ ...call("tabs_context"), tool: "nope" as BrowserTool })).toMatchObject({ ok: false, error: "bad_args" });
  });

  test("navigate resolves on same-document navigation without waiting for load", async () => {
    const { api, tabs, executor } = setup();
    const tab = await tabs.create(session, "https://example.test/");
    api.cdpResults["Page.navigate"] = () => { queueMicrotask(() => api.emit(tab.id, "Page.navigatedWithinDocument", {})); return {}; };
    const t0 = Date.now();
    expect((await executor.run(call("navigate", { tabId: tab.id, url: "https://example.test/#x" }))).ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(150);
  });

  test("shift+letter types the upper case letter", async () => {
    const { parseKeys } = await import("../src/background/keys.ts");
    expect(parseKeys("shift+a")[0]).toMatchObject({ key: "A", text: "A", modifiers: 8 });
  });

  test("DOM agent is enabled before ref based DOM calls", async () => {
    const { api, tabs, executor } = setup();
    const tab = await tabs.create(session);
    api.cdpResults["Accessibility.getFullAXTree"] = { nodes: [{ nodeId: "1", role: { value: "button" }, name: { value: "Go" }, backendDOMNodeId: 9 }] };
    api.cdpResults["DOM.getContentQuads"] = { quads: [[0, 0, 2, 0, 2, 2, 0, 2]] };
    await executor.run(call("read_page", { tabId: tab.id }));
    await executor.run(call("hover", { tabId: tab.id, ref: "ref_1" }));
    const methods = api.cdpLog.map(l => l.method);
    expect(methods.indexOf("DOM.getDocument")).toBeGreaterThan(-1);
    expect(methods.indexOf("DOM.getDocument")).toBeLessThan(methods.indexOf("DOM.getContentQuads"));
  });

  test("text results are truncated at 100000 chars", () => {
    expect(capText("a".repeat(100_001))).toBe(`${"a".repeat(100_000)}\n[truncated]`);
    expect(capText("short")).toBe("short");
  });

  test("javascript returns JSON and surfaces exceptions", async () => {
    const { api, tabs, executor } = setup();
    const tab = await tabs.create(session);
    api.cdpResults["Runtime.evaluate"] = { result: { value: { a: 1 } } };
    expect(textOf(await executor.run(call("javascript", { tabId: tab.id, code: "x" })))).toBe('{"a":1}');
    api.cdpResults["Runtime.evaluate"] = { exceptionDetails: { exception: { description: "boom" } } };
    expect(await executor.run(call("javascript", { tabId: tab.id, code: "x" }))).toMatchObject({ ok: false, error: "internal" });
  });

  test("console and network buffers fill from debugger events", async () => {
    const { api, tabs, executor } = setup();
    const tab = await tabs.create(session);
    await executor.run(call("get_console", { tabId: tab.id })); // attach
    api.emit(tab.id, "Runtime.consoleAPICalled", { type: "error", args: [{ value: "bad" }] });
    api.emit(tab.id, "Network.requestWillBeSent", { requestId: "1", request: { url: "https://a.test/x", method: "GET" } });
    api.emit(tab.id, "Network.responseReceived", { requestId: "1", response: { status: 200 } });
    expect(textOf(await executor.run(call("get_console", { tabId: tab.id, onlyErrors: true })))).toBe("[error] bad");
    expect(textOf(await executor.run(call("get_network", { tabId: tab.id })))).toBe("GET https://a.test/x 200");
  });
});

describe("visuals and abort hygiene", () => {
  function recordingUi() {
    const log: string[] = [];
    let signal: AbortSignal | undefined;
    const ui: Ui = {
      beforeAction: (_t, _p, s) => { signal = s; log.push("before"); },
      markControlled: (t) => { log.push(`mark:${t}`); },
      unmark: (t) => { log.push(`unmark:${t}`); },
      unmarkAll: () => { log.push("unmarkAll"); },
      suspend: t => { log.push(`suspend:${t}`); },
      restore: t => { log.push(`restore:${t}`); },
    };
    return { ui, log, signal: () => signal };
  }

  test("beforeAction receives the call's abort signal; a throwing ui never fails the call", async () => {
    const r = recordingUi();
    r.ui.beforeAction = () => { throw new Error("overlay gone"); };
    const { api, tabs, executor } = setup(r.ui);
    const tab = await tabs.create(session);
    api.cdpResults["Page.getLayoutMetrics"] = { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } };
    api.cdpResults["Page.captureScreenshot"] = { data: "/9j/" };
    await executor.run(call("screenshot", { tabId: tab.id }));
    expect((await executor.run(call("hover", { tabId: tab.id, coordinate: [10, 10] }))).ok).toBe(true);
  });

  test("unmark on close_tab, tab removal, stop and pause", async () => {
    const r = recordingUi();
    const { api, state, tabs, executor } = setup(r.ui);
    const t1 = await tabs.create(session);
    expect((await executor.run(call("close_tab", { tabId: t1.id }))).ok).toBe(true);
    expect(r.log).toContain(`unmark:${t1.id}`);
    const t2 = await tabs.create(session);
    api.closeTab(t2.id);
    await new Promise(res => setTimeout(res, 2));
    expect(r.log).toContain(`unmark:${t2.id}`);
    r.log.length = 0;
    state.pause();
    expect(r.log).toContain("unmarkAll");
    r.log.length = 0;
    state.resume();
    await state.stop();
    expect(r.log).toContain("unmarkAll");
  });

  test("no overlay is drawn while paused", async () => {
    const r = recordingUi();
    const { state, tabs, executor } = setup(r.ui);
    const tab = await tabs.create(session);
    r.log.length = 0;
    state.pause();
    r.log.length = 0;
    expect(await executor.run(call("read_page", { tabId: tab.id }))).toMatchObject({ error: "paused_by_user" });
    expect(r.log).toEqual([]);
  });

  test("timeout during attach keeps the debugger attached for a concurrent call", async () => {
    const { api, state, tabs, executor } = setup();
    const tab = await tabs.create(session);
    const attach = api.debugger.attach;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    api.debugger.attach = async id => { await gate; await attach(id); };
    const first = executor.run(call("read_page", { tabId: tab.id }));
    await new Promise(r => setTimeout(r, 5));
    const id = [...(state as unknown as { inflight: Map<string, AbortController> }).inflight.keys()][0]!;
    state.abort(id);
    release();
    expect(await first).toMatchObject({ ok: false, error: "timeout" });
    expect(api.attachedTabs.has(tab.id)).toBe(true);
    api.debugger.attach = attach;
    api.cdpResults["Accessibility.getFullAXTree"] = { nodes: [] };
    expect((await executor.run(call("read_page", { tabId: tab.id }))).ok).toBe(true);
    expect(api.detachCalls).toEqual([]);
  });

  test("stop during attach drops recorded tab state so the next attach is real", async () => {
    const { api, state, tabs, executor } = setup();
    const tab = await tabs.create(session);
    const attach = api.debugger.attach;
    api.debugger.attach = async id => { await state.stop(); await attach(id); };
    await executor.run(call("read_page", { tabId: tab.id }));
    await new Promise(r => setTimeout(r, 5)); // the aborted dispatch finishes its detach after run() returned
    state.resume();
    api.debugger.attach = attach;
    api.cdpResults["Accessibility.getFullAXTree"] = { nodes: [] };
    expect((await executor.run(call("read_page", { tabId: tab.id }))).ok).toBe(true);
    expect(api.attachedTabs.has(tab.id)).toBe(true);
  });

  test("aborted calls do not run side-effecting non-CDP steps", async () => {
    const { api, state, tabs, executor } = setup();
    const tab = await tabs.create(session);
    // abort lands while the ownership lookup is in flight
    const get = api.tabs.get;
    api.tabs.get = async id => { const r = await get(id); await state.stop(); return r; };
    expect(await executor.run(call("close_tab", { tabId: tab.id }))).toMatchObject({ ok: false, error: "stopped_by_user" });
    expect(api.tabList.has(tab.id)).toBe(true);
    state.resume();
    expect(await executor.run(call("resize", { tabId: tab.id, width: 800, height: 600 }))).toMatchObject({ ok: false, error: "stopped_by_user" });
    expect(api.resizes).toEqual([]);
    api.tabs.get = get;
  });

  test("main-frame navigation from a click clears domReady; subframes do not", async () => {
    const { api, tabs, executor } = setup();
    const tab = await tabs.create(session);
    api.cdpResults["Accessibility.getFullAXTree"] = { nodes: [{ nodeId: "1", role: { value: "button" }, name: { value: "Go" }, backendDOMNodeId: 9 }] };
    api.cdpResults["DOM.getContentQuads"] = { quads: [[0, 0, 2, 0, 2, 2, 0, 2]] };
    await executor.run(call("read_page", { tabId: tab.id }));
    await executor.run(call("hover", { tabId: tab.id, ref: "ref_1" }));
    const getDocs = () => api.cdpLog.filter(l => l.method === "DOM.getDocument").length;
    expect(getDocs()).toBe(1);
    api.emit(tab.id, "Page.frameNavigated", { frame: { id: "f", parentId: "main" } });
    await executor.run(call("hover", { tabId: tab.id, ref: "ref_1" }));
    expect(getDocs()).toBe(1);
    api.emit(tab.id, "Page.frameNavigated", { frame: { id: "main" } });
    await executor.run(call("hover", { tabId: tab.id, ref: "ref_1" }));
    expect(getDocs()).toBe(2);
  });

  test("screenshot and mouse input run between suspend and restore, in order, also when aborted", async () => {
    const r = recordingUi();
    const { api, state, tabs, executor } = setup(r.ui);
    const tab = await tabs.create(session);
    const order = r.log;
    const send = api.debugger.send;
    api.debugger.send = async (id, method, params) => { if (/^(Page\.captureScreenshot|Input\.dispatchMouseEvent)$/.test(method)) order.push(method); return send(id, method, params); };
    api.cdpResults["Page.getLayoutMetrics"] = { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } };
    api.cdpResults["Page.captureScreenshot"] = { data: "/9j/" };
    await executor.run(call("screenshot", { tabId: tab.id }));
    const shot = order.filter(l => /suspend|restore|captureScreenshot/.test(l));
    expect(shot).toEqual([`suspend:${tab.id}`, "Page.captureScreenshot", `restore:${tab.id}`]);
    order.length = 0;
    expect((await executor.run(call("click", { tabId: tab.id, coordinate: [10, 10] }))).ok).toBe(true);
    const seq = order.filter(l => !l.startsWith("mark") && l !== "before");
    expect(seq).toEqual([`suspend:${tab.id}`, "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", `restore:${tab.id}`]);
    // abort between suspend and the capture: restore still runs
    order.length = 0;
    api.cdpResults["Page.getLayoutMetrics"] = async () => { await state.stop(); return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } }; };
    state.resume();
    expect(await executor.run(call("screenshot", { tabId: tab.id }))).toMatchObject({ ok: false, error: "stopped_by_user" });
    await new Promise(res => setTimeout(res, 10)); // run() returns on abort; the dispatch unwinds right after
    expect(order.filter(l => /^(suspend|restore)/.test(l))).toEqual([`suspend:${tab.id}`, `restore:${tab.id}`]);
  });

  test("a ui that fails to suspend never fails the call", async () => {
    const r = recordingUi();
    r.ui.suspend = () => { throw new Error("gone"); };
    r.ui.restore = () => { throw new Error("gone"); };
    const { api, tabs, executor } = setup(r.ui);
    const tab = await tabs.create(session);
    api.cdpResults["Page.getLayoutMetrics"] = { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } };
    api.cdpResults["Page.captureScreenshot"] = { data: "/9j/" };
    expect((await executor.run(call("screenshot", { tabId: tab.id }))).ok).toBe(true);
  });

  const VIEWPORT = { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } };

  test("a capture Chrome never answers returns tab_hidden within the cap and restores the overlay", async () => {
    const r = recordingUi();
    const { api, tabs, executor } = setup(r.ui, { captureTimeoutMs: 40, defaultTimeoutMs: 5000 });
    const tab = await tabs.create(session);
    api.cdpResults["Page.getLayoutMetrics"] = VIEWPORT;
    api.cdpResults["Page.captureScreenshot"] = () => new Promise(() => {});
    const t0 = Date.now();
    const res = await executor.run(call("screenshot", { tabId: tab.id }));
    expect(Date.now() - t0).toBeLessThan(500);
    expect(res).toMatchObject({ ok: false, error: "tab_hidden" });
    expect((res as { message: string }).message).toBe(`Chrome did not render tab ${tab.id} (minimised or hidden window). Ask the user to bring the window forward, then retry.`);
    expect(r.log.at(-1)).toBe(`restore:${tab.id}`);
  });

  test("a hung capture hit by the call timeout restores the overlay straight away (abort path)", async () => {
    const r = recordingUi();
    const { api, tabs, executor } = setup(r.ui, { defaultTimeoutMs: 50 });
    const tab = await tabs.create(session);
    api.cdpResults["Page.getLayoutMetrics"] = VIEWPORT;
    api.cdpResults["Page.captureScreenshot"] = () => new Promise(() => {});
    const t0 = Date.now();
    expect(await executor.run(call("screenshot", { tabId: tab.id }))).toMatchObject({ ok: false, error: "timeout" });
    await new Promise(res => setTimeout(res, 10));
    expect(Date.now() - t0).toBeLessThan(200);
    expect(r.log.filter(l => l.startsWith("restore"))).toEqual([`restore:${tab.id}`]);
  });

  test("a tab that is not active is activated before the capture, and the wait is bounded when it never turns visible", async () => {
    const { api, tabs, executor } = setup(undefined, { visibleWaitMs: 80 });
    const tab = await tabs.create(session);
    api.tabList.get(tab.id)!.active = false;
    api.cdpResults["Page.getLayoutMetrics"] = VIEWPORT;
    api.cdpResults["Page.captureScreenshot"] = { data: "/9j/" };
    const order: string[] = [];
    const activate = api.tabs.activate;
    api.tabs.activate = async id => { order.push("activate"); await activate(id); };
    const send = api.debugger.send;
    api.debugger.send = async (id, m, p) => { if (m === "Page.captureScreenshot") order.push("capture"); return send(id, m, p); };
    expect((await executor.run(call("screenshot", { tabId: tab.id }))).ok).toBe(true);
    expect(order).toEqual(["activate", "capture"]);
    expect(api.tabList.get(tab.id)!.active).toBe(true);
  });

  test("an already active tab is not activated; input tools activate a background tab too", async () => {
    const { api, tabs, executor } = setup(undefined, { visibleWaitMs: 30 });
    const tab = await tabs.create(session);
    api.cdpResults["Page.getLayoutMetrics"] = VIEWPORT;
    api.cdpResults["Page.captureScreenshot"] = { data: "/9j/" };
    await executor.run(call("screenshot", { tabId: tab.id }));
    expect(api.activateCalls).toEqual([]);
    api.tabList.get(tab.id)!.active = false;
    api.cdpResults["Runtime.evaluate"] = { result: { value: "visible" } };
    expect((await executor.run(call("key", { tabId: tab.id, key: "a" }))).ok).toBe(true);
    expect(api.activateCalls).toEqual([tab.id]);
    api.tabList.get(tab.id)!.active = false;
    await executor.run(call("javascript", { tabId: tab.id, code: "1" }));
    expect(api.activateCalls).toEqual([tab.id]); // javascript does not need the front
  });

  test("tabs_create opens the tab active, in its group", async () => {
    const { api, executor } = setup();
    const id = JSON.parse(textOf(await executor.run(call("tabs_create", { url: "example.test" })))).tabId;
    expect(api.tabList.get(id)!.active).toBe(true);
    expect(api.tabList.get(id)!.groupId).toBeGreaterThan(0);
  });

  test("after a hover the overlay stays hidden until the hold ends, the next non-hover call, or stop", async () => {
    const r = recordingUi();
    const { api, state, tabs, executor } = setup(r.ui, { hoverHoldMs: 60 });
    const tab = await tabs.create(session);
    api.cdpResults["Page.getLayoutMetrics"] = VIEWPORT;
    api.cdpResults["Page.captureScreenshot"] = { data: "/9j/" };
    await executor.run(call("screenshot", { tabId: tab.id }));
    const restores = () => r.log.filter(l => l.startsWith("restore")).length;
    const base = restores();
    expect((await executor.run(call("hover", { tabId: tab.id, coordinate: [10, 10] }))).ok).toBe(true);
    expect(restores()).toBe(base); // still hidden right after the hover
    await new Promise(res => setTimeout(res, 100));
    expect(restores()).toBe(base + 1); // timer restored
    // next non-hover call releases early
    await executor.run(call("hover", { tabId: tab.id, coordinate: [10, 10] }));
    expect(restores()).toBe(base + 1);
    await executor.run(call("tabs_context"));
    expect(restores()).toBe(base + 1); // tabs_context is not tab scoped
    await executor.run(call("get_console", { tabId: tab.id }));
    expect(restores()).toBe(base + 2);
    // stop releases a pending hold
    state.resume();
    await executor.run(call("hover", { tabId: tab.id, coordinate: [10, 10] }));
    await state.stop();
    expect(restores()).toBe(base + 3);
    await new Promise(res => setTimeout(res, 100));
    expect(restores()).toBe(base + 3); // and the timer does not fire again
  });
});
