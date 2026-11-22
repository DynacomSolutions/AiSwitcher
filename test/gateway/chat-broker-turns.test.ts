import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatBody } from "../../src/browser/chat-protocol.ts";
import type { BrowserBinding } from "../../src/browser/types.ts";
import { createBrowserCaller } from "../../src/gateway/browser/routing.ts";
import { parseChatToExt } from "../../src/browser/chat-protocol.ts";
import { cut, pieces, shortField } from "../../src/gateway/chat/turn.ts";
import { ChatBroker, type BrokerDeps } from "../../src/gateway/chat/broker.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { MemoryChatStore } from "../../src/gateway/chat/store.ts";
import { sessionName } from "../../src/gateway/chat/kube.ts";
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
  expect(transport.stoppedSessions).toEqual([]);
  clock.t += 2000;
  await broker.sweepIdle();
  expect(transport.stoppedSessions).toEqual([sessionName(rec.id, 1)]);
  expect(transport.stopped).toEqual([]);
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
  expect(transport.stoppedSessions).toEqual([sessionName(rec.id, 1)]);
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

// ---- Round 1 ----

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
const permissionOf = async (s: MemoryChatStore, id: string) => {
  await until(async () => (await bodies(s, id)).some((b) => b.k === "permission"), "permission");
  return (await bodies(s, id)).find((b) => b.k === "permission") as Extract<ChatBody, { k: "permission" }>;
};
const HUNG = "The agent did not stop. It was restarted. Send a message to continue.";

test("a cleanup that stops its pod slowly never deletes the new pod", async () => {
  const { broker, store, transport } = setup({ stopSessionDelayMs: 300 });
  const rec = await made(broker);
  await send(broker, rec.id, "exit");
  await until(async () => (await bodies(store, rec.id)).some((b) => b.k === "error"), "error item");
  await send(broker, rec.id, "say:back");
  await turnEnded(store, rec.id);
  await Bun.sleep(500);
  expect(transport.stopped).toEqual([]);
  expect(transport.cluster.has(sessionName(rec.id, 2))).toBe(true);
  expect(transport.cluster.has(sessionName(rec.id, 1))).toBe(false);
});

test("close on a dormant chat while a prompt starts ends closed with no pod left", async () => {
  const { broker, store, transport } = setup();
  const rec = await made(broker);
  const p = broker.prompt(rec.id, "bind-1", "say:hi");
  await broker.close(rec.id, "user");
  await p;
  await Bun.sleep(300);
  expect((await store.get(rec.id))?.state).toBe("closed");
  expect(transport.cluster.size).toBe(0);
});

test("a state write that fails keeps the chat usable and is counted", async () => {
  const { broker, store, metrics } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "say:one");
  await turnEnded(store, rec.id);
  await idleState(store, rec.id);
  const real = store.update.bind(store);
  let fails = 0;
  store.update = async (id, patch, fence) => {
    if (patch.state === "idle" && fails < 3) {
      fails += 1;
      throw new Error("db down");
    }
    return real(id, patch, fence);
  };
  await send(broker, rec.id, "say:two");
  await turnEnded(store, rec.id, 2);
  await Bun.sleep(400);
  expect(fails).toBe(3);
  expect(metrics.render()).toContain('ais_gateway_chat_errors_total{kind="store"} 1');
  expect((await store.get(rec.id))?.state).toBe("thinking");
  expect(await broker.prompt(rec.id, "bind-1", "say:three")).toBeUndefined();
  await turnEnded(store, rec.id, 3);
});

test("cuts never split a surrogate pair, count UTF-8 bytes and strip NUL", () => {
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  for (const lead of [8000, 8001, 8002, 8003, 8004, 8005]) {
    const out = cut(`${"a".repeat(lead)}${"😀".repeat(100)}`);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(8192);
    expect(lone.test(out)).toBe(false);
    expect(out.endsWith("[truncated]")).toBe(true);
  }
  const cjk = cut("漢".repeat(5000));
  expect(Buffer.byteLength(cjk)).toBeLessThanOrEqual(8192);
  expect(cut("a\u0000b")).toBe("ab");
  const text = `${"漢".repeat(5000)}${"😀".repeat(3000)}\u0000end`;
  const parts = pieces(text);
  expect(parts.every((x) => Buffer.byteLength(x) <= 8192 && !lone.test(x) && !x.includes("\u0000"))).toBe(true);
  expect(parts.join("")).toBe(text.replaceAll("\u0000", ""));
});

