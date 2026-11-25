import { describe, expect, test } from "bun:test";
import type { BrowserTool, CallRequest } from "../../../src/browser/protocol.ts";
import { Executor } from "../src/background/executor.ts";
import { State } from "../src/background/state.ts";
import { HOLDER_LIVE_MS, TabManager } from "../src/background/tabs.ts";
import { FakeChrome } from "./fakes.ts";

// One chat, several sessions: the agent session id changes when Claude Code compacts the context.
const S1 = { id: "sess-1", identity: "alice", label: "Mail chat" };
const S2 = { id: "sess-2", identity: "alice", label: "Mail chat" };
const S3 = { id: "sess-3", identity: "alice", label: "Mail chat" };
const OTHER_CHAT = { id: "sess-x", identity: "alice", label: "Another chat" };
let n = 0;
let clock = 7_000_000;

function setup(api = new FakeChrome()) {
  const tabs = new TabManager(api, () => clock);
  const executor = new Executor({ api, tabs, state: new State(api.storage) });
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

  test("a tab that waits on a beforeunload dialog stays with the chat", async () => {
    const { t, a2, gidA } = await compacted();
    // a1 stays open and owned after a "Leave site?" dialog kept it: the group still closes as a whole later.
    await t.call("tabs_context", {}, S2);
    expect(await t.call("close_group", { groupId: gidA }, S2)).toMatchObject({ ok: true });
    expect(t.api.tabList.has(a2)).toBe(false);
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

describe("request_group allowClose and a tab that never loads", () => {
  test("an unlinked old record of the identity stops blocking after the relink window", async () => {
    const t = setup();
    const ids: number[] = [];
    for (let i = 0; i < 2; i++) ids.push(t.api.addTab(1 + i, `https://u.example.com/${i}`).id);
    const gid = await t.api.tabs.group(ids);
    t.api.groups.set(gid, { title: "Mail chat", color: "blue" });
    const records = (t.tabs as unknown as { agents: Map<string, Record<string, unknown>> }).agents;
    records.set("k", { identity: "alice", label: "Old chat", title: "Mail chat", color: "blue", groupId: -1, tabs: [{ id: 99, url: "x", owned: true, adopted: false }], holder: "gone", updatedAt: clock });
    await t.tabs.load();
    const r = await t.call("request_group", { groupId: gid, allowClose: true }, S1);
    expect(JSON.stringify(r)).toContain("earlier approval protects"); // inside the window: still protected
    clock += 11 * 60_000;
    const later = t.call("request_group", { groupId: gid, allowClose: true }, S1);
    await Bun.sleep(50);
    expect(JSON.stringify(await Promise.race([later, Bun.sleep(100).then(() => "prompt")]))).not.toContain("earlier approval protects");
  });
});
