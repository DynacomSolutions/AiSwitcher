import { describe, expect, test } from "bun:test";
import type { BrowserTool, CallRequest } from "../../../src/browser/protocol.ts";
import { Executor } from "../src/background/executor.ts";
import { State } from "../src/background/state.ts";
import { HOLDER_LIVE_MS, TabManager } from "../src/background/tabs.ts";
import { FakeChrome } from "./fakes.ts";

// One chat, several sessions: the agent session id changes when Claude Code compacts the context.
// The stable chat id (the T3 thread id) is the same across the sessions of one chat.
const S1 = { id: "sess-1", identity: "alice", label: "Mail chat", chatId: "thread-mail" };
const S2 = { id: "sess-2", identity: "alice", label: "Mail chat", chatId: "thread-mail" };
const S3 = { id: "sess-3", identity: "alice", label: "Mail chat", chatId: "thread-mail" };
const OTHER_CHAT = { id: "sess-x", identity: "alice", label: "Another chat", chatId: "thread-other" };
/** A different chat that has the same label (two T3 threads with one title). */
const SAME_LABEL = { id: "sess-y", identity: "alice", label: "Mail chat", chatId: "thread-twin" };
/** An older shim: no chat id, only the label. */
const OLD_SHIM = { id: "sess-old", identity: "alice", label: "Mail chat" };
let n = 0;
let clock = 7_000_000;

function setup(api = new FakeChrome()) {
  const tabs = new TabManager(api, () => clock);
  const executor = new Executor({ api, tabs, state: new State(api.storage), sleep: async () => {} });
  const call = (tool: BrowserTool | "session_end", args: Record<string, unknown> = {}, s: Record<string, unknown> = S1) => executor.run({ id: `c${++n}`, session: s, tool, args } as CallRequest);
  const json = (r: Awaited<ReturnType<typeof call>>) => JSON.parse(r.ok && r.content[0]?.type === "text" ? r.content[0].text : "{}");
  const create = async (s: Record<string, unknown>, url: string): Promise<number> => json(await call("tabs_create", { url }, s)).tabId;
  return { api, tabs, executor, call, json, create };
}

/** S1 opens two tabs in its group A. S2 (after a compaction) calls while S1 is still inside its live window, so it cannot take A and makes group B. */
async function compacted() {
  const t = setup();
  const a1 = await t.create(S1, "https://mail.example.com/1");
  const a2 = await t.create(S1, "https://mail.example.com/2");
  await t.tabs.refreshAgents();
  const gidA = t.api.tabList.get(a1)!.groupId;
  clock += 60_000;
  const b1 = await t.create(S2, "https://docs.example.com/1");
  const gidB = t.api.tabList.get(b1)!.groupId;
  clock += HOLDER_LIVE_MS + 1000; // S1 is quiet for good
  return { t, a1, a2, b1, gidA, gidB };
}

