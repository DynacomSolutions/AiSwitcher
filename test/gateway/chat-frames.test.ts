import { afterEach, expect, test } from "bun:test";
import type { ChatToExt } from "../../src/browser/chat-protocol.ts";
import type { BrowserBinding } from "../../src/browser/types.ts";
import { BrowserHub, type HubSocket } from "../../src/gateway/browser/hub.ts";
import { ChatBroker } from "../../src/gateway/chat/broker.ts";
import { MemoryChatBus } from "../../src/gateway/chat/bus.ts";
import { ChatFrames } from "../../src/gateway/chat/frames.ts";
import { MemoryChatStore } from "../../src/gateway/chat/store.ts";
import { chatTokenKey } from "../../src/gateway/chat/token.ts";
import { PrometheusMetrics } from "../../src/gateway/metrics.ts";
import { StubPodTransport } from "./fixtures/stub-transport.ts";

class FakeWs implements HubSocket {
  sent: Array<Record<string, unknown>> = [];
  closed?: { code?: number };
  send(d: string) {
    this.sent.push(JSON.parse(d) as Record<string, unknown>);
    return d.length;
  }
  close(code?: number) {
    this.closed = { code };
  }
  of(t: string): Array<Record<string, any>> {
    return this.sent.filter((m) => m.t === t);
  }
}

const binding = (name: string): BrowserBinding => ({ name, target: { kind: "identity", identity: "id1" }, profileLabel: "p", state: "active", createdAt: "2026-11-04T00:00:00.000Z" });
const SEL = { provider: "claude", identity: "alpha" } as const;
const createFrame = (over: Record<string, unknown> = {}) => ({ t: "chat.create", chatId: crypto.randomUUID(), name: "Chat", color: "#336699", windowId: 1, selection: SEL, tabIds: [7], ...over });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

type FakeCatalog = { get(p?: string): Promise<never[]>; check(p: string, i: string, m?: string): Promise<"ok" | "identity" | "model"> };
const okCatalog: FakeCatalog = { get: async () => [], check: async () => "ok" };

async function setup(over: { maxLive?: number; catalog?: FakeCatalog; slowEventsMs?: number; wrapBroker?: (b: ChatBroker) => Pick<ChatBroker, "create" | "dispatch">; lockWaitMs?: number } = {}) {
  const store = new MemoryChatStore();
  if (over.slowEventsMs) {
    const real = store.events.bind(store);
    store.events = async (...a) => {
      await Bun.sleep(over.slowEventsMs as number);
      return real(...a);
    };
  }
  const bus = new MemoryChatBus();
  const transport = new StubPodTransport();
  const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
  const bindings: Record<string, BrowserBinding> = { "tok-a": binding("bind-a"), "tok-b": binding("bind-b") };
  let frames!: ChatFrames;
  const hub = new BrowserHub({
    authToken: async (t) => bindings[t],
    onChat: (b, m, r) => frames.handle(b, m, r),
    onAttach: (b) => frames.onAttach(b),
  });
  const broker = new ChatBroker({
    store,
    transport,
    mcpUrl: "http://gateway.test/mcp",
    tokenKey: chatTokenKey("test-admin-token"),
    replicaId: "replica-a",
    metrics,
    now: Date.now,
    bus,
    publish: (id) => void frames.poke(id),
    rejectChat: (id, code, message) => frames.rejectChat(id, code, message),
    watchedChats: () => frames.watchedChats(),
    identityOf: async (b) => (b.startsWith("bind-") ? "alpha" : undefined),
  });
  frames = new ChatFrames({
    broker: over.wrapBroker ? over.wrapBroker(broker) : broker,
    store,
    bus,
    catalog: over.catalog ?? okCatalog,
    hub,
    maxPerWindow: 6,
    ...(over.lockWaitMs !== undefined ? { createLockWaitMs: over.lockWaitMs } : {}),
    ...(over.maxLive !== undefined ? { maxLive: over.maxLive } : {}),
  });
  await broker.start();
  await frames.start();
  const sockets: FakeWs[] = [];
  const connect = async (token: string): Promise<FakeWs> => {
    const ws = new FakeWs();
    sockets.push(ws);
    hub.open(ws);
    await hub.message(ws, JSON.stringify({ t: "hello", token, version: "1", paused: false }));
    return ws;
  };
  cleanups.push(async () => {
    for (const ws of sockets) hub.detach(ws);
    await frames.stop();
    await broker.dispose();
    transport.killAll();
  });
  const send = async (ws: FakeWs, frame: unknown): Promise<void> => {
    await hub.message(ws, JSON.stringify(frame));
    await settle();
  };
  return { store, bus, transport, broker, frames, hub, connect, send };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Bun.sleep(5);
};
const until = async (fn: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await Bun.sleep(5);
  }
  throw new Error("until timed out");
};