test("a cancel that the agent ignores restarts the agent, shows fixed copy and the next prompt resumes", async () => {
  const { broker, store, transport, metrics } = setup({}, { cancelGraceMs: 100 });
  const rec = await made(broker);
  await send(broker, rec.id, "hang");
  await until(async () => (await store.get(rec.id))?.state === "thinking", "thinking");
  await broker.cancel(rec.id);
  await until(async () => (await bodies(store, rec.id)).some((b) => b.k === "error"), "error item");
  expect((await bodies(store, rec.id)).find((b) => b.k === "error")).toEqual({ k: "error", code: "agent_exit", message: HUNG });
  await idleState(store, rec.id);
  await send(broker, rec.id, "say:back");
  await turnEnded(store, rec.id);
  expect(transport.starts).toHaveLength(2);
  expect(transport.written.some((l) => l.includes('"session/load"'))).toBe(true);
  expect(metrics.render()).toContain('ais_gateway_chat_turns_total{outcome="error"} 1');
});

test("a turn with no sign of life for stallMs is restarted, and our writes count as life", async () => {
  const { broker, store, clock } = setup({}, { stallMs: 1000, leaseTtlMs: 10 * 3_600_000, cancelGraceMs: 1_000_000_000 });
  const rec = await made(broker);
  await send(broker, rec.id, "hang");
  await until(async () => (await store.get(rec.id))?.state === "thinking", "thinking");
  clock.t += 900;
  await broker.cancel(rec.id);
  clock.t += 900;
  await broker.sweepIdle();
  expect((await bodies(store, rec.id)).some((b) => b.k === "error")).toBe(false);
  clock.t += 200;
  await broker.sweepIdle();
  await until(async () => (await bodies(store, rec.id)).some((b) => b.k === "error"), "error item");
  expect((await bodies(store, rec.id)).find((b) => b.k === "error")).toMatchObject({ code: "agent_exit", message: HUNG });
});

test("a stalled turn with an open ask is not restarted", async () => {
  const { broker, store, clock } = setup({}, { stallMs: 1000, leaseTtlMs: 10 * 3_600_000 });
  const rec = await made(broker);
  await send(broker, rec.id, "ask");
  await permissionOf(store, rec.id);
  clock.t += 5000;
  await broker.sweepIdle();
  expect((await bodies(store, rec.id)).some((b) => b.k === "error")).toBe(false);
});

test("a lease lost during an ask still marks the ask cancelled", async () => {
  const ft = new FakeTimers();
  const { broker, store, clock } = setup({}, { timers: ft });
  const rec = await made(broker);
  await send(broker, rec.id, "ask");
  const perm = await permissionOf(store, rec.id);
  clock.t += 61_000;
  ft.fire(20_000);
  await until(async () => (await bodies(store, rec.id)).some((b) => b.k === "error"), "error item");
  expect(await bodies(store, rec.id)).toContainEqual({ k: "permission_resolved", requestId: perm.requestId, cancelled: true });
});

test("an ask outside a turn returns the state to idle after the answer", async () => {
  const { broker, store } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "lateask");
  await turnEnded(store, rec.id);
  const perm = await permissionOf(store, rec.id);
  await until(async () => (await store.get(rec.id))?.state === "waiting", "waiting");
  await broker.answerPermission(rec.id, perm.requestId, "allow");
  await until(async () => (await store.get(rec.id))?.state === "idle", "idle again");
});

test("configure during a start reaches the new pod", async () => {
  const { broker, store, transport } = setup({ beforeSpawn: () => Bun.sleep(150) });
  const rec = await made(broker);
  await send(broker, rec.id, "say:hi");
  await broker.configure(rec.id, { model: "stub-deep" });
  await turnEnded(store, rec.id);
  expect(transport.starts).toHaveLength(1);
  expect(transport.written.some((l) => l.includes('"session/set_config_option"') && l.includes("stub-deep"))).toBe(true);
  expect((await store.get(rec.id))?.selection.model).toBe("stub-deep");
});

test("a cancel while the pod starts ends the turn and sends no session/prompt", async () => {
  const { broker, store, transport, metrics } = setup({ beforeSpawn: () => Bun.sleep(150) });
  const rec = await made(broker);
  await send(broker, rec.id, "say:hi");
  await broker.cancel(rec.id);
  await turnEnded(store, rec.id);
  expect(await bodies(store, rec.id)).toContainEqual({ k: "turn_end", stopReason: "cancelled" });
  expect(transport.written.some((l) => l.includes('"session/prompt"'))).toBe(false);
  expect(metrics.render()).toContain('ais_gateway_chat_turns_total{outcome="cancelled"} 1');
  await send(broker, rec.id, "say:next");
  await turnEnded(store, rec.id, 2);
  expect(transport.written.filter((l) => l.includes('"session/prompt"'))).toHaveLength(1);
});

