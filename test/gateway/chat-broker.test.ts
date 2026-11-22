import { afterEach, expect, spyOn, test } from "bun:test";
import { ChatBroker, type BrokerDeps, type BrokerReject } from "../../src/gateway/chat/broker.ts";
import { KubeHttpError } from "../../src/gateway/chat/kube-http.ts";
import { PodStartError } from "../../src/gateway/chat/pod-transport.ts";
import { MemoryChatStore } from "../../src/gateway/chat/store.ts";
import { chatTokenKey, mintChatToken, verifyChatToken } from "../../src/gateway/chat/token.ts";
import { sessionName } from "../../src/gateway/chat/kube.ts";
import type { ChatRecord } from "../../src/gateway/chat/types.ts";
import { PrometheusMetrics } from "../../src/gateway/metrics.ts";
import { StubPodTransport, type StubTransportOptions } from "./fixtures/stub-transport.ts";

const DAY = 86_400_000;
const KEY = chatTokenKey("test-admin-token");
const SELECTION = { provider: "claude", identity: "alpha" } as const;
const brokers: ChatBroker[] = [];
const transports: StubPodTransport[] = [];
afterEach(async () => {
  for (const b of brokers.splice(0)) await b.dispose();
  for (const t of transports.splice(0)) t.killAll();
});

class FakeTimers {
  private n = 0;
  readonly items = new Map<number, { fn: () => void; ms: number }>();
  setTimeout(fn: () => void, ms: number): unknown {
    this.items.set(++this.n, { fn, ms });
    return this.n;
  }
  clearTimeout(h: unknown): void {
    this.items.delete(h as number);
  }
  fire(ms: number): void {
    const hit = [...this.items.entries()].find(([, i]) => i.ms === ms);
    if (!hit) throw new Error(`no timer of ${ms} ms`);
    this.items.delete(hit[0]);
    hit[1].fn();
  }
}

function setup(topts: StubTransportOptions = {}, over: Partial<BrokerDeps> = {}, existing?: { store: MemoryChatStore; clock: { t: number } }) {
  const clock = existing?.clock ?? { t: 1_700_000_000_000 };
  const store = existing?.store ?? new MemoryChatStore(() => clock.t);
  const transport = new StubPodTransport(topts);
  transports.push(transport);
  const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
  const published: Array<[string, number]> = [];
  const broker = new ChatBroker({
    store,
    transport,
    mcpUrl: "http://gateway.test/mcp",
    tokenKey: KEY,
    replicaId: "replica-a",
    metrics,
    now: () => clock.t,
    publish: (id, seq) => void published.push([id, seq]),
    identityOf: async (b) => (b === "bind-1" ? "alpha" : undefined),
    ...over,
  });
  brokers.push(broker);
  return { broker, store, transport, metrics, clock, published };
}

const input = (over: Partial<Parameters<ChatBroker["create"]>[0]> = {}) => ({
  chatId: crypto.randomUUID(),
  binding: "bind-1",
  windowId: 1,
  name: "My chat",
  color: "#aabbcc",
  selection: SELECTION,
  tabIds: [7],
  ...over,
});
const made = async (b: ChatBroker, over: Partial<Parameters<ChatBroker["create"]>[0]> = {}): Promise<ChatRecord> => {
  const r = await b.create(input(over));
  if ("code" in r) throw new Error(`rejected: ${r.code}`);
  return r;
};
const bodies = async (s: MemoryChatStore, id: string) => (await s.events(id, 0, 1000)).map((e) => e.body);

test("create stores the chat and refuses the seventh with window_cap", async () => {
  const { broker, store } = setup();
  for (let i = 0; i < 6; i++) await made(broker);
  const r = (await broker.create(input())) as BrokerReject;
  expect(r.code).toBe("window_cap");
  const first = await made(broker, { windowId: 2 });
  expect(first.state).toBe("starting");
  expect((await bodies(store, first.id))[0]).toEqual({ k: "notice", text: "Starting your agent" });
});

