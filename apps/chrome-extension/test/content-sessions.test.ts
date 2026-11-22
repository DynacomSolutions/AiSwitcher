import { describe, expect, test } from "bun:test";
import { createCursors, type Cursor } from "../src/content/cursor.ts";
import { createSessionTracker } from "../src/content/sessions.ts";

function fakeCursor() {
  const made: Array<{ destroyed: boolean; hidden: number }> = [];
  const make = (): Cursor => {
    const state = { destroyed: false, hidden: 0 };
    made.push(state);
    return { el: {} as HTMLElement, async moveTo() {}, ripple() {}, hide() { state.hidden++; }, destroy() { state.destroyed = true; } };
  };
  return { make, made };
}

describe("createCursors", () => {
  test("one cursor per session id, created on first use", () => {
    const f = fakeCursor();
    const c = createCursors({} as ShadowRoot, f.make);
    expect(c.for("a")).toBe(c.for("a"));
    expect(c.for("b")).not.toBe(c.for("a"));
    expect(f.made).toHaveLength(2);
    expect(c.entries().map(([id]) => id)).toEqual(["a", "b"]);
  });

  test("remove destroys one cursor and keeps the other", () => {
    const f = fakeCursor();
    const c = createCursors({} as ShadowRoot, f.make);
    c.for("a"); c.for("b");
    expect(c.remove("b")).toBe(true);
    expect(c.remove("b")).toBe(false);
    expect(f.made.map(m => m.destroyed)).toEqual([false, true]);
    expect(c.entries().map(([id]) => id)).toEqual(["a"]);
    c.destroy();
    expect(f.made.every(m => m.destroyed)).toBe(true);
    expect(c.entries()).toEqual([]);
  });
});

describe("content script partial unmark", () => {
  test("marks a and b, b acts, unmark b: the page overlay stays and a's entry stays", () => {
    const f = fakeCursor();
    const cursors = createCursors({} as ShadowRoot, f.make);
    const sessions = createSessionTracker();
    sessions.add("a", "#f97316", "Chat A");
    sessions.add("b", "#22c55e", "Chat B");
    cursors.for("b"); // only b has acted
    cursors.remove("b");
    expect(sessions.remove("b")).toBe(false); // a is left: keep host
    expect(sessions.info("a")).toEqual({ colour: "#f97316", tag: "Chat A" });
    expect(sessions.remove("a")).toBe(true); // last one: tear down
  });

  test("snapshot data: each acting session reports its colour and tag", () => {
    const sessions = createSessionTracker();
    sessions.add("a", "#f97316", "Chat A");
    expect(sessions.info("a")).toEqual({ colour: "#f97316", tag: "Chat A" });
    expect(sessions.info("missing")).toBeUndefined();
    expect(sessions.size()).toBe(1);
  });
});
