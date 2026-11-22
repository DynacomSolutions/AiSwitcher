import { describe, expect, test } from "bun:test";
import type { BrowserTool, CallRequest } from "../../../src/browser/protocol.ts";
import { Executor } from "../src/background/executor.ts";
import { State } from "../src/background/state.ts";
import { TabManager } from "../src/background/tabs.ts";
import { FakeChrome } from "./fakes.ts";

const S1 = { id: "s1", identity: "alice", label: "chat one" };
const S2 = { id: "s2", identity: "alice", label: "chat two" };
let n = 0;

function setup(api = new FakeChrome()) {
  const tabs = new TabManager(api);
  const executor = new Executor({ api, tabs, state: new State(api.storage) });
  const call = (tool: BrowserTool | "session_end", args: Record<string, unknown> = {}, s = S1) => executor.run({ id: `c${++n}`, session: s, tool, args } as CallRequest);
  const json = (r: Awaited<ReturnType<typeof call>>) => JSON.parse(r.ok && r.content[0]?.type === "text" ? r.content[0].text : "{}");
  const create = async (s = S1, args: Record<string, unknown> = {}): Promise<number> => json(await call("tabs_create", args, s)).tabId;
  return { api, tabs, executor, call, json, create };
}

describe("save_group", () => {
  test("saving the own group keeps every tab open and grouped with the new title after session end", async () => {
    const t = setup();
    const ids = [await t.create(), await t.create(), await t.create()];
    const before = t.api.tabList.get(ids[0]!)!.groupId;
    const r = await t.call("save_group", { name: "ContractFinder" });
    expect(r.ok).toBe(true);
    expect(t.json(r)).toMatchObject({ name: "ContractFinder", groupId: before, tabCount: 3 });
    expect(t.api.groups.get(before)!.title).toBe("ContractFinder");
    await t.call("session_end");
    for (const id of ids) expect(t.api.tabList.get(id)!.groupId).toBe(before);
    expect(t.api.tabList.size).toBe(3);
    expect(t.api.groups.get(before)!.title).toBe("ContractFinder");
  });

  test("an unsaved group still closes at session end", async () => {
    const t = setup();
    await t.create();
    await t.call("session_end");
    expect(t.api.tabList.size).toBe(0);
  });

  test("after saving, the session gets a fresh own group and the saved group is not re-adopted by title", async () => {
    const t = setup();
    const a = await t.create();
    const saved = t.api.tabList.get(a)!.groupId;
    await t.call("save_group", { name: "chat one" }); // same title as the session label
    const b = await t.create();
    expect(t.api.tabList.get(b)!.groupId).not.toBe(saved);
    await t.call("session_end");
    expect(t.api.tabList.has(a)).toBe(true);
    expect(t.api.tabList.has(b)).toBe(false);
  });

  test("saving a granted group keeps the user's title and ends with the group intact", async () => {
    const t = setup();
    const u1 = t.api.addTab(1);
    const u2 = t.api.addTab(2);
    const group = await t.api.tabs.group([u1.id, u2.id]);
    t.api.groups.set(group, { title: "Reading", color: "red" });
    await t.call("tabs_context");
    expect(await t.tabs.grant(group, "s1")).toBe("ok");
    const r = await t.call("save_group", { name: "reads", groupId: group });
    expect(r.ok).toBe(true);
    expect(t.api.groups.get(group)!.title).toBe("Reading");
    expect((await t.tabs.savedGroups())).toEqual([{ name: "reads", groupId: group, open: true, tabCount: 2 }]);
    await t.call("session_end");
    expect(t.api.tabList.size).toBe(2);
  });

  test("a group that is not granted to the session is forbidden", async () => {
    const t = setup();
    await t.create();
    const other = await t.create(S2);
    const otherGroup = t.api.tabList.get(other)!.groupId;
    const user = t.api.addTab(9);
    const userGroup = await t.api.tabs.group([user.id]);
    expect(await t.call("save_group", { name: "x", groupId: otherGroup })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await t.call("save_group", { name: "x", groupId: userGroup })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.groups.get(otherGroup)!.title).toBe("chat two");
    expect(await t.tabs.savedGroups()).toEqual([]);
  });

  test("without a group of its own, save_group is bad_args", async () => {
    const t = setup();
    await t.call("tabs_context");
    expect(await t.call("save_group", { name: "x" })).toMatchObject({ ok: false, error: "bad_args" });
  });

  test("a name that belongs to another open group fails; the same group may save again", async () => {
    const t = setup();
    await t.create();
    await t.create(S2);
    expect((await t.call("save_group", { name: "docs" })).ok).toBe(true);
    expect(await t.call("save_group", { name: "docs" }, S2)).toMatchObject({ ok: false, error: "bad_args" });
    expect(t.api.groups.get(t.api.tabList.get(101)!.groupId)!.title).toBe("chat two");
    const again = await t.call("save_group", { name: "docs", groupId: t.api.tabList.get(100)!.groupId });
    expect(again.ok).toBe(true);
    expect(await t.tabs.savedGroups()).toHaveLength(1);
  });

  test("an empty name is bad_args", async () => {
    const t = setup();
    await t.create();
    expect(await t.call("save_group", { name: "  " })).toMatchObject({ ok: false, error: "bad_args" });
  });

  test("adopt_tab refuses a tab of an open saved group", async () => {
    const t = setup();
    const a = await t.create();
    await t.call("save_group", { name: "docs" });
    await t.call("session_end");
    expect(await t.call("adopt_tab", { tabId: a }, S2)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.tabList.get(a)!.groupId).not.toBe(-1);
  });
});

