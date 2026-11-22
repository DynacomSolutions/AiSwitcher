import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatBody } from "../../src/browser/chat-protocol.ts";
import type { BrowserBinding } from "../../src/browser/types.ts";
import { createBrowserCaller } from "../../src/gateway/browser/routing.ts";
import { ChatBroker, type BrokerDeps } from "../../src/gateway/chat/broker.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { MemoryChatStore } from "../../src/gateway/chat/store.ts";
import { chatTokenKey, mintChatToken } from "../../src/gateway/chat/token.ts";
import { PrometheusMetrics } from "../../src/gateway/metrics.ts";
import { StubPodTransport, type StubTransportOptions } from "./fixtures/stub-transport.ts";

const KEY = chatTokenKey("test-admin-token");
const SELECTION = { provider: "claude", identity: "alpha" } as const;
const root = mkdtempSync(join(tmpdir(), "ais-chat-turns-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const brokers: ChatBroker[] = [];
const transports: StubPodTransport[] = [];
afterEach(async () => {
  for (const b of brokers.splice(0)) await b.dispose();
  for (const t of transports.splice(0)) t.killAll();
});

function setup(topts: StubTransportOptions = {}, over: Partial<BrokerDeps> = {}) {
  const clock = { t: 1_700_000_000_000 };
  const store = new MemoryChatStore(() => clock.t);
  const stateFile = join(root, `${crypto.randomUUID()}.state`);
  const transport = new StubPodTransport({ ...topts, env: { STUB_ACP_STATE: stateFile, ...topts.env } });
  transports.push(transport);
  const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
  const ended: Array<[string, string]> = [];
  const broker = new ChatBroker({
    store,
    transport,
    mcpUrl: "http://gateway.test/mcp",
    tokenKey: KEY,
    replicaId: "replica-a",
    metrics,
    now: () => clock.t,
    publish: () => undefined,
    identityOf: async (b) => (b === "bind-1" ? "alpha" : undefined),
    endBrowserSession: async (b, s) => void ended.push([b, s]),
    ...over,
  });
  brokers.push(broker);
  return { broker, store, transport, metrics, clock, ended };
}

const made = async (b: ChatBroker, over: { selection?: { provider: "claude"; identity: string; model?: string } } = {}) => {
  const chatId = crypto.randomUUID();
  const r = await b.create({ chatId, binding: "bind-1", windowId: 1, name: "My chat", color: "#aabbcc", selection: over.selection ?? SELECTION, tabIds: [7] });
  if ("code" in r) throw new Error(`rejected: ${r.code}`);
  return r;
};
const bodies = async (s: MemoryChatStore, id: string): Promise<ChatBody[]> => (await s.events(id, 0, 10_000)).map((e) => e.body);
async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out: ${what}`);
}
/** Send a prompt, and send it again while the previous turn still closes. */
async function send(b: ChatBroker, id: string, text: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await b.prompt(id, "bind-1", text);
    if (!r) return;
    if (r.code !== "busy") throw new Error(`rejected: ${r.code}`);
    await Bun.sleep(10);
  }
  throw new Error("still busy");
}
const turnEnded = (s: MemoryChatStore, id: string, n = 1) => until(async () => (await bodies(s, id)).filter((b) => b.k === "turn_end").length >= n, `turn_end ${n}`);
const idleState = (s: MemoryChatStore, id: string) => until(async () => (await s.get(id))?.state === "idle", "state idle");

test("a prompt streams text updates as ordered events and ends with turn_end end_turn; a second prompt during a turn returns busy", async () => {
  const { broker, store } = setup();
  const rec = await made(broker);
  expect(await broker.prompt(rec.id, "bind-1", "slow")).toBeUndefined();
  expect(await broker.prompt(rec.id, "bind-1", "say:more")).toMatchObject({ code: "busy" });
  await until(async () => (await store.get(rec.id))?.state === "thinking", "thinking");
  await broker.cancel(rec.id);
  await turnEnded(store, rec.id);
  await idleState(store, rec.id);
  await send(broker, rec.id, "say:hello world");
  await turnEnded(store, rec.id, 2);
  const all = await bodies(store, rec.id);
  const tail = all.slice(all.findIndex((b) => b.k === "user" && b.text === "say:hello world"));
  expect(tail.map((b) => b.k)).toEqual(["user", "text", "text", "turn_end"]);
  expect(tail.filter((b) => b.k === "text").map((b) => (b as { text: string }).text).join("")).toBe("hello world");
  expect(tail[3]).toEqual({ k: "turn_end", stopReason: "end_turn" });
});

test("tool updates become tool items per toolCallId with status pending then done", async () => {
  const { broker, store } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "tool");
  await turnEnded(store, rec.id);
  const tools = (await bodies(store, rec.id)).filter((b) => b.k === "tool") as Array<Extract<ChatBody, { k: "tool" }>>;
  expect(tools.map((t) => [t.toolCallId, t.status])).toEqual([["tc1", "pending"], ["tc1", "done"]]);
  expect(tools[1]).toMatchObject({ title: "Read file", result: "file body" });
});

test("a tool result of 1 MB is stored cut to 8 KiB with a truncated marker, and an image result part is dropped", async () => {
  const { broker, store } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "big");
  await turnEnded(store, rec.id);
  const big = (await bodies(store, rec.id)).filter((b) => b.k === "tool" && b.status === "done")[0] as Extract<ChatBody, { k: "tool" }>;
  expect(big.result?.length).toBeLessThanOrEqual(8192);
  expect(big.result?.endsWith("[truncated]")).toBe(true);
  await idleState(store, rec.id);
  await send(broker, rec.id, "image");
  await turnEnded(store, rec.id, 2);
  const shot = (await bodies(store, rec.id)).filter((b) => b.k === "tool" && b.toolCallId === "tc4" && b.status === "done")[0] as Extract<ChatBody, { k: "tool" }>;
  expect(shot.result).toBe("caption");
  expect(JSON.stringify(await bodies(store, rec.id))).not.toContain("IMAGEDATA");
});

test("ask appends a permission item, state is waiting, answer resumes the turn with the chosen option", async () => {
  const { broker, store } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "ask");
  await until(async () => (await bodies(store, rec.id)).some((b) => b.k === "permission"), "permission");
  await until(async () => (await store.get(rec.id))?.state === "waiting", "waiting");
  const perm = (await bodies(store, rec.id)).find((b) => b.k === "permission") as Extract<ChatBody, { k: "permission" }>;
  expect(perm.options.map((o) => o.id)).toEqual(["allow", "deny"]);
  await broker.answerPermission(rec.id, perm.requestId, "allow");
  await turnEnded(store, rec.id);
  const all = await bodies(store, rec.id);
  expect(all).toContainEqual({ k: "permission_resolved", requestId: perm.requestId, optionId: "allow" });
  expect(all).toContainEqual({ k: "text", text: "chose:allow" });
  await idleState(store, rec.id);
});

test("close while an ask is open resolves it as cancelled", async () => {
  const { broker, store, transport } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "ask");
  await until(async () => (await bodies(store, rec.id)).some((b) => b.k === "permission"), "permission");
  const perm = (await bodies(store, rec.id)).find((b) => b.k === "permission") as Extract<ChatBody, { k: "permission" }>;
  await broker.close(rec.id, "user");
  expect(await bodies(store, rec.id)).toContainEqual({ k: "permission_resolved", requestId: perm.requestId, cancelled: true });
  expect(transport.stopped).toContain(rec.id);
});

test("cancel on slow ends the turn with stopReason cancelled and keeps the pod", async () => {
  const { broker, store, transport, metrics } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "slow");
  await until(async () => (await store.get(rec.id))?.state === "thinking", "thinking");
  await broker.cancel(rec.id);
  await turnEnded(store, rec.id);
  expect(await bodies(store, rec.id)).toContainEqual({ k: "turn_end", stopReason: "cancelled" });
  expect(transport.stopped).toEqual([]);
  expect(transport.starts).toHaveLength(1);
  expect(metrics.render()).toContain('ais_gateway_chat_turns_total{outcome="cancelled"} 1');
});

test("an agent that exits mid-turn appends agent_exit and the next prompt starts a new pod and loads the session", async () => {
  const { broker, store, transport, metrics } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "exit");
  await until(async () => (await bodies(store, rec.id)).some((b) => b.k === "error"), "error item");
  expect((await bodies(store, rec.id)).find((b) => b.k === "error")).toMatchObject({ code: "agent_exit" });
  await idleState(store, rec.id);
  expect(metrics.render()).toContain('ais_gateway_chat_turns_total{outcome="error"} 1');
  await send(broker, rec.id, "say:back");
  await turnEnded(store, rec.id);
  expect(transport.starts).toHaveLength(2);
  expect(transport.starts[1]?.generation).toBe(2);
  expect(transport.written.some((l) => l.includes('"session/load"'))).toBe(true);
  expect(JSON.stringify(await bodies(store, rec.id))).not.toContain("This chat restarted");
  expect(metrics.render()).toContain('ais_gateway_chat_sessions_total{event="session_resumed"} 1');
});

test("with STUB_ACP_LOAD=0 the next prompt shows the restarted notice", async () => {
  const { broker, store, transport } = setup({ env: { STUB_ACP_LOAD: "0" } });
  const rec = await made(broker);
  await send(broker, rec.id, "exit");
  await until(async () => (await bodies(store, rec.id)).some((b) => b.k === "error"), "error item");
  await idleState(store, rec.id);
  await send(broker, rec.id, "say:again");
  await turnEnded(store, rec.id);
  expect(await bodies(store, rec.id)).toContainEqual({ k: "notice", text: "This chat restarted. The agent does not remember earlier messages." });
  expect(transport.written.some((l) => l.includes('"session/load"'))).toBe(false);
});

test("a failed session/load shows the restarted notice and counts resume_failed", async () => {
  const { broker, store, metrics } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "exit");
  await until(async () => (await bodies(store, rec.id)).some((b) => b.k === "error"), "error item");
  await idleState(store, rec.id);
  const lease = await store.acquireLease(rec.id, "replica-a", 60_000, 0);
  await store.update(rec.id, { acpSessionId: "unknown-session" }, { replica: "replica-a", epoch: lease as number });
  await store.releaseLease(rec.id, { replica: "replica-a", epoch: lease as number });
  await send(broker, rec.id, "say:fresh");
  await turnEnded(store, rec.id);
  expect(await bodies(store, rec.id)).toContainEqual({ k: "notice", text: "This chat restarted. The agent does not remember earlier messages." });
  expect(metrics.render()).toContain('ais_gateway_chat_errors_total{kind="resume_failed"} 1');
});

test("a rate-limit failure text becomes an error item with code limit and the reset time in the message", async () => {
  const { broker, store, metrics } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "limit");
  await until(async () => (await bodies(store, rec.id)).some((b) => b.k === "error"), "error item");
  const err = (await bodies(store, rec.id)).find((b) => b.k === "error") as Extract<ChatBody, { k: "error" }>;
  expect(err.code).toBe("limit");
  expect(err.message).toContain("2023-11-15T00:00:00.000Z");
  expect(err.message).not.toContain("Rate limit reached");
  expect(metrics.render()).toContain('ais_gateway_chat_errors_total{kind="limit"} 1');
  await idleState(store, rec.id);
});

test("any other prompt error becomes an acp error item with fixed copy", async () => {
  const { broker, store } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "fail");
  await until(async () => (await bodies(store, rec.id)).some((b) => b.k === "error"), "error item");
  const err = (await bodies(store, rec.id)).find((b) => b.k === "error") as Extract<ChatBody, { k: "error" }>;
  expect(err).toEqual({ k: "error", code: "acp", message: "The agent could not finish this turn." });
});

test("sweepIdle ends the pod after idleMs, keeps the chat idle, and the next prompt resumes", async () => {
  const { broker, store, transport, clock, metrics } = setup({}, { idleMs: 1000 });
  const rec = await made(broker);
  await send(broker, rec.id, "say:hi");
  await turnEnded(store, rec.id);
  await idleState(store, rec.id);
  await broker.sweepIdle();
  expect(transport.stopped).toEqual([]);
  clock.t += 2000;
  await broker.sweepIdle();
  expect(transport.stopped).toEqual([rec.id]);
  expect((await store.get(rec.id))?.state).toBe("idle");
  expect(metrics.render()).toContain('ais_gateway_chat_sessions_total{event="idle_closed"} 1');
  await send(broker, rec.id, "say:again");
  await turnEnded(store, rec.id, 2);
  expect(transport.starts).toHaveLength(2);
  expect(transport.written.some((l) => l.includes('"session/load"'))).toBe(true);
  expect(metrics.render()).toContain('ais_gateway_chat_sessions_total{event="session_resumed"} 1');
});

test("the idle limit never passes three hours", async () => {
  const { broker, store, transport, clock } = setup({}, { idleMs: 24 * 3_600_000, leaseTtlMs: 10 * 3_600_000 });
  const rec = await made(broker);
  await send(broker, rec.id, "say:hi");
  await turnEnded(store, rec.id);
  await idleState(store, rec.id);
  clock.t += 3 * 3_600_000 + 1000;
  await broker.sweepIdle();
  expect(transport.stopped).toEqual([rec.id]);
});

test("configure applies the model through session/set_config_option and appends a config item", async () => {
  const { broker, store, transport } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "say:hi");
  await turnEnded(store, rec.id);
  await idleState(store, rec.id);
  await broker.configure(rec.id, { model: "stub-deep" });
  expect(transport.written.some((l) => l.includes('"session/set_config_option"') && l.includes("stub-deep"))).toBe(true);
  const cfg = (await bodies(store, rec.id)).filter((b) => b.k === "config").at(-1) as Extract<ChatBody, { k: "config" }>;
  expect(cfg.current.model).toBe("stub-deep");
  expect((await store.get(rec.id))?.selection.model).toBe("stub-deep");
});

test("close deletes the pod, sends SESSION_END for chat:<id> to the binding and stops accepting prompts", async () => {
  const { broker, store, transport, ended, metrics } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "say:hi");
  await turnEnded(store, rec.id);
  await broker.close(rec.id, "user");
  expect(transport.stopped).toContain(rec.id);
  expect(ended).toEqual([["bind-1", `chat:${rec.id}`]]);
  expect((await store.get(rec.id))?.state).toBe("closed");
  expect(await broker.prompt(rec.id, "bind-1", "say:again")).toMatchObject({ code: "bad_request" });
  expect(metrics.render()).toContain('ais_gateway_chat_sessions_total{event="session_closed"} 1');
});

test("a prompt from another binding is refused", async () => {
  const { broker } = setup();
  const rec = await made(broker);
  expect(await broker.prompt(rec.id, "bind-2", "say:hi")).toMatchObject({ code: "bad_request" });
});

test("link updates the grants so a tab call outside the set is forbidden_tab", async () => {
  const { broker, transport } = setup();
  const rec = await made(broker);
  await broker.startPod(rec.id);
  const token = mintChatToken(KEY, { chatId: rec.id, binding: "bind-1", exp: Date.now() + 100_000, gen: 1 });
  const binding: BrowserBinding = { name: "bind-1", target: { kind: "identity", identity: "alpha" }, profileLabel: "p", state: "active", createdAt: "2026-11-04T00:00:00.000Z" };
  const calls: unknown[] = [];
  const hub = {
    connected: () => [binding],
    call: async (_n: string, req: { id: string }) => {
      calls.push(req);
      return { id: req.id, ok: true as const, content: [{ type: "text" as const, text: "ok" }] };
    },
    abort: () => {},
    revoke: () => {},
    extensionVersion: () => undefined,
  };
  const caller = createBrowserCaller({ store: new MemoryGatewayStore(), now: () => new Date(), hub } as never);
  const call = async (tabId: number) => {
    const p = await broker.principal(token);
    if (!p) throw new Error("no principal");
    return caller("alpha", { session: { id: `chat:${rec.id}`, label: "L" }, tool: "read_page", args: { tabId } }, undefined, { binding: p.binding, color: p.color, linked: p.linked });
  };
  expect((await call(9)).body).toMatchObject({ ok: false, error: "forbidden_tab" });
  expect(calls).toHaveLength(0);
  await broker.link(rec.id, [9]);
  expect((await call(9)).body).toMatchObject({ ok: true });
  expect((await call(7)).body).toMatchObject({ ok: false, error: "forbidden_tab" });
  expect(transport.starts).toHaveLength(1);
});

test("a full turn flow produces no other label series", async () => {
  const { broker, store, metrics } = setup();
  const rec = await made(broker);
  for (const text of ["say:hi", "tool", "fail", "limit"]) {
    await send(broker, rec.id, text);
    await Bun.sleep(50);
    await idleState(store, rec.id);
  }
  await broker.rename(rec.id, "Renamed");
  await broker.close(rec.id, "user");
  const out = metrics.render();
  expect(out).toContain("ais_gateway_chat_turns_total");
  expect(out).not.toContain('="other"');
});
