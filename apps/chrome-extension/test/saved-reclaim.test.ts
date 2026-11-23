import { describe, expect, test } from "bun:test";
import type { BrowserTool, CallRequest } from "../../../src/browser/protocol.ts";
import { Executor } from "../src/background/executor.ts";
import { State } from "../src/background/state.ts";
import { HOLDER_LIVE_MS, TabManager } from "../src/background/tabs.ts";
import { FakeChrome } from "./fakes.ts";

const OLD = { id: "old-1", identity: "alice", label: "ContractFinder" };
const NEW = { id: "new-1", identity: "alice", label: "ContractFinder" };
const NEW_LABEL = { id: "new-2", identity: "alice", label: "Another chat" };
const NEW_IDENTITY = { id: "new-3", identity: "bob", label: "ContractFinder" };
let n = 0;
let clock = 9_000_000;

function setup(api = new FakeChrome()) {
  const tabs = new TabManager(api, () => clock);
  const executor = new Executor({ api, tabs, state: new State(api.storage) });
  const call = (tool: BrowserTool | "session_end", args: Record<string, unknown> = {}, s = OLD) => executor.run({ id: `r${++n}`, session: s, tool, args } as CallRequest);
  const json = (r: Awaited<ReturnType<typeof call>>) => JSON.parse(r.ok && r.content[0]?.type === "text" ? r.content[0].text : "{}");
  const create = async (s = OLD, url?: string): Promise<number> => json(await call("tabs_create", url ? { url } : {}, s)).tabId;
  return { api, tabs, executor, call, json, create };
}

type T = ReturnType<typeof setup>;

/** The old session makes 5 tabs (1 and 2 split, 3 and 4 split) and saves the group as "ContractFinder". */
async function savedCase(count = 5) {
  const t = setup();
  const ids: number[] = [];
  for (let i = 0; i < count; i++) ids.push(await t.create(OLD, `https://jobs.example.com/${i}`));
  await t.api.tabs.createSplit([ids[0]!, ids[1]!]);
  await t.api.tabs.createSplit([ids[2]!, ids[3]!]);
  expect((await t.call("save_group", { name: "ContractFinder" })).ok).toBe(true);
  return { t, ids, gid: t.api.tabList.get(ids[0]!)!.groupId };
}

function shape(api: FakeChrome) {
  return JSON.stringify([...api.tabList.values()].map(x => [x.id, x.groupId, x.splitViewId, x.index, x.active]));
}

function untouched(t: T) {
  const before = { shape: shape(t.api), move: t.api.moveCalls.length, act: t.api.activations.length, created: t.api.createdActive.length, group: t.api.groupWindowIds.length, remove: t.api.removeCalls.length, split: t.api.splitCalls.length, unsplit: t.api.unsplitCalls.length };
  return () => {
    expect(shape(t.api)).toBe(before.shape);
    expect(t.api.moveCalls.length).toBe(before.move);
    expect(t.api.activations.length).toBe(before.act);
    expect(t.api.createdActive.length).toBe(before.created);
    expect(t.api.groupWindowIds.length).toBe(before.group);
    expect(t.api.removeCalls.length).toBe(before.remove);
    expect(t.api.splitCalls.length).toBe(before.split);
    expect(t.api.unsplitCalls.length).toBe(before.unsplit);
  };
}

const navigateOk = (t: T, id: number) => { t.api.cdpResults["Page.navigate"] = () => { queueMicrotask(() => t.api.emit(id, "Page.navigatedWithinDocument", {})); return {}; }; };