describe("a later session of the same chat regains its earlier group", () => {
  test("tabs_context lists the earlier group as own", async () => {
    const { t, gidA, gidB } = await compacted();
    const ctx = t.json(await t.call("tabs_context", {}, S2));
    expect(ctx.groups.find((g: { groupId: number }) => g.groupId === gidA)).toMatchObject({ scope: "own", hiddenTabCount: 0 });
    expect(ctx.groups.find((g: { groupId: number }) => g.groupId === gidB)).toMatchObject({ scope: "own" });
  });

  test("close_tab works on a tab of the earlier group", async () => {
    const { t, a1 } = await compacted();
    expect(await t.call("close_tab", { tabId: a1 }, S2)).toMatchObject({ ok: true });
    expect(t.api.tabList.has(a1)).toBe(false);
  });

  test("adopt_tab works on a tab whose dead holder is the same chat", async () => {
    const { t, a1 } = await compacted();
    expect(await t.call("adopt_tab", { tabId: a1 }, S2)).toMatchObject({ ok: true });
  });

  test("close_group closes the earlier group and keeps the new one", async () => {
    const { t, a1, a2, b1, gidA } = await compacted();
    expect(await t.call("close_group", { groupId: gidA }, S2)).toMatchObject({ ok: true });
    expect(t.api.tabList.has(a1)).toBe(false);
    expect(t.api.tabList.has(a2)).toBe(false);
    expect(t.api.tabList.has(b1)).toBe(true);
  });

  test("a second compaction still regains the earliest group", async () => {
    const { t, a1, b1 } = await compacted();
    await t.call("tabs_context", {}, S2);
    clock += HOLDER_LIVE_MS + 1000;
    await t.call("tabs_context", {}, S3);
    expect(await t.call("close_tab", { tabId: a1 }, S3)).toMatchObject({ ok: true });
    expect(await t.call("close_tab", { tabId: b1 }, S3)).toMatchObject({ ok: true });
  });

  test("a tab that holds a beforeunload prompt stays open and owned by the chat", async () => {
    const { t, a1, a2, gidA } = await compacted();
    t.api.keepOpen.add(a1); // "Leave site?": the page refuses to close
    const first = await t.call("close_group", { groupId: gidA }, S2);
    expect(t.api.tabList.has(a2)).toBe(false);
    expect(t.api.tabList.has(a1)).toBe(true);
    expect(JSON.stringify(first)).toContain(String(a1));
    // The tab still belongs to the chat that regained it, and the group stays its own.
    expect(t.tabs.sessions.get(S2.id)!.tabIds.has(a1)).toBe(true);
    expect(t.tabs.owns(S2.id, a1, "alice")).toBe(true);
  });

  test("a live holder of the same chat keeps its tabs", async () => {
    const { t, a1 } = await compacted();
    await t.call("tabs_context", {}, S1); // S1 calls again: live
    expect(await t.call("close_tab", { tabId: a1 }, S2)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await t.call("adopt_tab", { tabId: a1 }, S2)).toMatchObject({ ok: false, error: "forbidden_tab" });
  });

  test("another chat never takes the tabs, even when the holder is dead", async () => {
    const { t, a1, gidA } = await compacted();
    expect(await t.call("close_tab", { tabId: a1 }, OTHER_CHAT)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await t.call("adopt_tab", { tabId: a1 }, OTHER_CHAT)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await t.call("close_group", { groupId: gidA }, OTHER_CHAT)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.tabList.has(a1)).toBe(true);
  });

  test("another live chat keeps its tabs against adopt_tab", async () => {
    const t = setup();
    const x = await t.create(OTHER_CHAT, "https://x.example.com/1");
    await t.call("tabs_context", {}, OTHER_CHAT);
    expect(await t.call("adopt_tab", { tabId: x }, S2)).toMatchObject({ ok: false, error: "forbidden_tab" });
  });
});

