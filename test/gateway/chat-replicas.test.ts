import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatBody } from "../../src/browser/chat-protocol.ts";
import { MemoryChatBus, type ChatBusMsg } from "../../src/gateway/chat/bus.ts";
import { ChatBroker, chatIdleMsFromEnv } from "../../src/gateway/chat/broker.ts";
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
async function pair(opts: { frozenA?: boolean; ackMs?: number; ackTries?: number } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const store = new MemoryChatStore(() => clock.t);
  const bus = new MemoryChatBus();
  const cluster = new Set<string>();
  const stateFile = join(root, `${crypto.randomUUID()}.state`);
  const make = async (replicaId: string, timers?: Timers) => {
    const transport = new StubPodTransport({ cluster, env: { STUB_ACP_STATE: stateFile } });
    transports.push(transport);
    const seen: Array<[string, number]> = [];
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
      ...(opts.ackMs !== undefined ? { forwardAckMs: opts.ackMs } : {}),
      ...(opts.ackTries !== undefined ? { forwardAckTries: opts.ackTries } : {}),
    });
    brokers.push(broker);
    await broker.start();
    return { broker, transport, seen, metrics };
  };
  const a = await make("replica-a", opts.frozenA ? frozen : undefined);
  const b = await make("replica-b");
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

test("a missed notice is recovered: events(afterSeq) from the store fills the gap", async () => {
  const { store, bus, a, b, id } = await pair();
  let dropNext = true;
  bus.drop = (m: ChatBusMsg) => {
    if (m.t === "event" && dropNext) {
      dropNext = false;
      return true;
    }
    return false;
  };
  await prompt(a.broker, id, "say:gap");
  await until(async () => (await turnEnds(store, id)) === 1, "turn");
  await idle(store, id);
  await Bun.sleep(50);
  const last = (await store.get(id))?.lastSeq ?? 0;
  const top = Math.max(...b.seen.map(([, s]) => s));
  expect(top).toBeGreaterThan(0);
  // The consumer holds a cursor. A later notice makes it read from the store, and it gets the dropped events too.
  const rows = await store.events(id, 0, 1000);
  expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: last }, (_, i) => i + 1));
  expect(b.seen.some(([, s]) => s === last)).toBe(true);
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

test("a prompt that stays unanswered by a live owner is counted, and its user event stays in the feed", async () => {
  const { store, bus, a, b, id } = await pair({ ackMs: 20, ackTries: 3 });
  await prompt(a.broker, id, "say:one");
  await until(async () => (await turnEnds(store, id)) === 1, "turn");
  await idle(store, id);
  bus.drop = (m) => m.t === "cmd";
  expect(await prompt(b.broker, id, "say:two")).toBeUndefined();
  await until(() => b.metrics.render().includes('kind="owner_unreachable"'), "metric");
  expect((await bodies(store, id)).filter((x) => x.k === "user")).toHaveLength(2);
  expect(b.transport.starts).toHaveLength(0);
});

test("the idle limit reads the environment, defaults to 2 hours and is capped at 3 hours", () => {
  expect(chatIdleMsFromEnv({})).toBe(2 * 3_600_000);
  expect(chatIdleMsFromEnv({ AIS_GATEWAY_CHAT_IDLE_MINUTES: "30" })).toBe(30 * 60_000);
  expect(chatIdleMsFromEnv({ AIS_GATEWAY_CHAT_IDLE_MINUTES: "600" })).toBe(3 * 3_600_000);
  expect(chatIdleMsFromEnv({ AIS_GATEWAY_CHAT_IDLE_MINUTES: "abc" })).toBe(2 * 3_600_000);
  expect(chatIdleMsFromEnv({ AIS_GATEWAY_CHAT_IDLE_MINUTES: "0" })).toBe(2 * 3_600_000);
});
