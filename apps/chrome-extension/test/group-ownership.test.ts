import { describe, expect, test } from "bun:test";
import type { BrowserTool, CallRequest } from "../../../src/browser/protocol.ts";
import { Executor } from "../src/background/executor.ts";
import { mergeTabLists } from "../src/background/chrome-api.ts";
import { State } from "../src/background/state.ts";
import { HOLDER_LIVE_MS, SESSION_END_MS, TabManager } from "../src/background/tabs.ts";
import { FakeChrome } from "./fakes.ts";

const A = { id: "sess-a", identity: "alice", label: "Job board" };
const B = { id: "sess-b", identity: "alice", label: "Job board" };
const OTHER_LABEL = { id: "sess-c", identity: "alice", label: "Another chat" };
const OTHER_IDENTITY = { id: "sess-d", identity: "bob", label: "Job board" };
let n = 0;
let clock = 5_000_000;

function setup(api = new FakeChrome()) {
  const tabs = new TabManager(api, () => clock);
  const executor = new Executor({ api, tabs, state: new State(api.storage) });
  const call = (tool: BrowserTool | "session_end", args: Record<string, unknown> = {}, s = A) => executor.run({ id: `g${++n}`, session: s, tool, args } as CallRequest);
  const json = (r: Awaited<ReturnType<typeof call>>) => JSON.parse(r.ok && r.content[0]?.type === "text" ? r.content[0].text : "{}");
  const create = async (s = A, url?: string): Promise<number> => json(await call("tabs_create", url ? { url } : {}, s)).tabId;
  return { api, tabs, executor, call, json, create };
}

const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://jobs.example.com/job/${i}`);

/** Session A opens tabs in its own group and adopts them all. */
async function ownerCase(count = 4) {
  const t = setup();
  const ids: number[] = [];
  for (const u of urls(count)) ids.push(await t.create(A, u));
  for (const id of ids) await t.call("adopt_tab", { tabId: id });
  await t.tabs.refreshAgents();
  return { t, ids };
}