describe("the stable chat id decides who takes tabs from a dead session", () => {
  test("the same label with a different chat id never takes the tabs (no own group)", async () => {
    const { t, a1, gidA } = await compacted();
    expect(await t.call("close_tab", { tabId: a1 }, SAME_LABEL)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await t.call("adopt_tab", { tabId: a1 }, SAME_LABEL)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await t.call("close_group", { groupId: gidA }, SAME_LABEL)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.tabList.has(a1)).toBe(true);
  });

  test("the same label with a different chat id never takes the tabs (own group)", async () => {
    const { t, a1, gidA } = await compacted();
    await t.create(SAME_LABEL, "https://twin.example.com/1");
    clock += HOLDER_LIVE_MS + 1000;
    expect(await t.call("close_tab", { tabId: a1 }, SAME_LABEL)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await t.call("close_group", { groupId: gidA }, SAME_LABEL)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.tabList.has(a1)).toBe(true);
  });

  test("the same chat id takes the tabs after a compaction", async () => {
    const { t, a1, gidA } = await compacted();
    expect(await t.call("close_group", { groupId: gidA }, S2)).toMatchObject({ ok: true });
    expect(t.api.tabList.has(a1)).toBe(false);
  });

  test("an older shim without a chat id keeps the label rule: it takes the tabs of a dead session when it has no own group", async () => {
    const { t, a1 } = await compacted();
    expect(await t.call("close_tab", { tabId: a1 }, OLD_SHIM)).toMatchObject({ ok: true });
  });

  test("an older shim with an own group takes nothing from a dead session", async () => {
    // The older shim made its own group while the holder was still live.
    const t2 = setup();
    const x1 = await t2.create(S1, "https://mail.example.com/1");
    await t2.call("tabs_context", {}, S1);
    await t2.create(OLD_SHIM, "https://old.example.com/1");
    clock += HOLDER_LIVE_MS + 1000;
    expect(await t2.call("close_tab", { tabId: x1 }, OLD_SHIM)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t2.api.tabList.has(x1)).toBe(true);
  });

  test("a service worker restart keeps live sessions live", async () => {
    const t = setup();
    const a1 = await t.create(S1, "https://mail.example.com/1");
    await t.tabs.refreshAgents();
    clock += 2 * 60_000; // quiet for 2 minutes only: still live
    const later = setup(t.api); // a new service worker: same chrome, no memory
    await later.tabs.load();
    expect(await later.call("close_tab", { tabId: a1 }, OLD_SHIM)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.tabList.has(a1)).toBe(true);
  });

  test("a returning old session sees the group that its chat moved as held by the new session", async () => {
    const { t, a1, gidA } = await compacted();
    await t.call("tabs_context", {}, S2); // S2 takes group A and is live now
    const ctx = t.json(await t.call("tabs_context", {}, { ...S1, id: "sess-1b", chatId: "thread-elsewhere", label: "Mail chat" }));
    const g = ctx.groups.find((x: { groupId: number }) => x.groupId === gidA);
    expect(g).toMatchObject({ scope: "other", holderLabel: "Mail chat", holderLive: true });
    expect(t.api.tabList.has(a1)).toBe(true);
  });
});

describe("a saved group follows the chat id", () => {
  async function savedByMail() {
    const t = setup();
    const a1 = await t.create(S1, "https://mail.example.com/1");
    await t.tabs.refreshAgents();
    const gid = t.api.tabList.get(a1)!.groupId;
    expect(await t.call("save_group", { name: "Mail saved" }, S1)).toMatchObject({ ok: true });
    clock += HOLDER_LIVE_MS + 1000; // S1 is quiet for good
    return { t, a1, gid };
  }

  test("a chat with the same label and another chat id neither regains nor closes the saved group", async () => {
    const { t, a1, gid } = await savedByMail();
    await t.call("tabs_context", {}, SAME_LABEL);
    expect(await t.call("close_tab", { tabId: a1 }, SAME_LABEL)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await t.call("close_group", { groupId: gid }, SAME_LABEL)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.tabList.has(a1)).toBe(true);
  });

  test("a later session of the same chat id regains the saved group", async () => {
    const { t, a1 } = await savedByMail();
    expect(await t.call("close_tab", { tabId: a1 }, S2)).toMatchObject({ ok: true });
    expect(t.api.tabList.has(a1)).toBe(false);
  });

  test("a saved group stored before the chat id existed keeps the label rule", async () => {
    const { t, a1 } = await savedByMail();
    for (const g of t.api.store.savedGroups as Array<{ chatId?: string }>) delete g.chatId;
    const later = setup(t.api);
    await later.tabs.load();
    expect(await later.call("close_tab", { tabId: a1 }, SAME_LABEL)).toMatchObject({ ok: true });
  });
});