test("chat.create from a bound extension creates the chat and replies chat.state starting", async () => {
  const s = await setup();
  const ws = await s.connect("tok-a");
  const f = createFrame();
  await s.send(ws, f);
  const st = ws.of("chat.state");
  expect(st).toHaveLength(1);
  expect(st[0]).toMatchObject({ chatId: f.chatId, state: "starting", summary: { chatId: f.chatId, name: "Chat", windowId: 1, tabIds: [7] } });
  expect((await s.store.get(f.chatId))?.binding).toBe("bind-a");
  // The start notice of the chat reaches the socket as event 1.
  expect(ws.of("chat.event").map((e) => [e.seq, e.body.k])).toEqual([[1, "notice"]]);
  expect(ws.of("chat.reject")).toEqual([]);
});

test("the same chat.create from another binding is refused (a chat belongs to one binding)", async () => {
  const s = await setup();
  const a = await s.connect("tok-a");
  const b = await s.connect("tok-b");
  const f = createFrame();
  await s.send(a, f);
  await s.send(b, f);
  expect(b.of("chat.reject")).toEqual([expect.objectContaining({ chatId: f.chatId, code: "bad_request" })]);
  expect(b.of("chat.state")).toEqual([]);
  expect((await s.store.get(f.chatId))?.binding).toBe("bind-a");
  // The refused binding gets no feed of the chat either.
  await s.store.appendEvent(f.chatId, { k: "user", text: "hello" });
  await s.bus.publish({ t: "event", chatId: f.chatId, seq: 2 });
  await until(() => a.of("chat.event").length === 2);
  expect(b.of("chat.event")).toEqual([]);
});

test("a chat.prompt for another binding's chat is rejected bad_request", async () => {
  const s = await setup();
  const a = await s.connect("tok-a");
  const b = await s.connect("tok-b");
  const f = createFrame();
  await s.send(a, f);
  await s.send(b, { t: "chat.prompt", chatId: f.chatId, text: "hijack" });
  expect(b.of("chat.reject")).toEqual([expect.objectContaining({ chatId: f.chatId, code: "bad_request" })]);
  const rows = await s.store.events(f.chatId, 0, 100);
  expect(rows.some((r) => r.body.k === "user")).toBe(false);
  expect(s.transport.starts).toHaveLength(0);
});

test("the seventh chat in a window gets chat.reject window_cap", async () => {
  const s = await setup();
  const ws = await s.connect("tok-a");
  for (let i = 0; i < 6; i += 1) await s.send(ws, createFrame());
  expect(ws.of("chat.state")).toHaveLength(6);
  const seventh = createFrame();
  await s.send(ws, seventh);
  expect(ws.of("chat.reject")).toEqual([expect.objectContaining({ chatId: seventh.chatId, code: "window_cap" })]);
  expect(await s.store.get(seventh.chatId)).toBeUndefined();
  // Another window still has room.
  await s.send(ws, createFrame({ windowId: 2 }));
  expect(ws.of("chat.state")).toHaveLength(7);
});

test("the 13th live chat on the gateway gets chat.reject limit with the cap copy", async () => {
  const s = await setup();
  const ws = await s.connect("tok-a");
  for (const windowId of [1, 2]) for (let i = 0; i < 6; i += 1) await s.send(ws, createFrame({ windowId }));
  expect(ws.of("chat.state")).toHaveLength(12);
  const extra = createFrame({ windowId: 3 });
  await s.send(ws, extra);
  expect(ws.of("chat.reject")).toEqual([{ t: "chat.reject", chatId: extra.chatId, code: "limit", message: "Too many chats are open. Close one, then try again." }]);
  expect(await s.store.get(extra.chatId)).toBeUndefined();
  expect(await s.store.countOpen()).toBe(12);
});

test("chat.resume afterSeq replays the missing events in order then live ones", async () => {
  const s = await setup();
  const ws = await s.connect("tok-a");
  const f = createFrame();
  await s.send(ws, f);
  for (const t of ["m2", "m3", "m4", "m5"]) await s.store.appendEvent(f.chatId, { k: "user", text: t });
  ws.sent.length = 0;
  await s.send(ws, { t: "chat.resume", chatId: f.chatId, afterSeq: 2 });
  expect(ws.of("chat.event").map((e) => e.seq)).toEqual([3, 4, 5]);
  expect(ws.of("chat.state")).toHaveLength(1);
  // A live event follows with the next number, once.
  await s.store.appendEvent(f.chatId, { k: "user", text: "m6" });
  await s.bus.publish({ t: "event", chatId: f.chatId, seq: 6 });
  await s.bus.publish({ t: "event", chatId: f.chatId, seq: 6 });
  await until(() => ws.of("chat.event").length === 4);
  await settle();
  expect(ws.of("chat.event").map((e) => e.seq)).toEqual([3, 4, 5, 6]);
});

