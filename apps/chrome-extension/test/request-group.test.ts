import { describe, expect, jest, test } from "bun:test";
import type { BrowserTool, CallRequest } from "../../../src/browser/protocol.ts";
import { Executor } from "../src/background/executor.ts";
import { State } from "../src/background/state.ts";
import { HOLDER_LIVE_MS, TabManager } from "../src/background/tabs.ts";
import { FakeChrome } from "./fakes.ts";

const AG = { id: "agent-1", identity: "alice", label: "ContractFinder" };
const OTHER = { id: "agent-2", identity: "alice", label: "Another chat" };
let n = 0;
let clock = 9_000_000;

function setup(api = new FakeChrome(), groupPromptMs?: number) {
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
    // An abort of the call does not end the request: it stays pending for the owner.
    expect(slow.api.shown.size).toBe(1);
    expect(slow.executor.requests.list().length).toBe(1);
    slow.executor.requests.answer(slow.executor.requests.list()[0]!.id, false);
    expect(slow.api.shown.size).toBe(0);
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

  async function approved(t: ReturnType<typeof setup>, gid: number): Promise<void> {
    const pending = t.call("request_group", { groupId: gid });
    await until(() => t.api.shown.size === 1);
    t.api.clickNotification(0);
    expect((await pending).ok).toBe(true);
  }

  test("R1: a new session of the chat that reclaims the approved group still cannot close or ungroup its tabs", async () => {
    const t = setup();
    const { ids, gid } = await userGroup(t.api);
    await approved(t, gid);
    clock += HOLDER_LIVE_MS + 1000;
    const B = { id: "agent-3", identity: "alice", label: "ContractFinder" };
    expect(t.json(await t.call("tabs_context", {}, B)).sessionTabs.length).toBe(4);
    expect(await t.call("close_tab", { tabId: ids[0]! }, B)).toMatchObject({ ok: false, error: "forbidden_tab" });
    await t.call("session_end", {}, B);
    expect(t.api.tabList.size).toBe(4);
    for (const id of ids) expect(t.api.tabList.get(id)!.groupId).toBe(gid);
  });

  test("R1: the approval survives a browser restart", async () => {
    const t = setup();
    const { ids, gid } = await userGroup(t.api);
    await approved(t, gid);
    await t.tabs.refreshAgents();
    const idMap = t.api.restart();
    const fresh = setup(t.api);
    await fresh.tabs.load();
    const B = { id: "agent-4", identity: "alice", label: "ContractFinder" };
    const ctx = fresh.json(await fresh.call("tabs_context", {}, B));
    const newIds = ids.map(id => idMap.get(id)!);
    expect(ctx.sessionTabs.map((x: { tabId: number }) => x.tabId)).toEqual(newIds);
    expect(await fresh.call("close_tab", { tabId: newIds[0]! }, B)).toMatchObject({ ok: false, error: "forbidden_tab" });
    await fresh.call("session_end", {}, B);
    expect(t.api.tabList.size).toBe(4);
    const newGid = t.api.tabList.get(newIds[0]!)!.groupId;
    for (const id of newIds) expect(t.api.tabList.get(id)!.groupId).toBe(newGid);
  });

  test("R2: with the production timeouts a click after 31 seconds still approves", async () => {
    jest.useFakeTimers();
    try {
      const t = setup();
      const { gid } = await userGroup(t.api);
      const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
      const pending = t.call("request_group", { groupId: gid });
      await flush();
      expect(t.api.shown.size).toBe(1);
      jest.advanceTimersByTime(31_000);
      await flush();
      t.api.clickNotification(0);
      expect(await pending).toMatchObject({ ok: true });
    } finally {
      jest.useRealTimers();
    }
  });

  test("Q4: a tab added while the prompt is open is refused, a tab removed is not", async () => {
    const t = setup();
    const { ids, gid } = await userGroup(t.api);
    const added = t.call("request_group", { groupId: gid });
    await until(() => t.api.shown.size === 1);
    const extra = t.api.addTab(90, "https://late.example.com/");
    await t.api.tabs.group([extra.id], gid);
    t.api.clickNotification(0);
    const r = await added;
    expect(r).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(r.ok ? "" : r.message).toContain("The group changed while the prompt was open. Ask again.");
    expect(t.tabs.sessions.get("agent-1")?.tabIds.size ?? 0).toBe(0);
    t.api.closeTab(extra.id);
    const removed = t.call("request_group", { groupId: gid });
    await until(() => t.api.shown.size === 1);
    t.api.closeTab(ids[0]!);
    t.api.clickNotification(0);
    expect(await removed).toMatchObject({ ok: true });
    expect(t.tabs.sessions.get("agent-1")!.tabIds.size).toBe(3);
  });

  test("Q3: a group of another session of the same identity is said so in the prompt, another identity is refused", async () => {
    const t = setup();
    const a = await t.tabs.create(OTHER, "https://a.example.com/");
    const gid = t.api.tabList.get(a.id)!.groupId;
    await t.call("tabs_context", {}, OTHER);
    clock += HOLDER_LIVE_MS + 1000; // the holder is idle
    const pending = t.call("request_group", { groupId: gid });
    await until(() => t.api.shown.size === 1);
    expect(t.api.everShown[0]!.message).toContain("Another agent session made this group.");
    t.api.clickNotification(1);
    await pending;
    const shown = t.api.everShown.length;
    const BOB = { id: "bob-1", identity: "bob", label: "Bob chat" };
    expect(await t.call("request_group", { groupId: gid }, BOB)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.everShown.length).toBe(shown);
  });

  test("Q3: a plain user group has no such sentence", async () => {
    const t = setup();
    const { gid } = await userGroup(t.api);
    const pending = t.call("request_group", { groupId: gid });
    await until(() => t.api.shown.size === 1);
    expect(t.api.everShown[0]!.message).not.toContain("Another agent session");
    t.api.clickNotification(1);
    await pending;
  });
});

