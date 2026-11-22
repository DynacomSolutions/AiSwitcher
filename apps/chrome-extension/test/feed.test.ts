import { describe, expect, test } from "bun:test";
import type { ChatItem } from "../src/shared/chat.ts";
import { buildFeed } from "../src/sidepanel/chat/feed.ts";

let n = 0;
const it = (body: ChatItem["body"], seq = ++n): ChatItem => ({ seq, ts: seq, body });

describe("buildFeed", () => {
  test("text chunks of one turn become one assistant item", () => {
    const feed = buildFeed([it({ k: "user", text: "hi" }, 1), it({ k: "text", text: "Hel" }, 2), it({ k: "text", text: "lo" }, 3)]);
    expect(feed).toEqual([{ kind: "user", seq: 1, text: "hi" }, { kind: "assistant", seq: 2, text: "Hello", streaming: true }]);
  });
  test("the assistant item stops streaming at turn_end and a new turn starts a new item", () => {
    const feed = buildFeed([it({ k: "text", text: "a" }, 1), it({ k: "turn_end", stopReason: "end_turn" }, 2), it({ k: "text", text: "b" }, 3)]);
    expect(feed).toEqual([{ kind: "assistant", seq: 1, text: "a", streaming: false }, { kind: "assistant", seq: 3, text: "b", streaming: true }]);
    expect(buildFeed(feed.length ? [it({ k: "text", text: "a" }, 1), it({ k: "turn_end", stopReason: "x" }, 2)] : [])).toEqual([{ kind: "assistant", seq: 1, text: "a", streaming: false }]);
  });
  test("tool_call then tool_call_update become one card with the final status", () => {
    const feed = buildFeed([
      it({ k: "tool", toolCallId: "t1", title: "Read", status: "running", args: "{}" }, 1),
      it({ k: "text", text: "x" }, 2),
      it({ k: "tool", toolCallId: "t1", title: "Read", status: "done", result: "ok" }, 3),
    ]);
    const tools = feed.filter((f) => f.kind === "tool");
    expect(tools).toEqual([{ kind: "tool", seq: 1, toolCallId: "t1", title: "Read", status: "done", args: "{}", result: "ok" }]);
  });
  test("an unresolved permission stays open and a permission_resolved closes it", () => {
    const perm = it({ k: "permission", requestId: "r1", rpcId: 1, title: "Run?", options: [{ id: "a", name: "Allow", kind: "allow_once" }] }, 1);
    const open = buildFeed([perm]);
    expect(open[0]).toMatchObject({ kind: "permission", requestId: "r1" });
    expect((open[0] as { resolved?: unknown }).resolved).toBeUndefined();
    const closed = buildFeed([perm, it({ k: "permission_resolved", requestId: "r1", optionId: "a" }, 2)]);
    expect(closed).toHaveLength(1);
    expect((closed[0] as { resolved?: unknown }).resolved).toEqual({ optionId: "a" });
    const cancelled = buildFeed([perm, it({ k: "permission_resolved", requestId: "r1", cancelled: true }, 2)]);
    expect((cancelled[0] as { resolved?: unknown }).resolved).toEqual({ cancelled: true });
  });
  test("thought items are hidden", () => {
    const feed = buildFeed([it({ k: "thought", text: "hmm" }, 1), it({ k: "text", text: "a" }, 2), it({ k: "thought", text: "more" }, 3), it({ k: "text", text: "b" }, 4)]);
    expect(feed).toEqual([{ kind: "assistant", seq: 2, text: "ab", streaming: true }]);
  });
  test("error and notice items are kept, config is dropped", () => {
    const feed = buildFeed([it({ k: "error", code: "limit", message: "m" }, 1), it({ k: "notice", text: "n" }, 2), it({ k: "config", models: [], efforts: [], current: {} }, 3)]);
    expect(feed).toEqual([{ kind: "error", seq: 1, code: "limit", message: "m" }, { kind: "notice", seq: 2, text: "n" }]);
  });
  test("events replayed twice (same seqs) give the same feed", () => {
    const items = [it({ k: "user", text: "hi" }, 1), it({ k: "text", text: "a" }, 2), it({ k: "tool", toolCallId: "t", title: "T", status: "done" }, 3), it({ k: "text", text: "b" }, 4)];
    expect(buildFeed([...items, ...items])).toEqual(buildFeed(items));
  });
});

describe("buildFeed streaming and cap", () => {
  test("only the last assistant item streams: a later tool or error ends it", () => {
    const feed = buildFeed([it({ k: "text", text: "a" }, 1), it({ k: "tool", toolCallId: "t", title: "T", status: "running" }, 2), it({ k: "text", text: "b" }, 3)]);
    expect(feed.filter((f) => f.kind === "assistant").map((f) => (f as { streaming: boolean }).streaming)).toEqual([false, true]);
    const after = buildFeed([it({ k: "text", text: "a" }, 1), it({ k: "error", code: "limit", message: "m" }, 2)]);
    expect((after[0] as { streaming: boolean }).streaming).toBe(false);
  });
  test("a tool update after later text does not split that text", () => {
    const feed = buildFeed([it({ k: "tool", toolCallId: "t", title: "T", status: "running" }, 1), it({ k: "text", text: "a" }, 2), it({ k: "tool", toolCallId: "t", title: "T", status: "done" }, 3), it({ k: "text", text: "b" }, 4)]);
    expect(feed.filter((f) => f.kind === "assistant")).toEqual([{ kind: "assistant", seq: 2, text: "ab", streaming: true }]);
  });
  test("a feed over 500 items drops the oldest and shows one notice at the top", () => {
    const many = Array.from({ length: 600 }, (_, i) => it({ k: "user", text: `m${i}` }, i + 1));
    const feed = buildFeed(many);
    expect(feed).toHaveLength(501);
    expect(feed[0]).toEqual({ kind: "notice", seq: -1, text: "Older messages are hidden." });
    expect(feed[1]).toMatchObject({ text: "m100" });
    expect(feed.filter((f) => f.kind === "notice")).toHaveLength(1);
  });
});