test("create refuses an id that is not a lowercase hex UUID", async () => {
  const { broker, store, transport } = setup();
  for (const chatId of ["0b6f3c2a-1111-4222-8333-44445555666G", "0B6F3C2A-1111-4222-8333-444455556666", "0b6f3c2a", "0b6f3c2a-xxxx-4222-8333-444455556666"]) {
    const r = (await broker.create(input({ chatId }))) as BrokerReject;
    expect(r.code).toBe("bad_request");
  }
  expect(await store.listByBinding("bind-1")).toHaveLength(0);
  expect(transport.starts).toHaveLength(0);
});

test("create refuses a used id with bad_request", async () => {
  const { broker } = setup();
  const rec = await made(broker);
  const r = (await broker.create(input({ chatId: rec.id }))) as BrokerReject;
  expect(r.code).toBe("bad_request");
});

test("the first start sends initialize then session/new with one http mcp server named ais-browser", async () => {
  const { broker, store, transport } = setup();
  const rec = await made(broker);
  expect(transport.starts).toHaveLength(0);
  const rt = await broker.startPod(rec.id);
  expect(rt).toBeDefined();
  const sent = transport.written.map((l) => JSON.parse(l));
  expect(sent[0].method).toBe("initialize");
  expect(sent[1].method).toBe("session/new");
  expect(sent[1].params.cwd).toBe("/work");
  const servers = sent[1].params.mcpServers;
  expect(servers).toHaveLength(1);
  expect(servers[0]).toMatchObject({ type: "http", name: "ais-browser", url: "http://gateway.test/mcp" });
  const h = Object.fromEntries(servers[0].headers.map((x: { name: string; value: string }) => [x.name, x.value]));
  expect(h["X-AIS-Session-Id"]).toBe(`chat:${rec.id}`);
  expect(h["X-AIS-Session-Label"]).toBe("My%20chat");
  const token = String(h.Authorization).replace(/^Bearer /, "");
  expect(verifyChatToken(KEY, token, rec.createdAt)).toEqual({ chatId: rec.id, binding: "bind-1", exp: rec.createdAt + 7 * DAY, gen: 1 });
  const after = await store.get(rec.id);
  expect(after?.state).toBe("idle");
  expect(after?.generation).toBe(1);
  expect(after?.acpSessionId).toStartWith("stub-");
  expect(after?.canLoad).toBe(true);
  expect(transport.starts[0]).toEqual({ chatId: rec.id, generation: 1, provider: "claude", identity: "alpha" });
  expect(transport.signals[0]).toBeInstanceOf(AbortSignal);
});

test("start is single-flight per chat", async () => {
  const { broker, transport } = setup();
  const rec = await made(broker);
  const [a, b] = await Promise.all([broker.startPod(rec.id), broker.startPod(rec.id)]);
  expect(a).toBe(b);
  expect(transport.starts).toHaveLength(1);
});

test("the token is minted for the chat and binding, and appears in no store row, no event and no log line", async () => {
  const logs: string[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" "))));
  try {
    const { broker, store, transport } = setup();
    const rec = await made(broker);
    await broker.startPod(rec.id);
    const sent = JSON.parse(transport.written[1]!);
    const token = String(sent.params.mcpServers[0].headers.find((x: { name: string }) => x.name === "Authorization").value).replace(/^Bearer /, "");
    expect(token).toStartWith("aisc1.");
    const everything = JSON.stringify([await store.get(rec.id), await store.events(rec.id, 0, 1000), await store.listByBinding("bind-1", { includeClosed: true })]);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(token.split(".")[1]!);
    expect(logs.join("\n")).not.toContain(token);
  } finally {
    for (const s of spies) s.mockRestore();
  }
});

