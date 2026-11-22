import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatBody } from "../../src/browser/chat-protocol.ts";
import { MemoryChatBus, type ChatBusMsg } from "../../src/gateway/chat/bus.ts";
import { ChatBroker, chatIdleMsFromEnv, type BrokerDeps } from "../../src/gateway/chat/broker.ts";
import { sessionName } from "../../src/gateway/chat/kube.ts";
import type { Timers } from "../../src/gateway/chat/pod-transport.ts";
import { MemoryChatStore } from "../../src/gateway/chat/store.ts";
import { chatTokenKey } from "../../src/gateway/chat/token.ts";
import { PrometheusMetrics } from "../../src/gateway/metrics.ts";
import { StubPodTransport } from "./fixtures/stub-transport.ts";

const KEY = chatTokenKey("test-admin-token");
const root = mkdtempSync(join(tmpdir(), "ais-chat-replicas-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const brokers: ChatBroker[] = [];
const transports: StubPodTransport[] = [];
afterEach(async () => {
  for (const b of brokers.splice(0)) await b.dispose();
  for (const t of transports.splice(0)) t.killAll();
});

/** Timers that never fire: a replica that cannot renew its lease, like a crashed one. */
const frozen: Timers = { setTimeout: () => 0, clearTimeout: () => undefined };

/** Two replicas over one store, one bus and one fake cluster. */
async function pair(opts: { frozenA?: boolean; ackMs?: number; a?: Partial<BrokerDeps>; b?: Partial<BrokerDeps>; slowStartMs?: number } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const store = new MemoryChatStore(() => clock.t);
  const bus = new MemoryChatBus();
  const cluster = new Set<string>();
  const stateFile = join(root, `${crypto.randomUUID()}.state`);
  const make = async (replicaId: string, timers?: Timers, extra: Partial<BrokerDeps> = {}, slow = 0) => {
    const transport = new StubPodTransport({ cluster, env: { STUB_ACP_STATE: stateFile }, ...(slow ? { beforeSpawn: () => Bun.sleep(slow) } : {}) });
    transports.push(transport);
    const seen: Array<[string, number]> = [];
    const rejects: Array<{ chatId: string; code: string; message: string }> = [];
    const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
    const broker = new ChatBroker({
      store,
      transport,
      bus,
      mcpUrl: "http://gateway.test/mcp",
      tokenKey: KEY,
      replicaId,
      metrics,
      now: () => clock.t,
      publish: (id, seq) => void seen.push([id, seq]),
      identityOf: async (b) => (b === "bind-1" ? "alpha" : undefined),
      ...(timers ? { timers } : {}),
      ...extra,
      ...(opts.ackMs !== undefined ? { forwardAckMs: opts.ackMs } : {}),
      rejectChat: (chatId, code, message) => void rejects.push({ chatId, code, message }),
    });
    brokers.push(broker);
    await broker.start();
    return { broker, transport, seen, metrics, rejects };
  };
  const a = await make("replica-a", opts.frozenA ? frozen : undefined, opts.a, opts.slowStartMs);
  const b = await make("replica-b", undefined, opts.b);
  const rec = await a.broker.create({ chatId: crypto.randomUUID(), binding: "bind-1", windowId: 1, name: "My chat", color: "#aabbcc", selection: { provider: "claude", identity: "alpha" }, tabIds: [7] });
  if ("code" in rec) throw new Error("rejected");
  return { clock, store, bus, cluster, a, b, id: rec.id };
}

const bodies = async (s: MemoryChatStore, id: string): Promise<ChatBody[]> => (await s.events(id, 0, 10_000)).map((e) => e.body);
async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out: ${what}`);
}
const prompt = (b: ChatBroker, id: string, text: string) => b.dispatch({ chatId: id, binding: "bind-1", cmd: "prompt", args: { text } });
const turnEnds = async (s: MemoryChatStore, id: string) => (await bodies(s, id)).filter((x) => x.k === "turn_end").length;
const idle = (s: MemoryChatStore, id: string) => until(async () => (await s.get(id))?.state === "idle", "idle");

test("a prompt sent to the non-owner runs on the owner and both replicas see the events", async () => {
  const { store, a, b, id } = await pair();
  expect(await prompt(a.broker, id, "say:first")).toBeUndefined();
  await until(async () => (await turnEnds(store, id)) === 1, "first turn");
  await idle(store, id);
  expect((await store.get(id))?.ownerReplica).toBe("replica-a");
  a.seen.length = 0;
  b.seen.length = 0;
  expect(await prompt(b.broker, id, "say:second")).toBeUndefined();
  await until(async () => (await turnEnds(store, id)) === 2, "second turn");
  await idle(store, id);
  const all = await bodies(store, id);
  expect(all.filter((x) => x.k === "text").map((x) => (x as { text: string }).text).join("")).toBe("firstsecond");
  expect(a.transport.starts).toHaveLength(1);
  expect(b.transport.starts).toHaveLength(0);
  const last = (await store.get(id))?.lastSeq ?? 0;
  for (const r of [a, b]) expect(Math.max(...r.seen.map(([, s]) => s))).toBe(last);
});

test("only one pod starts when both replicas get a prompt at once", async () => {
  const { store, a, b, id } = await pair();
  const [r1, r2] = await Promise.all([prompt(a.broker, id, "say:one"), prompt(b.broker, id, "say:two")]);
  expect(r1).toBeUndefined();
  expect(r2).toBeUndefined();
  await until(async () => (await turnEnds(store, id)) >= 1, "a turn");
  await idle(store, id);
  await Bun.sleep(100);
  expect(a.transport.starts.length + b.transport.starts.length).toBe(1);
  // The second prompt is not lost silently: it ran as a turn or the feed says it did not.
  const all = await bodies(store, id);
  expect(all.filter((x) => x.k === "user")).toHaveLength(2);
  const ran = all.filter((x) => x.k === "turn_end").length;
  const noted = all.filter((x) => x.k === "notice" && x.text.includes("still working")).length;
  expect(ran + noted).toBeGreaterThanOrEqual(2);
});

test("one broker with two prompts at once for a free chat starts exactly one pod", async () => {
  const { store, a, id } = await pair();
  const rs = await Promise.all([prompt(a.broker, id, "say:one"), prompt(a.broker, id, "say:two")]);
  expect(rs.filter((r) => r === undefined)).toHaveLength(1);
  expect(rs.filter((r) => r?.code === "busy")).toHaveLength(1);
  await until(async () => (await turnEnds(store, id)) === 1, "turn");
  expect(a.transport.starts).toHaveLength(1);
});

test("owner crash (lease expiry, fake clock) lets the other replica resume on the next prompt and it deletes the stale session first", async () => {
  const { store, clock, a, b, id } = await pair({ frozenA: true });
  await prompt(a.broker, id, "say:before");
  await until(async () => (await turnEnds(store, id)) === 1, "first turn");
  await idle(store, id);
  clock.t += 61_000;
  expect(await prompt(b.broker, id, "say:after")).toBeUndefined();
  await until(async () => (await turnEnds(store, id)) === 2, "second turn");
  expect(b.transport.starts).toHaveLength(1);
  expect(b.transport.starts[0]?.generation).toBe(2);
  expect(b.transport.stoppedSessions).toContain(sessionName(id, 1));
  expect(b.transport.stopped).not.toContain(id);
  expect((await store.get(id))?.ownerReplica).toBe("replica-b");
});

test("drain waits for the running turn, then releases the lease and leaves the chat idle", async () => {
  const { store, a, id } = await pair();
  await prompt(a.broker, id, "slow");
  await until(async () => (await store.get(id))?.state === "thinking", "thinking");
  let done = false;
  const d = a.broker.drain().then(() => void (done = true));
  await Bun.sleep(150);
  expect(done).toBe(false);
  await a.broker.cancel(id);
  await d;
  const rec = await store.get(id);
  expect(rec?.state).toBe("idle");
  expect(rec?.ownerReplica).toBeUndefined();
  expect((await bodies(store, id)).some((x) => x.k === "turn_end")).toBe(true);
  expect(a.transport.stoppedSessions).toContain(sessionName(id, 1));
});

test("drain answers a pending permission as cancelled", async () => {
  const { store, a, id } = await pair();
  await prompt(a.broker, id, "ask");
  await until(async () => (await bodies(store, id)).some((x) => x.k === "permission"), "permission");
  await a.broker.drain();
  const all = await bodies(store, id);
  const perm = all.find((x) => x.k === "permission") as Extract<ChatBody, { k: "permission" }>;
  expect(all).toContainEqual({ k: "permission_resolved", requestId: perm.requestId, cancelled: true });
  expect((await store.get(id))?.state).toBe("idle");
});

test("after drain the other replica resumes with session/load and the feed shows a resumed notice", async () => {
  const { store, a, b, id } = await pair();
  await prompt(a.broker, id, "say:one");
  await until(async () => (await turnEnds(store, id)) === 1, "first turn");
  await idle(store, id);
  const sid = (await store.get(id))?.acpSessionId;
  await a.broker.drain();
  expect(await prompt(b.broker, id, "say:two")).toBeUndefined();
  await until(async () => (await turnEnds(store, id)) === 2, "second turn");
  expect((await store.get(id))?.acpSessionId).toBe(sid);
  expect(b.transport.starts).toHaveLength(1);
  expect((await bodies(store, id)).some((x) => x.k === "notice" && x.text.includes("resumed"))).toBe(true);
});

test("drain of a chat with no turn detaches at once and refuses new prompts", async () => {
  const { store, a, id } = await pair();
  await prompt(a.broker, id, "say:one");
  await until(async () => (await turnEnds(store, id)) === 1, "turn");
  await idle(store, id);
  await a.broker.drain();
  const rec = await store.get(id);
  expect(rec?.ownerReplica).toBeUndefined();
  expect(rec?.state).toBe("idle");
  expect(await prompt(a.broker, id, "say:late")).toMatchObject({ code: "unavailable" });
  // The refused prompt left no user event behind.
  expect((await bodies(store, id)).filter((x) => x.k === "user")).toHaveLength(1);
});

test("after a LISTEN reconnect the replica pushes the events it missed, the last one included", async () => {
  const { store, bus, a, b, id } = await pair();
  await prompt(a.broker, id, "say:one");
  await until(async () => (await turnEnds(store, id)) === 1, "first turn");
  await idle(store, id);
  await Bun.sleep(50);
  // The connection is down: B gets no event notice, so it never hears of the last event (the turn end).
  bus.drop = (m) => m.t === "event" || m.t === "state";
  await prompt(a.broker, id, "say:two");
  await until(async () => (await turnEnds(store, id)) === 2, "second turn");
  await idle(store, id);
  const last = (await store.get(id))?.lastSeq ?? 0;
  expect(Math.max(...b.seen.map(([, s]) => s))).toBeLessThan(last);
  bus.drop = undefined as never;
  bus.simulateReconnect();
  await until(() => b.seen.some(([, s]) => s === last), "last event after reconnect");
  expect(((await store.events(id, 0, 1000)).at(-1)?.body as { k: string }).k).toBe("turn_end");
});

test("a prompt that the owner never receives is taken over once its lease has ended, and is not lost", async () => {
  const { store, bus, clock, a, b, id } = await pair({ frozenA: true, ackMs: 50 });
  await prompt(a.broker, id, "say:one");
  await until(async () => (await turnEnds(store, id)) === 1, "turn");
  await idle(store, id);
  // The owner is gone: it gets no command, and its lease runs out.
  bus.drop = (m) => m.t === "cmd";
  expect(await prompt(b.broker, id, "say:two")).toBeUndefined();
  clock.t += 61_000;
  await until(async () => (await turnEnds(store, id)) === 2, "taken over turn");
  expect(b.transport.starts).toHaveLength(1);
  expect((await bodies(store, id)).filter((x) => x.k === "user")).toHaveLength(2);
});

test("an owner that never acks with a live lease gives a reject that is not stored, and a retry reuses the stored prompt", async () => {
  const { store, bus, a, b, id } = await pair({ ackMs: 20 });
  await prompt(a.broker, id, "say:one");
  await until(async () => (await turnEnds(store, id)) === 1, "turn");
  await idle(store, id);
  bus.drop = (m) => m.t === "cmd";
  expect(await prompt(b.broker, id, "say:two")).toBeUndefined();
  await until(() => b.rejects.length === 1, "reject");
  expect(b.rejects[0]).toEqual({ chatId: id, code: "unavailable", message: "The chat did not answer. Try again in a moment." });
  expect(b.metrics.render().includes('kind="owner_unreachable"')).toBe(true);
  expect(b.transport.starts).toHaveLength(0);
  const users = async () => (await bodies(store, id)).filter((x) => x.k === "user");
  expect(await users()).toHaveLength(2);
  // The owner is back. The retry reuses the stored event and runs.
  bus.drop = undefined as never;
  expect(await prompt(b.broker, id, "say:two")).toBeUndefined();
  await until(async () => (await turnEnds(store, id)) === 2, "retry turn");
  expect(await users()).toHaveLength(2);
});

test("an owner that acks gives no reject and no metric", async () => {
  const { store, a, b, id } = await pair({ ackMs: 20 });
  await prompt(a.broker, id, "say:one");
  await until(async () => (await turnEnds(store, id)) === 1, "turn");
  await idle(store, id);
  expect(await b.broker.dispatch({ chatId: id, binding: "bind-1", cmd: "configure", args: { name: "Renamed" } })).toBeUndefined();
  await until(async () => (await store.get(id))?.name === "Renamed", "renamed on the owner");
  await Bun.sleep(100);
  expect(b.rejects).toHaveLength(0);
  expect(b.metrics.render().includes("owner_unreachable")).toBe(false);
});

test("the idle limit reads the environment, defaults to 2 hours and is capped at 3 hours", () => {
  expect(chatIdleMsFromEnv({})).toBe(2 * 3_600_000);
  expect(chatIdleMsFromEnv({ AIS_GATEWAY_CHAT_IDLE_MINUTES: "30" })).toBe(30 * 60_000);
  expect(chatIdleMsFromEnv({ AIS_GATEWAY_CHAT_IDLE_MINUTES: "600" })).toBe(3 * 3_600_000);
  expect(chatIdleMsFromEnv({ AIS_GATEWAY_CHAT_IDLE_MINUTES: "abc" })).toBe(2 * 3_600_000);
  expect(chatIdleMsFromEnv({ AIS_GATEWAY_CHAT_IDLE_MINUTES: "0" })).toBe(2 * 3_600_000);
});

/** A user event stored by a non-owner, then a cmd for it on the bus. */
async function storeAndSend(store: MemoryChatStore, bus: MemoryChatBus, id: string, text: string, to = "replica-a"): Promise<number> {
  const seq = await store.appendEvent(id, { k: "user", text });
  await bus.publish({ t: "cmd", to, chatId: id, cmd: "prompt", seq });
  return seq;
}

test("two commands for one chat in one tick run one turn, and a repeat of the same number runs nothing", async () => {
  const { store, bus, a, id } = await pair();
  const s1 = await store.appendEvent(id, { k: "user", text: "say:one" });
  const s2 = await store.appendEvent(id, { k: "user", text: "say:two" });
  await Promise.all([bus.publish({ t: "cmd", to: "replica-a", chatId: id, cmd: "prompt", seq: s1 }), bus.publish({ t: "cmd", to: "replica-a", chatId: id, cmd: "prompt", seq: s2 })]);
  await until(async () => (await turnEnds(store, id)) >= 1, "a turn");
  await idle(store, id);
  await Bun.sleep(100);
  expect(await turnEnds(store, id)).toBe(1);
  expect(a.transport.starts).toHaveLength(1);
  const notes = async () => (await bodies(store, id)).filter((x) => x.k === "notice" && x.text.includes("did not take")).length;
  expect(await notes()).toBe(1);
  // The same number again (a retry after a late ack): no turn and no notice.
  await bus.publish({ t: "cmd", to: "replica-a", chatId: id, cmd: "prompt", seq: s1 });
  await bus.publish({ t: "cmd", to: "replica-a", chatId: id, cmd: "prompt", seq: s1 });
  await Bun.sleep(150);
  expect(await turnEnds(store, id)).toBe(1);
  expect(await notes()).toBe(1);
});

test("the same number twice in one tick runs one turn and no busy notice", async () => {
  const { store, bus, a, id } = await pair();
  const seq = await store.appendEvent(id, { k: "user", text: "say:once" });
  const m = { t: "cmd" as const, to: "replica-a", chatId: id, cmd: "prompt" as const, seq };
  await Promise.all([bus.publish(m), bus.publish(m)]);
  await until(async () => (await turnEnds(store, id)) >= 1, "turn");
  await idle(store, id);
  await Bun.sleep(100);
  expect(await turnEnds(store, id)).toBe(1);
  expect((await bodies(store, id)).filter((x) => x.k === "notice" && x.text.includes("did not take"))).toHaveLength(0);
  expect(a.transport.starts).toHaveLength(1);
});

test("a command that arrives while drain begins starts no pod", async () => {
  const { store, bus, a, id } = await pair();
  const orig = store.get.bind(store);
  let armed = true;
  let drained: Promise<void> | undefined;
  store.get = async (cid: string) => {
    const r = await orig(cid);
    if (armed) {
      armed = false;
      drained = a.broker.drain();
    }
    return r;
  };
  await storeAndSend(store, bus, id, "say:late");
  await until(() => drained !== undefined, "drain began");
  await drained;
  await Bun.sleep(100);
  expect(a.transport.starts).toHaveLength(0);
  expect(await turnEnds(store, id)).toBe(0);
});

test("a hung turn during drain is still restarted by the stall check, and drain ends", async () => {
  const { store, clock, a, id } = await pair({ a: { sweepMs: 20, stallMs: 1000 } });
  await prompt(a.broker, id, "hang");
  await until(async () => (await store.get(id))?.state === "thinking", "thinking");
  const d = a.broker.drain();
  clock.t += 5000;
  const outcome = await Promise.race([d.then(() => "done"), Bun.sleep(5000).then(() => "stuck")]);
  expect(outcome).toBe("done");
  expect((await store.get(id))?.ownerReplica).toBeUndefined();
});

test("a publish error rejects the dispatch at once, and a bad command or an oversize one never reaches the bus", async () => {
  const { store, bus, a, b, id } = await pair({ ackMs: 30_000 });
  await prompt(a.broker, id, "say:one");
  await until(async () => (await turnEnds(store, id)) === 1, "turn");
  await idle(store, id);
  const sent: unknown[] = [];
  const pub = bus.publish.bind(bus);
  bus.publish = async (m) => {
    sent.push(m);
    return pub(m);
  };
  const t0 = Date.now();
  bus.drop = () => {
    throw new Error("down");
  };
  const r = await prompt(b.broker, id, "say:two");
  expect(r).toMatchObject({ code: "unavailable", message: "Your message could not be passed on. Try again." });
  expect(Date.now() - t0).toBeLessThan(2000);
  bus.drop = undefined as never;
  sent.length = 0;
  expect(await b.broker.dispatch({ chatId: id, binding: "bind-1", cmd: "configure", args: { name: "x".repeat(200) } })).toMatchObject({ code: "bad_request" });
  expect(await b.broker.dispatch({ chatId: id, binding: "bind-1", cmd: "link", args: { tabIds: "no" } })).toMatchObject({ code: "bad_request" });
  expect(sent).toHaveLength(0);
});

test("the owner gets a busy notice in the feed when a prompt arrives during its pod start", async () => {
  const { store, a, b, id } = await pair({ slowStartMs: 300 });
  await prompt(a.broker, id, "say:one");
  await until(async () => (await store.get(id))?.state === "starting", "starting");
  expect(await prompt(b.broker, id, "say:two")).toBeUndefined();
  await until(async () => (await bodies(store, id)).some((x) => x.k === "notice" && x.text.includes("did not take")), "busy notice");
  await until(async () => (await turnEnds(store, id)) === 1, "turn");
});

test("the lease is judged by the store clock, not by this replica's clock", async () => {
  const { store, clock, a, b, id } = await pair({ frozenA: true, ackMs: 30_000, b: { now: () => 1_700_000_000_000 - 600_000 } });
  await prompt(a.broker, id, "say:one");
  await until(async () => (await turnEnds(store, id)) === 1, "turn");
  await idle(store, id);
  // The store clock says the lease ended. B's own clock is ten minutes behind and would call it live.
  clock.t += 61_000;
  expect(await prompt(b.broker, id, "say:two")).toBeUndefined();
  await until(async () => (await turnEnds(store, id)) === 2, "turn on B without the ack wait");
  expect(b.transport.starts).toHaveLength(1);
});

test("per-chat entries go on close, and late acks stay bounded", async () => {
  const { store, bus, a, id } = await pair();
  await prompt(a.broker, id, "say:one");
  await until(async () => (await turnEnds(store, id)) === 1, "turn");
  await idle(store, id);
  const inner = a.broker as unknown as { notified: Map<string, number>; lastAccepted: Map<string, number>; acked: Map<string, number> };
  inner.lastAccepted.set(id, 5);
  expect(inner.notified.has(id)).toBe(true);
  await a.broker.close(id, "user");
  expect(inner.notified.has(id)).toBe(false);
  expect(inner.lastAccepted.has(id)).toBe(false);
  for (let i = 0; i < 1500; i++) await bus.publish({ t: "ack", to: "replica-a", chatId: id, ref: `late-${i}` });
  await Bun.sleep(100);
  expect(inner.acked.size).toBeLessThanOrEqual(1000);
});
