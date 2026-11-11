import { describe, expect, test } from "bun:test";
import { TabManager } from "../src/background/tabs.ts";
import { FakeChrome } from "./fakes.ts";

const ref = (id = "s1", label = "refactor login", identity = "alice") => ({ id, identity, label });
const groupIds = (api: FakeChrome) => new Set([...api.tabList.values()].map(t => t.groupId).filter(g => g !== -1));

describe("one tab group per agent session", () => {
  test("concurrent first calls create a single group", async () => {
    const api = new FakeChrome();
    const tabs = new TabManager(api);
    const made = await Promise.all([tabs.create(ref(), "https://a.example.com/"), tabs.create(ref(), "https://b.example.com/"), tabs.create(ref(), "https://c.example.com/")]);
    expect(groupIds(api).size).toBe(1);
    expect(new Set(made.map(t => api.tabList.get(t.id)!.groupId)).size).toBe(1);
    expect(api.groups.size).toBe(1);
  });

  test("a service-worker restart reuses the group", async () => {
    const api = new FakeChrome();
    const first = await new TabManager(api).create(ref(), "https://a.example.com/");
    const restarted = new TabManager(api); // new worker: empty memory, same chrome.storage.session
    await restarted.load();
    const second = await restarted.create(ref(), "https://b.example.com/");
    expect(api.tabList.get(second.id)!.groupId).toBe(api.tabList.get(first.id)!.groupId);
    expect(groupIds(api).size).toBe(1);
  });

  test("a restart that lost its session map re-adopts the live group with the same title", async () => {
    const api = new FakeChrome();
    const first = await new TabManager(api).create(ref(), "https://a.example.com/");
    api.session = {};
    const second = await new TabManager(api).create(ref(), "https://b.example.com/");
    expect(api.tabList.get(second.id)!.groupId).toBe(api.tabList.get(first.id)!.groupId);
    expect(groupIds(api).size).toBe(1);
  });

  test("a shim reconnect with the same session id keeps the group; a different session never steals it", async () => {
    const api = new FakeChrome();
    const tabs = new TabManager(api);
    const a = await tabs.create(ref("s1", "chat one"), "https://a.example.com/");
    const again = await tabs.create(ref("s1", "chat one"), "https://b.example.com/");
    expect(api.tabList.get(again.id)!.groupId).toBe(api.tabList.get(a.id)!.groupId);
    const other = await tabs.create(ref("s2", "chat one"), "https://c.example.com/"); // same title, different live session
    expect(api.tabList.get(other.id)!.groupId).not.toBe(api.tabList.get(a.id)!.groupId);
    expect(groupIds(api).size).toBe(2);
  });

  test("a dissolved group is replaced once, not per call", async () => {
    const api = new FakeChrome();
    const tabs = new TabManager(api);
    const a = await tabs.create(ref(), "https://a.example.com/");
    api.tabList.get(a.id)!.groupId = -1; // user dissolved the group
    const [b, c] = await Promise.all([tabs.create(ref(), "https://b.example.com/"), tabs.create(ref(), "https://c.example.com/")]);
    expect(api.tabList.get(b.id)!.groupId).toBe(api.tabList.get(c.id)!.groupId);
  });

  test("a session whose tabs are all gone is dropped", async () => {
    const api = new FakeChrome();
    const tabs = new TabManager(api);
    const a = await tabs.create(ref(), "https://a.example.com/");
    api.closeTab(a.id);
    expect(tabs.sessions.has("s1")).toBe(false);
  });
});

