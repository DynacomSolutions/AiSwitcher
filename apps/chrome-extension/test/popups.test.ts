import { describe, expect, test } from "bun:test";
import { PopupGuard } from "../src/background/popups.ts";
import { TabManager } from "../src/background/tabs.ts";
import { FakeChrome } from "./fakes.ts";

const ref = (id = "s1", label = "fix login", identity = "alice") => ({ id, identity, label });
const settle = () => new Promise(r => setTimeout(r, 0));

async function setup() {
  const api = new FakeChrome();
  const tabs = new TabManager(api);
  const guard = new PopupGuard(api, tabs, Date.now, async () => {});
  const mine = api.addTab(1, "https://owner.example.com/");
  api.setActive(mine.id);
  await guard.load();
  const agent = await tabs.create(ref(), "https://agent.example.com/");
  return { api, tabs, guard, mine, agent };
}

describe("tabs opened by a page in an agent tab", () => {
  test("a foreground tab from a background agent tab gives the owner their tab back and joins the session", async () => {
    const { api, tabs, mine, agent } = await setup();
    const opened = api.openFromPage(agent.id);
    await settle();
    expect(api.activations).toEqual([mine.id]);
    expect(api.tabList.get(mine.id)!.active).toBe(true);
    expect(tabs.ownerOf(opened.id)).toBe("s1");
    expect(api.tabList.get(opened.id)!.groupId).toBe(api.tabList.get(agent.id)!.groupId);
  });

  test("works whichever of onCreated and onActivated Chrome fires first", async () => {
    const { api, mine, agent } = await setup();
    const t = { id: 500, windowId: 1, groupId: -1, url: "https://opened.example.com/", title: "", active: true };
    api.emit(agent.id, "Page.windowOpen", {});
    api.tabList.set(t.id, t);
    api.setActive(t.id); // activation reported first
    for (const l of api.createdListeners) l({ ...t });
    await settle();
    expect(api.activations).toEqual([mine.id]);
  });

  test("Page.windowOpen arriving just after onCreated still matches", async () => {
    const api = new FakeChrome();
    const tabs = new TabManager(api);
    let release = () => {};
    const guard = new PopupGuard(api, tabs, Date.now, () => new Promise<void>(r => { release = r; }));
    const mine = api.addTab(1);
    api.setActive(mine.id);
    await guard.load();
    const agent = await tabs.create(ref());
    const opened = api.openFromPage(agent.id, false, false);
    api.emit(agent.id, "Page.windowOpen", {});
    release();
    await settle();
    expect(api.activations).toEqual([mine.id]);
    expect(tabs.ownerOf(opened.id)).toBe("s1");
  });

  test("a stale request does not capture a tab the owner opens much later", async () => {
    const api = new FakeChrome();
    const tabs = new TabManager(api);
    let t = 0;
    const guard = new PopupGuard(api, tabs, () => t, async () => {});
    const mine = api.addTab(1);
    api.setActive(mine.id);
    await guard.load();
    const agent = await tabs.create(ref());
    api.emit(agent.id, "Page.windowOpen", {});
    t = 60_000;
    const own = api.openFromPage(mine.id, false, false);
    await settle();
    expect(api.activations).toEqual([]);
    expect(tabs.ownerOf(own.id)).toBeUndefined();
  });

  test("a background tab is claimed without touching the owner's tab", async () => {
    const { api, tabs, agent } = await setup();
    const opened = api.openFromPage(agent.id, true);
    await settle();
    expect(api.activations).toEqual([]);
    expect(tabs.ownerOf(opened.id)).toBe("s1");
  });

  test("the owner looking at the agent tab keeps normal link behaviour", async () => {
    const { api, tabs, agent } = await setup();
    api.setActive(agent.id);
    const opened = api.openFromPage(agent.id);
    await settle();
    expect(api.activations).toEqual([]);
    expect(api.tabList.get(opened.id)!.active).toBe(true);
    expect(tabs.ownerOf(opened.id)).toBeUndefined();
  });

  test("tabs opened from the owner's own tabs are left alone", async () => {
    const { api, tabs, mine } = await setup();
    const opened = api.openFromPage(mine.id);
    await settle();
    expect(api.activations).toEqual([]);
    expect(tabs.ownerOf(opened.id)).toBeUndefined();
  });

  test("the claimed tab closes with the session", async () => {
    const { api, tabs, agent } = await setup();
    const opened = api.openFromPage(agent.id);
    await settle();
    await tabs.closeSession("s1");
    expect(api.tabList.has(opened.id)).toBe(false);
  });

  test("in a user-granted group the tab stays in that group and outlives the session", async () => {
    const { api, tabs, mine } = await setup();
    const userTab = api.addTab(7, "https://granted.example.com/");
    const gid = await api.tabs.group([userTab.id]);
    await tabs.addToSession(ref(), (await tabs.create(ref())).id, false);
    expect(await tabs.grant(gid, "s1")).toBe("ok");
    const inGrant = (await tabs.createInGranted(ref(), gid))!;
    const opened = api.openFromPage(inGrant.id);
    await settle();
    expect(api.activations).toEqual([mine.id]);
    expect(api.tabList.get(opened.id)!.groupId).toBe(gid);
    await tabs.closeSession("s1");
    expect(api.tabList.has(opened.id)).toBe(true);
  });
});
