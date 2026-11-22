import { describe, expect, test } from "bun:test";
import { handleMessage } from "../src/background/messages.ts";
import type { MessageDeps, MessageSender } from "../src/background/messages.ts";

const ID = "abcdefghijklmnopabcdefghijklmnop";
function setup() {
  const calls: string[] = [];
  const deps: MessageDeps = {
    runtimeId: ID,
    state: { pause: () => { calls.push("pause"); }, resume: () => { calls.push("resume"); }, stop: async () => { calls.push("stop"); }, stopSession: s => { calls.push(`stopSession:${s}`); }, stopTab: t => { calls.push(`stopTab:${t}`); } },
    status: async () => { calls.push("status"); return { status: "idle", paused: false, inflight: 0, signedIn: false, sessions: [] }; },
    setDisconnected: async v => { calls.push(`disconnected:${v}`); },
    isMarked: id => id === 7,
    isSessionMarked: (tab, s) => tab === 7 && s === "s1",
    grant: async (g, sid) => { calls.push(`grant:${g}:${sid}`); return "ok"; },
    revoke: async g => { calls.push(`revoke:${g}`); },
    updater: { check: async () => { calls.push("check"); }, update: async () => { calls.push("update"); }, setAuto: async e => { calls.push(`auto:${e}`); } },
  };
  const replies: unknown[] = [];
  const send = (type: string, sender: MessageSender) => { const r = handleMessage({ type }, sender, v => replies.push(v), deps); return r; };
  return { calls, replies, send, deps };
}
const page: MessageSender = { id: ID, origin: `chrome-extension://${ID}` };
const content = (tab: number | undefined, frameId = 0): MessageSender => ({ id: ID, origin: "https://site.test", frameId, ...(tab !== undefined ? { tab: { id: tab } } : {}) });

describe("runtime message sender checks", () => {
  test("extension pages may use every message", async () => {
    const t = setup();
    for (const m of ["ais-pause", "ais-resume", "ais-stop", "ais-disconnect", "ais-connect", "ais-status"]) t.send(m, page);
    await Bun.sleep(5);
    expect(t.calls).toEqual(["pause", "resume", "stop", "disconnected:true", "disconnected:false", "status"]);
  });

  test("another extension or an unknown sender is ignored", () => {
    const t = setup();
    expect(t.send("ais-stop", { id: "other", origin: "chrome-extension://other" })).toBe(false);
    expect(t.send("ais-resume", {})).toBe(false);
    expect(handleMessage(null, page, () => {}, { ...({} as MessageDeps) })).toBe(false);
    expect(t.calls).toEqual([]);
  });

  test("a content script may only Stop, from the top frame of a marked tab", async () => {
    const t = setup();
    expect(t.send("ais-stop", content(7))).toBe(true);
    await Bun.sleep(5);
    expect(t.calls).toEqual(["stop"]);
    t.calls.length = 0;
    expect(t.send("ais-stop", content(8))).toBe(false); // unmarked tab
    expect(t.send("ais-stop", content(undefined))).toBe(false); // no tab
    expect(t.send("ais-stop", content(7, 3))).toBe(false); // subframe
    for (const m of ["ais-resume", "ais-pause", "ais-status", "ais-disconnect", "ais-connect"]) expect(t.send(m, content(7))).toBe(false);
    expect(t.calls).toEqual([]);
  });
});

