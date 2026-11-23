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

function setup(promptMs?: number) {
  const api = new FakeChrome();
  const tabs = new TabManager(api, () => 9_000_000);
  const executor = new Executor({ api, tabs, state: new State(api.storage), groupPromptMs: promptMs });
  const call = (tool: BrowserTool, args: Record<string, unknown> = {}) => executor.run({ id: `q${++n}`, session: AG, tool, args } as CallRequest);
  const deps = { runtimeId: ID, requests: executor.requests } as unknown as MessageDeps;
  const send = (msg: unknown, sender: MessageSender) => { const replies: unknown[] = []; const r = handleMessage(msg, sender, v => replies.push(v), deps); return { r, replies }; };
  return { api, tabs, executor, call, send };
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
    expect(t.api.popupsOpened[0]).toEqual({ path: `request.html?id=${id}`, width: 420, height: 360 });
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
    expect(changes).toBeGreaterThanOrEqual(3);
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
