import { describe, expect, test } from "bun:test";
import type { CallRequest } from "../../../src/browser/protocol.ts";
import { ChatHub } from "../src/background/chat.ts";
import { Executor } from "../src/background/executor.ts";
import { MAX_STOPPED, State } from "../src/background/state.ts";
import { TabManager } from "../src/background/tabs.ts";
import { FakeChrome } from "./fakes.ts";

describe("stop follow-ups", () => {
  test("an idle session that expires loses its stop block", async () => {
    const api = new FakeChrome();
    let now = 0;
    const tabs = new TabManager(api, () => now);
    const state = new State();
    tabs.onExpired = id => state.resumeSession(id);
    await tabs.create({ id: "s1", identity: "alice", label: "l" }, "https://example.test/");
    state.stopSession("s1");
    expect(state.isStopped("s1")).toBe(true);
    tabs.expireIdle();
    now += 31 * 60_000;
    tabs.expireIdle();
    now += 31 * 60_000;
    tabs.expireIdle();
    expect(state.isStopped("s1")).toBe(false);
  });

  test("the stopped set is capped and drops the oldest", () => {
    const s = new State();
    for (let i = 0; i < MAX_STOPPED + 5; i++) s.stopSession(`s${i}`);
    expect(s.isStopped("s0")).toBe(false);
    expect(s.isStopped("s4")).toBe(false);
    expect(s.isStopped("s5")).toBe(true);
    expect(s.isStopped(`s${MAX_STOPPED + 4}`)).toBe(true);
  });

  test("a session end from another identity does not lift the block", async () => {
    const api = new FakeChrome();
    const state = new State(api.storage);
    const executor = new Executor({ api, tabs: new TabManager(api), state, defaultTimeoutMs: 200 });
    const call = (tool: string, identity: string): CallRequest => ({ id: `k${Math.random()}`, session: { id: "s1", identity, label: "l" }, tool, args: {} }) as CallRequest;
    await executor.run(call("tabs_context", "alice"));
    state.stopSession("s1");
    await executor.run(call("session_end", "mallory"));
    expect(state.isStopped("s1")).toBe(true);
    expect(await executor.run(call("tabs_context", "alice"))).toMatchObject({ ok: false, error: "stopped_by_user" });
    await executor.run(call("session_end", "alice"));
    expect(state.isStopped("s1")).toBe(false);
  });

  test("the full stop cancels every chat with a running turn and no other", () => {
    const api = new FakeChrome();
    const sent: Array<{ t: string; chatId?: string }> = [];
    const hub = new ChatHub({ send: f => { sent.push(f as never); return true; }, tabs: new TabManager(api), storage: api.sessionStorage, now: () => 0, newId: () => "x" });
    const sum = (chatId: string, state: "idle" | "thinking" | "waiting") => ({ chatId, name: "n", color: "#3b82f6", windowId: 1, state, selection: { provider: "claude" as const, identity: "a" }, tabIds: [], lastSeq: 0, updatedAt: 1 });
    for (const [id, st] of [["a", "thinking"], ["b", "idle"], ["c", "waiting"]] as const) hub.handleFrame({ t: "chat.state", chatId: id, state: st, summary: sum(id, st) });
    const state = new State();
    state.onStop(() => hub.cancelRunning());
    void state.stop();
    expect(sent).toEqual([{ t: "chat.cancel", chatId: "a" }, { t: "chat.cancel", chatId: "c" }]);
  });
});
