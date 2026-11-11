import { describe, expect, test } from "bun:test";
import { handleMessage } from "../src/background/messages.ts";
import type { MessageDeps, MessageSender } from "../src/background/messages.ts";

const ID = "abcdefghijklmnopabcdefghijklmnop";
function setup() {
  const calls: string[] = [];
  const deps: MessageDeps = {
    runtimeId: ID,
    state: { pause: () => { calls.push("pause"); }, resume: () => { calls.push("resume"); }, stop: async () => { calls.push("stop"); } },
    status: async () => { calls.push("status"); return { status: "idle", paused: false, inflight: 0, signedIn: false, sessions: [] }; },
    setDisconnected: async v => { calls.push(`disconnected:${v}`); },
    isMarked: id => id === 7,
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