describe("per-agent stop messages", () => {
  const stopSession = (t: ReturnType<typeof setup>, sender: MessageSender, sessionId: unknown) => handleMessage({ type: "ais-stop-session", sessionId }, sender, v => t.replies.push(v), t.deps);

  test("ais-stop-session from a marked tab stops that session only", () => {
    const t = setup();
    expect(stopSession(t, content(7), "s1")).toBe(false);
    expect(t.calls).toEqual(["stopSession:s1"]);
  });

  test("ais-stop-session from a content script of an unmarked tab is refused", () => {
    const t = setup();
    stopSession(t, content(8), "s1");
    stopSession(t, content(undefined), "s1");
    stopSession(t, content(7, 2), "s1");
    expect(t.calls).toEqual([]);
  });

  test("ais-stop-session naming a session not marked on that tab is refused", () => {
    const t = setup();
    stopSession(t, content(7), "other");
    stopSession(t, content(7), 5);
    handleMessage({ type: "ais-stop-session", sessionId: "s1", tabId: 8 }, content(8), () => {}, t.deps);
    expect(t.calls).toEqual([]);
  });

  test("ais-stop-tab uses the sender tab, never the body", () => {
    const t = setup();
    handleMessage({ type: "ais-stop-tab", tabId: 99 }, content(7), () => {}, t.deps);
    handleMessage({ type: "ais-stop-tab" }, content(8), () => {}, t.deps);
    expect(t.calls).toEqual(["stopTab:7"]);
  });

  test("side panel may stop a session or a tab without the tab guard", () => {
    const t = setup();
    stopSession(t, page, "s9");
    expect(t.calls).toEqual(["stopSession:s9"]);
  });

  test("ais-stop from a content script still pauses everything (legacy single-agent pill)", async () => {
    const t = setup();
    expect(t.send("ais-stop", content(7))).toBe(true);
    await Bun.sleep(5);
    expect(t.calls).toEqual(["stop"]);
  });

  test("a message from a web page origin is ignored", () => {
    const t = setup();
    const web: MessageSender = { origin: "https://site.test", tab: { id: 7 }, frameId: 0 };
    const webWithId: MessageSender = { id: "someone-else", origin: "https://site.test", tab: { id: 7 }, frameId: 0 };
    for (const m of ["ais-stop", "ais-stop-session", "ais-stop-tab"]) {
      expect(handleMessage({ type: m, sessionId: "s1" }, web, () => {}, t.deps)).toBe(false);
      expect(handleMessage({ type: m, sessionId: "s1" }, webWithId, () => {}, t.deps)).toBe(false);
    }
    expect(t.calls).toEqual([]);
  });
});

describe("grant and revoke messages", () => {
  test("only the side panel may grant or revoke, with valid arguments", async () => {
    const t = setup();
    const send = (msg: object, sender: MessageSender) => handleMessage(msg, sender, v => t.replies.push(v), { ...({} as MessageDeps), runtimeId: ID, grant: async (g, s) => { t.calls.push(`grant:${g}:${s}`); return "ok"; }, revoke: async g => { t.calls.push(`revoke:${g}`); } });
    expect(send({ type: "ais-grant", groupId: 3, sessionId: "s1" }, page)).toBe(true);
    expect(send({ type: "ais-revoke", groupId: 3 }, page)).toBe(true);
    expect(send({ type: "ais-grant", groupId: "3", sessionId: "s1" }, page)).toBe(false);
    expect(send({ type: "ais-grant", groupId: 3, sessionId: "s1" }, { id: ID, origin: "https://site.test", frameId: 0, tab: { id: 7 } })).toBe(false);
    await Bun.sleep(5);
    expect(t.calls).toEqual(["grant:3:s1", "revoke:3"]);
    expect(t.replies).toContainEqual({ ok: false, error: "bad_args" });
    expect(t.replies.filter(r => (r as { ok: boolean }).ok)).toHaveLength(2);
  });
});

describe("update messages", () => {
  test("only the side panel can check, update or switch auto-update", async () => {
    const t = setup();
    t.send("ais-update-check", page);
    t.send("ais-update-now", page);
    handleMessage({ type: "ais-update-auto", enabled: false }, page, () => {}, t.deps);
    handleMessage({ type: "ais-update-auto", enabled: "no" }, page, () => {}, t.deps);
    t.send("ais-update-now", content(7));
    t.send("ais-update-check", content(7));
    await Bun.sleep(5);
    expect(t.calls).toEqual(["check", "update", "auto:false"]);
  });
});
