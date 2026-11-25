import { describe, expect, test } from "bun:test";
import { stableChatId } from "../src/browser/chat-id.ts";
import { launchHeaders } from "../src/browser/mcp-launch.ts";
import { parseMcpHeaders } from "../src/gateway/browser/mcp.ts";
import { forwardedSession } from "../src/gateway/browser/routing.ts";

describe("stable chat id", () => {
  test("only the T3 thread id counts; no session id of the agent does", () => {
    expect(stableChatId({ T3CODE_THREAD_ID: "thread-1" })).toBe("thread-1");
    expect(stableChatId({ CLAUDE_CODE_SESSION_ID: "abc", CODEX_SESSION_ID: "def" })).toBeUndefined();
    expect(stableChatId({ T3CODE_THREAD_ID: "bad id!" })).toBeUndefined();
  });

  test("the launch header carries it and the gateway reads it", () => {
    const h = launchHeaders({ label: "Mail chat", chatId: "thread-1" });
    expect(h["X-AIS-Chat-Id"]).toBe("thread-1");
    const parsed = parseMcpHeaders((n) => (n === "x-ais-chat-id" ? "thread-1" : null));
    expect(parsed).toMatchObject({ ok: true, value: { chatId: "thread-1" } });
    expect(parseMcpHeaders((n) => (n === "x-ais-chat-id" ? "bad id!" : null)).ok).toBe(false);
  });

  test("an older client sends none and the session stays as before", () => {
    expect(launchHeaders({ label: "Mail chat" })["X-AIS-Chat-Id"]).toBeUndefined();
    const b = { target: { kind: "identity" } } as never;
    expect(forwardedSession(b, "alice", "s1", "Mail chat")).toEqual({ id: "s1", identity: "alice", label: "Mail chat" });
    expect(forwardedSession(b, "alice", "s1", "Mail chat", "thread-1")).toEqual({ id: "s1", identity: "alice", label: "Mail chat", chatId: "thread-1" });
  });
});