describe("a chat keeps its group", () => {
  test("browser restart with new ids and a new session id: the new session owns the group and can save it", async () => {
    const { t, ids } = await ownerCase();
    const idMap = t.api.restart();
    const moveCalls = t.api.moveCalls.length;
    const activations = t.api.activations.length;
    const created = t.api.createdActive.length;
    const fresh = setup(t.api);
    await fresh.tabs.load();
    const ctx = fresh.json(await fresh.call("tabs_context", {}, B));
    const newIds = ids.map(id => idMap.get(id)!);
    expect(ctx.sessionTabs.map((x: { tabId: number }) => x.tabId)).toEqual(newIds);
    expect(ctx.sessionTabs.every((x: { scope: string }) => x.scope === "own")).toBe(true);
    expect(ctx.otherTabs).toEqual([]);
    expect(ctx.groups).toEqual([{ groupId: t.api.tabList.get(newIds[0]!)!.groupId, title: "Job board", tabCount: 4, scope: "own" }]);
    const saved = await fresh.call("save_group", { name: "Job board" }, B);
    expect(saved.ok).toBe(true);
    expect(fresh.json(saved)).toMatchObject({ tabCount: 4 });
    expect(t.api.tabList.size).toBe(4);
    expect(t.api.moveCalls.length).toBe(moveCalls);
    expect(t.api.activations.length).toBe(activations);
    expect(t.api.createdActive.length).toBe(created);
    expect([...t.api.tabList.keys()].sort()).toEqual([...newIds].sort());
  });

  test("the reclaimed tabs keep their created and adopted flags, so a session end closes only the created ones", async () => {
    const t = setup();
    const created = await t.create(A, "https://jobs.example.com/created");
    const user = t.api.addTab(7, "https://jobs.example.com/mine");
    await t.call("adopt_tab", { tabId: user.id });
    await t.tabs.refreshAgents();
    const idMap = t.api.restart();
    const fresh = setup(t.api);
    await fresh.tabs.load();
    await fresh.call("tabs_context", {}, B);
    await fresh.call("session_end", {}, B);
    expect(t.api.tabList.has(idMap.get(created)!)).toBe(false);
    expect(t.api.tabList.has(idMap.get(user.id)!)).toBe(true);
    expect(t.api.tabList.get(idMap.get(user.id)!)!.groupId).toBe(-1);
  });

  test("a new session id with the same label reclaims the group without a browser restart once the old session went quiet", async () => {
    const { t, ids } = await ownerCase();
    await t.call("tabs_context", {}, A);
    clock += HOLDER_LIVE_MS + 1000;
    const before = t.api.tabList.get(ids[0]!)!.groupId;
    const ctx = t.json(await t.call("tabs_context", {}, B));
    expect(ctx.sessionTabs.map((x: { tabId: number }) => x.tabId)).toEqual(ids);
    expect(t.tabs.sessions.get("sess-b")!.groupId).toBe(before);
    expect(t.tabs.sessions.get("sess-a")?.tabIds.size ?? 0).toBe(0);
    expect(t.api.tabList.size).toBe(4);
  });

  test("an expired session no longer blocks the same chat", async () => {
    const { t, ids } = await ownerCase();
    await t.call("tabs_context", {}, A);
    clock += SESSION_END_MS + 1000;
    t.tabs.expireIdle();
    expect(t.json(await t.call("tabs_context", {}, B)).sessionTabs.length).toBe(ids.length);
  });

  test("a live session with the same label keeps its group: no steal", async () => {
    const { t, ids } = await ownerCase();
    await t.call("tabs_context", {}, A); // A is live
    const ctx = t.json(await t.call("tabs_context", {}, B));
    expect(ctx.sessionTabs).toEqual([]);
    expect(ctx.otherTabs).toEqual([]); // the tabs stay A's
    expect(t.tabs.owns("sess-a", ids[0]!, "alice")).toBe(true);
  });

  test("a different label or a different identity does not reclaim", async () => {
    const { t, ids } = await ownerCase();
    const idMap = t.api.restart();
    const fresh = setup(t.api);
    await fresh.tabs.load();
    expect(fresh.json(await fresh.call("tabs_context", {}, OTHER_LABEL)).sessionTabs).toEqual([]);
    expect(fresh.json(await fresh.call("tabs_context", {}, OTHER_IDENTITY)).sessionTabs).toEqual([]);
    const adopt = await fresh.call("save_group", { name: "x" }, OTHER_IDENTITY);
    expect(adopt.ok).toBe(false);
    expect(fresh.tabs.ownerOf(idMap.get(ids[0]!)!)).toBeUndefined();
  });

  test("a user group with the same title but other URLs is not claimed", async () => {
    const { t } = await ownerCase();
    t.api.restart();
    // The restored agent group is gone; the user has a group with the same title and other URLs.
    for (const id of [...t.api.tabList.keys()]) t.api.closeTab(id);
    t.api.groups.clear();
    const u1 = t.api.addTab(901, "https://elsewhere.example.com/1");
    const u2 = t.api.addTab(902, "https://elsewhere.example.com/2");
    const g = await t.api.tabs.group([u1.id, u2.id]);
    t.api.groups.set(g, { title: "Job board", color: "red" });
    const fresh = setup(t.api);
    await fresh.tabs.load();
    expect(fresh.json(await fresh.call("tabs_context", {}, B)).sessionTabs).toEqual([]);
    expect(fresh.tabs.ownerOf(901)).toBeUndefined();
  });

  test("a group that a saved group or a grant claims is not reclaimed", async () => {
    const { t, ids } = await ownerCase();
    await t.call("save_group", { name: "Job board" }); // the record gives way to the saved group
    clock += SESSION_END_MS + 1000;
    t.tabs.expireIdle();
    expect(await t.tabs.reclaim(B)).toBe(false);
    expect(t.api.store.agentGroups).toEqual([]);
    expect(ids.length).toBe(4);
  });

  test("the record never shrinks while the group closes", async () => {
    const { t, ids } = await ownerCase();
    for (const id of ids.slice(0, 3)) t.api.closeTab(id);
    await t.tabs.refreshAgents();
    clock += 2000;
    await t.tabs.refreshAgents();
    expect((t.api.store.agentGroups as Array<{ tabs: unknown[] }>)[0]!.tabs.length).toBe(4);
    t.api.closeTab(ids[3]!);
    clock += 60_000;
    await t.tabs.refreshAgents();
    expect((t.api.store.agentGroups as Array<{ tabs: unknown[] }>)[0]!.tabs.length).toBe(4);
  });

  test("a session end by the agent drops the record", async () => {
    const { t } = await ownerCase();
    await t.call("session_end");
    expect(t.api.store.agentGroups).toEqual([]);
  });

  test("lazy session restore: the group links when the tabs finish loading", async () => {
    const { t, ids } = await ownerCase();
    const idMap = t.api.restart();
    const newIds = ids.map(id => idMap.get(id)!);
    const real = newIds.map(id => t.api.tabList.get(id)!.url);
    for (const id of newIds) t.api.tabList.get(id)!.url = ""; // still loading
    const fresh = setup(t.api);
    await fresh.tabs.load();
    expect(fresh.json(await fresh.call("tabs_context", {}, B)).sessionTabs).toEqual([]);
    newIds.forEach((id, i) => { t.api.tabList.get(id)!.url = real[i]!; });
    fresh.tabs.tabUpdated({ status: "complete" });
    await Bun.sleep(900);
    const ctx = fresh.json(await fresh.call("tabs_context", {}, B));
    expect(ctx.sessionTabs.map((x: { tabId: number }) => x.tabId)).toEqual(newIds);
  });

  test("a saved group links after its tabs finish loading", async () => {
    const t = setup();
    const a = await t.create(A, "https://a.example.com/");
    const b = await t.create(A, "https://b.example.com/");
    await t.call("save_group", { name: "docs" });
    const idMap = t.api.restart();
    const newIds = [a, b].map(id => idMap.get(id)!);
    for (const id of newIds) t.api.tabList.get(id)!.url = "";
    const fresh = setup(t.api);
    await fresh.tabs.load();
    expect(await fresh.tabs.savedGroups()).toEqual([{ name: "docs", groupId: -1, open: false, tabCount: 2 }]);
    t.api.tabList.get(newIds[0]!)!.url = "https://a.example.com/";
    t.api.tabList.get(newIds[1]!)!.url = "https://b.example.com/";
    fresh.tabs.tabUpdated({ url: "https://b.example.com/" });
    await Bun.sleep(900);
    const gid = t.api.tabList.get(newIds[0]!)!.groupId;
    expect(await fresh.tabs.savedGroups()).toEqual([{ name: "docs", groupId: gid, open: true, tabCount: 2 }]);
  });
});

