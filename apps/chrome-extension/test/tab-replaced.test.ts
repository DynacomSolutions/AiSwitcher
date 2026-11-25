import { describe, expect, test } from "bun:test";
import type { BrowserTool, CallRequest } from "../../../src/browser/protocol.ts";
import { Executor } from "../src/background/executor.ts";
import { State } from "../src/background/state.ts";
import { TabManager } from "../src/background/tabs.ts";
import { FakeChrome } from "./fakes.ts";

const AG = { id: "agent-1", identity: "alice", label: "ContractFinder" };
let n = 0;
let clock = 9_000_000;

function setup() {
  const api = new FakeChrome();
  const tabs = new TabManager(api, () => clock);
  const state = new State(api.storage);
  const executor = new Executor({ api, tabs, state });
  const call = (tool: BrowserTool | "session_end", args: Record<string, unknown> = {}, s: Record<string, unknown> = AG) => executor.run({ id: `r${++n}`, session: s, tool, args } as CallRequest);
  const json = (r: Awaited<ReturnType<typeof call>>) => JSON.parse(r.ok && r.content[0]?.type === "text" ? r.content[0].text : "{}");
  return { api, tabs, state, executor, call, json };
}

const sessionTabIds = async (t: ReturnType<typeof setup>): Promise<number[]> => t.json(await t.call("tabs_context")).sessionTabs.map((x: { tabId: number }) => x.tabId);