test("a permission option id and name are cut to 256 characters and the cut id still answers", async () => {
  const { broker, store } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "longask");
  const perm = await permissionOf(store, rec.id);
  expect(perm.options[0]?.id).toHaveLength(256);
  expect(perm.options[0]?.name).toHaveLength(256);
  await broker.answerPermission(rec.id, perm.requestId, perm.options[0]?.id);
  await turnEnded(store, rec.id);
  expect(await bodies(store, rec.id)).toContainEqual({ k: "text", text: `chose:${"o".repeat(300)}` });
});

test("resume loads the session by the capability of the new pod, not the stored flag", async () => {
  const { broker, store, transport } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "exit");
  await until(async () => (await bodies(store, rec.id)).some((b) => b.k === "error"), "error item");
  await idleState(store, rec.id);
  const epoch = (await store.acquireLease(rec.id, "replica-a", 60_000, 0)) as number;
  await store.update(rec.id, { canLoad: false }, { replica: "replica-a", epoch });
  await store.releaseLease(rec.id, { replica: "replica-a", epoch });
  await send(broker, rec.id, "say:back");
  await turnEnded(store, rec.id);
  expect(transport.written.some((l) => l.includes('"session/load"'))).toBe(true);
  expect(JSON.stringify(await bodies(store, rec.id))).not.toContain("This chat restarted");
});

test("every fenced state write is followed by a publish", async () => {
  const order: string[] = [];
  const { broker, store, clock } = setup({}, { idleMs: 1000, publish: () => void order.push("publish") });
  const real = store.update.bind(store);
  store.update = async (id, patch, fence) => {
    const r = await real(id, patch, fence);
    if (patch.state) order.push(`update:${patch.state}`);
    return r;
  };
  const after = (mark: string): string | undefined => order[order.lastIndexOf(mark) + 1];
  const a = await made(broker);
  await send(broker, a.id, "exit");
  await until(async () => (await bodies(store, a.id)).some((b) => b.k === "error"), "error item");
  await idleState(store, a.id);
  await Bun.sleep(100);
  expect(after("update:idle")).toBe("publish");
  await send(broker, a.id, "say:hi");
  await turnEnded(store, a.id);
  await idleState(store, a.id);
  clock.t += 2000;
  await broker.sweepIdle();
  expect(after("update:idle")).toBe("publish");
  await broker.close(a.id, "user");
  expect(order.lastIndexOf("update:closed")).toBeGreaterThan(-1);
  expect(after("update:closed")).toBe("publish");
});

test("cancel during an ask resolves the ask as cancelled and ends the turn", async () => {
  const { broker, store } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "ask");
  const perm = await permissionOf(store, rec.id);
  await broker.cancel(rec.id);
  await turnEnded(store, rec.id);
  const all = await bodies(store, rec.id);
  expect(all).toContainEqual({ k: "permission_resolved", requestId: perm.requestId, cancelled: true });
  expect(all).toContainEqual({ k: "text", text: "cancelled" });
  await idleState(store, rec.id);
});

test("an agent that exits during an ask resolves the ask as cancelled and shows agent_exit", async () => {
  const { broker, store, transport } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "ask");
  const perm = await permissionOf(store, rec.id);
  transport.killAll();
  await until(async () => (await bodies(store, rec.id)).some((b) => b.k === "error"), "error item");
  const all = await bodies(store, rec.id);
  expect(all).toContainEqual({ k: "permission_resolved", requestId: perm.requestId, cancelled: true });
  expect(all.find((b) => b.k === "error")).toMatchObject({ code: "agent_exit" });
  await idleState(store, rec.id);
});

test("an unknown or already answered requestId changes nothing", async () => {
  const { broker, store } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "ask");
  const perm = await permissionOf(store, rec.id);
  const before = (await bodies(store, rec.id)).length;
  await broker.answerPermission(rec.id, "9-99", "allow");
  await broker.answerPermission(rec.id, perm.requestId, "not-an-option-id");
  await turnEnded(store, rec.id);
  const resolved = (await bodies(store, rec.id)).filter((b) => b.k === "permission_resolved");
  expect(resolved).toEqual([{ k: "permission_resolved", requestId: perm.requestId, cancelled: true }]);
  await broker.answerPermission(rec.id, perm.requestId, "allow");
  expect((await bodies(store, rec.id)).filter((b) => b.k === "permission_resolved")).toHaveLength(1);
  expect(before).toBeGreaterThan(0);
});