describe("tabs_context lists every tab and group", () => {
  test("a split pair lists both tabs", async () => {
    const t = setup();
    const a = t.api.addTab(1, "https://a.example.com/", "A", { splitViewId: 9 });
    const b = t.api.addTab(2, "https://b.example.com/", "B", { splitViewId: 9 });
    const ctx = t.json(await t.call("tabs_context"));
    expect(ctx.otherTabs.map((x: { tabId: number }) => x.tabId)).toEqual([a.id, b.id]);
    expect(ctx.otherTabs.every((x: { splitViewId: number }) => x.splitViewId === 9)).toBe(true);
  });

  test("100 tabs in 50 split pairs are all listed", async () => {
    const t = setup();
    for (let i = 0; i < 50; i++) {
      t.api.addTab(1000 + 2 * i, `https://jobs.example.com/${i}`, "job", { splitViewId: i + 1 });
      t.api.addTab(1001 + 2 * i, `https://posts.example.com/${i}`, "post", { splitViewId: i + 1 });
    }
    const ctx = t.json(await t.call("tabs_context"));
    expect(ctx.otherTabs.length).toBe(100);
  });

  test("the real query merges the window lists, so no tab hides another", () => {
    const mk = (id: number) => ({ id, windowId: 1, groupId: -1, url: "", title: "", active: false, splitViewId: -1, index: id, pinned: false });
    expect(mergeTabLists([mk(1), mk(3)], [mk(1), mk(2), mk(3), mk(4)]).map(x => x.id)).toEqual([1, 3, 2, 4]);
    expect(mergeTabLists([mk(-1), mk(-1)]).length).toBe(0);
  });

  test("every tab shows its groupId and groups lists all open groups with their scope", async () => {
    const t = setup();
    const own = await t.create(A, "https://a.example.com/");
    const u1 = t.api.addTab(1, "https://user.example.com/1");
    const u2 = t.api.addTab(2, "https://user.example.com/2", "T", 2);
    const g1 = await t.api.tabs.group([u1.id]);
    t.api.groups.set(g1, { title: "Reading", color: "red" });
    const g2 = await t.api.tabs.group([u2.id]);
    t.api.groups.set(g2, { title: "Other window", color: "blue" });
    const free = t.api.addTab(3, "https://free.example.com/");
    const ctx = t.json(await t.call("tabs_context"));
    const ownGroup = t.api.tabList.get(own)!.groupId;
    expect(ctx.groups).toEqual([
      { groupId: ownGroup, title: "Job board", tabCount: 1, scope: "own" },
      { groupId: g1, title: "Reading", tabCount: 1, scope: "other" },
      { groupId: g2, title: "Other window", tabCount: 1, scope: "other" },
    ]);
    const group = (id: number) => [...ctx.sessionTabs, ...ctx.otherTabs].find((x: { tabId: number }) => x.tabId === id).groupId;
    expect(group(own)).toBe(ownGroup);
    expect(group(u1.id)).toBe(g1);
    expect(group(free.id)).toBe(-1);
    expect(await t.tabs.grant(g1, "sess-a")).toBe("ok");
    await t.call("save_group", { name: "kept" });
    const again = t.json(await t.call("tabs_context"));
    expect(again.groups.find((x: { groupId: number }) => x.groupId === g1).scope).toBe("granted");
    expect(again.groups.find((x: { groupId: number }) => x.groupId === ownGroup).scope).toBe("granted"); // saved and held by this session
  });
});

