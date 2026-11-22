import { describe, expect, test } from "bun:test";
import type { ChatState } from "../../../src/browser/chat-protocol.ts";
import type { ChatView } from "../src/shared/chat.ts";
import { composerMode } from "../src/sidepanel/chat/composer.ts";
import { capState, rowFor } from "../src/sidepanel/chat/list.ts";

const chat = (id: string, state: ChatState, over: Partial<ChatView["summary"]> = {}): ChatView => ({
  summary: { chatId: id, name: `Chat ${id}`, color: "#3b82f6", windowId: 1, state, selection: { provider: "claude", identity: "a" }, tabIds: [5], lastSeq: 3, updatedAt: 0, ...over },
  items: [],
});

describe("rowFor", () => {
  test("rowFor maps thinking, waiting, idle, failed", () => {
    expect(rowFor(chat("a", "thinking")).state).toBe("thinking");
    expect(rowFor(chat("a", "waiting")).state).toBe("waiting for you");
    expect(rowFor(chat("a", "idle")).state).toBe("idle");
    expect(rowFor(chat("a", "failed")).state).toBe("failed");
    expect(rowFor(chat("a", "starting")).state).toBe("starting");
    const r = rowFor(chat("a", "idle"));
    expect(r.colour).toBe("#3b82f6");
    expect(r.provider).toBe("claude");
    expect(r.unread).toBe(false);
  });
  test("rowFor marks a chat unread when it is past the last seen item", () => {
    expect(rowFor(chat("a", "idle"), 1).unread).toBe(true);
    expect(rowFor(chat("a", "idle"), 3).unread).toBe(false);
  });
});

describe("capState", () => {
  test("capState is full at 6 open chats of the window and ignores other windows and closed chats", () => {
    const six = ["1", "2", "3", "4", "5", "6"].map(i => chat(i, "idle"));
    const r = capState(six, 1);
    expect(r.full).toBe(true);
    expect(r.message).toBe("You can have 6 chats open in this window. Close one to start another.");
    expect(capState([...six.slice(0, 5), chat("x", "closed")], 1).full).toBe(false);
    expect(capState([...six.slice(0, 5), chat("y", "idle", { windowId: 2 })], 1).full).toBe(false);
  });
});

describe("composerMode", () => {
  test("composerMode gives Stop while thinking and no Send", () => {
    expect(composerMode(chat("a", "thinking"), false)).toMatchObject({ send: false, stop: true });
    expect(composerMode(chat("a", "waiting"), false)).toMatchObject({ send: false, stop: true });
    expect(composerMode(chat("a", "idle"), false)).toMatchObject({ send: true, stop: false });
  });
  test("composerMode with no links gives the no-pages hint", () => {
    expect(composerMode(chat("a", "idle", { tabIds: [] }), false).hint).toBe("No pages are linked. The agent cannot see any tab.");
  });
  test("composerMode while paused keeps Send enabled with the paused hint", () => {
    const m = composerMode(chat("a", "idle"), true);
    expect(m.send).toBe(true);
    expect(m.hint).toBe("Browser control is paused. The agent can still reply.");
  });
});