// ---- Round 2 ----

/** Make every error and notice append slow, and tell when the first one starts. */
function slowAppends(store: MemoryChatStore, ms: number): { started: () => boolean } {
  const real = store.appendEvent.bind(store);
  let started = false;
  store.appendEvent = async (id, body, fence) => {
    if (body.k === "error" || (body.k === "notice" && body.text.startsWith("The agent stopped after"))) {
      started = true;
      await Bun.sleep(ms);
    }
    return real(id, body, fence);
  };
  return { started: () => started };
}

test("rename during an agent exit clean-up does not break the clean-up", async () => {
  const { broker, store } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "say:hi");
  await turnEnded(store, rec.id);
  const slow = slowAppends(store, 150);
  await send(broker, rec.id, "exit");
  await until(() => slow.started(), "clean-up started");
  await broker.rename(rec.id, "Renamed");
  expect((await bodies(store, rec.id)).some((b) => b.k === "error" && b.code === "agent_exit")).toBe(true);
  expect((await store.get(rec.id))?.state).toBe("idle");
  expect((await store.get(rec.id))?.name).toBe("Renamed");
});

test("link during an idle end clean-up does not break the clean-up", async () => {
  const { broker, store, clock, transport } = setup({}, { idleMs: 1000 });
  const rec = await made(broker);
  await send(broker, rec.id, "say:hi");
  await turnEnded(store, rec.id);
  await idleState(store, rec.id);
  const slow = slowAppends(store, 150);
  clock.t += 2000;
  const sweep = broker.sweepIdle();
  await until(() => slow.started(), "clean-up started");
  await broker.link(rec.id, [7, 8]);
  await sweep;
  expect((await bodies(store, rec.id)).some((b) => b.k === "notice" && b.text.startsWith("The agent stopped after"))).toBe(true);
  expect((await store.get(rec.id))?.state).toBe("idle");
  expect((await store.get(rec.id))?.tabIds).toEqual([7, 8]);
  expect(transport.stoppedSessions).toEqual([sessionName(rec.id, 1)]);
});

test("short fields keep to 256 UTF-16 units and a permission with emoji names passes the parser", () => {
  const out = shortField("😀".repeat(200));
  expect(out.length).toBeLessThanOrEqual(256);
  expect(out).toBe("😀".repeat(128));
  expect(shortField("a\u0000b")).toBe("ab");
  const item = { t: "chat.event", chatId: "c1", seq: 1, ts: 1, body: { k: "permission", requestId: "1-1", rpcId: 1, title: "t", options: [{ id: shortField("😀".repeat(200)), name: shortField("😀".repeat(200)), kind: "allow_once" }] } };
  expect(parseChatToExt(item)).toBeDefined();
});

test("an open ask outside a turn is cancelled when the chat is idle past idleMs, and the pod ends", async () => {
  const { broker, store, transport, clock } = setup({}, { idleMs: 1000, leaseTtlMs: 10 * 3_600_000 });
  const rec = await made(broker);
  await send(broker, rec.id, "lateask");
  await turnEnded(store, rec.id);
  const perm = await permissionOf(store, rec.id);
  await until(async () => (await store.get(rec.id))?.state === "waiting", "waiting");
  await broker.sweepIdle();
  expect(transport.stoppedSessions).toEqual([]);
  clock.t += 2000;
  await broker.sweepIdle();
  expect(transport.stoppedSessions).toEqual([sessionName(rec.id, 1)]);
  expect(await bodies(store, rec.id)).toContainEqual({ k: "permission_resolved", requestId: perm.requestId, cancelled: true });
  expect((await store.get(rec.id))?.state).toBe("idle");
});

test("a drain that waits for a claimed prompt does not spin", async () => {
  const { broker, store } = setup();
  const rec = await made(broker);
  const realGet = store.get.bind(store);
  store.get = async (id: string) => {
    await Bun.sleep(300);
    return realGet(id);
  };
  const real = globalThis.setImmediate;
  let calls = 0;
  (globalThis as { setImmediate: unknown }).setImmediate = ((fn: () => void, ...a: unknown[]) => {
    calls += 1;
    return real(fn, ...a);
  }) as typeof setImmediate;
  try {
    const p = broker.prompt(rec.id, "bind-1", "hi");
    await Bun.sleep(5);
    await broker.drain();
    await p;
  } finally {
    globalThis.setImmediate = real;
  }
  expect(calls).toBeLessThan(20);
});

