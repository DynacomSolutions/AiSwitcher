import { describe, expect, test } from "bun:test";
import type { BrowserTool, CallRequest } from "../../../src/browser/protocol.ts";
import { Executor } from "../src/background/executor.ts";
import { handleMessage } from "../src/background/messages.ts";
import type { MessageDeps, MessageSender } from "../src/background/messages.ts";
import { State } from "../src/background/state.ts";
import { TabManager } from "../src/background/tabs.ts";
import { createRequestView, renderRequest } from "../src/shared/request-card.ts";
import { countdownText } from "../src/shared/request.ts";
import { asDoc, asEl, fakeDoc, walk } from "./fake-dom.ts";
import { FakeChrome } from "./fakes.ts";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const AG = { id: "agent-1", identity: "alice", label: "ContractFinder" };
let n = 0;

function setup(promptMs?: number, waitMs?: number) {
  const api = new FakeChrome();
  const tabs = new TabManager(api, () => 9_000_000);
  const state = new State(api.storage);
  const executor = new Executor({ api, tabs, state, groupPromptMs: promptMs, groupWaitMs: waitMs });
  const call = (tool: BrowserTool, args: Record<string, unknown> = {}, id = `q${++n}`) => executor.run({ id, session: AG, tool, args } as CallRequest);
  const deps = { runtimeId: ID, requests: executor.requests } as unknown as MessageDeps;
  const text = (r: Awaited<ReturnType<typeof call>>) => JSON.parse(r.ok && r.content[0]?.type === "text" ? r.content[0].text : "{}");
  const send = (msg: unknown, sender: MessageSender) => { const replies: unknown[] = []; const r = handleMessage(msg, sender, v => replies.push(v), deps); return { r, replies }; };
  return { api, tabs, state, executor, call, send, text };
}
async function userGroup(api: FakeChrome, count = 3) {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) ids.push(api.addTab(1 + i, `https://jobs.example.com/${i}`).id);
  const gid = await api.tabs.group(ids);
  api.groups.set(gid, { title: "Jobs", color: "blue" });
  return { ids, gid };
}
async function until(fn: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !fn(); i++) await Bun.sleep(5);
  expect(fn()).toBe(true);
}
const page: MessageSender = { id: ID, origin: `chrome-extension://${ID}`, url: `chrome-extension://${ID}/sidepanel.html` };
const contentScript: MessageSender = { id: ID, origin: "https://site.test", url: "https://site.test/page", frameId: 0, tab: { id: 7 } };