test("a failed pod start appends an error item with code pod_start, sets state failed and counts chatError pod_start", async () => {
  const { broker, store, metrics, transport, published } = setup({ failStart: new PodStartError("InitFailed") });
  const rec = await made(broker);
  expect(await broker.startPod(rec.id)).toBeUndefined();
  const list = await bodies(store, rec.id);
  expect(list.at(-1)).toEqual({ k: "error", code: "pod_start", message: "The agent could not start." });
  expect((await store.get(rec.id))?.state).toBe("failed");
  expect(metrics.render()).toContain('ais_gateway_chat_errors_total{kind="pod_start"} 1');
  expect(transport.stopped).toContain(rec.id);
  expect(published.at(-1)).toEqual([rec.id, list.length]);
});

test("a failed start logs one line with op and status, and no message text", async () => {
  const lines: string[] = [];
  const err = new KubeHttpError(403, "create", "Forbidden");
  const { broker } = setup({ failStart: err }, { log: (l) => void lines.push(l) });
  const rec = await made(broker);
  await broker.startPod(rec.id);
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toEqual({ event: "chat_start_failed", chat: rec.id, generation: 1, code: "pod_start", kind: "pod_start", error: "KubeHttpError", op: "create", status: 403, kubeReason: "Forbidden" });
  expect(lines[0]).not.toContain(err.message);
});

test("a failed start of a pod logs its reason code", async () => {
  const lines: string[] = [];
  const { broker } = setup({ failStart: new PodStartError("InitFailed") }, { log: (l) => void lines.push(l) });
  const rec = await made(broker);
  await broker.startPod(rec.id);
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ event: "chat_start_failed", error: "PodStartError", reason: "InitFailed" });
});

test("an other start error logs its constructor name only", async () => {
  const lines: string[] = [];
  const { broker } = setup({ failStart: new Error("secret-host.internal leak-marker-xyz") }, { log: (l) => void lines.push(l) });
  const rec = await made(broker);
  await broker.startPod(rec.id);
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain("leak-marker");
  expect(JSON.parse(lines[0]!)).toMatchObject({ error: "Error", code: "attach" });
});

test("an unknown start error is shown as fixed copy, never raw", async () => {
  const { broker, store } = setup({ failStart: new Error("secret-host.internal refused leak-marker-xyz") });
  const rec = await made(broker);
  await broker.startPod(rec.id);
  const text = JSON.stringify(await bodies(store, rec.id));
  expect(text).not.toContain("secret-host");
  expect(text).not.toContain("leak-marker");
  expect((await bodies(store, rec.id)).at(-1)).toMatchObject({ k: "error", code: "attach" });
});

test("phase notices from the transport become notice items", async () => {
  const { broker, store } = setup({ phases: [{ reason: "NodeBudget", text: "The cluster is busy. Your chat starts when memory is free." }] });
  const rec = await made(broker);
  await broker.startPod(rec.id);
  expect(await bodies(store, rec.id)).toContainEqual({ k: "notice", text: "The cluster is busy. Your chat starts when memory is free." });
});

test("a start that never finishes fails with timeout after startTimeoutMs (fake clock)", async () => {
  const timers = new FakeTimers();
  const { broker, store, metrics, transport } = setup({ hang: true }, { timers, startTimeoutMs: 5000 });
  const rec = await made(broker);
  const p = broker.startPod(rec.id);
  await Bun.sleep(20);
  expect(transport.starts).toHaveLength(1);
  timers.fire(5000);
  expect(await p).toBeUndefined();
  expect((await bodies(store, rec.id)).at(-1)).toEqual({ k: "error", code: "timeout", message: "The agent did not start in time." });
  expect((await store.get(rec.id))?.state).toBe("failed");
  expect(metrics.render()).toContain('ais_gateway_chat_errors_total{kind="timeout"} 1');
});

