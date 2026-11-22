import { describe, expect, test } from "bun:test";
import { MAX_CHAT_TEXT, parseChatFromExt, parseChatToExt, sessionIdForChat, type ChatSummary } from "../../src/browser/chat-protocol.ts";

const selection = { provider: "claude", identity: "main", model: "m1", effort: "high" };
const summary: ChatSummary = { chatId: "c-1", name: "N", color: "#aabbcc", windowId: 3, state: "idle", selection: { provider: "claude", identity: "main" }, tabIds: [1, 2], lastSeq: 4, updatedAt: 99 };

const fromExt = [
  { t: "chat.create", chatId: "c-1", name: "N", color: "#aabbcc", windowId: 3, selection, tabIds: [1] },
  { t: "chat.prompt", chatId: "c-1", text: "hi" },
  { t: "chat.cancel", chatId: "c-1" },
  { t: "chat.permission", chatId: "c-1", requestId: "r1", optionId: "o1" },
  { t: "chat.link", chatId: "c-1", tabIds: [1, 2] },
  { t: "chat.config", chatId: "c-1", model: "m", effort: "low" },
  { t: "chat.rename", chatId: "c-1", name: "New" },
  { t: "chat.close", chatId: "c-1" },
  { t: "chat.resume", chatId: "c-1", afterSeq: 0 },
  { t: "chat.list", windowId: 3 },
  { t: "chat.list" },
  { t: "chat.catalog", reqId: "q1", provider: "codex" },
];

const toExt = [
  { t: "chat.event", chatId: "c-1", seq: 1, ts: 5, body: { k: "text", text: "x" } },
  { t: "chat.event", chatId: "c-1", seq: 2, ts: 5, body: { k: "tool", toolCallId: "t", title: "T", status: "done", args: "a", result: "r" } },
  { t: "chat.event", chatId: "c-1", seq: 3, ts: 5, body: { k: "permission", requestId: "r", rpcId: 7, title: "P", options: [{ id: "o", name: "O", kind: "allow" }] } },
  { t: "chat.event", chatId: "c-1", seq: 4, ts: 5, body: { k: "config", models: [{ id: "m", name: "M" }], efforts: ["low"], current: { model: "m" } } },
  { t: "chat.event", chatId: "c-1", seq: 5, ts: 5, body: { k: "error", code: "timeout", message: "late" } },
  { t: "chat.event", chatId: "c-1", seq: 6, ts: 5, body: { k: "turn_end", stopReason: "end_turn" } },
  { t: "chat.state", chatId: "c-1", state: "idle", summary },
  { t: "chat.list", chats: [summary] },
  { t: "chat.reject", chatId: "c-1", code: "busy", message: "no" },
  { t: "chat.catalog", reqId: "q1", providers: [{ provider: "claude", identities: [{ name: "main", kind: "identity", models: [{ id: "m", name: "M" }] }], efforts: ["low"] }] },
];

