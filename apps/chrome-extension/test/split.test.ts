import { describe, expect, test } from "bun:test";
import type { BrowserTool, CallRequest } from "../../../src/browser/protocol.ts";
import { Executor } from "../src/background/executor.ts";
import { State } from "../src/background/state.ts";
import { TabManager } from "../src/background/tabs.ts";
import { FakeChrome } from "./fakes.ts";

const S1 = { id: "s1", identity: "alice", label: "chat one" };
const S2 = { id: "s2", identity: "alice", label: "chat two" };
let n = 0;

function setup() {
  const api = new FakeChrome();
  const tabs = new TabManager(api);
  const executor = new Executor({ api, tabs, state: new State(api.storage) });
  const call = (tool: BrowserTool, args: Record<string, unknown> = {}, s = S1) => executor.run({ id: `c${++n}`, session: s, tool, args } as CallRequest);
  const json = (r: Awaited<ReturnType<typeof call>>) => JSON.parse(r.ok && r.content[0]?.type === "text" ? r.content[0].text : "{}");
  const create = async (s = S1, args: Record<string, unknown> = {}): Promise<number> => json(await call("tabs_create", args, s)).tabId;
  return { api, tabs, executor, call, json, create };
}

describe("split_tabs", () => {
  test("splits two own adjacent tabs", async () => {
    const t = setup();
    const a = await t.create();
    const b = await t.create();
    const r = await t.call("split_tabs", { tabIds: [a, b] });
    expect(r.ok).toBe(true);
    const out = t.json(r);
    expect(out.tabIds).toEqual([a, b]);
    expect(t.api.tabList.get(a)!.splitViewId).toBe(out.splitViewId);
    expect(t.api.tabList.get(b)!.splitViewId).toBe(out.splitViewId);
    expect(t.api.moveCalls).toHaveLength(0);
    expect(t.api.activations).toHaveLength(0);
  });

  test("splits tabs of a granted group", async () => {
    const t = setup();
    const u1 = t.api.addTab(1);
    const u2 = t.api.addTab(2);
    const group = await t.api.tabs.group([u1.id, u2.id]);
    await t.call("tabs_context"); // registers the session
    expect(await t.tabs.grant(group, "s1")).toBe("ok");
    const r = await t.call("split_tabs", { tabIds: [1, 2] });
    expect(r.ok).toBe(true);
    expect(t.api.tabList.get(1)!.splitViewId).toBe(t.json(r).splitViewId);
    expect(t.api.tabList.get(1)!.groupId).toBe(group);
  });

  test("another session's tab and the user's other tab are forbidden", async () => {
    const t = setup();
    const mine = await t.create();
    const theirs = await t.create(S2);
    const user = t.api.addTab(9).id;
    expect(await t.call("split_tabs", { tabIds: [mine, theirs] })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await t.call("split_tabs", { tabIds: [user, mine] })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.splitCalls).toHaveLength(0);
  });

  test("moves the second tab after the first when it comes later in the strip", async () => {
    const t = setup();
    const a = await t.create();
    const x = t.api.addTab(50).id; // the user's tab between them
    const b = await t.create();
    expect(t.api.order()).toEqual([a, x, b]);
    const group = t.api.tabList.get(a)!.groupId;
    const r = await t.call("split_tabs", { tabIds: [a, b] });
    expect(r.ok).toBe(true);
    expect(t.api.order()).toEqual([a, b, x]);
    expect(t.api.tabList.get(b)!.groupId).toBe(group);
    expect(t.api.tabList.get(b)!.windowId).toBe(1);
  });

  test("moves the second tab after the first when it comes earlier in the strip", async () => {
    const t = setup();
    const b = await t.create();
    const x = t.api.addTab(50).id;
    const a = await t.create();
    expect(t.api.order()).toEqual([b, x, a]);
    const r = await t.call("split_tabs", { tabIds: [a, b] });
    expect(r.ok).toBe(true);
    expect(t.api.order()).toEqual([x, a, b]);
    expect(t.api.moveCalls).toEqual([{ tabId: b, index: 2 }]);
  });

  test("refuses different groups, windows and pinned states, and the same tab twice", async () => {
    const t = setup();
    const a = await t.create();
    const b = await t.create();
    expect(await t.call("split_tabs", { tabIds: [a, a] })).toMatchObject({ ok: false, error: "bad_args" });
    t.api.tabList.get(b)!.groupId = -1;
    expect(await t.call("split_tabs", { tabIds: [a, b] })).toMatchObject({ ok: false, error: "bad_args", message: expect.stringContaining("different tab groups") });
    t.api.tabList.get(b)!.groupId = t.api.tabList.get(a)!.groupId;
    t.api.tabList.get(b)!.windowId = 2;
    expect(await t.call("split_tabs", { tabIds: [a, b] })).toMatchObject({ ok: false, error: "bad_args", message: expect.stringContaining("different windows") });
    t.api.tabList.get(b)!.windowId = 1;
    t.api.tabList.get(b)!.pinned = true;
    expect(await t.call("split_tabs", { tabIds: [a, b] })).toMatchObject({ ok: false, error: "bad_args", message: expect.stringContaining("pinned") });
    expect(t.api.splitCalls).toHaveLength(0);
    expect(t.api.moveCalls).toHaveLength(0);
  });

  test("the same split again succeeds with the same id; a tab in another split is refused", async () => {
    const t = setup();
    const a = await t.create();
    const b = await t.create();
    const c = await t.create();
    const first = t.json(await t.call("split_tabs", { tabIds: [a, b] }));
    const again = t.json(await t.call("split_tabs", { tabIds: [b, a] }));
    expect(again.splitViewId).toBe(first.splitViewId);
    expect(t.api.splitCalls).toHaveLength(1);
    expect(await t.call("split_tabs", { tabIds: [b, c] })).toMatchObject({ ok: false, error: "bad_args", message: expect.stringContaining("already in another split") });
  });

  test("an old Chrome gives a clear error and moves nothing", async () => {
    const t = setup();
    const a = await t.create();
    t.api.addTab(50);
    const b = await t.create();
    t.api.oldChrome = true;
    const r = await t.call("split_tabs", { tabIds: [a, b] });
    expect(r).toMatchObject({ ok: false, error: "bad_args", message: expect.stringContaining("Split view needs Chrome 155 or later. This Chrome is 140.0.7339.") });
  });
});

