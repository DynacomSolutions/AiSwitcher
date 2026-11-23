import { describe, expect, test } from "bun:test";
import type { BrowserTool, CallRequest } from "../../../src/browser/protocol.ts";
import { Executor } from "../src/background/executor.ts";
import { State } from "../src/background/state.ts";
import { TabManager } from "../src/background/tabs.ts";
import { FakeChrome } from "./fakes.ts";

const A = { id: "agent-1", identity: "alice", label: "Cleaner" };
const B = { id: "agent-2", identity: "alice", label: "Other chat" };
let n = 0;

function setup(api = new FakeChrome()) {
  const tabs = new TabManager(api, () => 9_000_000);
  const state = new State(api.storage);
  const executor = new Executor({ api, tabs, state, sleep: async () => {} });
  const call = (tool: BrowserTool | "session_end", args: Record<string, unknown> = {}, s: Record<string, unknown> = A, id = `r${++n}`) => executor.run({ id, session: s, tool, args } as CallRequest);
  const json = (r: Awaited<ReturnType<typeof call>>) => JSON.parse(r.ok && r.content[0]?.type === "text" ? r.content[0].text : "{}");
  /** Opens `count` tabs in the own group of the session. */
  const own = async (s: Record<string, unknown> = A, count = 3) => {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) ids.push(json(await call("tabs_create", { url: `https://own.example.com/${i}` }, s)).tabId);
    return { ids, gid: api.tabList.get(ids[0]!)!.groupId };
  };
  return { api, tabs, state, executor, call, json, own };
}

async function userGroup(api: FakeChrome, count = 3, first = 1) {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) ids.push(api.addTab(first + i, `https://jobs.example.com/${first + i}`).id);
  const gid = await api.tabs.group(ids);
  api.groups.set(gid, { title: "User group", color: "blue" });
  return { ids, gid };
}

async function until(fn: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !fn(); i++) await Bun.sleep(5);
  expect(fn()).toBe(true);
}