test("the gateway-wide cap counts as a limit error", async () => {
  const { broker, metrics } = setup();
  await made(broker);
  const r = await broker.create({ chatId: crypto.randomUUID(), binding: "bind-1", windowId: 2, name: "n", color: "#aabbcc", selection: SELECTION, tabIds: [], maxLive: 1 });
  expect(r).toEqual({ code: "limit", message: "Too many chats are open. Close one, then try again." });
  expect(metrics.render()).toContain('ais_gateway_chat_errors_total{kind="limit"} 1');
});

test("a prompt starts no pod when the identity is no longer listed, and fails closed when the list cannot be read", async () => {
  let verdict: "ok" | "identity" | "throw" = "identity";
  const { broker, store, transport } = setup({}, {
    checkSelection: async () => {
      if (verdict === "throw") throw new Error("configmap down");
      return verdict;
    },
  });
  const rec = await made(broker);
  await send(broker, rec.id, "hi");
  await until(async () => (await bodies(store, rec.id)).some((b) => b.k === "error"), "error item");
  let errs = (await bodies(store, rec.id)).filter((b) => b.k === "error");
  expect(errs).toEqual([{ k: "error", code: "bad_request", message: "This identity is no longer available. Start a new chat." }]);
  expect(transport.starts).toHaveLength(0);
  verdict = "throw";
  await until(async () => (await store.get(rec.id))?.state !== "thinking" && (await store.get(rec.id))?.state !== "starting", "idle");
  await send(broker, rec.id, "again");
  await until(async () => (await bodies(store, rec.id)).filter((b) => b.k === "error").length === 2, "second error");
  errs = (await bodies(store, rec.id)).filter((b) => b.k === "error");
  expect(errs[1]).toMatchObject({ code: "unavailable" });
  expect(transport.starts).toHaveLength(0);
});

const agentText = async (s: MemoryChatStore, id: string, n: number): Promise<string> => {
  await turnEnded(s, id, n);
  const all = await bodies(s, id);
  const ends: number[] = [];
  all.forEach((b, i) => b.k === "turn_end" && ends.push(i));
  const from = n === 1 ? 0 : ends[n - 2]! + 1;
  return all.slice(from, ends[n - 1]).filter((b) => b.k === "text").map((b) => (b as { text: string }).text).join("");
};

test("the prompt carries a context block with the linked tab ids, then the user text", async () => {
  const { broker, store } = setup();
  const rec = await made(broker);
  await broker.link(rec.id, [7, 8]);
  await send(broker, rec.id, "ctx");
  const said = await agentText(store, rec.id, 1);
  expect(said).toContain("tab ids 7, 8");
  expect(said).toContain("ais-browser");
  expect(said).toContain("tabs_context");
  expect(said).not.toContain("no Chrome tab is linked");
});

test("after chat.link changes the tabs the next prompt uses the new ids", async () => {
  const { broker, store } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "ctx");
  expect(await agentText(store, rec.id, 1)).toContain("tab ids 7.");
  await idleState(store, rec.id);
  await broker.link(rec.id, [21, 22]);
  await send(broker, rec.id, "ctx");
  const said = await agentText(store, rec.id, 2);
  expect(said).toContain("tab ids 21, 22.");
  expect(said).not.toContain("7");
});

test("no linked tabs gives the no-tab context", async () => {
  const { broker, store } = setup();
  const rec = await made(broker);
  await broker.link(rec.id, []);
  await send(broker, rec.id, "ctx");
  expect(await agentText(store, rec.id, 1)).toContain("no Chrome tab is linked to this chat");
});

test("the feed holds the user text only, never the context block", async () => {
  const { broker, store } = setup();
  const rec = await made(broker);
  await send(broker, rec.id, "say:hi");
  await turnEnded(store, rec.id);
  const all = await bodies(store, rec.id);
  expect(all.filter((b) => b.k === "user")).toEqual([expect.objectContaining({ k: "user", text: "say:hi" })]);
  expect(JSON.stringify(all)).not.toContain("Browser context");
  expect(JSON.stringify(await store.get(rec.id))).not.toContain("Browser context");
});