describe("open_group", () => {
  test("an open group is granted to the session; a live holder blocks another session", async () => {
    const t = setup();
    const a = await t.create();
    await t.call("save_group", { name: "docs" });
    await t.call("tabs_context", {}, S2);
    expect(await t.call("open_group", { name: "docs" }, S2)).toMatchObject({ ok: false, error: "forbidden_tab" });
    await t.call("session_end"); // s1 gone: the group is free
    const r = await t.call("open_group", { name: "docs" }, S2);
    expect(r.ok).toBe(true);
    expect(t.json(r).tabs.map((x: { tabId: number }) => x.tabId)).toEqual([a]);
    expect(t.tabs.grantee(t.json(r).groupId)).toBe("s2");
    expect(t.api.createdActive).toHaveLength(1);
  });

  test("a closed group is recreated inactive, in order, with title, colour and split pairs", async () => {
    const t = setup();
    const ids = [await t.create(S1, { url: "https://a.example.com/" }), await t.create(S1, { url: "https://b.example.com/" }), await t.create(S1, { url: "https://c.example.com/" }), await t.create(S1, { url: "https://d.example.com/" })];
    await t.call("split_tabs", { tabIds: [ids[0]!, ids[1]!] });
    await t.call("split_tabs", { tabIds: [ids[2]!, ids[3]!] });
    const saved = t.json(await t.call("save_group", { name: "pairs" }));
    t.api.groups.set(saved.groupId, { title: "pairs", color: "green" });
    await t.call("save_group", { name: "pairs", groupId: saved.groupId });
    await t.call("session_end");
    for (const id of ids) t.api.closeTab(id); // the user closed the group
    expect(await t.tabs.savedGroups()).toEqual([{ name: "pairs", groupId: -1, open: false, tabCount: 4 }]);
    const activeBefore = t.api.activations.length;
    const r = await t.call("open_group", { name: "pairs" }, S2);
    expect(r.ok).toBe(true);
    const out = t.json(r);
    expect(out.tabs.map((x: { url: string }) => x.url)).toEqual(["https://a.example.com/", "https://b.example.com/", "https://c.example.com/", "https://d.example.com/"]);
    expect(out.groupId).not.toBe(saved.groupId);
    expect(t.api.groups.get(out.groupId)).toEqual({ title: "pairs", color: "green" });
    const [a, b, c, d] = out.tabs;
    expect(a.splitViewId).toBe(b.splitViewId);
    expect(c.splitViewId).toBe(d.splitViewId);
    expect(a.splitViewId).not.toBe(c.splitViewId);
    expect(t.api.order()).toEqual(out.tabs.map((x: { tabId: number }) => x.tabId));
    expect([...t.api.tabList.values()].every(x => !x.active)).toBe(true);
    expect(t.api.activations.length).toBe(activeBefore);
    expect(t.tabs.grantee(out.groupId)).toBe("s2");
    // The reopened group outlives the new session too.
    await t.call("session_end", {}, S2);
    expect(t.api.tabList.size).toBe(4);
    expect(await t.tabs.savedGroups()).toEqual([{ name: "pairs", groupId: out.groupId, open: true, tabCount: 4 }]);
  });

  test("without split support the tabs open and a warning is returned", async () => {
    const t = setup();
    const a = await t.create();
    const b = await t.create();
    await t.call("split_tabs", { tabIds: [a, b] });
    await t.call("save_group", { name: "p" });
    await t.call("session_end");
    t.api.closeTab(a);
    t.api.closeTab(b);
    t.api.oldChrome = true;
    const r = await t.call("open_group", { name: "p" }, S2);
    expect(r.ok).toBe(true);
    expect(t.json(r).tabs).toHaveLength(2);
    expect(t.json(r).warnings[0]).toContain("Split views were not restored");
  });

  test("an unknown name is bad_args", async () => {
    const t = setup();
    expect(await t.call("open_group", { name: "nope" })).toMatchObject({ ok: false, error: "bad_args" });
  });
});