test("an agent without http MCP support appends an error item", async () => {
  const { broker, store, transport, metrics } = setup({ env: { STUB_ACP_HTTP: "0" } });
  const rec = await made(broker);
  expect(await broker.startPod(rec.id)).toBeUndefined();
  expect((await bodies(store, rec.id)).at(-1)).toMatchObject({ k: "error", message: "This agent cannot use HTTP tools" });
  expect((await store.get(rec.id))?.state).toBe("failed");
  expect(transport.closedStreams).toContain(rec.id);
  expect(transport.written.map((l) => JSON.parse(l).method)).not.toContain("session/new");
  expect(metrics.render()).toContain('ais_gateway_chat_errors_total{kind="acp"} 1');
});

test("an agent exit before initialize appends agent_exit with fixed copy and no stderr text", async () => {
  const { broker, store, metrics } = setup({ exitAtOnce: true });
  const rec = await made(broker);
  expect(await broker.startPod(rec.id)).toBeUndefined();
  const last = (await bodies(store, rec.id)).at(-1);
  expect(last).toMatchObject({ k: "error", code: "agent_exit" });
  const text = JSON.stringify(await bodies(store, rec.id));
  expect(text).not.toContain("boom-from-pod");
  expect(text).not.toContain("leak-marker");
  expect((await store.get(rec.id))?.state).toBe("failed");
  expect(metrics.render()).toContain('ais_gateway_chat_errors_total{kind="agent_exit"} 1');
});

test("an ACP request timeout on initialize closes the pod stream", async () => {
  const { broker, store, transport, metrics } = setup({ silent: true }, { acpTimeoutMs: 50 });
  const rec = await made(broker);
  expect(await broker.startPod(rec.id)).toBeUndefined();
  expect(transport.closedStreams).toContain(rec.id);
  expect((await bodies(store, rec.id)).at(-1)).toMatchObject({ k: "error", code: "timeout" });
  expect(metrics.render()).toContain('ais_gateway_chat_errors_total{kind="timeout"} 1');
});

test("principal() returns the chat for a good token and undefined once the chat is closed or past maxAgeMs", async () => {
  const { broker, store, clock } = setup();
  const rec = await made(broker, { tabIds: [7, 9] });
  const mint = (await import("../../src/gateway/chat/token.ts")).mintChatToken;
  const token = mint(KEY, { chatId: rec.id, binding: "bind-1", exp: rec.createdAt + 7 * DAY, gen: 0 });
  const p = await broker.principal(token);
  expect(p).toMatchObject({ chatId: rec.id, binding: "bind-1", identity: "alpha", label: "My chat", color: "#aabbcc" });
  expect([...(p?.linked ?? [])]).toEqual([7, 9]);
  expect(await broker.principal("aisc1.bad.token")).toBeUndefined();
  expect(await broker.principal(mint(KEY, { chatId: rec.id, binding: "bind-2", exp: rec.createdAt + 7 * DAY, gen: 0 }))).toBeUndefined();
  expect(await broker.principal(mint(chatTokenKey("other"), { chatId: rec.id, binding: "bind-1", exp: rec.createdAt + 7 * DAY, gen: 0 }))).toBeUndefined();
  // Past maxAgeMs, even with a token that has not expired.
  const long = mint(KEY, { chatId: rec.id, binding: "bind-1", exp: rec.createdAt + 30 * DAY, gen: 0 });
  clock.t = rec.createdAt + 7 * DAY + 1;
  expect(await broker.principal(long)).toBeUndefined();
  clock.t = rec.createdAt + 1000;
  expect(await broker.principal(token)).toBeDefined();
  // Closed.
  const fence = { replica: "replica-a", epoch: (await store.acquireLease(rec.id, "replica-a", 60_000, clock.t))! };
  await store.update(rec.id, { state: "closed" }, fence);
  expect(await broker.principal(token)).toBeUndefined();
});

test("principal() is undefined when the binding has no identity", async () => {
  const { broker } = setup({}, { identityOf: async () => undefined });
  const rec = await made(broker);
  const token = (await import("../../src/gateway/chat/token.ts")).mintChatToken(KEY, { chatId: rec.id, binding: "bind-1", exp: rec.createdAt + DAY, gen: 0 });
  expect(await broker.principal(token)).toBeUndefined();
});