describe("user-granted tab groups", () => {
  async function setup() {
    const { Executor } = await import("../src/background/executor.ts");
    const { State } = await import("../src/background/state.ts");
    const api = new FakeChrome();
    let now = 1_000;
    const tabs = new TabManager(api, () => now);
    const state = new State();
    const executor = new Executor({ api, tabs, state });
    // The user's own tab group, titled and coloured by them.
    const userTab = api.addTab(1, "https://user.example.com/");
    const userGroup = await api.tabs.group([userTab.id]);
    api.groups.set(userGroup, { title: "Holiday plans", color: "orange" });
    let n = 0;
    const call = (tool: string, args: Record<string, unknown>, sid = "s1") => executor.run({ id: `c${++n}`, session: { id: sid, identity: "alice", label: sid === "s1" ? "refactor login" : "other chat" }, tool, args } as never);
    return { api, tabs, state, executor, userTab, userGroup, call, advance: (ms: number) => { now += ms; } };
  }
  const json = (r: { ok: boolean; content?: Array<{ text?: string }> }) => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);

  test("a rename retitles the session's own group but never a granted group", async () => {
    const t = await setup();
    const made = json(await t.call("tabs_create", { url: "https://a.example.com/" }) as never);
    const own = t.api.tabList.get(made.tabId ?? made.id)?.groupId ?? [...t.api.groups.keys()].find(g => g !== t.userGroup)!;
    expect(t.api.groups.get(own)?.title).toBe("refactor login");
    expect(await t.tabs.grant(t.userGroup, "s1")).toBe("ok");
    const renamed = { id: "s1", identity: "alice", label: "login rewrite" };
    expect(t.tabs.touch(renamed)).toBe(true);
    expect(t.tabs.touch(renamed)).toBe(false); // same name again
    await new Promise(r => setTimeout(r, 10));
    expect(t.api.groups.get(own)?.title).toBe("login rewrite");
    expect(t.api.groups.get(t.userGroup)?.title).toBe("Holiday plans");
    expect(t.api.groups.get(t.userGroup)?.color).toBe("orange");
  });

  test("without a grant the session cannot touch the user's group", async () => {
    const t = await setup();
    await t.call("tabs_context", {});
    expect(await t.call("read_page", { tabId: t.userTab.id })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await t.call("tabs_create", { groupId: t.userGroup })).toMatchObject({ ok: false, error: "forbidden_tab" });
  });

  test("grant: the session lists, acts in and opens tabs in the group; title and colour stay; others cannot use it", async () => {
    const t = await setup();
    await t.call("tabs_context", {});
    expect(await t.tabs.grant(t.userGroup, "s1")).toBe("ok");
    const ctx = json(await t.call("tabs_context", {}) as never);
    expect(ctx.grantedGroups).toEqual([t.userGroup]);
    expect(ctx.sessionTabs).toEqual([expect.objectContaining({ tabId: t.userTab.id, scope: "granted" })]);
    t.api.cdpResults["Runtime.evaluate"] = { result: { value: 2 } };
    expect((await t.call("javascript", { tabId: t.userTab.id, code: "1+1" })).ok).toBe(true);
    const made = json(await t.call("tabs_create", { url: "example.com", groupId: t.userGroup }) as never);
    expect(t.api.tabList.get(made.tabId)!.groupId).toBe(t.userGroup);
    expect(t.api.tabList.get(made.tabId)!.active).toBe(false);
    expect(t.api.groups.get(t.userGroup)).toEqual({ title: "Holiday plans", color: "orange" });
    // Opened tabs may be closed, the user's tab may not.
    expect((await t.call("close_tab", { tabId: made.tabId })).ok).toBe(true);
    expect(await t.call("close_tab", { tabId: t.userTab.id })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.tabList.has(t.userTab.id)).toBe(true);
    // Another session is locked out, and cannot be granted the same group.
    await t.call("tabs_context", {}, "s2");
    expect(await t.call("read_page", { tabId: t.userTab.id }, "s2")).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await t.tabs.grant(t.userGroup, "s2")).toBe("in_use");
    expect(await t.call("adopt_tab", { tabId: t.userTab.id }, "s2")).toMatchObject({ ok: false, error: "forbidden_tab" });
  });

  test("a session's own group cannot be granted, and its own group stays as is", async () => {
    const t = await setup();
    await t.call("tabs_create", {}, "s2");
    const own = t.tabs.sessions.get("s2")!.groupId;
    await t.call("tabs_context", {});
    expect(await t.tabs.grant(own, "s1")).toBe("in_use");
    await t.tabs.grant(t.userGroup, "s2");
    expect(t.tabs.sessions.get("s2")!.groupId).toBe(own);
    expect(t.api.groups.get(own)!.title).toBe("other chat");
  });

  test("revoke removes access", async () => {
    const t = await setup();
    await t.call("tabs_context", {});
    await t.tabs.grant(t.userGroup, "s1");
    t.tabs.revoke(t.userGroup);
    expect(await t.call("read_page", { tabId: t.userTab.id })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.tabs.grantee(t.userGroup)).toBeUndefined();
  });

  test("closing the group, Stop and session end each clear the grant", async () => {
    const t = await setup();
    await t.call("tabs_context", {});
    await t.tabs.grant(t.userGroup, "s1");
    t.api.tabList.get(t.userTab.id)!.groupId = -1; // group dissolved
    await t.tabs.pruneGrants();
    expect(t.tabs.grantee(t.userGroup)).toBeUndefined();

    const g2 = await t.api.tabs.group([t.userTab.id]);
    expect(await t.tabs.grant(g2, "s1")).toBe("ok");
    await t.state.stop();
    t.tabs.revokeAll(); // wired to state.onStop in the worker
    expect(t.tabs.grantee(g2)).toBeUndefined();

    expect(await t.tabs.grant(g2, "s1")).toBe("ok");
    t.advance(31 * 60_000);
    t.tabs.expireIdle();
    t.advance(31 * 60_000);
    t.tabs.expireIdle();
    expect(t.tabs.grantee(g2)).toBeUndefined();
    expect(t.tabs.sessions.has("s1")).toBe(false);
  });

  test("a grant survives a service-worker restart and revoke persists", async () => {
    const t = await setup();
    await t.call("tabs_context", {});
    await t.tabs.grant(t.userGroup, "s1");
    const restarted = new TabManager(t.api);
    await restarted.load();
    expect(restarted.grantee(t.userGroup)).toBe("s1");
    restarted.revoke(t.userGroup);
    const again = new TabManager(t.api);
    await again.load();
    expect(again.grantee(t.userGroup)).toBeUndefined();
  });

  test("an unknown session or group cannot be granted", async () => {
    const t = await setup();
    expect(await t.tabs.grant(t.userGroup, "nobody")).toBe("no_session");
    await t.call("tabs_context", {});
    expect(await t.tabs.grant(999, "s1")).toBe("no_group");
  });
});