test("chat.resume for a chat that is gone gets chat.reject expired, and another binding's chat gets bad_request", async () => {
  const s = await setup();
  const a = await s.connect("tok-a");
  const b = await s.connect("tok-b");
  const f = createFrame();
  await s.send(a, f);
  await s.send(a, { t: "chat.resume", chatId: crypto.randomUUID(), afterSeq: 0 });
  expect(a.of("chat.reject")).toEqual([expect.objectContaining({ code: "expired" })]);
  await s.send(b, { t: "chat.resume", chatId: f.chatId, afterSeq: 0 });
  expect(b.of("chat.reject")).toEqual([expect.objectContaining({ code: "bad_request" })]);
  expect(b.of("chat.event")).toEqual([]);
});

test("chat.permission with an unknown requestId is ignored", async () => {
  const s = await setup();
  const ws = await s.connect("tok-a");
  const f = createFrame();
  await s.send(ws, f);
  const before = (await s.store.events(f.chatId, 0, 100)).length;
  ws.sent.length = 0;
  await s.send(ws, { t: "chat.permission", chatId: f.chatId, requestId: "no-such-request", optionId: "allow" });
  expect(ws.of("chat.reject")).toEqual([]);
  expect((await s.store.events(f.chatId, 0, 100)).length).toBe(before);
  expect(ws.closed).toBeUndefined();
});

test("a frame over the size caps is dropped and the socket stays open", async () => {
  const s = await setup();
  const ws = await s.connect("tok-a");
  const f = createFrame();
  await s.send(ws, f);
  ws.sent.length = 0;
  await s.send(ws, { t: "chat.prompt", chatId: f.chatId, text: "x".repeat(65537) });
  await s.send(ws, { t: "chat.link", chatId: f.chatId, tabIds: Array.from({ length: 33 }, (_, i) => i) });
  await s.send(ws, { t: "chat.create", chatId: "not a valid id!", name: "n", color: "#336699", windowId: 1, selection: SEL, tabIds: [] });
  expect(ws.sent).toEqual([]);
  expect(ws.closed).toBeUndefined();
  expect((await s.store.events(f.chatId, 0, 100)).some((r) => r.body.k === "user")).toBe(false);
  // The socket still works.
  await s.send(ws, { t: "chat.list" });
  expect(ws.of("chat.list")).toHaveLength(1);
});

test("an event notice from the bus reaches only the binding that owns the chat", async () => {
  const s = await setup();
  const a = await s.connect("tok-a");
  const b = await s.connect("tok-b");
  const f = createFrame();
  await s.send(a, f);
  await s.send(b, createFrame({ windowId: 2 }));
  a.sent.length = 0;
  b.sent.length = 0;
  await s.store.appendEvent(f.chatId, { k: "user", text: "for a" });
  await s.bus.publish({ t: "event", chatId: f.chatId, seq: 2 });
  await until(() => a.of("chat.event").length === 1);
  await settle();
  expect(a.of("chat.event").map((e) => e.body.text)).toEqual(["for a"]);
  expect(b.of("chat.event")).toEqual([]);
  // A state notice reaches the owner only, and only when the state changed.
  b.sent.length = 0;
  a.sent.length = 0;
  await s.bus.publish({ t: "state", chatId: f.chatId });
  await settle();
  expect(a.of("chat.state")).toEqual([]);
  expect(b.sent).toEqual([]);
});

test("onAttach sends chat.list for the binding", async () => {
  const s = await setup();
  const first = await s.connect("tok-a");
  const f = createFrame();
  await s.send(first, f);
  await s.send(first, createFrame({ windowId: 2 }));
  const again = await s.connect("tok-a");
  await until(() => again.of("chat.list").length === 1);
  const list = again.of("chat.list")[0] as Extract<ChatToExt, { t: "chat.list" }>;
  expect(list.chats.map((c) => c.windowId).sort()).toEqual([1, 2]);
  expect(list.chats.find((c) => c.chatId === f.chatId)).toMatchObject({ state: "starting", name: "Chat" });
  // Another binding sees none of them.
  const other = await s.connect("tok-b");
  await until(() => other.of("chat.list").length === 1);
  expect((other.of("chat.list")[0] as { chats: unknown[] }).chats).toEqual([]);
});