describe("pending group requests", () => {
  test("the pending list API returns the request with its facts and deadline", async () => {
    const t = setup(5000);
    const { gid } = await userGroup(t.api);
    const pending = t.call("request_group", { groupId: gid, allowClose: true });
    await until(() => t.executor.requests.list().length === 1);
    const { replies } = t.send({ type: "ais-requests" }, page);
    const [req] = replies[0] as Array<Record<string, unknown>>;
    expect(req).toMatchObject({ agentLabel: "ContractFinder", identity: "alice", groupId: gid, groupTitle: "Jobs", tabCount: 3, allowClose: true, consent: "The agent can read, use and CLOSE these tabs." });
    expect((req!.deadline as number) - (req!.createdAt as number)).toBe(5000);
    expect(req!.note).toBeUndefined();
    t.executor.requests.answer(req!.id as string, false);
    await pending;
    expect(t.executor.requests.list()).toEqual([]);
  });

  test("a notification body click opens the side panel of the last focused window", async () => {
    const t = setup(5000);
    t.api.focusedWindowId = 4;
    const { gid } = await userGroup(t.api);
    const pending = t.call("request_group", { groupId: gid });
    await until(() => t.api.shown.size === 1);
    t.api.clickNotificationBody();
    await until(() => t.api.sidePanelOpened.length === 1);
    expect(t.api.sidePanelOpened).toEqual([4]);
    expect(t.api.popupsOpened).toEqual([]);
    t.api.clickNotification(1);
    await pending;
  });

  test("when sidePanel.open throws, a 420 by 360 popup window opens for that request", async () => {
    const t = setup(5000);
    t.api.sidePanelFails = true;
    const { gid } = await userGroup(t.api);
    const pending = t.call("request_group", { groupId: gid });
    await until(() => t.api.shown.size === 1);
    t.api.clickNotificationBody();
    await until(() => t.api.popupsOpened.length === 1);
    const id = t.executor.requests.list()[0]!.id;
    expect(t.api.popupsOpened[0]).toMatchObject({ path: `request.html?id=${id}`, width: 420, height: 360 });
    t.api.clickNotification(1);
    await pending;
  });

  test("a click after the request ended opens nothing", async () => {
    const t = setup(5000);
    const { gid } = await userGroup(t.api);
    const pending = t.call("request_group", { groupId: gid });
    await until(() => t.api.shown.size === 1);
    const id = t.api.everShown[0]!.id;
    t.api.clickNotification(1);
    await pending;
    for (const l of t.api.notificationClickListeners) l(id);
    await Bun.sleep(10);
    expect(t.api.sidePanelOpened).toEqual([]);
    expect(t.api.popupsOpened).toEqual([]);
  });

  test("approve from the side panel takes the group and clears the notification", async () => {
    const t = setup(5000);
    const { ids, gid } = await userGroup(t.api);
    const pending = t.call("request_group", { groupId: gid });
    await until(() => t.executor.requests.list().length === 1);
    const id = t.executor.requests.list()[0]!.id;
    const { replies } = t.send({ type: "ais-request-answer", id, approve: true }, page);
    expect(replies).toEqual([{ ok: true }]);
    const r = await pending;
    expect(r.ok).toBe(true);
    expect(t.tabs.sessions.get("agent-1")!.tabIds.size).toBe(ids.length);
    expect(t.api.shown.size).toBe(0);
    expect(t.api.clearedNotifications).toContain(id);
    // A second answer finds nothing.
    expect(t.send({ type: "ais-request-answer", id, approve: true }, page).replies).toEqual([{ ok: false }]);
  });

  test("deny from the side panel refuses with forbidden_tab", async () => {
    const t = setup(5000);
    const { gid } = await userGroup(t.api);
    const pending = t.call("request_group", { groupId: gid });
    await until(() => t.executor.requests.list().length === 1);
    t.send({ type: "ais-request-answer", id: t.executor.requests.list()[0]!.id, approve: false }, page);
    expect(await pending).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.tabs.sessions.get("agent-1")?.tabIds.size ?? 0).toBe(0);
  });

  test("a timeout removes the request and clears the notification", async () => {
    const t = setup(40);
    const { gid } = await userGroup(t.api);
    const pending = t.call("request_group", { groupId: gid });
    await until(() => t.executor.requests.list().length === 1);
    expect(await pending).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.executor.requests.list()).toEqual([]);
    expect(t.api.shown.size).toBe(0);
  });

  test("listeners hear when a request starts and ends", async () => {
    const t = setup(5000);
    let changes = 0;
    t.executor.requests.onChange(() => { changes++; });
    const { gid } = await userGroup(t.api);
    const pending = t.call("request_group", { groupId: gid });
    await until(() => changes === 1);
    t.executor.requests.answer(t.executor.requests.list()[0]!.id, false);
    await pending;
    expect(changes).toBe(2);
  });

  test("a content script is refused, with a web page origin, with a spoofed url, and from another extension", async () => {
    const t = setup(5000);
    const { ids, gid } = await userGroup(t.api);
    const pending = t.call("request_group", { groupId: gid });
    await until(() => t.executor.requests.list().length === 1);
    const id = t.executor.requests.list()[0]!.id;
    for (const sender of [contentScript, { ...contentScript, url: `chrome-extension://${ID}/x` }, { id: ID, origin: `chrome-extension://${ID}`, url: "https://site.test/" }, { id: "other", origin: "chrome-extension://other" }, {}] as MessageSender[]) {
      for (const msg of [{ type: "ais-request-answer", id, approve: true }, { type: "ais-requests" }]) {
        const { r, replies } = t.send(msg, sender);
        expect(r).toBe(false);
        expect(replies).toEqual([]);
      }
    }
    expect(t.executor.requests.list().length).toBe(1);
    expect(t.tabs.sessions.get("agent-1")?.tabIds.size ?? 0).toBe(0);
    t.executor.requests.answer(id, false);
    await pending;
    expect(ids.length).toBe(3);
  });

  test("a bad answer body is refused with bad_args", async () => {
    const t = setup(5000);
    const { replies } = t.send({ type: "ais-request-answer", id: 5, approve: "yes" }, page);
    expect(replies).toEqual([{ ok: false, error: "bad_args" }]);
  });
});

