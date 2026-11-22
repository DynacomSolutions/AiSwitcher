import { afterEach, expect, spyOn, test } from "bun:test";
import { ChatBroker, type BrokerDeps, type BrokerReject } from "../../src/gateway/chat/broker.ts";
import { PodStartError } from "../../src/gateway/chat/pod-transport.ts";
import { MemoryChatStore } from "../../src/gateway/chat/store.ts";
import { chatTokenKey, verifyChatToken } from "../../src/gateway/chat/token.ts";
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
  expect(verifyChatToken(KEY, token, rec.createdAt)).toEqual({ chatId: rec.id, binding: "bind-1", exp: rec.createdAt + 7 * DAY });
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
  const token = mint(KEY, { chatId: rec.id, binding: "bind-1", exp: rec.createdAt + 7 * DAY });
  const p = await broker.principal(token);
  expect(p).toMatchObject({ chatId: rec.id, binding: "bind-1", identity: "alpha", label: "My chat", color: "#aabbcc" });
  expect([...(p?.linked ?? [])]).toEqual([7, 9]);
  expect(await broker.principal("aisc1.bad.token")).toBeUndefined();
  expect(await broker.principal(mint(KEY, { chatId: rec.id, binding: "bind-2", exp: rec.createdAt + 7 * DAY }))).toBeUndefined();
  expect(await broker.principal(mint(chatTokenKey("other"), { chatId: rec.id, binding: "bind-1", exp: rec.createdAt + 7 * DAY }))).toBeUndefined();
  // Past maxAgeMs, even with a token that has not expired.
  const long = mint(KEY, { chatId: rec.id, binding: "bind-1", exp: rec.createdAt + 30 * DAY });
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
  const token = (await import("../../src/gateway/chat/token.ts")).mintChatToken(KEY, { chatId: rec.id, binding: "bind-1", exp: rec.createdAt + DAY });
  expect(await broker.principal(token)).toBeUndefined();
});

test("chatPodStart is observed with the seconds from create to initialize", async () => {
  const { broker, metrics, clock } = setup();
  const rec = await made(broker);
  clock.t = rec.createdAt + 2500;
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