describe("the call time is stored rarely", () => {
  test("one tabs_context call writes the call time at most once", async () => {
    const t = setup();
    await t.create(S1, "https://mail.example.com/1");
    clock += 60_000;
    let writes = 0;
    const set = t.api.sessionStorage.set;
    t.api.sessionStorage.set = async (v: Record<string, unknown>) => { if ("lastCalls" in v) writes++; return set(v); };
    await t.call("tabs_context", {}, S1);
    expect(writes).toBeLessThanOrEqual(1);
  });

  test("a call time older than the live window is not stored", async () => {
    const t = setup();
    await t.create(S1, "https://mail.example.com/1");
    clock += HOLDER_LIVE_MS + 1000;
    await t.create(S2, "https://docs.example.com/1");
    const calls = t.api.session.lastCalls as Record<string, number>;
    expect(calls[S1.id]).toBeUndefined();
    expect(calls[S2.id]).toBeDefined();
  });
});

describe("request_group allowClose and a tab that never loads", () => {
  /** A user group of 2 tabs, and an unlinked record of the same identity and title that holds approved tabs under old tab ids (a browser restart). */
  async function withUnlinkedRecord(t: ReturnType<typeof setup>, recordUrls: string[]) {
    const ids: number[] = [];
    for (let i = 0; i < 2; i++) ids.push(t.api.addTab(1 + i, `https://u.example.com/${i}`).id);
    const gid = await t.api.tabs.group(ids);
    t.api.groups.set(gid, { title: "Mail chat", color: "blue" });
    t.api.store.agentGroups = [{ identity: "alice", label: "Old chat", title: "Mail chat", color: "blue", groupId: -1, tabs: recordUrls.map((url, i) => ({ id: 900 + i, url, owned: true, adopted: true, approved: true })), holder: "gone", updatedAt: clock }];
    await t.tabs.load();
    return { ids, gid };
  }
  const approve = async (t: ReturnType<typeof setup>, gid: number, s: Record<string, unknown> = S1) => {
    const pending = t.call("request_group", { groupId: gid, allowClose: true }, s);
    for (let i = 0; i < 400 && t.api.shown.size === 0; i++) await Bun.sleep(5);
    if (t.api.shown.size === 0) return pending; // refused before any prompt: the caller reads the error
    t.api.clickNotification(0);
    return pending;
  };

  test("inside the relink window an unlinked record still blocks", async () => {
    const t = setup();
    const { gid } = await withUnlinkedRecord(t, ["https://u.example.com/0"]);
    expect(JSON.stringify(await t.call("request_group", { groupId: gid, allowClose: true }))).toContain("earlier approval protects");
  });

  test("after the window allowClose keeps the protection of the tab that an unlinked record approved, and other tabs are closable", async () => {
    const t = setup();
    const { ids, gid } = await withUnlinkedRecord(t, ["https://u.example.com/0"]);
    clock += 11 * 60_000;
    expect(t.json(await approve(t, gid))).toMatchObject({ approved: true });
    expect(await t.call("close_tab", { tabId: ids[0]! })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await t.call("close_tab", { tabId: ids[1]! })).toMatchObject({ ok: true });
  });

  test("an approved tab with no match keeps every tab approved and reports that allowClose was not applied", async () => {
    const t = setup();
    const { ids, gid } = await withUnlinkedRecord(t, ["https://u.example.com/0", "https://stuck.example.com/never-loaded"]);
    clock += 11 * 60_000;
    expect(t.json(await approve(t, gid))).toMatchObject({ approved: true, allowCloseSkipped: true });
    expect(await t.call("close_tab", { tabId: ids[0]! })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await t.call("close_tab", { tabId: ids[1]! })).toMatchObject({ ok: false, error: "forbidden_tab" });
  });

  test("the relink window does not start again when the service worker restarts", async () => {
    const t = setup();
    const { gid } = await withUnlinkedRecord(t, ["https://u.example.com/0"]);
    clock += 6 * 60_000;
    const later = setup(t.api);
    await later.tabs.load(); // the keepalive alarm woke a stopped worker
    clock += 6 * 60_000; // 12 minutes since the run started
    expect(t.json(await approve(later, gid))).toMatchObject({ approved: true });
  });
});
