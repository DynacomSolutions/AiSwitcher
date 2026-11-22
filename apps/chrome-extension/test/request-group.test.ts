import { describe, expect, test } from "bun:test";
import type { BrowserTool, CallRequest } from "../../../src/browser/protocol.ts";
import { Executor } from "../src/background/executor.ts";
import { State } from "../src/background/state.ts";
import { TabManager } from "../src/background/tabs.ts";
import { FakeChrome } from "./fakes.ts";

const AG = { id: "agent-1", identity: "alice", label: "ContractFinder" };
const OTHER = { id: "agent-2", identity: "alice", label: "Another chat" };
let n = 0;
const clock = 9_000_000;

function setup(api = new FakeChrome(), groupPromptMs = 120_000) {
  const tabs = new TabManager(api, () => clock);
  const state = new State(api.storage);
  const executor = new Executor({ api, tabs, state, groupPromptMs });
  const call = (tool: BrowserTool | "session_end", args: Record<string, unknown> = {}, s: Record<string, unknown> = AG, id = `r${++n}`) => executor.run({ id, session: s, tool, args } as CallRequest);
  const json = (r: Awaited<ReturnType<typeof call>>) => JSON.parse(r.ok && r.content[0]?.type === "text" ? r.content[0].text : "{}");
  return { api, tabs, state, executor, call, json };
}

async function userGroup(api: FakeChrome, title = "ContractFinder", count = 4, first = 1) {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) ids.push(api.addTab(first + i, `https://jobs.example.com/${first + i}`).id);
  const gid = await api.tabs.group(ids);
  api.groups.set(gid, { title, color: "blue" });
  return { ids, gid };
}

async function until(fn: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !fn(); i++) await Bun.sleep(5);
  expect(fn()).toBe(true);
}