describe("agent cannot approve its own request", () => {
  const extUrl = `chrome-extension://${ID}/request.html?id=x`;

  test("a failed notification opens no window and keeps the request in the side panel with a badge", async () => {
    const t = setup(5000);
    t.api.notifications.create = async () => { throw new Error("no notifications"); };
    const { gid } = await userGroup(t.api);
    const pending = t.call("request_group", { groupId: gid });
    await until(() => t.executor.requests.list().length === 1);
    await Bun.sleep(20);
    expect(t.api.popupsOpened).toEqual([]);
    expect(t.api.sidePanelOpened).toEqual([]);
    expect(t.api.badge).toBe("!");
    t.send({ type: "ais-request-answer", id: t.executor.requests.list()[0]!.id, approve: false }, page);
    await pending;
    expect(t.api.badge).toBe("");
  });

  test("a tab that shows an extension page cannot read or answer requests", async () => {
    const t = setup(5000);
    const { gid } = await userGroup(t.api);
    const pending = t.call("request_group", { groupId: gid });
    await until(() => t.executor.requests.list().length === 1);
    const id = t.executor.requests.list()[0]!.id;
    const inTab: MessageSender = { ...page, tab: { id: 55 }, url: extUrl, frameId: 0 };
    for (const msg of [{ type: "ais-requests" }, { type: "ais-request-answer", id, approve: true }]) {
      const { r, replies } = t.send(msg, inTab);
      expect(r).toBe(false);
      expect(replies).toEqual([]);
    }
    expect(t.executor.requests.list().length).toBe(1);
    t.executor.requests.answer(id, false);
    await pending;
  });

  test("the popup tab opened for a request sees and answers only that request", async () => {
    const t = setup(5000);
    const g1 = await userGroup(t.api, 2);
    const p1 = t.call("request_group", { groupId: g1.gid });
    await until(() => t.api.shown.size === 1);
    const first = t.executor.requests.list()[0]!.id;
    const g2 = await userGroup(t.api, 2);
    const p2 = t.executor.requests; // second request from another session
    const other = t.executor.run({ id: "q-other", session: { id: "agent-2", identity: "alice", label: "Other" }, tool: "request_group", args: { groupId: g2.gid } } as CallRequest);
    await until(() => t.executor.requests.list().length === 2);
    t.api.sidePanelFails = true;
    t.api.clickNotificationBody(first);
    await until(() => t.api.popupsOpened.length === 1);
    const popupTab = t.api.popupsOpened[0]!.tabId;
    const sender: MessageSender = { ...page, tab: { id: popupTab }, url: `chrome-extension://${ID}/request.html?id=${first}` };
    const listed = t.send({ type: "ais-requests" }, sender).replies[0] as Array<{ id: string }>;
    expect(listed.map(r => r.id)).toEqual([first]);
    const secondId = p2.list().find(r => r.id !== first)!.id;
    expect(t.send({ type: "ais-request-answer", id: secondId, approve: true }, sender).replies).toEqual([]);
    expect(t.send({ type: "ais-request-answer", id: first, approve: false }, sender).replies).toEqual([{ ok: true }]);
    await p1;
    // The tab closes: it can no longer answer.
    for (const l of t.api.removedListeners) l(popupTab);
    expect(t.send({ type: "ais-request-answer", id: secondId, approve: false }, sender).r).toBe(false);
    p2.answer(secondId, false);
    await other;
  });

  test("adopt_tab, tabs_context and every tab tool refuse a browser or extension page", async () => {
    const t = setup(5000);
    const ext = t.api.addTab(70, extUrl);
    const settings = t.api.addTab(71, "chrome://settings/");
    const dev = t.api.addTab(72, "devtools://devtools/bundled/inspector.html");
    const web = t.api.addTab(73, "https://example.com/");
    for (const tab of [ext, settings, dev]) {
      expect(await t.call("adopt_tab", { tabId: tab.id })).toMatchObject({ ok: false, error: "forbidden_tab" });
    }
    expect((await t.call("adopt_tab", { tabId: web.id })).ok).toBe(true);
    const ctx = t.text(await t.call("tabs_context"));
    expect([...ctx.sessionTabs, ...ctx.otherTabs].map((x: { tabId: number }) => x.tabId)).toEqual([web.id]);
    // A session tab that later shows an extension page: no tool acts on it.
    t.api.tabList.get(web.id)!.url = extUrl;
    for (const [tool, args] of [["javascript", { code: "1" }], ["click", { coordinate: [1, 1] }], ["type", { text: "a" }], ["key", { key: "Enter" }], ["form_input", { ref: "r", value: "v" }], ["read_page", {}], ["screenshot", {}], ["navigate", { url: "https://example.com" }], ["close_tab", {}]] as const) {
      expect(await t.call(tool as BrowserTool, { tabId: web.id, ...args })).toMatchObject({ ok: false, error: "forbidden_tab" });
    }
    for (const tab of [ext, settings, dev]) expect(t.api.attachedTabs.has(tab.id)).toBe(false);
  });
});