describe("unsplit_tabs", () => {
  test("ends a split of own tabs", async () => {
    const t = setup();
    const a = await t.create();
    const b = await t.create();
    const { splitViewId } = t.json(await t.call("split_tabs", { tabIds: [a, b] }));
    const r = await t.call("unsplit_tabs", { tabId: b });
    expect(r.ok).toBe(true);
    expect(t.api.unsplitCalls).toEqual([splitViewId]);
    expect(t.api.tabList.get(a)!.splitViewId).toBe(-1);
    expect(t.api.tabList.get(b)!.splitViewId).toBe(-1);
  });

  test("a tab that is not split is a bad_args error", async () => {
    const t = setup();
    const a = await t.create();
    expect(await t.call("unsplit_tabs", { tabId: a })).toMatchObject({ ok: false, error: "bad_args" });
  });

  test("forbidden when any tab of the split is outside the session", async () => {
    const t = setup();
    const a = await t.create();
    const user = t.api.addTab(60);
    t.api.tabList.get(a)!.splitViewId = user.splitViewId = 77;
    expect(await t.call("unsplit_tabs", { tabId: a })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await t.call("unsplit_tabs", { tabId: 60 })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.unsplitCalls).toHaveLength(0);
  });
});

describe("tabs_create splitWithTabId", () => {
  test("opens a split tab in the session's own group, inactive and owned", async () => {
    const t = setup();
    const a = await t.create();
    const r = await t.call("tabs_create", { url: "https://b.example.com/", splitWithTabId: a });
    expect(r.ok).toBe(true);
    const out = t.json(r);
    const base = t.api.tabList.get(a)!;
    const made = t.api.tabList.get(out.tabId)!;
    expect(made.groupId).toBe(base.groupId);
    expect(made.splitViewId).toBe(base.splitViewId);
    expect(out.splitViewId).toBe(base.splitViewId);
    expect(made.active).toBe(false);
    expect(t.tabs.owns("s1", out.tabId, "alice")).toBe(true);
    expect(t.tabs.sessions.get("s1")!.adopted.has(out.tabId)).toBe(false);
  });

  test("in a granted group the new tab stays in that group and outlives the session", async () => {
    const t = setup();
    const u = t.api.addTab(1);
    const group = await t.api.tabs.group([u.id]);
    await t.call("tabs_context");
    await t.tabs.grant(group, "s1");
    const out = t.json(await t.call("tabs_create", { splitWithTabId: 1 }));
    expect(t.api.tabList.get(out.tabId)!.groupId).toBe(group);
    expect(t.api.tabList.get(out.tabId)!.splitViewId).toBe(t.api.tabList.get(1)!.splitViewId);
    expect(t.tabs.sessions.get("s1")!.adopted.has(out.tabId)).toBe(true);
  });

  test("forbidden for a base tab outside the session; bad_args with groupId; old Chrome error", async () => {
    const t = setup();
    const a = await t.create();
    const theirs = await t.create(S2);
    const user = t.api.addTab(9).id;
    expect(await t.call("tabs_create", { splitWithTabId: theirs })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await t.call("tabs_create", { splitWithTabId: user })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await t.call("tabs_create", { splitWithTabId: a, groupId: 3 })).toMatchObject({ ok: false, error: "bad_args" });
    const before = t.api.tabList.size;
    t.api.oldChrome = true;
    expect(await t.call("tabs_create", { splitWithTabId: a })).toMatchObject({ ok: false, error: "bad_args", message: expect.stringContaining("Chrome 155") });
    expect(t.api.tabList.size).toBe(before);
  });
});

describe("tabs_context and split view", () => {
  test("reports splitViewId only for split tabs", async () => {
    const t = setup();
    const a = await t.create();
    const b = await t.create();
    const c = await t.create();
    const { splitViewId } = t.json(await t.call("split_tabs", { tabIds: [a, b] }));
    const ctx = t.json(await t.call("tabs_context"));
    const by = (id: number) => ctx.sessionTabs.find((x: { tabId: number }) => x.tabId === id);
    expect(by(a).splitViewId).toBe(splitViewId);
    expect(by(b).splitViewId).toBe(splitViewId);
    expect("splitViewId" in by(c)).toBe(false);
  });
});

describe("split tool arguments", () => {
  test("split_tabs needs exactly two tab ids", async () => {
    const t = setup();
    expect(await t.call("split_tabs", { tabIds: [1] })).toMatchObject({ ok: false, error: "bad_args" });
    expect(await t.call("split_tabs", { tabIds: [1, 2, 3] })).toMatchObject({ ok: false, error: "bad_args" });
    expect(await t.call("split_tabs", {})).toMatchObject({ ok: false, error: "bad_args" });
  });
});