describe("request_group", () => {
  test("approve: the group is the own group, every tab is adopted, save_group works", async () => {
    const t = setup();
    const { ids, gid } = await userGroup(t.api);
    const moved = t.api.moveCalls.length;
    const pending = t.call("request_group", { groupId: gid });
    await until(() => t.api.shown.size === 1);
    const note = t.api.everShown[0]!;
    expect(note.title).toBe("AIS Browser: allow an agent to use a tab group?");
    expect(note.buttons).toEqual(["Approve", "Deny"]);
    expect(note.message).toContain("ContractFinder");
    expect(note.message).toContain("alice");
    expect(note.message).toContain("4 tabs");
    expect(note.message).toContain("The agent can read and use these tabs. It never closes them.");
    t.api.clickNotification(0);
    const r = await pending;
    expect(r.ok).toBe(true);
    expect(t.json(r)).toMatchObject({ approved: true, tabCount: 4 });
    expect(t.api.shown.size).toBe(0);
    const ctx = t.json(await t.call("tabs_context"));
    expect(ctx.sessionTabs.map((x: { tabId: number }) => x.tabId)).toEqual(ids);
    expect(ctx.sessionTabs.every((x: { scope: string }) => x.scope === "own")).toBe(true);
    expect(t.tabs.sessions.get("agent-1")!.adopted.size).toBe(4);
    expect(t.api.store.agentGroups).toMatchObject([{ identity: "alice", label: "ContractFinder", groupId: gid }]);
    expect(t.api.moveCalls.length).toBe(moved);
    expect(t.api.activations).toEqual([]);
    expect(t.api.createdActive).toEqual([]);
    expect((await t.call("save_group", { name: "ContractFinder" })).ok).toBe(true);
  });

  test("approve: close_tab refuses an approved tab, and session_end closes and ungroups nothing", async () => {
    const t = setup();
    const { ids, gid } = await userGroup(t.api);
    const pending = t.call("request_group", { groupId: gid });
    await until(() => t.api.shown.size === 1);
    t.api.clickNotification(0);
    await pending;
    expect(await t.call("close_tab", { tabId: ids[0]! })).toMatchObject({ ok: false, error: "forbidden_tab" });
    await t.call("session_end");
    expect(t.api.tabList.size).toBe(4);
    for (const id of ids) expect(t.api.tabList.get(id)!.groupId).toBe(gid);
  });

  test("deny, close, timeout and abort refuse with forbidden_tab and clear the notification", async () => {
    const t = setup(new FakeChrome(), 60);
    const { ids, gid } = await userGroup(t.api);
    const deny = t.call("request_group", { groupId: gid });
    await until(() => t.api.shown.size === 1);
    t.api.clickNotification(1);
    expect(await deny).toMatchObject({ ok: false, error: "forbidden_tab" });
    const closed = t.call("request_group", { groupId: gid });
    await until(() => t.api.shown.size === 1);
    t.api.dismissNotification();
    expect(await closed).toMatchObject({ ok: false, error: "forbidden_tab" });
    const timeout = await t.call("request_group", { groupId: gid });
    expect(timeout).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(timeout.ok ? "" : timeout.message).toContain("did not answer");
    const slow = setup(new FakeChrome(), 5000);
    const g2 = await userGroup(slow.api);
    const aborted = slow.call("request_group", { groupId: g2.gid }, AG, "abort-me");
    await until(() => slow.api.shown.size === 1);
    slow.state.abort("abort-me");
    expect((await aborted).ok).toBe(false);
    expect(slow.api.shown.size).toBe(0);
    expect(slow.api.clearedNotifications.length).toBe(1);
    expect(t.api.shown.size).toBe(0);
    expect(t.api.clearedNotifications.length).toBe(3);
    expect(t.tabs.sessions.get("agent-1")?.groupId ?? -1).toBe(-1);
    for (const id of ids) expect(t.api.tabList.get(id)!.groupId).toBe(gid);
  });

  test("a second request for the same group while one waits is refused", async () => {
    const t = setup();
    const { gid } = await userGroup(t.api);
    const first = t.call("request_group", { groupId: gid });
    await until(() => t.api.shown.size === 1);
    expect(await t.call("request_group", { groupId: gid }, OTHER)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.everShown.length).toBe(1);
    t.api.clickNotification(1);
    await first;
  });

  describe("refusals show no notification", () => {
    test("a chat-panel session", async () => {
      const t = setup();
      const { gid } = await userGroup(t.api);
      expect(await t.call("request_group", { groupId: gid }, { ...AG, id: "chat:1", chat: true })).toMatchObject({ ok: false, error: "forbidden_tab" });
      expect(t.api.everShown.length).toBe(0);
    });

    test("a granted group", async () => {
      const t = setup();
      const { gid } = await userGroup(t.api);
      await t.call("tabs_context", {}, OTHER);
      expect(await t.tabs.grant(gid, "agent-2")).toBe("ok");
      expect(await t.call("request_group", { groupId: gid })).toMatchObject({ ok: false, error: "forbidden_tab" });
      expect(t.api.everShown.length).toBe(0);
    });

    test("a saved group", async () => {
      const t = setup();
      const a = await t.tabs.create(OTHER, "https://a.example.com/");
      await t.call("save_group", { name: "kept" }, OTHER);
      expect(await t.call("request_group", { groupId: t.api.tabList.get(a.id)!.groupId })).toMatchObject({ ok: false, error: "forbidden_tab" });
      expect(t.api.everShown.length).toBe(0);
    });

    test("the own group of another live session", async () => {
      const t = setup();
      const a = await t.tabs.create(OTHER, "https://a.example.com/");
      await t.call("tabs_context", {}, OTHER);
      expect(await t.call("request_group", { groupId: t.api.tabList.get(a.id)!.groupId })).toMatchObject({ ok: false, error: "forbidden_tab" });
      expect(t.api.everShown.length).toBe(0);
    });

    test("a group linked to the record of another identity or chat", async () => {
      const t = setup();
      await t.tabs.create(OTHER, "https://a.example.com/");
      await t.tabs.refreshAgents();
      t.api.restart();
      const fresh = setup(t.api);
      await fresh.tabs.load();
      const gid = [...t.api.tabList.values()][0]!.groupId;
      expect(fresh.tabs.sessions.size).toBe(0);
      expect(await fresh.call("request_group", { groupId: gid })).toMatchObject({ ok: false, error: "forbidden_tab" });
      expect(await fresh.call("request_group", { groupId: gid }, { id: "bob-1", identity: "bob", label: "Another chat" })).toMatchObject({ ok: false, error: "forbidden_tab" });
      expect(t.api.everShown.length).toBe(0);
    });

    test("the own group: answers already yours", async () => {
      const t = setup();
      const a = await t.tabs.create(AG, "https://a.example.com/");
      const r = await t.call("request_group", { groupId: t.api.tabList.get(a.id)!.groupId });
      expect(r.ok).toBe(true);
      expect(t.json(r)).toMatchObject({ already: true });
      expect(t.api.everShown.length).toBe(0);
    });

    test("a session that has an own group with tabs gets bad_args", async () => {
      const t = setup();
      await t.tabs.create(AG, "https://a.example.com/");
      const { gid } = await userGroup(t.api, "Reading", 2, 50);
      expect(await t.call("request_group", { groupId: gid })).toMatchObject({ ok: false, error: "bad_args" });
      expect(t.api.everShown.length).toBe(0);
    });

    test("a group that does not exist", async () => {
      const t = setup();
      expect(await t.call("request_group", { groupId: 4242 })).toMatchObject({ ok: false, error: "bad_args" });
      expect(t.api.everShown.length).toBe(0);
    });
  });

  test("every rule is checked again after the click: a group granted while the prompt is open stays with its grantee", async () => {
    const t = setup();
    const { ids, gid } = await userGroup(t.api);
    await t.call("tabs_context", {}, OTHER);
    const pending = t.call("request_group", { groupId: gid });
    await until(() => t.api.shown.size === 1);
    expect(await t.tabs.grant(gid, "agent-2")).toBe("ok");
    t.api.clickNotification(0);
    expect(await pending).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.tabs.sessions.get("agent-1")?.tabIds.size ?? 0).toBe(0);
    expect(t.tabs.grantee(gid)).toBe("agent-2");
    expect(t.tabs.ownerOf(ids[0]!)).toBeUndefined();
    expect(t.api.shown.size).toBe(0);
  });
});