test("chatPodStart is observed with the seconds from the start of the start path to initialize", async () => {
  const clock = { t: 1_700_000_000_000 };
  const { broker, metrics } = setup({ beforeSpawn: async () => void (clock.t += 2500) }, {}, { store: new MemoryChatStore(() => clock.t), clock });
  const rec = await made(broker);
  clock.t += 10_000; // idle time between create and the first start does not count
  await broker.startPod(rec.id);
  const out = metrics.render();
  expect(out).toContain("ais_gateway_chat_pod_start_seconds_count 1");
  expect(out).toContain("ais_gateway_chat_pod_start_seconds_sum 2.5");
});

test("the generation grows across gateway restarts and is never reused", async () => {
  const first = setup();
  const rec = await made(first.broker);
  await first.broker.startPod(rec.id);
  await first.broker.dispose();
  const second = setup({}, {}, { store: first.store, clock: first.clock });
  await second.broker.startPod(rec.id);
  expect((await first.store.get(rec.id))?.generation).toBe(2);
  expect(second.transport.starts[0]?.generation).toBe(2);
});

test("a known create and start flow emits no other series", async () => {
  const { broker, metrics } = setup();
  const rec = await made(broker);
  await broker.startPod(rec.id);
  const out = metrics.render();
  expect(out).toContain('ais_gateway_chat_sessions_total{event="session_created"} 1');
  expect(out).not.toContain('"other"');
});

const tokenOf = (transport: StubPodTransport, n = 1): string => {
  const line = transport.written.map((l) => JSON.parse(l)).filter((m) => m.method === "session/new")[n - 1];
  return String(line.params.mcpServers[0].headers.find((x: { name: string }) => x.name === "Authorization").value).replace(/^Bearer /, "");
};
const tick = () => Bun.sleep(10);

test("the lease is renewed during a slow start, so the start ends idle", async () => {
  const timers = new FakeTimers();
  const clock = { t: 1_700_000_000_000 };
  const { broker, store } = setup(
    {
      beforeSpawn: async () => {
        clock.t += 30_000;
        timers.fire(20_000);
        await tick();
        clock.t += 50_000; // now past the first expiry of 60 s
      },
    },
    { timers },
    { store: new MemoryChatStore(() => clock.t), clock },
  );
  const rec = await made(broker);
  expect(await broker.startPod(rec.id)).toBeDefined();
  expect((await store.get(rec.id))?.state).toBe("idle");
});

test("a hung start with renewals still shows a timeout item", async () => {
  const timers = new FakeTimers();
  const clock = { t: 1_700_000_000_000 };
  const { broker, store } = setup({ hang: true }, { timers, startTimeoutMs: 300_000 }, { store: new MemoryChatStore(() => clock.t), clock });
  const rec = await made(broker);
  const p = broker.startPod(rec.id);
  await tick();
  clock.t += 30_000;
  timers.fire(20_000);
  await tick();
  clock.t += 50_000;
  timers.fire(300_000);
  expect(await p).toBeUndefined();
  expect((await bodies(store, rec.id)).at(-1)).toMatchObject({ k: "error", code: "timeout" });
});

test("a lost lease stops only its own session and never the session of the new owner", async () => {
  const clock = { t: 1_700_000_000_000 };
  const store = new MemoryChatStore(() => clock.t);
  const cluster = new Set<string>();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const a = setup({ cluster, beforeSpawn: () => held }, { replicaId: "replica-a" }, { store, clock });
  const b = setup({ cluster }, { replicaId: "replica-b" }, { store, clock });
  const rec = await made(a.broker);
  const pa = a.broker.startPod(rec.id);
  await tick();
  clock.t += 120_000; // the lease of A has expired
  expect(await b.broker.startPod(rec.id)).toBeDefined();
  release();
  expect(await pa).toBeUndefined();
  expect(a.transport.starts[0]?.generation).toBe(1);
  expect(b.transport.starts[0]?.generation).toBe(2);
  expect(a.transport.stopped).toEqual([]);
  expect(a.transport.stoppedSessions).toContain(sessionName(rec.id, 1));
  expect(cluster.has(sessionName(rec.id, 2))).toBe(true);
  expect((await store.get(rec.id))?.state).toBe("idle");
  expect(JSON.stringify(await bodies(store, rec.id))).not.toContain('"error"');
});