describe("legacy reclaim of a group without a record", () => {
  const LEGACY = { id: "sess-l", identity: "alice", label: "ContractFinder" };
  async function legacyGroup(title = "ContractFinder", count = 4, from = 1) {
    const t = setup();
    const ids: number[] = [];
    for (let i = 0; i < count; i++) ids.push(t.api.addTab(from + i, `https://jobs.example.com/${title}/${i}`).id);
    const gid = await t.api.tabs.group(ids);
    t.api.groups.set(gid, { title, color: "blue" });
    return { t, ids, gid };
  }

  test("a new session with the label takes the group as adopted tabs, saves it and leaves the tabs alone", async () => {
    const { t, ids, gid } = await legacyGroup();
    const ctx = t.json(await t.call("tabs_context", {}, LEGACY));
    expect(ctx.sessionTabs.map((x: { tabId: number }) => x.tabId)).toEqual(ids);
    expect(ctx.groups).toEqual([{ groupId: gid, title: "ContractFinder", tabCount: 4, scope: "own" }]);
    expect((t.api.store.agentGroups as Array<{ tabs: Array<{ adopted: boolean }> }>)[0]!.tabs.every(x => x.adopted)).toBe(true);
    expect(t.api.moveCalls).toEqual([]);
    expect(t.api.activations).toEqual([]);
    expect(t.api.createdActive).toEqual([]);
    expect((await t.call("save_group", { name: "ContractFinder" }, LEGACY)).ok).toBe(true);
  });

  test("a session end closes no tab of the adopted group", async () => {
    const { t, ids, gid } = await legacyGroup();
    await t.call("tabs_context", {}, LEGACY);
    await t.call("session_end", {}, LEGACY);
    expect(t.api.tabList.size).toBe(ids.length);
    for (const id of ids) expect(t.api.tabList.get(id)!.groupId).toBe(-1);
    expect(gid).toBeGreaterThan(0);
  });

  test("two groups with the same title: no reclaim", async () => {
    const { t, ids } = await legacyGroup();
    const x = t.api.addTab(50, "https://other.example.com/");
    t.api.groups.set(await t.api.tabs.group([x.id]), { title: "ContractFinder", color: "red" });
    expect(t.json(await t.call("tabs_context", {}, LEGACY)).sessionTabs).toEqual([]);
    expect(t.tabs.ownerOf(ids[0]!)).toBeUndefined();
  });

  test("a granted or saved group is not reclaimed", async () => {
    const granted = await legacyGroup();
    await granted.t.call("tabs_context", {}, OTHER_LABEL);
    expect(await granted.t.tabs.grant(granted.gid, "sess-c")).toBe("ok");
    expect(granted.t.json(await granted.t.call("tabs_context", {}, LEGACY)).sessionTabs).toEqual([]);
    const s = setup();
    const a = await s.create(OTHER_LABEL, "https://a.example.com/");
    await s.call("save_group", { name: "ContractFinder" }, OTHER_LABEL);
    expect(s.json(await s.call("tabs_context", {}, LEGACY)).sessionTabs).toEqual([]);
    expect(s.tabs.ownerOf(a)).toBe("sess-c");
  });

  test("a different label does not reclaim", async () => {
    const { t } = await legacyGroup();
    expect(t.json(await t.call("tabs_context", {}, OTHER_LABEL)).sessionTabs).toEqual([]);
  });

  test("a session that has its own group does not take another", async () => {
    const { t, ids } = await legacyGroup();
    await t.create({ ...LEGACY, label: "Mine" }, "https://mine.example.com/");
    await t.call("tabs_context", LEGACY.id === "" ? {} : {}, LEGACY); // same session id, now labelled like the legacy group
    expect(t.tabs.ownerOf(ids[0]!)).toBeUndefined();
  });
});