describe("request_group allowClose", () => {
  test("the prompt says the agent can close the tabs, the title stays the same", async () => {
    const t = setup();
    const { gid } = await userGroup(t.api);
    const pending = t.call("request_group", { groupId: gid, allowClose: true });
    await until(() => t.api.shown.size === 1);
    const note = t.api.everShown[0]!;
    expect(note.title).toBe("AIS Browser: allow an agent to use a tab group?");
    expect(note.message).toContain("The agent can read, use and CLOSE these tabs.");
    expect(note.message).not.toContain("never closes");
    t.api.clickNotification(1);
    await pending;
  });

  test("approve: the tabs are owned and not approved, close_tab works and session_end closes the rest", async () => {
    const t = setup();
    const { ids, gid } = await userGroup(t.api);
    const pending = t.call("request_group", { groupId: gid, allowClose: true });
    await until(() => t.api.shown.size === 1);
    t.api.clickNotification(0);
    const r = await pending;
    expect(t.json(r)).toMatchObject({ approved: true, tabCount: 4 });
    const s = t.tabs.sessions.get("agent-1")!;
    expect(s.groupId).toBe(gid);
    expect([...s.tabIds]).toEqual(ids);
    expect(s.adopted.size).toBe(0);
    expect(s.approved?.size ?? 0).toBe(0);
    expect((await t.call("close_tab", { tabId: ids[0]! })).ok).toBe(true);
    expect(t.api.tabList.has(ids[0]!)).toBe(false);
    await t.call("session_end");
    expect(t.api.tabList.size).toBe(0);
  });

  test("deny does nothing", async () => {
    const t = setup();
    const { ids, gid } = await userGroup(t.api);
    const pending = t.call("request_group", { groupId: gid, allowClose: true });
    await until(() => t.api.shown.size === 1);
    t.api.clickNotification(1);
    expect(await pending).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.tabs.sessions.get("agent-1")?.groupId ?? -1).toBe(-1);
    for (const id of ids) expect(t.api.tabList.get(id)!.groupId).toBe(gid);
    expect(t.api.tabList.size).toBe(4);
  });

  test("tabs that an earlier approval protected stay unclosable", async () => {
    const t = setup();
    const { ids, gid } = await userGroup(t.api);
    const first = t.call("request_group", { groupId: gid });
    await until(() => t.api.shown.size === 1);
    t.api.clickNotification(0);
    await first;
    expect(await t.call("close_tab", { tabId: ids[0]! })).toMatchObject({ ok: false, error: "forbidden_tab" });
    // A later chat session of the same identity asks again, now with allowClose.
    clock += HOLDER_LIVE_MS + 1000;
    const second = t.call("request_group", { groupId: gid, allowClose: true }, OTHER);
    await until(() => t.api.shown.size === 1);
    t.api.clickNotification(0);
    await second;
    expect(await t.call("close_tab", { tabId: ids[0]! }, OTHER)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.tabList.has(ids[0]!)).toBe(true);
  });

  test("allowClose is refused while an unlinked record of the identity has the same title", async () => {
    const t = setup();
    const first = await userGroup(t.api);
    const p1 = t.call("request_group", { groupId: first.gid });
    await until(() => t.api.shown.size === 1);
    t.api.clickNotification(0);
    await p1;
    const records = (t.tabs as unknown as { agents: Map<string, { groupId: number }> }).agents;
    expect(records.size).toBe(1);
    for (const r of records.values()) r.groupId = -1;
    const second = await userGroup(t.api, "ContractFinder", 2, 20);
    const r = await t.call("request_group", { groupId: second.gid, allowClose: true }, OTHER);
    expect(r).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(JSON.stringify(r)).toContain("earlier approval protects");
    expect(t.api.shown.size).toBe(0);
  });
});