test("a token of an older generation, and any token after a failed start, is refused", async () => {
  const first = setup();
  const rec = await made(first.broker);
  await first.broker.startPod(rec.id);
  const old = tokenOf(first.transport);
  expect(await first.broker.principal(old)).toBeDefined();
  await first.broker.dispose();
  const second = setup({}, {}, { store: first.store, clock: first.clock });
  await second.broker.startPod(rec.id);
  expect(await second.broker.principal(old)).toBeUndefined();
  expect(await second.broker.principal(tokenOf(second.transport))).toBeDefined();
  const bad = setup({ env: { STUB_ACP_NEW_ERROR: "1" } });
  const r2 = await made(bad.broker);
  const t = mintChatToken(KEY, { chatId: r2.id, binding: "bind-1", exp: r2.createdAt + DAY, gen: 1 });
  await bad.broker.startPod(r2.id);
  expect(await bad.broker.principal(t)).toBeUndefined();
});

test("an agent error on session/new is classified as acp", async () => {
  const { broker, store } = setup({ env: { STUB_ACP_NEW_ERROR: "1" } });
  const rec = await made(broker);
  expect(await broker.startPod(rec.id)).toBeUndefined();
  expect((await bodies(store, rec.id)).at(-1)).toMatchObject({ k: "error", code: "acp" });
});

test("a store error while reporting a failure stops only the own session and never rejects", async () => {
  const clock = { t: 1_700_000_000_000 };
  const inner = new MemoryChatStore(() => clock.t);
  const store = Object.create(inner) as MemoryChatStore;
  store.appendEvent = async (id, body, fence) => {
    if (body.k === "error") throw new Error("database down");
    return inner.appendEvent(id, body, fence);
  };
  const { broker, transport } = setup({ failStart: new PodStartError("InitFailed") }, {}, { store, clock });
  const rec = await made(broker);
  expect(await broker.startPod(rec.id)).toBeUndefined();
  expect(transport.stopped).toEqual([]);
  expect(transport.stoppedSessions).toContain(sessionName(rec.id, 1));
});

test("a store error at the start of a start gives undefined, not a rejection", async () => {
  const clock = { t: 1_700_000_000_000 };
  const inner = new MemoryChatStore(() => clock.t);
  const store = Object.create(inner) as MemoryChatStore;
  const { broker } = setup({}, {}, { store, clock });
  const rec = await made(broker);
  store.get = async () => {
    throw new Error("database down");
  };
  expect(await broker.startPod(rec.id)).toBeUndefined();
});

test("a new start removes the pod of an older generation", async () => {
  const cluster = new Set<string>();
  const first = setup({ cluster });
  const rec = await made(first.broker);
  await first.broker.startPod(rec.id);
  expect([...cluster]).toEqual([sessionName(rec.id, 1)]);
  await first.broker.dispose();
  const second = setup({ cluster }, {}, { store: first.store, clock: first.clock });
  await second.broker.startPod(rec.id);
  expect([...cluster]).toEqual([sessionName(rec.id, 2)]);
});

test("startPod refuses a chat past maxAgeMs with fixed copy", async () => {
  const { broker, store, transport, clock } = setup();
  const rec = await made(broker);
  clock.t = rec.createdAt + 7 * DAY + 1;
  expect(await broker.startPod(rec.id)).toBeUndefined();
  expect(transport.starts).toHaveLength(0);
  expect((await bodies(store, rec.id)).at(-1)).toEqual({ k: "error", code: "expired", message: "This chat is too old. Open a new chat." });
});