describe("forget_group", () => {
  test("deletes the snapshot, revokes the grant and closes nothing", async () => {
    const t = setup();
    const a = await t.create();
    const gid = t.api.tabList.get(a)!.groupId;
    await t.call("save_group", { name: "docs" });
    const r = await t.call("forget_group", { name: "docs" });
    expect(t.json(r)).toMatchObject({ forgotten: true, open: true });
    expect(t.tabs.grantee(gid)).toBeUndefined();
    expect(await t.tabs.savedGroups()).toEqual([]);
    expect(t.api.tabList.has(a)).toBe(true);
    expect(await t.call("forget_group", { name: "docs" })).toMatchObject({ ok: false, error: "bad_args" });
  });

  test("another live session holding the group blocks forget_group", async () => {
    const t = setup();
    await t.create();
    await t.call("save_group", { name: "docs" });
    await t.call("tabs_context", {}, S2);
    expect(await t.call("forget_group", { name: "docs" }, S2)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await t.tabs.savedGroups()).toHaveLength(1);
  });
});

describe("tabs_context and persistence", () => {
  test("tabs_context lists savedGroups, shared across sessions", async () => {
    const t = setup();
    await t.create();
    await t.call("save_group", { name: "docs" });
    const ctx = t.json(await t.call("tabs_context", {}, S2));
    expect(ctx.savedGroups).toEqual([{ name: "docs", groupId: t.api.tabList.get(100)!.groupId, open: true, tabCount: 1 }]);
    expect(ctx.sessionTabs).toEqual([]);
  });

  test("refreshSaved follows tab changes; closing every tab keeps the last snapshot", async () => {
    const t = setup();
    const a = await t.create(S1, { url: "https://a.example.com/" });
    await t.call("save_group", { name: "docs" });
    const gid = t.api.tabList.get(a)!.groupId;
    const b = await t.create(S1, { groupId: gid, url: "https://b.example.com/" });
    t.api.tabList.get(a)!.url = "https://a2.example.com/";
    await t.tabs.refreshSaved();
    expect((t.api.store.savedGroups as Array<{ tabs: Array<{ url: string }> }>)[0]!.tabs.map(x => x.url)).toEqual(["https://a2.example.com/", "https://b.example.com/"]);
    t.api.closeTab(a);
    t.api.closeTab(b);
    await t.tabs.refreshSaved();
    expect((t.api.store.savedGroups as Array<{ tabs: unknown[] }>)[0]!.tabs).toHaveLength(2);
    expect(await t.tabs.savedGroups()).toEqual([{ name: "docs", groupId: -1, open: false, tabCount: 2 }]);
  });
});

describe("persistence", () => {
  test("a new TabManager loads the saved group as open when the group is still there", async () => {
    const t = setup();
    await t.create();
    await t.call("save_group", { name: "docs" });
    const again = new TabManager(t.api);
    await again.load();
    expect(await again.savedGroups()).toEqual([{ name: "docs", groupId: t.api.tabList.get(100)!.groupId, open: true, tabCount: 1 }]);
  });

  test("after a browser restart the old group id is invalid and the group counts as closed", async () => {
    const t = setup();
    const a = await t.create(S1, { url: "https://a.example.com/" });
    await t.call("save_group", { name: "docs" });
    // Browser restart: tabs and groups are new, storage.local stays, storage.session is empty.
    t.api.closeTab(a);
    t.api.session = {};
    t.api.groups.clear();
    t.api.nextGroup = 1;
    t.api.nextTab = 500;
    const other = t.api.addTab(5, "https://other.example.com/");
    t.api.tabList.get(other.id)!.groupId = await t.api.tabs.group([other.id]); // a new group that reuses the old group id
    const fresh = setup(t.api);
    await fresh.tabs.load();
    expect(await fresh.tabs.savedGroups()).toEqual([{ name: "docs", groupId: -1, open: false, tabCount: 1 }]);
    const r = await fresh.call("open_group", { name: "docs" }, S2);
    expect(r.ok).toBe(true);
    expect(fresh.json(r).tabs.map((x: { url: string }) => x.url)).toEqual(["https://a.example.com/"]);
    expect(t.api.tabList.get(other.id)!.groupId).not.toBe(fresh.json(r).groupId);
  });
});
