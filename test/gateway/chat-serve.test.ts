import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { MemoryChatBus } from "../../src/gateway/chat/bus.ts";
import { buildChatSession, type KubeApi, type PodHandle, type PodPhaseNotice, type PodSpecInput } from "../../src/gateway/chat/kube.ts";
import { chatTokenKey, mintChatToken } from "../../src/gateway/chat/token.ts";
import { MemoryRefreshBackend } from "../../src/gateway/refresh-guard.ts";
import { chatConfigFromEnv, startGateway, type GatewayHooks } from "../../src/gateway/serve.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { generateToken } from "../../src/gateway/tokens.ts";
import { StubPodTransport } from "./fixtures/stub-transport.ts";

const ADMIN = "adm-test-value-0001-0123456789abcdef";
const root = mkdtempSync(join(tmpdir(), "ais-chat-serve-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Frame = Record<string, any>;

/** An extension stand-in: a WebSocket that says hello and keeps every frame. */
class Client {
  readonly frames: Frame[] = [];
  closeCode?: number;
  closedAt?: number;
  onCall?: (req: Frame) => Frame;
  private constructor(private readonly ws: WebSocket) {}
  static async open(port: number, token: string, onCall?: (req: Frame) => Frame): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/browser/connect`);
    const c = new Client(ws);
    if (onCall) c.onCall = onCall;
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Frame;
      c.frames.push(m);
      if (m.t === "call" && c.onCall) ws.send(JSON.stringify({ t: "result", result: c.onCall(m.req) }));
    };
    ws.onclose = (e) => {
      c.closeCode = e.code;
      c.closedAt = Date.now();
    };
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("ws error"));
    });
    ws.send(JSON.stringify({ t: "hello", token, version: "1", paused: false }));
    await c.until(() => c.frames.some((f) => f.t === "welcome"));
    return c;
  }
  send(f: Frame): void {
    this.ws.send(JSON.stringify(f));
  }
  of(t: string): Frame[] {
    return this.frames.filter((f) => f.t === t);
  }
  async until(fn: () => boolean, ms = 8000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return;
      await Bun.sleep(10);
    }
    throw new Error(`timed out; frames: ${JSON.stringify(this.frames.map((f) => f.t))}`);
  }
}

let store: MemoryGatewayStore;
let started: Array<{ stop(): Promise<void> }>;
let transports: StubPodTransport[];
let origWarn: typeof console.warn;
let origInfo: typeof console.info;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  store = new MemoryGatewayStore();
  started = [];
  transports = [];
  origWarn = console.warn;
  origInfo = console.info;
  console.warn = () => {};
  console.info = () => {};
  for (const k of Object.keys(process.env)) if (k.startsWith("AIS_GATEWAY_CHAT_")) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  for (const g of started) await g.stop().catch(() => undefined);
  for (const t of transports) t.killAll();
  console.warn = origWarn;
  console.info = origInfo;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  for (const k of Object.keys(process.env)) if (k.startsWith("AIS_GATEWAY_CHAT_")) delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
});

const hooks = (over: Partial<GatewayHooks> = {}): GatewayHooks => ({
  host: "127.0.0.1",
  refreshBackend: new MemoryRefreshBackend(),
  migrate: async () => undefined,
  openStore: () => store,
  creds: { get: async (_p: string, identity: string) => ({ identity, accessToken: "x" }), refreshAfter401: async () => ({ identity: "id1", accessToken: "x" }) } as unknown as GatewayHooks["creds"],
  usageFor: async () => undefined,
  poolMembers: async () => ["id1"],
  notify: () => undefined,
  warmBackoff: { initialMs: 10, maxMs: 20 },
  ledger: { max: 1000, flushMs: 3_600_000 },
  refreshIntervalMs: 3_600_000,
  exit: () => undefined,
  noHeartbeat: true,
  ...over,
});

async function boot(over: Partial<GatewayHooks> = {}) {
  const g = await startGateway({ port: 0, adminPort: 0, databaseUrl: "postgres://unused", adminToken: ADMIN, handleSignals: false }, hooks(over));
  started.push(g);
  const end = Date.now() + 5000;
  while (!g.ready() && Date.now() < end) await Bun.sleep(10);
  if (!g.ready()) throw new Error("gateway not ready");
  return g;
}

async function pair(): Promise<string> {
  await store.putBrowserBinding({ name: "work", target: { kind: "identity", identity: "id1" }, profileLabel: "w", state: "active", createdAt: "2026-11-01T00:00:00.000Z" });
  const t = generateToken();
  await store.addBrowserToken("work", t.prefix, t.hash);
  return t.token;
}

const stub = (over: ConstructorParameters<typeof StubPodTransport>[0] = {}): StubPodTransport => {
  const t = new StubPodTransport({ env: { STUB_ACP_STATE: join(root, `${crypto.randomUUID()}.state`) }, ...over });
  transports.push(t);
  return t;
};
const SEL = { provider: "claude", identity: "alpha" };
const create = (chatId: string, over: Frame = {}): Frame => ({ t: "chat.create", chatId, name: "Chat", color: "#336699", windowId: 1, selection: SEL, tabIds: [4242], ...over });
const texts = (c: Client): string => c.of("chat.event").filter((e) => e.body.k === "text").map((e) => e.body.text).join("");

test("a full chat over the WebSocket: create, prompt \"say:hello\", receives chat.event text then turn_end", async () => {
  const token = await pair();
  const g = await boot({ chatTransport: stub() });
  const c = await Client.open(g.port, token);
  // The attach sends the chat list first.
  await c.until(() => c.of("chat.list").length === 1);
  const chatId = crypto.randomUUID();
  c.send(create(chatId));
  await c.until(() => c.of("chat.state").some((s) => s.state === "starting"));
  c.send({ t: "chat.prompt", chatId, text: "say:hello" });
  await c.until(() => c.of("chat.event").some((e) => e.body.k === "turn_end"));
  const events = c.of("chat.event");
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  const kinds = events.map((e) => e.body.k);
  expect(kinds.indexOf("user")).toBeGreaterThanOrEqual(0);
  expect(kinds.indexOf("text")).toBeGreaterThan(kinds.indexOf("user"));
  expect(kinds.at(-1)).toBe("turn_end");
  expect(texts(c)).toBe("hello");
  await c.until(() => c.of("chat.state").at(-1)?.state === "idle");
  expect(c.of("chat.reject")).toEqual([]);
});

test("the stub agent reaches /browser/mcp with the chat token and tabs_context lists only linked tabs", async () => {
  const token = await pair();
  const g = await boot({ chatTransport: stub() });
  const calls: Frame[] = [];
  const c = await Client.open(g.port, token, (req) => {
    calls.push(req);
    return { id: req.id, ok: true, content: [{ type: "text", text: JSON.stringify({ sessionTabs: [{ tabId: 4242, url: "https://example.test/a" }, { tabId: 5151 }], otherTabs: [{ tabId: 6161 }], grantedGroups: [{ groupId: 9 }] }) }] };
  });
  const chatId = crypto.randomUUID();
  c.send(create(chatId));
  await c.until(() => c.of("chat.state").length > 0);
  c.send({ t: "chat.prompt", chatId, text: "mcp-tabs" });
  await c.until(() => c.of("chat.event").some((e) => e.body.k === "turn_end"));
  const out = texts(c);
  expect(out.startsWith("tabs:200:")).toBe(true);
  expect(out).toContain("4242");
  expect(out).not.toContain("5151");
  expect(out).not.toContain("6161");
  expect(out).not.toContain("groupId");
  // One call reached the extension, for the chat's own session.
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ tool: "tabs_context", session: { id: `chat:${chatId}`, chat: true } });
});

test("SIGTERM-style stop() while a turn runs lets the turn finish and closes the sockets with 1012", async () => {
  const token = await pair();
  let turnEnded = false;
  let endedBeforeSessionStop: boolean | undefined;
  class Spy extends StubPodTransport {
    override async start(input: PodSpecInput, signal: AbortSignal, onPhase: (n: PodPhaseNotice) => void): Promise<PodHandle> {
      const h = await super.start(input, signal, onPhase);
      h.stream.onLine((l) => {
        if (l.includes("stopReason")) turnEnded = true;
      });
      return h;
    }
    override async stopSession(session: string): Promise<void> {
      endedBeforeSessionStop = turnEnded;
      await super.stopSession(session);
    }
  }
  const spy = new Spy({ env: { STUB_ACP_STATE: join(root, `${crypto.randomUUID()}.state`) } });
  transports.push(spy);
  const g = await boot({ chatTransport: spy });
  const c = await Client.open(g.port, token);
  const chatId = crypto.randomUUID();
  c.send(create(chatId));
  await c.until(() => c.of("chat.state").length > 0);
  c.send({ t: "chat.prompt", chatId, text: "wait:700" });
  await c.until(() => spy.written.some((l) => l.includes("session/prompt")));
  const stopping = g.stop();
  await c.until(() => c.closeCode !== undefined);
  expect(c.closeCode).toBe(1012);
  // The socket closed while the turn still ran.
  expect(turnEnded).toBe(false);
  expect(g.ready()).toBe(false);
  await stopping;
  expect(turnEnded).toBe(true);
  expect(endedBeforeSessionStop).toBe(true);
});

test("/metrics shows the chat series", async () => {
  const token = await pair();
  const g = await boot({ chatTransport: stub() });
  const c = await Client.open(g.port, token);
  const chatId = crypto.randomUUID();
  c.send(create(chatId));
  await c.until(() => c.of("chat.state").length > 0);
  c.send({ t: "chat.prompt", chatId, text: "say:hi" });
  await c.until(() => c.of("chat.event").some((e) => e.body.k === "turn_end"));
  const body = await (await fetch(`http://127.0.0.1:${g.port}/metrics`)).text();
  expect(body).toContain('ais_gateway_chat_sessions_total{event="session_created"} 1');
  expect(body).toContain('ais_gateway_chat_turns_total{outcome="ok"} 1');
  expect(body).toMatch(/ais_gateway_chat_pod_start_seconds_count [1-9]/);
  expect(body).toMatch(/ais_gateway_chats_active 1\n/);
});

test("with the env unset no chat route or frame is active (chat.create gets chat.reject unavailable)", async () => {
  const token = await pair();
  const g = await boot();
  const c = await Client.open(g.port, token);
  const chatId = crypto.randomUUID();
  c.send(create(chatId));
  c.send({ t: "chat.catalog", reqId: "r1" });
  await c.until(() => c.of("chat.reject").length === 2);
  expect(c.of("chat.reject")).toEqual([
    { t: "chat.reject", chatId, code: "unavailable", message: "Chat is not available on this gateway." },
    { t: "chat.reject", reqId: "r1", code: "unavailable", message: "Chat is not available on this gateway." },
  ]);
  expect(c.of("chat.list")).toEqual([]);
  // A chat token gets no access to the MCP route.
  const real = mintChatToken(chatTokenKey(ADMIN), { chatId, binding: "work", exp: Date.now() + 60_000, gen: 0 });
  const res = await fetch(`http://127.0.0.1:${g.port}/browser/mcp`, { method: "POST", headers: { authorization: `Bearer ${real}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  expect(res.status).toBe(401);
  expect(c.closeCode).toBeUndefined();
});

test("chat settings come from the environment, and the class reaches the AgentSession spec", () => {
  const env = { AIS_GATEWAY_CHAT_GROUP: "agents.example.test", AIS_GATEWAY_CHAT_MCP_URL: "http://gateway.example.test/browser/mcp", AIS_GATEWAY_CHAT_NAMESPACE: "ns-a", AIS_GATEWAY_CHAT_NODE: "node-a" };
  const dflt = chatConfigFromEnv(env);
  expect(dflt).toEqual({ kube: { group: "agents.example.test", namespace: "ns-a", node: "node-a", configMap: "agent-runtime-config", class: "chat" }, mcpUrl: "http://gateway.example.test/browser/mcp", maxLive: 12, startTimeoutMs: 240_000 });
  const custom = chatConfigFromEnv({ ...env, AIS_GATEWAY_CHAT_CLASS: "heavy", AIS_GATEWAY_CHAT_CONFIG_MAP: "cfg-x", AIS_GATEWAY_CHAT_MAX: "5", AIS_GATEWAY_CHAT_START_TIMEOUT_MS: "9000" });
  expect(custom).toMatchObject({ kube: { class: "heavy", configMap: "cfg-x" }, maxLive: 5, startTimeoutMs: 9000 });
  const session = buildChatSession({ chatId: crypto.randomUUID(), generation: 1, provider: "claude", identity: "alpha" }, custom!.kube, 1_700_000_000) as { spec: { class: string; workspace: string; node: string } };
  expect(session.spec).toMatchObject({ class: "heavy", workspace: "chat", node: "node-a" });
  expect((buildChatSession({ chatId: crypto.randomUUID(), generation: 1, provider: "claude", identity: "alpha" }, dflt!.kube, 1) as { spec: { class: string } }).spec.class).toBe("chat");
  // A bad number means the default.
  expect(chatConfigFromEnv({ ...env, AIS_GATEWAY_CHAT_MAX: "many" })?.maxLive).toBe(12);
});

test("chat is off unless the group and the MCP URL are set, and a missing namespace or node is an error", () => {
  expect(chatConfigFromEnv({})).toBeUndefined();
  expect(chatConfigFromEnv({ AIS_GATEWAY_CHAT_GROUP: "agents.example.test" })).toBeUndefined();
  expect(chatConfigFromEnv({ AIS_GATEWAY_CHAT_MCP_URL: "http://gateway.example.test/browser/mcp" })).toBeUndefined();
  const both = { AIS_GATEWAY_CHAT_GROUP: "agents.example.test", AIS_GATEWAY_CHAT_MCP_URL: "http://gateway.example.test/browser/mcp" };
  expect(() => chatConfigFromEnv(both)).toThrow("AIS_GATEWAY_CHAT_NAMESPACE");
  expect(() => chatConfigFromEnv({ ...both, AIS_GATEWAY_CHAT_NAMESPACE: "ns-a" })).toThrow("AIS_GATEWAY_CHAT_NODE");
});

test("the class from the environment reaches the AgentSession that serve creates", async () => {
  const token = await pair();
  Object.assign(process.env, { AIS_GATEWAY_CHAT_GROUP: "agents.example.test", AIS_GATEWAY_CHAT_MCP_URL: "http://gateway.example.test/browser/mcp", AIS_GATEWAY_CHAT_NAMESPACE: "ns-a", AIS_GATEWAY_CHAT_NODE: "node-a", AIS_GATEWAY_CHAT_CLASS: "heavy" });
  const created: Array<{ metadata: { namespace: string }; spec: Record<string, unknown>; apiVersion: string }> = [];
  const api: KubeApi = {
    createSession: async (obj) => {
      created.push(obj as never);
      throw new Error("stop here");
    },
    getSession: async () => undefined,
    listSessions: async () => [],
    watchSession: () => ({ close() {} }),
    annotate: async () => undefined,
    deleteSession: async () => undefined,
    getConfigMap: async () => ({ "config.json": JSON.stringify({ providers: { claude: { identities: ["alpha"] } } }) }),
    openAttach: async () => {
      throw new Error("no attach");
    },
  };
  const g = await boot({ chatKubeApi: api });
  const c = await Client.open(g.port, token);
  const chatId = crypto.randomUUID();
  c.send(create(chatId));
  await c.until(() => c.of("chat.state").length > 0);
  c.send({ t: "chat.prompt", chatId, text: "hi" });
  await c.until(() => created.length > 0);
  expect(created[0]?.spec).toMatchObject({ class: "heavy", node: "node-a", workspace: "chat", provider: "claude", identity: "alpha" });
  expect(created[0]?.apiVersion).toBe("agents.example.test/v1alpha1");
  expect(created[0]?.metadata.namespace).toBe("ns-a");
});

test("chat frames are refused until the chat bus is listening, and the start is retried with a log and a metric", async () => {
  const token = await pair();
  class FlakyBus extends MemoryChatBus {
    attempts = 0;
    override async subscribe(h: Parameters<MemoryChatBus["subscribe"]>[0]) {
      this.attempts += 1;
      if (this.attempts <= 2) throw new Error("listen down");
      return super.subscribe(h);
    }
  }
  const bus = new FlakyBus();
  const warnings: string[] = [];
  console.warn = (m: unknown) => void warnings.push(String(m));
  const g = await boot({ chatTransport: stub(), chatBus: bus });
  const early = await Client.open(g.port, token);
  const chatId = crypto.randomUUID();
  early.send(create(chatId));
  await early.until(() => early.of("chat.reject").length === 1);
  expect(early.of("chat.reject")[0]).toMatchObject({ chatId, code: "unavailable" });
  expect(early.of("chat.list")).toEqual([]);
  // The retry succeeds on the third try. A new connection then gets the list and a working chat.
  const end = Date.now() + 5000;
  while (bus.attempts < 3 && Date.now() < end) await Bun.sleep(10);
  await Bun.sleep(50);
  const late = await Client.open(g.port, token);
  await late.until(() => late.of("chat.list").length === 1);
  late.send(create(chatId));
  await late.until(() => late.of("chat.state").length === 1);
  expect(warnings.some((w) => w.includes("could not listen"))).toBe(true);
  const body = await (await fetch(`http://127.0.0.1:${g.port}/metrics`)).text();
  expect(body).toMatch(/ais_gateway_chat_errors_total\{kind="other"\} [2-9]/);
});