test("an abort from dispose is not a failure and leaves the chat resumable", async () => {
  const { broker, store, metrics, transport } = setup({ hang: true });
  const rec = await made(broker);
  const p = broker.startPod(rec.id);
  await tick();
  await broker.dispose();
  expect(await p).toBeUndefined();
  expect(JSON.stringify(await bodies(store, rec.id))).not.toContain('"error"');
  expect((await store.get(rec.id))?.state).toBe("starting");
  expect(metrics.render()).not.toContain("ais_gateway_chat_errors_total{");
  expect(transport.stopped).toEqual([]);
});

test("create frees its lease even when the notice cannot be stored", async () => {
  const clock = { t: 1_700_000_000_000 };
  const inner = new MemoryChatStore(() => clock.t);
  const store = Object.create(inner) as MemoryChatStore;
  store.appendEvent = async () => {
    throw new Error("database down");
  };
  const { broker } = setup({}, {}, { store, clock });
  const id = crypto.randomUUID();
  await expect(broker.create(input({ chatId: id }))).rejects.toThrow();
  expect(await inner.acquireLease(id, "replica-z", 1000, clock.t)).toBeDefined();
});

test("a generic store error in fail() after the lease moved leaves the new owner's session", async () => {
  const clock = { t: 1_700_000_000_000 };
  const inner = new MemoryChatStore(() => clock.t);
  const brokenA = Object.create(inner) as MemoryChatStore;
  brokenA.appendEvent = async (id, body, fence) => {
    if (body.k === "error") throw new Error("database down");
    return inner.appendEvent(id, body, fence);
  };
  const cluster = new Set<string>();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const a = setup({ cluster, beforeSpawn: () => held, env: { STUB_ACP_NEW_ERROR: "1" } }, { replicaId: "replica-a" }, { store: brokenA, clock });
  const b = setup({ cluster }, { replicaId: "replica-b" }, { store: inner, clock });
  const rec = await made(a.broker);
  const pa = a.broker.startPod(rec.id);
  await tick();
  clock.t += 120_000;
  expect(await b.broker.startPod(rec.id)).toBeDefined();
  release();
  expect(await pa).toBeUndefined();
  expect(a.transport.stopped).toEqual([]);
  expect(cluster.has(sessionName(rec.id, 2))).toBe(true);
});

test("a lease that expires with no new owner ends with a visible error and state failed", async () => {
  const timers = new FakeTimers();
  const clock = { t: 1_700_000_000_000 };
  const { broker, store, metrics } = setup({ hang: true }, { timers, startTimeoutMs: 300_000 }, { store: new MemoryChatStore(() => clock.t), clock });
  const rec = await made(broker);
  const p = broker.startPod(rec.id);
  await tick();
  clock.t += 70_000; // the lease has expired and nobody else took it
  timers.fire(20_000);
  expect(await p).toBeUndefined();
  expect((await bodies(store, rec.id)).at(-1)).toMatchObject({ k: "error", code: "unavailable" });
  expect((await store.get(rec.id))?.state).toBe("failed");
  expect(metrics.render()).toContain('ais_gateway_chat_errors_total{kind="other"} 1');
});

test("a running chat whose lease expires with no new owner shows an error and fails", async () => {
  const timers = new FakeTimers();
  const clock = { t: 1_700_000_000_000 };
  const { broker, store } = setup({}, { timers }, { store: new MemoryChatStore(() => clock.t), clock });
  const rec = await made(broker);
  expect(await broker.startPod(rec.id)).toBeDefined();
  clock.t += 70_000;
  timers.fire(20_000);
  await Bun.sleep(50);
  expect((await bodies(store, rec.id)).at(-1)).toMatchObject({ k: "error", code: "unavailable" });
  expect((await store.get(rec.id))?.state).toBe("failed");
});