describe("close_group", () => {
  test("the own group closes in one remove call, with no debugger attach", async () => {
    const t = setup();
    const { ids, gid } = await t.own();
    const cdp = t.api.cdpLog.length;
    const r = await t.call("close_group", { groupId: gid });
    expect(t.json(r)).toMatchObject({ groupId: gid, closed: 3, stillOpen: [] });
    expect(t.json(r).note).toContain("saved group stays saved");
    expect(t.api.removeCalls).toEqual([ids]);
    expect(t.api.cdpLog.length).toBe(cdp);
    expect(t.api.attachedTabs.size).toBe(0);
    expect(t.api.tabList.size).toBe(0);
    expect(t.tabs.sessions.has("agent-1")).toBe(false);
  });

  test("a group with one approved tab is refused and nothing closes", async () => {
    const t = setup();
    const { ids, gid } = await t.own();
    (t.tabs.sessions.get("agent-1")!.approved ??= new Set()).add(ids[1]!);
    const r = await t.call("close_group", { groupId: gid });
    expect(r).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.removeCalls).toEqual([]);
    expect(t.api.tabList.size).toBe(3);
  });

  test("a group of approved tabs (request_group without allowClose) is refused", async () => {
    const t = setup();
    const { ids, gid } = await userGroup(t.api);
    const pending = t.call("request_group", { groupId: gid });
    await until(() => t.api.shown.size === 1);
    t.api.clickNotification(0);
    await pending;
    expect(await t.call("close_group", { groupId: gid })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.removeCalls).toEqual([]);
    for (const id of ids) expect(t.api.tabList.has(id)).toBe(true);
  });

  test("a user tab inside the own group refuses the whole group", async () => {
    const t = setup();
    const { ids, gid } = await t.own();
    const user = t.api.addTab(900, "https://user.example.com/");
    await t.api.tabs.group([user.id], gid);
    expect(await t.call("close_group", { groupId: gid })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.removeCalls).toEqual([]);
    expect(t.api.tabList.size).toBe(ids.length + 1);
  });

  test("a browser page inside the own group refuses the whole group", async () => {
    const t = setup();
    const { ids, gid } = await t.own();
    t.tabs.sessions.get("agent-1")!.tabIds.add(901);
    const page = t.api.addTab(901, "chrome://settings/");
    await t.api.tabs.group([page.id], gid);
    expect(await t.call("close_group", { groupId: gid })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.removeCalls).toEqual([]);
    expect(t.api.tabList.size).toBe(ids.length + 1);
  });

  test("a granted group is refused", async () => {
    const t = setup();
    await t.call("tabs_context");
    const { ids, gid } = await userGroup(t.api);
    expect(await t.tabs.grant(gid, "agent-1")).toBe("ok");
    expect(await t.call("close_group", { groupId: gid })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.removeCalls).toEqual([]);
    for (const id of ids) expect(t.api.tabList.has(id)).toBe(true);
  });

  test("a saved group is refused", async () => {
    const t = setup();
    const { gid } = await t.own();
    expect((await t.call("save_group", { name: "keep" })).ok).toBe(true);
    expect(await t.call("close_group", { groupId: gid })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.removeCalls).toEqual([]);
    expect(t.api.tabList.size).toBe(3);
  });

  test("the group of another session is refused", async () => {
    const t = setup();
    const { gid } = await t.own(B);
    await t.own(A, 1);
    expect(await t.call("close_group", { groupId: gid }, A)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.removeCalls).toEqual([]);
    expect(t.api.tabList.size).toBe(4);
  });

  test("a group of the user is refused", async () => {
    const t = setup();
    await t.call("tabs_context");
    const { ids, gid } = await userGroup(t.api);
    expect(await t.call("close_group", { groupId: gid })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.removeCalls).toEqual([]);
    for (const id of ids) expect(t.api.tabList.has(id)).toBe(true);
  });

  test("an abort before the remove leaves every tab open", async () => {
    const t = setup();
    const { gid } = await t.own();
    const query = t.api.tabs.query.bind(t.api.tabs);
    let queries = 0;
    t.api.tabs.query = async (...args: Parameters<typeof query>) => {
      const r = await query(...args);
      if (++queries === 2) t.state.abort("abort-me"); // the re-read right before the remove
      return r;
    };
    const r = await t.call("close_group", { groupId: gid }, A, "abort-me");
    expect(r).toMatchObject({ ok: false, message: "Call aborted by the gateway." });
    expect(t.api.removeCalls).toEqual([]);
    expect(t.api.tabList.size).toBe(3);
  });

  test("a tab added after the first read is not closed", async () => {
    const t = setup();
    const { ids, gid } = await t.own();
    const query = t.api.tabs.query.bind(t.api.tabs);
    let queries = 0;
    t.api.tabs.query = async (...args: Parameters<typeof query>) => {
      const r = await query(...args);
      if (++queries === 1) { const added = t.api.addTab(950, "https://late.example.com/"); await t.api.tabs.group([added.id], gid); }
      return r;
    };
    const r = await t.call("close_group", { groupId: gid });
    expect(t.json(r)).toMatchObject({ closed: 3, stillOpen: [] });
    expect(t.api.removeCalls).toEqual([ids]);
    expect(t.api.tabList.has(950)).toBe(true);
    expect(t.api.tabList.size).toBe(1);
  });

  test("a tab that stays open is reported in stillOpen and stays owned", async () => {
    const t = setup();
    const { ids, gid } = await t.own();
    t.api.keepOpen.add(ids[1]!);
    const r = await t.call("close_group", { groupId: gid });
    expect(t.json(r)).toMatchObject({ groupId: gid, closed: 2, stillOpen: [ids[1]!] });
    expect(t.json(r).note).toContain("stayed open");
    expect(t.api.tabList.has(ids[1]!)).toBe(true);
    expect(t.tabs.owns("agent-1", ids[1]!, "alice")).toBe(true);
    expect(t.tabs.sessions.get("agent-1")!.tabIds.size).toBe(1);
  });

  test("a group taken with request_group allowClose can be closed", async () => {
    const t = setup();
    const { ids, gid } = await userGroup(t.api);
    const pending = t.call("request_group", { groupId: gid, allowClose: true });
    await until(() => t.api.shown.size === 1);
    t.api.clickNotification(0);
    expect((await pending).ok).toBe(true);
    const r = await t.call("close_group", { groupId: gid });
    expect(t.json(r)).toMatchObject({ groupId: gid, closed: 3, stillOpen: [] });
    expect(t.api.removeCalls).toEqual([ids]);
    expect(t.api.tabList.size).toBe(0);
  });

  test("discarded tabs close with no attach", async () => {
    const t = setup();
    const { ids, gid } = await t.own();
    for (const id of ids) t.api.tabList.get(id)!.discarded = true;
    const cdp = t.api.cdpLog.length;
    const r = await t.call("close_group", { groupId: gid });
    expect(t.json(r)).toMatchObject({ closed: 3, stillOpen: [] });
    expect(t.api.cdpLog.length).toBe(cdp);
    expect(t.api.attachedTabs.size).toBe(0);
    expect(t.api.tabList.size).toBe(0);
  });

  test("an unknown or empty group id is bad_args or forbidden_tab, and closes nothing", async () => {
    const t = setup();
    await t.own();
    expect((await t.call("close_group", { groupId: 4242 })).ok).toBe(false);
    expect((await t.call("close_group", { groupId: -1 })).ok).toBe(false);
    expect(t.api.removeCalls).toEqual([]);
    expect(t.api.tabList.size).toBe(3);
  });

  test("a chat session cannot close a group", async () => {
    const t = setup();
    const chat = { id: "chat-1", identity: "alice", label: "A chat", chat: true };
    const { gid } = await t.own(chat, 1);
    expect(await t.call("close_group", { groupId: gid }, chat)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.removeCalls).toEqual([]);
  });
});