describe("tabs.onReplaced", () => {
  test("an own tab that Chrome replaces stays own, and close_tab works on the new id", async () => {
    const t = setup();
    const a = await t.tabs.create(AG, "https://a.example.com/");
    const b = await t.tabs.create(AG, "https://b.example.com/");
    const fresh = t.api.replaceTab(a.id);
    expect((await sessionTabIds(t)).sort()).toEqual([b.id, fresh].sort());
    const ctx = t.json(await t.call("tabs_context"));
    expect(ctx.otherTabs.map((x: { tabId: number }) => x.tabId)).not.toContain(fresh);
    expect(t.tabs.sessions.get("agent-1")!.tabIds.has(a.id)).toBe(false);
    expect((await t.call("close_tab", { tabId: fresh })).ok).toBe(true);
    expect(t.api.tabList.has(fresh)).toBe(false);
  });

  test("the debugger of the old id is marked detached, so the next call attaches again", async () => {
    const t = setup();
    const a = await t.tabs.create(AG, "https://a.example.com/");
    expect((await t.call("read_page", { tabId: a.id })).ok).toBe(true);
    expect(t.executor.attachedTabIds()).toEqual([a.id]);
    const fresh = t.api.replaceTab(a.id);
    expect(t.executor.attachedTabIds()).toEqual([]);
    expect((await t.call("read_page", { tabId: fresh })).ok).toBe(true);
    expect(t.executor.attachedTabIds()).toEqual([fresh]);
  });

  test("adopted and approved flags move to the new id", async () => {
    const t = setup();
    const a = await t.tabs.create(AG, "https://a.example.com/");
    const user = t.api.addTab(50, "https://user.example.com/");
    expect((await t.call("adopt_tab", { tabId: user.id })).ok).toBe(true);
    const s = t.tabs.sessions.get("agent-1")!;
    s.approved = new Set([user.id]);
    const fresh = t.api.replaceTab(user.id);
    expect(s.tabIds.has(fresh)).toBe(true);
    expect(s.adopted.has(fresh)).toBe(true);
    expect(s.approved.has(fresh)).toBe(true);
    expect([...s.tabIds, ...s.adopted, ...s.approved]).not.toContain(user.id);
    expect(s.adopted.has(a.id)).toBe(false);
    const stored = (t.api.session.sessions as Array<{ tabIds: number[]; adoptedTabIds: number[]; approvedTabIds: number[] }>)[0]!;
    expect(stored.tabIds).toContain(fresh);
    expect(stored.adoptedTabIds).toEqual([fresh]);
    expect(stored.approvedTabIds).toEqual([fresh]);
  });

  test("the saved group gets the new id", async () => {
    const t = setup();
    const a = await t.tabs.create(AG, "https://a.example.com/");
    await t.tabs.create(AG, "https://b.example.com/");
    expect((await t.call("save_group", { name: "kept" })).ok).toBe(true);
    const fresh = t.api.replaceTab(a.id);
    await Bun.sleep(5);
    const saved = t.api.store.savedGroups as Array<{ tabIds: number[] }>;
    expect(saved[0]!.tabIds).toContain(fresh);
    expect(saved[0]!.tabIds).not.toContain(a.id);
  });

  test("the agent record gets the new id", async () => {
    const t = setup();
    const a = await t.tabs.create(AG, "https://a.example.com/");
    await t.tabs.create(AG, "https://b.example.com/");
    await t.tabs.refreshAgents();
    const before = t.api.store.agentGroups as Array<{ tabs: Array<{ id: number }> }>;
    expect(before[0]!.tabs.map(x => x.id)).toContain(a.id);
    const fresh = t.api.replaceTab(a.id);
    await Bun.sleep(5);
    const ids = (t.api.store.agentGroups as Array<{ tabs: Array<{ id: number }> }>)[0]!.tabs.map(x => x.id);
    expect(ids).toContain(fresh);
    expect(ids).not.toContain(a.id);
  });

  test("a tab of a granted group stays usable", async () => {
    const t = setup();
    await t.tabs.create(AG, "https://a.example.com/");
    const ids = [t.api.addTab(60).id, t.api.addTab(61).id];
    const gid = await t.api.tabs.group(ids);
    t.api.groups.set(gid, { title: "Shared", color: "blue" });
    expect(await t.tabs.grant(gid, "agent-1")).toBe("ok");
    const fresh = t.api.replaceTab(ids[0]!);
    const ctx = t.json(await t.call("tabs_context"));
    const granted = ctx.sessionTabs.filter((x: { scope?: string }) => x.scope === "granted").map((x: { tabId: number }) => x.tabId);
    expect(granted).toContain(fresh);
    expect(t.tabs.grantedGroups("agent-1")).toEqual([gid]);
    expect((await t.call("read_page", { tabId: fresh })).ok).toBe(true);
  });

  test("a chat link moves to the new id", async () => {
    const t = setup();
    const a = t.api.addTab(70);
    t.tabs.setChatLinks("chat:a", [a.id], true);
    const fresh = t.api.replaceTab(a.id);
    expect(t.tabs.chatLinks("chat:a")).toEqual([fresh]);
    expect((t.api.session.chatLinks as Array<{ tabIds: number[] }>)[0]!.tabIds).toEqual([fresh]);
  });

  test("onRemoved of the old id right after onReplaced does not drop the tab", async () => {
    const t = setup();
    const a = await t.tabs.create(AG, "https://a.example.com/");
    const fresh = t.api.replaceTab(a.id);
    for (const l of t.api.removedListeners) l(a.id);
    expect(await sessionTabIds(t)).toEqual([fresh]);
  });

  test("onRemoved of the old id just before onReplaced does not lose the tab", async () => {
    const t = setup();
    const a = await t.tabs.create(AG, "https://a.example.com/");
    const b = await t.tabs.create(AG, "https://b.example.com/");
    t.tabs.setChatLinks("chat:a", [a.id], true);
    const old = t.api.tabList.get(a.id)!;
    const fresh = t.api.nextTab++;
    for (const l of t.api.removedListeners) l(a.id);
    t.api.tabList.delete(a.id);
    t.api.tabList.set(fresh, { ...old, id: fresh });
    for (const l of t.api.replacedListeners) l(fresh, a.id);
    expect(await sessionTabIds(t)).toEqual([b.id, fresh]);
    expect(t.tabs.chatLinks("chat:a")).toEqual([fresh]);
  });

  test("a real removal later still drops the tab", async () => {
    const t = setup();
    const a = await t.tabs.create(AG, "https://a.example.com/");
    const b = await t.tabs.create(AG, "https://b.example.com/");
    const fresh = t.api.replaceTab(a.id);
    clock += 5000;
    t.api.closeTab(fresh);
    expect(await sessionTabIds(t)).toEqual([b.id]);
  });

  test("an unknown old id does nothing", async () => {
    const t = setup();
    const a = await t.tabs.create(AG, "https://a.example.com/");
    const stray = t.api.addTab(80);
    const owned = () => JSON.stringify({ sessions: t.api.session.sessions, grants: t.api.session.grants, chatLinks: t.api.session.chatLinks }); // the call times change with every call
    const before = owned();
    t.api.replaceTab(stray.id);
    expect(await sessionTabIds(t)).toEqual([a.id]);
    expect(owned()).toBe(before);
    expect(t.tabs.ownerOf(80)).toBeUndefined();
  });

  test("a replace that names a tab of another session as the added tab does nothing", async () => {
    const t = setup();
    const a = await t.tabs.create(AG, "https://a.example.com/");
    const other = { id: "agent-2", identity: "alice", label: "Other" };
    const b = await t.tabs.create(other, "https://b.example.com/");
    const before = JSON.stringify(t.api.session);
    for (const l of t.api.replacedListeners) l(b.id, a.id);
    expect(t.tabs.sessions.get("agent-1")!.tabIds.has(a.id)).toBe(true);
    expect(t.tabs.sessions.get("agent-1")!.tabIds.has(b.id)).toBe(false);
    expect(t.tabs.ownerOf(b.id)).toBe("agent-2");
    expect(JSON.stringify(t.api.session)).toBe(before);
  });

  test("closing an own tab and then a replace into a known user tab does not give the user tab away", async () => {
    const t = setup();
    const x = await t.tabs.create(AG, "https://a.example.com/");
    const user = t.api.addTab(90, "https://user.example.com/");
    await t.api.tabs.query(); // the manager has seen the user tab
    for (const l of t.api.createdListeners) l({ ...user });
    await sessionTabIds(t);
    t.api.closeTab(x.id);
    for (const l of t.api.replacedListeners) l(user.id, x.id);
    expect(t.tabs.ownerOf(user.id)).toBeUndefined();
    expect(await sessionTabIds(t)).toEqual([]);
  });
});