test("a dispose during session/new revokes the token even when stopSession fails", async () => {
  const { broker, store, transport } = setup({ env: { STUB_ACP_NEW_HANG: "1" }, failStopSession: true });
  const rec = await made(broker);
  const p = broker.startPod(rec.id);
  for (let i = 0; i < 200 && !transport.written.some((l) => l.includes("session/new")); i++) await Bun.sleep(5);
  const token = tokenOf(transport);
  expect(await broker.principal(token)).toBeDefined();
  await broker.dispose();
  expect(await p).toBeUndefined();
  expect(transport.stoppedSessions).toContain(sessionName(rec.id, 1));
  expect(await broker.principal(token)).toBeUndefined();
  expect((await store.get(rec.id))?.generation).toBe(2);
});

test("a hung stopSession of an old generation cannot hold the start past its deadline", async () => {
  const first = setup();
  const rec = await made(first.broker);
  await first.broker.startPod(rec.id);
  await first.broker.dispose();
  const timers = new FakeTimers();
  const second = setup({ hangStopSession: true }, { timers, startTimeoutMs: 5000 }, { store: first.store, clock: first.clock });
  const p = second.broker.startPod(rec.id);
  await tick();
  expect(second.transport.starts).toHaveLength(0);
  timers.fire(5000);
  expect(await p).toBeUndefined();
  expect((await bodies(first.store, rec.id)).at(-1)).toMatchObject({ k: "error", code: "timeout" });
});

test("a late lost-lease clean-up leaves a newer generation alone and adds no second error", async () => {
  const clock = { t: 1_700_000_000_000 };
  const store = new MemoryChatStore(() => clock.t);
  const cluster = new Set<string>();
  const timers = new FakeTimers();
  const a = setup({ cluster }, { replicaId: "replica-a", timers }, { store, clock });
  const b = setup({ cluster }, { replicaId: "replica-b" }, { store, clock });
  const rec = await made(a.broker);
  expect(await a.broker.startPod(rec.id)).toBeDefined();
  clock.t += 120_000;
  expect(await b.broker.startPod(rec.id)).toBeDefined();
  await b.broker.dispose(); // the lease is free and the pod of B stays
  timers.fire(20_000);
  await Bun.sleep(50);
  expect(cluster.has(sessionName(rec.id, 2))).toBe(true);
  expect(JSON.stringify(await bodies(store, rec.id))).not.toContain('"error"');
  expect(a.transport.stopped).toEqual([]);
  expect((await store.get(rec.id))?.state).toBe("idle");
});

test("a start during a lost-lease clean-up waits for it and keeps its pod", async () => {
  const clock = { t: 1_700_000_000_000 };
  const inner = new MemoryChatStore(() => clock.t);
  const store = Object.create(inner) as MemoryChatStore;
  let gate: Promise<void> | undefined;
  let waiting = false;
  store.acquireLease = async (id, replica, ttl, now) => {
    if (gate) {
      waiting = true;
      await gate;
    }
    return inner.acquireLease(id, replica, ttl, now);
  };
  const cluster = new Set<string>();
  const timers = new FakeTimers();
  const { broker, transport } = setup({ cluster }, { timers }, { store, clock });
  const rec = await made(broker);
  expect(await broker.startPod(rec.id)).toBeDefined();
  let open!: () => void;
  gate = new Promise<void>((r) => (open = r));
  clock.t += 70_000;
  timers.fire(20_000);
  for (let i = 0; i < 100 && !waiting; i++) await Bun.sleep(5);
  const again = broker.startPod(rec.id);
  await tick();
  expect(transport.starts).toHaveLength(1);
  gate = undefined;
  open();
  expect(await again).toBeDefined();
  expect(transport.starts).toHaveLength(2);
  expect([...cluster]).toEqual([sessionName(rec.id, 2)]);
  const errors = (await bodies(inner, rec.id)).filter((x) => x.k === "error");
  expect(errors).toHaveLength(1);
  expect((await inner.get(rec.id))?.state).toBe("idle");
});
