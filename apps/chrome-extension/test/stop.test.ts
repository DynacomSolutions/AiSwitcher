import { describe, expect, test } from "bun:test";
import { State } from "../src/background/state.ts";

describe("per-session and per-tab stop", () => {
  test("stopSession aborts only that session's calls and does not pause", () => {
    const s = new State();
    const a = s.track("c1", "sa");
    const a2 = s.track("c2", "sa");
    const b = s.track("c3", "sb");
    s.stopSession("sa");
    expect(a.signal.aborted).toBe(true);
    expect(a.signal.reason).toBe("stopped");
    expect(a2.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(s.paused).toBe(false);
    expect(s.inflightCount).toBe(1);
  });

  test("stopTab aborts every session marked on the tab", () => {
    const s = new State();
    s.setSessionsOnTab(t => (t === 4 ? ["sa", "sb"] : []));
    const a = s.track("c1", "sa");
    const b = s.track("c2", "sb");
    const c = s.track("c3", "sc");
    s.stopTab(4);
    expect(a.signal.aborted && b.signal.aborted).toBe(true);
    expect(c.signal.aborted).toBe(false);
    expect(s.paused).toBe(false);
    s.stopTab(9);
    expect(c.signal.aborted).toBe(false);
  });

  test("stop still aborts everything and pauses", async () => {
    const s = new State();
    const a = s.track("c1", "sa");
    await s.stop();
    expect(a.signal.aborted).toBe(true);
    expect(s.paused).toBe(true);
  });
});

test("after stopSession a new call of that session is blocked until resume", () => {
  const s = new State();
  s.stopSession("sa");
  expect(s.isStopped("sa")).toBe(true);
  expect(s.isStopped("sb")).toBe(false);
  s.resumeSession("sa");
  expect(s.isStopped("sa")).toBe(false);
});