describe("ending a session closes what it created", () => {
  async function setup() {
    const { Executor } = await import("../src/background/executor.ts");
    const { State } = await import("../src/background/state.ts");
    const api = new FakeChrome();
    const tabs = new TabManager(api);
    const executor = new Executor({ api, tabs, state: new State() });
    let n = 0;
    const call = (tool: string, args: Record<string, unknown> = {}, sid = "s1") => executor.run({ id: `c${++n}`, session: { id: sid, identity: "alice", label: "refactor login" }, tool, args } as never);
    return { api, tabs, call };
  }
  const tabId = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text).tabId as number;

  test("created tabs close, adopted tabs stay and leave the group", async () => {
    const t = await setup();
    const made = tabId(await t.call("tabs_create", { url: "https://a.example.com/" }));
    const user = t.api.addTab(1, "https://user.example.com/");
    await t.call("adopt_tab", { tabId: user.id });
    const group = t.api.tabList.get(made)!.groupId;
    expect(t.api.tabList.get(user.id)!.groupId).toBe(group);
    expect(await t.call("session_end")).toMatchObject({ ok: true });
    expect(t.api.tabList.has(made)).toBe(false);
    expect(t.api.tabList.get(user.id)!.groupId).toBe(-1);
    expect(t.tabs.sessions.has("s1")).toBe(false);
  });

  test("adopted tab in some other group is left alone; granted group and its tabs survive and the grant is revoked", async () => {
    const t = await setup();
    await t.call("tabs_context");
    const other = t.api.addTab(1, "https://other.example.com/");
    const otherGroup = await t.api.tabs.group([other.id]);
    const grantedTab = t.api.addTab(2, "https://granted.example.com/");
    const granted = await t.api.tabs.group([grantedTab.id]);
    await t.tabs.grant(granted, "s1");
    const inGranted = tabId(await t.call("tabs_create", { groupId: granted }));
    await t.tabs.addToSession({ id: "s1", identity: "alice", label: "refactor login" }, other.id);
    await t.call("tabs_create");
    t.api.tabList.get(other.id)!.groupId = otherGroup; // the user moved the adopted tab to a group of their own
    await t.call("session_end");
    expect(t.api.tabList.get(other.id)!.groupId).toBe(otherGroup);
    expect(t.api.tabList.has(inGranted)).toBe(true);
    expect(t.api.tabList.get(grantedTab.id)!.groupId).toBe(granted);
    expect(t.tabs.grantee(granted)).toBeUndefined();
    expect(t.tabs.sessions.has("s1")).toBe(false);
  });

  test("session_end for an unknown session is a harmless ok, and other sessions are untouched", async () => {
    const t = await setup();
    const keep = tabId(await t.call("tabs_create", {}, "s2"));
    expect(await t.call("session_end", {}, "nobody")).toMatchObject({ ok: true });
    expect(t.api.tabList.has(keep)).toBe(true);
  });

  test("the created/adopted split survives a restart; older data counts as created", async () => {
    const t = await setup();
    const made = tabId(await t.call("tabs_create"));
    const user = t.api.addTab(1);
    await t.call("adopt_tab", { tabId: user.id });
    await new Promise(r => setTimeout(r, 5));
    const restarted = new TabManager(t.api);
    await restarted.load();
    expect([...restarted.sessions.get("s1")!.adopted]).toEqual([user.id]);
    await restarted.closeSession("s1");
    expect(t.api.tabList.has(made)).toBe(false);
    expect(t.api.tabList.has(user.id)).toBe(true);

    const legacy = new FakeChrome();
    const tab = legacy.addTab(5);
    legacy.session = { sessions: [{ id: "old", groupId: -1, identity: "alice", label: "x", tabIds: [tab.id] }] };
    const m = new TabManager(legacy);
    await m.load();
    await m.closeSession("old");
    expect(legacy.tabList.has(5)).toBe(false);
  });

  test("idle expiry does not close tabs", async () => {
    const api = new FakeChrome();
    let now = 0;
    const tabs = new TabManager(api, () => now);
    const tab = await tabs.create({ id: "s1", identity: "alice", label: "x" }, "https://a.example.com/");
    tabs.touch({ id: "s1", identity: "alice", label: "x" });
    now += 31 * 60_000;
    tabs.expireIdle();
    expect(api.tabList.has(tab.id)).toBe(true);
  });
});

describe("self-update reload keeps sessions", () => {
  test("handover restores tabs and grants after chrome.storage.session was cleared", async () => {
    const api = new FakeChrome();
    const tabs = new TabManager(api);
    const t = await tabs.create(ref(), "https://a.example.com/");
    const user = api.addTab(9);
    const gid = await api.tabs.group([user.id]);
    expect(await tabs.grant(gid, "s1")).toBe("ok");
    await tabs.handover();
    api.session = {}; // chrome.runtime.reload() clears session storage
    const next = new TabManager(api);
    await next.load();
    expect(next.ownerOf(t.id)).toBe("s1");
    expect(next.grantee(gid)).toBe("s1");
    expect(api.store.handover).toBeUndefined();
  });

  test("a stale handover from an earlier browser run is ignored", async () => {
    const api = new FakeChrome();
    let now = 0;
    const tabs = new TabManager(api, () => now);
    const t = await tabs.create(ref(), "https://a.example.com/");
    await tabs.handover();
    api.session = {};
    now = 10 * 60_000;
    const next = new TabManager(api, () => now);
    await next.load();
    expect(next.ownerOf(t.id)).toBeUndefined();
  });
});