test("chat.catalog answers with the catalogue and a failing ConfigMap gives chat.reject unavailable", async () => {
  const good = await setup();
  const ws = await good.connect("tok-a");
  await good.send(ws, { t: "chat.catalog", reqId: "r1" });
  expect(ws.of("chat.catalog")).toEqual([{ t: "chat.catalog", reqId: "r1", providers: [] }]);
  const bad = await setup({
    catalog: {
      ...okCatalog,
      get: async () => {
        throw new Error("down");
      },
    },
  });
  const w2 = await bad.connect("tok-a");
  await bad.send(w2, { t: "chat.catalog", reqId: "r2" });
  expect(w2.of("chat.reject")).toEqual([expect.objectContaining({ reqId: "r2", code: "unavailable" })]);
});

test("a forwarded command that failed reaches the panel as chat.reject through rejectChat", async () => {
  const s = await setup();
  const ws = await s.connect("tok-a");
  const f = createFrame();
  await s.send(ws, f);
  ws.sent.length = 0;
  s.frames.rejectChat(f.chatId, "unavailable", "The chat did not answer. Try again in a moment.");
  expect(ws.of("chat.reject")).toEqual([{ t: "chat.reject", chatId: f.chatId, code: "unavailable", message: "The chat did not answer. Try again in a moment." }]);
  expect(s.frames.watchedChats()).toContain(f.chatId);
});

test("a reconnect during a replay never sends events out of order to the new socket", async () => {
  const s = await setup({ slowEventsMs: 25 });
  const first = await s.connect("tok-a");
  const f = createFrame();
  await s.send(first, f);
  for (let i = 2; i <= 500; i += 1) await s.store.appendEvent(f.chatId, { k: "user", text: `m${i}` });
  // The replay of 500 events takes three pages. The browser reconnects while it runs.
  void s.hub.message(first, JSON.stringify({ t: "chat.resume", chatId: f.chatId, afterSeq: 0 }));
  await Bun.sleep(40);
  const second = await s.connect("tok-a");
  await s.hub.message(second, JSON.stringify({ t: "chat.resume", chatId: f.chatId, afterSeq: 0 }));
  await until(() => second.of("chat.event").length >= 500, 8000);
  await settle();
  const seqs = second.of("chat.event").map((e) => e.seq);
  expect(seqs).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
  // The watch of the new socket survived: live events still arrive.
  await s.store.appendEvent(f.chatId, { k: "user", text: "live" });
  await s.bus.publish({ t: "event", chatId: f.chatId, seq: 501 });
  await until(() => second.of("chat.event").length === 501);
  expect(second.of("chat.event").at(-1)?.seq).toBe(501);
});

test("create refuses a provider and identity that the ConfigMap does not list, and config refuses a model outside the list", async () => {
  const catalog: FakeCatalog = { get: async () => [], check: async (_p, i, m) => (i !== "alpha" ? "identity" : m === "not-listed" ? "model" : "ok") };
  const s = await setup({ catalog });
  const ws = await s.connect("tok-a");
  const bad = createFrame({ selection: { provider: "claude", identity: "stranger" } });
  await s.send(ws, bad);
  expect(ws.of("chat.reject")).toEqual([expect.objectContaining({ chatId: bad.chatId, code: "bad_request" })]);
  expect(await s.store.get(bad.chatId)).toBeUndefined();
  const badModel = createFrame({ selection: { provider: "claude", identity: "alpha", model: "not-listed" } });
  await s.send(ws, badModel);
  expect(ws.of("chat.reject")).toHaveLength(2);
  const good = createFrame({ selection: { provider: "claude", identity: "alpha", model: "listed" } });
  await s.send(ws, good);
  expect(ws.of("chat.state")).toHaveLength(1);
  expect((await s.store.get(good.chatId))?.selection.model).toBe("listed");
  ws.sent.length = 0;
  await s.send(ws, { t: "chat.config", chatId: good.chatId, model: "not-listed" });
  expect(ws.of("chat.reject")).toEqual([expect.objectContaining({ chatId: good.chatId, code: "bad_request" })]);
});

test("a create that waits more than the lock limit for another create gets chat.reject unavailable", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let first = true;
  const s = await setup({
    lockWaitMs: 60,
    wrapBroker: (b) => ({
      dispatch: (c) => b.dispatch(c),
      create: async (i) => {
        if (first) {
          first = false;
          await gate;
        }
        return b.create(i);
      },
    }),
  });
  const ws = await s.connect("tok-a");
  const slow = createFrame();
  const late = createFrame();
  void s.hub.message(ws, JSON.stringify(slow));
  await Bun.sleep(10);
  await s.send(ws, late);
  await Bun.sleep(120);
  expect(ws.of("chat.reject")).toEqual([expect.objectContaining({ chatId: late.chatId, code: "unavailable" })]);
  expect(await s.store.get(late.chatId)).toBeUndefined();
  // The create in flight is not cut: it finishes once released.
  release();
  await until(() => ws.of("chat.state").length === 1);
  expect(ws.of("chat.state")[0]?.chatId).toBe(slow.chatId);
});