describe("chat protocol", () => {
  for (const f of fromExt) test(`round-trips ${f.t}`, () => expect(parseChatFromExt(JSON.parse(JSON.stringify(f)))).toEqual(f as never));
  for (const f of toExt) test(`round-trips ${f.t}`, () => expect(parseChatToExt(JSON.parse(JSON.stringify(f)))).toEqual(f as never));

  test("rejects over-long prompt", () => {
    expect(parseChatFromExt({ t: "chat.prompt", chatId: "c", text: "a".repeat(MAX_CHAT_TEXT) })).toBeDefined();
    expect(parseChatFromExt({ t: "chat.prompt", chatId: "c", text: "a".repeat(MAX_CHAT_TEXT + 1) })).toBeUndefined();
  });
  test("rejects bad tab ids", () => {
    const link = (tabIds: unknown) => parseChatFromExt({ t: "chat.link", chatId: "c", tabIds });
    expect(link(Array.from({ length: 32 }, (_, i) => i))).toBeDefined();
    expect(link(Array.from({ length: 33 }, (_, i) => i))).toBeUndefined();
    expect(link([-1])).toBeUndefined();
    expect(link([1.5])).toBeUndefined();
  });
  test("rejects bad colour, provider, id and type", () => {
    const base = fromExt[0] as Record<string, unknown>;
    expect(parseChatFromExt({ ...base, color: "red" })).toBeUndefined();
    expect(parseChatFromExt({ ...base, color: "#AABBCC" })).toBeUndefined();
    expect(parseChatFromExt({ ...base, selection: { provider: "bash", identity: "x" } })).toBeUndefined();
    expect(parseChatFromExt({ ...base, chatId: "a b" })).toBeUndefined();
    expect(parseChatFromExt({ ...base, name: "a".repeat(81) })).toBeUndefined();
    expect(parseChatFromExt({ t: "chat.nope" })).toBeUndefined();
    expect(parseChatFromExt(null)).toBeUndefined();
  });
  test("drops a tool body with a bad status", () => {
    const body = { k: "tool", toolCallId: "t", title: "T", status: "weird" };
    expect(parseChatToExt({ t: "chat.event", chatId: "c", seq: 1, ts: 1, body })).toBeUndefined();
  });
  test("session id", () => {
    expect(sessionIdForChat("a-1")).toBe("chat:a-1");
    expect(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionIdForChat("a-1"))).toBe(true);
  });

  test("list caps", () => {
    const models = Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, name: `M${i}` }));
    const cat = { t: "chat.catalog", reqId: "q", providers: [{ provider: "claude", identities: [{ name: "a", kind: "pool", models }], efforts: ["low"] }] };
    expect(parseChatToExt(cat)).toBeDefined();
    expect(parseChatToExt({ ...cat, providers: [{ provider: "claude", identities: [], efforts: Array.from({ length: 65 }, () => "e") }] })).toBeUndefined();
  });
  test("rejects an oversize result", () => {
    const body = { k: "tool", toolCallId: "t", title: "T", status: "done", result: "x".repeat(70000) };
    expect(parseChatToExt({ t: "chat.event", chatId: "c", seq: 1, ts: 1, body })).toBeUndefined();
    expect(parseChatToExt({ t: "chat.event", chatId: "c", seq: 1, ts: 1, body: { k: "text", text: "x".repeat(MAX_CHAT_TEXT + 1) } })).toBeUndefined();
  });
  test("rejects unsafe integers", () => {
    for (const n of [1e21, 1e300, 2 ** 53, 1.5, -1]) {
      expect(parseChatToExt({ t: "chat.event", chatId: "c", seq: n, ts: 1, body: { k: "text", text: "x" } })).toBeUndefined();
      expect(parseChatToExt({ t: "chat.event", chatId: "c", seq: 1, ts: n, body: { k: "text", text: "x" } })).toBeUndefined();
      expect(parseChatFromExt({ t: "chat.resume", chatId: "c", afterSeq: n })).toBeUndefined();
      expect(parseChatFromExt({ t: "chat.link", chatId: "c", tabIds: [n] })).toBeUndefined();
      expect(parseChatFromExt({ ...(fromExt[0] as object), windowId: n })).toBeUndefined();
    }
  });
  test("strips unknown keys, nested too", () => {
    const c = parseChatFromExt({ ...(fromExt[0] as object), extra: 1, selection: { ...selection, extra: 2 } }) as Record<string, unknown>;
    expect(c).toEqual(fromExt[0] as never);
    const st = parseChatToExt({ t: "chat.state", chatId: "c-1", state: "idle", x: 1, summary: { ...summary, y: 2, selection: { ...summary.selection, z: 3 } } });
    expect(st).toEqual({ t: "chat.state", chatId: "c-1", state: "idle", summary } as never);
    const ev = parseChatToExt({ t: "chat.event", chatId: "c", seq: 1, ts: 1, body: { k: "text", text: "x", extra: 1 } });
    expect(ev).toEqual({ t: "chat.event", chatId: "c", seq: 1, ts: 1, body: { k: "text", text: "x" } } as never);
    const cfg = parseChatToExt({ t: "chat.event", chatId: "c", seq: 1, ts: 1, body: { k: "config", models: [{ id: "m", name: "M", q: 1 }], efforts: [], current: { model: "m", q: 1 } } });
    expect(cfg).toEqual({ t: "chat.event", chatId: "c", seq: 1, ts: 1, body: { k: "config", models: [{ id: "m", name: "M" }], efforts: [], current: { model: "m" } } } as never);
    const cat = parseChatToExt({ t: "chat.catalog", reqId: "q", providers: [{ provider: "claude", q: 1, efforts: [], identities: [{ name: "a", kind: "pool", models: [], q: 1 }] }] });
    expect(cat).toEqual({ t: "chat.catalog", reqId: "q", providers: [{ provider: "claude", efforts: [], identities: [{ name: "a", kind: "pool", models: [] }] }] } as never);
  });
  test("rejects an empty prompt", () => expect(parseChatFromExt({ t: "chat.prompt", chatId: "c", text: "" })).toBeUndefined());
  test("rejects a chat.state with a different chat id", () => {
    expect(parseChatToExt({ t: "chat.state", chatId: "other", state: "idle", summary })).toBeUndefined();
  });
  test("selection charset", () => {
    const base = fromExt[0] as Record<string, unknown>;
    for (const bad of ["a b", "a\nb", "", "x".repeat(129)]) {
      for (const key of ["identity", "model", "effort"]) expect(parseChatFromExt({ ...base, selection: { ...selection, [key]: bad } })).toBeUndefined();
    }
    expect(parseChatFromExt({ ...base, selection: { provider: "claude", identity: "a.b:c/d@e+f-g_h".replace("_", "") } })).toBeDefined();
  });
  test("other negative cases", () => {
    expect(parseChatToExt({ t: "chat.event", chatId: "c", seq: 1, ts: 1, body: { k: "bogus" } })).toBeUndefined();
    expect(parseChatToExt({ t: "chat.event", chatId: "bad id", seq: 1, ts: 1, body: { k: "text", text: "x" } })).toBeUndefined();
    expect(parseChatFromExt({ t: "chat.cancel", chatId: "x".repeat(65) })).toBeUndefined();
    expect(parseChatFromExt({ t: "chat.catalog", reqId: "q", provider: "bash" })).toBeUndefined();
    expect(parseChatFromExt({ t: "chat.permission", chatId: "c", requestId: "r" })).toEqual({ t: "chat.permission", chatId: "c", requestId: "r" });
  });

  test("an unknown error code reads as acp, so a newer gateway never makes a panel drop the frame", () => {
    expect(parseChatToExt({ t: "chat.event", chatId: "c-1", seq: 1, ts: 1, body: { k: "error", code: "future_code", message: "m" } })).toEqual({ t: "chat.event", chatId: "c-1", seq: 1, ts: 1, body: { k: "error", code: "acp", message: "m" } });
    expect(parseChatToExt({ t: "chat.reject", chatId: "c-1", code: "future_code", message: "m" })).toEqual({ t: "chat.reject", chatId: "c-1", code: "acp", message: "m" });
    expect(parseChatToExt({ t: "chat.reject", code: 5, message: "m" })).toBeUndefined();
  });
});