describe("a later session of the chat regains its saved group", () => {
  test("save_group records the chat label and keeps it in storage", async () => {
    const { t } = await savedCase();
    expect((t.api.store["savedGroups"] as Array<{ label?: string }>)[0]!.label).toBe("ContractFinder");
  });

  test("the first call of a new session of the same chat regains the group: nothing moves, find works, one tab of a split pair closes", async () => {
    const { t, ids, gid } = await savedCase();
    clock += HOLDER_LIVE_MS + 1000;
    const same = untouched(t);
    const ctx = t.json(await t.call("tabs_context", {}, NEW));
    expect(ctx.sessionTabs.map((x: { tabId: number }) => x.tabId)).toEqual(ids);
    expect(ctx.otherTabs).toEqual([]);
    expect(ctx.sessionTabs.every((x: { scope: string }) => x.scope === "granted")).toBe(true); // the state right after save_group
    expect(ctx.groups).toEqual([{ groupId: gid, title: "ContractFinder", tabCount: 5, scope: "granted", hiddenTabCount: 0 }]);
    same();
    navigateOk(t, ids[0]!);
    const find = await t.call("find", { tabId: ids[4]!, query: "x" }, NEW);
    expect(find.ok === false && find.error === "forbidden_tab").toBe(false);
    const partner = t.api.tabList.get(ids[1]!)!.splitViewId;
    expect(partner).not.toBe(-1);
    expect((await t.call("close_tab", { tabId: ids[0]! }, NEW)).ok).toBe(true);
    expect(t.api.tabList.has(ids[0]!)).toBe(false);
    expect(t.api.tabList.has(ids[1]!)).toBe(true);
    expect(t.api.tabList.get(ids[1]!)!.groupId).toBe(gid);
    expect(t.api.tabList.get(ids[2]!)!.splitViewId).toBe(t.api.tabList.get(ids[3]!)!.splitViewId);
    expect(t.api.tabList.get(ids[2]!)!.splitViewId).not.toBe(-1);
  });

  test("the saved entry stays saved and its holder becomes the new session; session end keeps every tab", async () => {
    const { t, ids, gid } = await savedCase();
    clock += HOLDER_LIVE_MS + 1000;
    await t.call("tabs_context", {}, NEW);
    expect(await t.tabs.savedGroups("alice")).toEqual([{ name: "ContractFinder", groupId: gid, open: true, tabCount: 5 }]);
    expect(t.tabs.grantee(gid)).toBe(NEW.id);
    await t.call("session_end", {}, NEW);
    expect(t.api.tabList.size).toBe(5);
    for (const id of ids) expect(t.api.tabList.get(id)!.groupId).toBe(gid);
  });

  test("open_group on the open saved group regains it the same way", async () => {
    const { t, ids, gid } = await savedCase();
    clock += HOLDER_LIVE_MS + 1000;
    const same = untouched(t);
    const r = await t.call("open_group", { name: "ContractFinder" }, NEW);
    expect(r.ok).toBe(true);
    expect(t.json(r).groupId).toBe(gid);
    same();
    expect(t.tabs.sessions.get(NEW.id)!.tabIds.size).toBe(5);
    expect((await t.call("close_tab", { tabId: ids[4]! }, NEW)).ok).toBe(true);
    expect(t.api.tabList.has(ids[4]!)).toBe(false);
    expect(t.api.tabList.has(ids[1]!)).toBe(true);
  });

  test("close_group still refuses the saved group", async () => {
    const { t, gid } = await savedCase();
    clock += HOLDER_LIVE_MS + 1000;
    await t.call("tabs_context", {}, NEW);
    const r = await t.call("close_group", { groupId: gid }, NEW);
    expect(r).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.tabList.size).toBe(5);
  });

  test("an old entry without a label regains through the chat's own agent record", async () => {
    const { t, ids, gid } = await savedCase();
    const saved = (t.api.store["savedGroups"] as Array<Record<string, unknown>>);
    delete saved[0]!["label"];
    t.api.store["agentGroups"] = [{ identity: "alice", label: "ContractFinder", title: "ContractFinder", color: "blue", groupId: gid, tabs: ids.map(id => ({ id, url: t.api.tabList.get(id)!.url, owned: true, adopted: false })), holder: OLD.id, updatedAt: clock }];
    const fresh = setup(t.api);
    // A restart of the extension in the same browser run: the ids stay, the session state is lost.
    t.api.session = {};
    await fresh.tabs.load();
    clock += HOLDER_LIVE_MS + 1000;
    const same = untouched(fresh);
    const ctx = fresh.json(await fresh.call("tabs_context", {}, NEW));
    expect(ctx.sessionTabs.map((x: { tabId: number }) => x.tabId)).toEqual(ids);
    same();
    expect((fresh.api.store["savedGroups"] as Array<{ label?: string }>)[0]!.label).toBe("ContractFinder");
  });

  test("an old entry without a label and no linking record is not regained", async () => {
    const { t } = await savedCase();
    delete (t.api.store["savedGroups"] as Array<Record<string, unknown>>)[0]!["label"];
    t.api.session = {}; // the extension restarted: no session state is left
    const fresh = setup(t.api);
    await fresh.tabs.load();
    clock += HOLDER_LIVE_MS + 1000;
    const ctx = fresh.json(await fresh.call("tabs_context", {}, NEW));
    expect(ctx.sessionTabs).toEqual([]);
    expect(ctx.otherTabs).toHaveLength(5);
  });

  test("a different identity never regains it", async () => {
    const { t, ids } = await savedCase();
    clock += HOLDER_LIVE_MS + 1000;
    const ctx = t.json(await t.call("tabs_context", {}, NEW_IDENTITY));
    expect(ctx.sessionTabs).toEqual([]);
    expect(await t.call("close_tab", { tabId: ids[0]! }, NEW_IDENTITY)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await t.call("open_group", { name: "ContractFinder" }, NEW_IDENTITY)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.tabs.grantee(t.api.tabList.get(ids[0]!)!.groupId)).toBe(OLD.id);
  });

  test("the same identity with another chat label never regains it", async () => {
    const { t, ids } = await savedCase();
    clock += HOLDER_LIVE_MS + 1000;
    const ctx = t.json(await t.call("tabs_context", {}, NEW_LABEL));
    expect(ctx.sessionTabs).toEqual([]);
    expect(await t.call("close_tab", { tabId: ids[0]! }, NEW_LABEL)).toMatchObject({ ok: false, error: "forbidden_tab" });
    // open_group gives no ownership to another chat: no tab becomes closable.
    await t.call("open_group", { name: "ContractFinder" }, NEW_LABEL);
    expect(await t.call("close_tab", { tabId: ids[0]! }, NEW_LABEL)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.tabs.sessions.get(NEW_LABEL.id)?.tabIds.size ?? 0).toBe(0);
  });

  test("a live old session keeps the group", async () => {
    const { t, ids, gid } = await savedCase();
    clock += HOLDER_LIVE_MS - 1000; // the old session was active a moment ago
    await t.call("tabs_context", {}, OLD);
    clock += 2000;
    const ctx = t.json(await t.call("tabs_context", {}, NEW));
    expect(ctx.sessionTabs).toEqual([]);
    expect(t.tabs.grantee(gid)).toBe(OLD.id);
    expect(await t.call("close_tab", { tabId: ids[0]! }, NEW)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await t.call("open_group", { name: "ContractFinder" }, NEW)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.tabs.sessions.get(OLD.id)!.tabIds.size).toBe(5);
  });

  test("an old session with a call in progress keeps the group", async () => {
    const { t, gid } = await savedCase();
    t.tabs.callStarted(OLD.id);
    clock += 3 * HOLDER_LIVE_MS;
    const ctx = t.json(await t.call("tabs_context", {}, NEW));
    expect(ctx.sessionTabs).toEqual([]);
    expect(t.tabs.grantee(gid)).toBe(OLD.id);
  });

  test("a new session that already has an own group with tabs does not regain", async () => {
    const t = setup();
    const own = await t.create(NEW, "https://own.example.com/"); // the new session has its own group first
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push(await t.create(OLD, `https://jobs.example.com/${i}`));
    expect((await t.call("save_group", { name: "ContractFinder" })).ok).toBe(true);
    const gid = t.api.tabList.get(ids[0]!)!.groupId;
    clock += HOLDER_LIVE_MS + 1000;
    const ctx = t.json(await t.call("tabs_context", {}, NEW));
    expect(ctx.sessionTabs.map((x: { tabId: number }) => x.tabId)).toEqual([own]);
    expect(t.tabs.grantee(gid)).toBe(OLD.id);
    expect(await t.call("open_group", { name: "ContractFinder" }, NEW)).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await t.call("close_tab", { tabId: ids[0]! }, NEW)).toMatchObject({ ok: false, error: "forbidden_tab" });
  });

  test("an approved tab is still refused by close_tab after the regain", async () => {
    const { t, ids } = await savedCase();
    t.tabs.sessions.get(OLD.id)!.approved = new Set([ids[4]!]);
    clock += HOLDER_LIVE_MS + 1000;
    await t.call("tabs_context", {}, NEW);
    expect(t.tabs.isApproved(NEW.id, ids[4]!)).toBe(true);
    const r = await t.call("close_tab", { tabId: ids[4]! }, NEW);
    expect(r).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.tabList.has(ids[4]!)).toBe(true);
    expect((await t.call("close_tab", { tabId: ids[3]! }, NEW)).ok).toBe(true);
  });

  test("the regain survives an extension restart with a new browser run", async () => {
    const { t, ids } = await savedCase();
    const map = t.api.restart();
    const fresh = setup(t.api);
    await fresh.tabs.load();
    expect((fresh.api.store["savedGroups"] as Array<{ label?: string }>)[0]!.label).toBe("ContractFinder");
    const same = untouched(fresh);
    const ctx = fresh.json(await fresh.call("tabs_context", {}, NEW));
    const newIds = ids.map(id => map.get(id)!);
    expect(ctx.sessionTabs.map((x: { tabId: number }) => x.tabId)).toEqual(newIds);
    expect(ctx.otherTabs).toEqual([]);
    same();
    expect((await fresh.call("close_tab", { tabId: newIds[0]! }, NEW)).ok).toBe(true);
    expect(fresh.api.tabList.has(newIds[1]!)).toBe(true);
  });

  test("after the regain the old session cannot control the tabs", async () => {
    const { t, ids } = await savedCase();
    clock += HOLDER_LIVE_MS + 1000;
    await t.call("tabs_context", {}, NEW);
    expect(await t.call("close_tab", { tabId: ids[0]! }, OLD)).toMatchObject({ ok: false, error: "forbidden_tab" });
  });
});