describe("request_group returns before the agent tool timeout", () => {
  test("no answer in time gives pending, and the answer arrives on the second call", async () => {
    const t = setup(5000, 30);
    const { gid } = await userGroup(t.api);
    const first = await t.call("request_group", { groupId: gid });
    const body = t.text(first);
    expect(body).toMatchObject({ pending: true, message: "Waiting for the owner. Call request_group again with the same groupId to get the answer." });
    expect(body.requestId).toBe(t.executor.requests.list()[0]!.id);
    expect(typeof body.deadline).toBe("number");
    expect(t.api.shown.size).toBe(1);
    const second = t.call("request_group", { groupId: gid });
    await Bun.sleep(5);
    t.api.clickNotification(0);
    const r = await second;
    expect(t.text(r)).toMatchObject({ approved: true, tabCount: 3 });
    expect(t.api.everShown.length).toBe(1);
  });

  test("an answer between two calls is returned at once", async () => {
    const t = setup(5000, 20);
    const { gid } = await userGroup(t.api);
    await t.call("request_group", { groupId: gid });
    t.api.clickNotification(0);
    const r = await t.call("request_group", { groupId: gid });
    expect(t.text(r)).toMatchObject({ approved: true });
    expect(t.api.everShown.length).toBe(1);
  });

  test("a denial between two calls is returned at once, once", async () => {
    const t = setup(5000, 20);
    const { gid } = await userGroup(t.api);
    await t.call("request_group", { groupId: gid });
    t.api.clickNotification(1);
    expect(await t.call("request_group", { groupId: gid })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(t.api.everShown.length).toBe(1);
    // Delivered: a later call asks again.
    await t.call("request_group", { groupId: gid });
    expect(t.api.everShown.length).toBe(2);
    t.api.clickNotification(1);
  });

  test("an abort of the call keeps the request pending, and a repeat call joins it", async () => {
    const t = setup(5000, 5000);
    const { gid } = await userGroup(t.api);
    const aborted = t.call("request_group", { groupId: gid }, "abort-1");
    await until(() => t.api.shown.size === 1);
    t.state.abort("abort-1");
    expect((await aborted).ok).toBe(false);
    expect(t.executor.requests.list().length).toBe(1);
    expect(t.api.shown.size).toBe(1);
    const again = t.call("request_group", { groupId: gid });
    await Bun.sleep(10);
    t.api.clickNotification(0);
    expect(t.text(await again)).toMatchObject({ approved: true });
    expect(t.api.everShown.length).toBe(1);
  });

  test("another session is refused while the request is pending", async () => {
    const t = setup(5000, 20);
    const { gid } = await userGroup(t.api);
    await t.call("request_group", { groupId: gid });
    const other = await t.executor.run({ id: "q-o", session: { id: "agent-2", identity: "alice", label: "Other" }, tool: "request_group", args: { groupId: gid } } as CallRequest);
    expect(other).toMatchObject({ ok: false, error: "forbidden_tab" });
    t.api.clickNotification(1);
  });

  test("a timeout of the request itself gives the same error", async () => {
    const t = setup(40, 5000);
    const { gid } = await userGroup(t.api);
    const r = await t.call("request_group", { groupId: gid });
    expect(r).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(r.ok ? "" : r.message).toContain("did not answer");
  });
});

describe("request card", () => {
  const req = { id: "r1", agentLabel: "ContractFinder", identity: "alice", groupId: 3, groupTitle: "Jobs", tabCount: 3, allowClose: true, shared: true, consent: "The agent can read, use and CLOSE these tabs.", note: "Another agent session made this group.", createdAt: 0, deadline: 125_000 };

  test("shows the title, agent, group, tabs, consent, note and countdown", () => {
    const doc = fakeDoc();
    const card = renderRequest(asDoc(doc), req, 5000, () => {}) as unknown as ReturnType<typeof doc.createElement>;
    const text = card.textContent;
    for (const s of ["An agent asks to use a tab group", "ContractFinder", "Jobs", "3", "The agent can read, use and CLOSE these tabs.", "Another agent session made this group.", "2:00 left", "Approve", "Deny"]) expect(text).toContain(s);
    expect(countdownText(1000, 5000)).toBe("0:00 left");
  });

  test("the buttons answer once and the view reloads and empties", async () => {
    const doc = fakeDoc();
    const root = doc.createElement("div");
    let list = [req];
    const answers: Array<[string, boolean]> = [];
    let empty = 0;
    const view = createRequestView({ doc: asDoc(doc), root: asEl(root), fetch: async () => list, answer: async (id, a) => { answers.push([id, a]); list = []; }, now: () => 5000, onEmpty: () => { empty++; } });
    await view.refresh();
    expect(root.hidden).toBe(false);
    const buttons = walk(root).filter(x => x.tag === "button");
    expect(buttons.map(b => b.textContent)).toEqual(["Approve", "Deny"]);
    buttons[0]!.click();
    buttons[0]!.click();
    await Bun.sleep(10);
    expect(answers.length).toBe(1);
    expect(answers[0]).toEqual(["r1", true]);
    expect(root.hidden).toBe(true);
    expect(root.children.length).toBe(0);
    expect(empty).toBe(1);
  });

  test("the popup view shows only its request and reports when it ended", async () => {
    const doc = fakeDoc();
    const root = doc.createElement("div");
    let list = [req, { ...req, id: "r2", agentLabel: "Other" }];
    let empty = 0;
    const view = createRequestView({ doc: asDoc(doc), root: asEl(root), fetch: async () => list, answer: async () => {}, now: () => 0, only: "r2", onEmpty: () => { empty++; } });
    await view.refresh();
    expect(root.textContent).toContain("Other");
    expect(root.textContent).not.toContain("ContractFinder");
    list = [];
    await view.refresh();
    expect(empty).toBe(1);
  });
});
