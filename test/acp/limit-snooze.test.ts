import { describe, expect, test } from "bun:test";
import { endpointFromServers, LimitSnoozer, mcpCaller, RESUME_DELAY_MS, RESUME_PROMPT, resetFromText, type McpCaller, type McpEndpoint } from "../../src/acp/limit-snooze.ts";
import { AcpRelay, type TurnFailure } from "../../src/acp/relay.ts";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const RESET = "2026-11-20T15:00:00Z";
const EP: McpEndpoint = { url: "http://127.0.0.1:1/mcp", authorization: ["Bear", "er SYNTHETIC"].join("") };
const stdioServer = { name: "t3-code", command: "t3", args: ["acp-mcp-bridge"], env: [{ name: "T3_ACP_MCP_ENDPOINT", value: EP.url }, { name: "T3_ACP_MCP_AUTHORIZATION", value: EP.authorization }] };
const httpServer = { type: "http", name: "t3-code", url: EP.url, headers: [{ name: "Authorization", value: EP.authorization }] };

function setup(opts: { fail?: boolean; subagent?: boolean; now?: () => number } = {}) {
  const calls: Array<[McpEndpoint, string, Record<string, unknown>]> = [];
  const logs: string[] = [];
  const caller: McpCaller = {
    async call(e, tool, args) {
      calls.push([e, tool, args]);
      if (opts.fail) throw new Error("MCP endpoint answered HTTP 500");
      if (tool === "schedule_task") return { scheduledTask: { scheduledTaskId: "task-1", boundThreadId: "thread-1" } };
      if (tool === "t3_thread_read") return { thread: { relationshipToParent: opts.subagent ? "subagent" : null } };
      return {};
    },
  };
  const limit = new LimitSnoozer({ caller, now: opts.now ?? (() => NOW), log: (l) => logs.push(l) });
  return { calls, logs, limit };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

const newSession = (mcpServers: unknown[]) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/x", mcpServers } });
const newAnswer = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "s1" } });
const prompt = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId: "s1", prompt: [{ type: "text", text: "hi" }] } });
const endTurn = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
const limited: TurnFailure = { message: `Usage limit reached. Resets at ${RESET}.`, code: "provider.rate_limit", status: 429 };

async function run(r: AcpRelay, id: number, servers: unknown[] = [stdioServer]) {
  r.fromClient(newSession(servers));
  await r.fromAgent(newAnswer);
  r.fromClient(prompt(id));
  return r.fromAgent(endTurn(id));
}
const relayWith = (limit: LimitSnoozer, failure: TurnFailure | "ok" | undefined) => new AcpRelay({ limit, adapter: { turnOutcome: async () => failure } });

describe("endpointFromServers", () => {
  test("stdio bridge env and http headers give the endpoint", () => {
    expect(endpointFromServers([stdioServer])).toEqual(EP);
    expect(endpointFromServers([httpServer])).toEqual(EP);
  });
  test("other servers give nothing", () => {
    expect(endpointFromServers([{ name: "other", url: "http://x", headers: [] }])).toBeUndefined();
    expect(endpointFromServers(undefined)).toBeUndefined();
  });
});

describe("resetFromText", () => {
  test("future reset is read, past reset and no reset are not", () => {
    expect(resetFromText(`x Resets at ${RESET}.`, NOW)?.toISOString()).toBe("2026-11-20T15:00:00.000Z");
    expect(resetFromText("Resets at 2026-11-20T11:00:00Z.", NOW)).toBeUndefined();
    expect(resetFromText("limit reached", NOW)).toBeUndefined();
  });
});

describe("relay with the limit snooze", () => {
  test("limit failure with a future reset: snooze then one schedule, answer unchanged", async () => {
    const { limit, calls } = setup();
    const out = await run(relayWith(limit, limited), 5);
    expect(JSON.parse(out[0]!).error.message).toContain(`Resets at ${RESET}`);
    await tick();
    expect(calls.map((c) => c[1])).toEqual(["t3_thread_organize", "schedule_task", "t3_thread_read"]);
    expect(calls[2]![2]).toEqual({ threadId: "thread-1", limit: 1, runLimit: 1, maxCharsPerItem: 1 });
    expect(calls[0]![0]).toEqual(EP);
    expect(calls[0]![2]).toEqual({ action: "snooze", snoozedUntil: "2026-11-20T15:00:00.000Z" });
    expect(calls[1]![2]).toEqual({ prompt: RESUME_PROMPT, schedule: { type: "once", runAt: new Date(Date.parse(RESET) + RESUME_DELAY_MS).toISOString() }, bindToCurrentThread: true, title: "Resume after usage limit" });
  });
  test("a JSON-RPC error with code -32003 and the reset in data also snoozes", async () => {
    const { limit, calls } = setup();
    const r = new AcpRelay({ limit });
    r.fromClient(newSession([httpServer]));
    await r.fromAgent(newAnswer);
    r.fromClient(prompt(6));
    await r.fromAgent(JSON.stringify({ jsonrpc: "2.0", id: 6, error: { code: -32003, message: "Internal error", data: { details: `Usage limit. Resets at ${RESET}.` } } }));
    await tick();
    expect(calls.length).toBe(3);
  });
  test("no reset, past reset, non-limit failure: no calls", async () => {
    for (const f of [{ message: "Usage limit reached.", status: 429 }, { message: "Too many. Resets at 2026-11-20T11:00:00Z.", status: 429 }, { message: `Bad request. Resets at ${RESET}.`, status: 400, code: "provider.api_error" }]) {
      const { limit, calls } = setup();
      await run(relayWith(limit, f), 5);
      await tick();
      expect(calls.length).toBe(0);
    }
  });
  test("duplicate failure gives one call set", async () => {
    const { limit, calls } = setup();
    const r = relayWith(limit, limited);
    await run(r, 5);
    r.fromClient(prompt(6));
    await r.fromAgent(endTurn(6));
    await tick();
    expect(calls.length).toBe(3);
  });
  test("no MCP server in session/new: no calls, one log line", async () => {
    const { limit, calls, logs } = setup();
    await run(relayWith(limit, limited), 5, []);
    await tick();
    expect(calls.length).toBe(0);
    expect(logs.length).toBe(1);
    expect(logs[0]).not.toContain(EP.url);
  });
  test("MCP errors never change the answer and log one line without the endpoint", async () => {
    const { limit, logs } = setup({ fail: true });
    const out = await run(relayWith(limit, limited), 5);
    expect(JSON.parse(out[0]!).error.data.status).toBe(429);
    await tick();
    expect(logs.length).toBe(1);
    expect(logs[0]).not.toContain(EP.url);
    expect(logs[0]).not.toContain("SYNTHETIC");
  });
});

describe("resume task lifecycle", () => {
  test("a prompt that ends well before the reset deletes the resume task, and a later limit can snooze again", async () => {
    const { limit, calls } = setup();
    const r = relayWith(limit, limited);
    await run(r, 5);
    await tick();
    const ok = new AcpRelay({ limit, adapter: { turnOutcome: async () => "ok" } });
    ok.fromClient(newSession([stdioServer]));
    await ok.fromAgent(newAnswer);
    ok.fromClient(prompt(8));
    await ok.fromAgent(endTurn(8));
    await tick();
    const del = calls.filter((c) => c[1] === "delete_scheduled_task");
    expect(del.length).toBe(1);
    expect(del[0]![2]).toEqual({ scheduledTaskId: "task-1" });
    r.fromClient(prompt(9));
    await r.fromAgent(endTurn(9));
    await tick();
    expect(calls.filter((c) => c[1] === "schedule_task").length).toBe(2);
  });
  test("a prompt that ends well after the resume time deletes nothing", async () => {
    let now = NOW;
    const { limit, calls } = setup({ now: () => now });
    await run(relayWith(limit, limited), 5);
    await tick();
    now = Date.parse(RESET) + RESUME_DELAY_MS + 1;
    limit.onSuccess("s1");
    await tick();
    expect(calls.some((c) => c[1] === "delete_scheduled_task")).toBe(false);
  });
  test("a subagent thread keeps the snooze and loses the resume task", async () => {
    const { limit, calls, logs } = setup({ subagent: true });
    await run(relayWith(limit, limited), 5);
    await tick();
    expect(calls.map((c) => c[1])).toEqual(["t3_thread_organize", "schedule_task", "t3_thread_read", "delete_scheduled_task"]);
    expect(logs[0]).toContain("subagent");
  });
  test("a reset more than 8 days away is ignored", () => {
    expect(resetFromText("Resets at 2026-11-28T12:00:01Z.", NOW)).toBeUndefined();
    expect(resetFromText("Resets at 2026-11-28T11:59:59Z.", NOW)).toBeDefined();
  });
});

describe("native Grok limit notification", () => {
  const complete = (stopReason: string, agentResult?: unknown) => JSON.stringify({ jsonrpc: "2.0", method: "_x.ai/session/prompt_complete", params: { sessionId: "s1", stopReason, agentResult } });
  test("rate_limit with the reset in agentResult snoozes", async () => {
    const { limit, calls } = setup();
    const r = new AcpRelay({ limit });
    r.fromClient(newSession([stdioServer]));
    await r.fromAgent(newAnswer);
    const out = await r.fromAgent(complete("rate_limit", `You've hit your usage limit. Resets at ${RESET}.`));
    expect(out.length).toBe(1);
    await tick();
    expect(calls.map((c) => c[1]).slice(0, 2)).toEqual(["t3_thread_organize", "schedule_task"]);
  });
  test("rate_limit with the reset only in an earlier message chunk snoozes", async () => {
    const { limit, calls } = setup();
    const r = new AcpRelay({ limit });
    r.fromClient(newSession([stdioServer]));
    await r.fromAgent(newAnswer);
    await r.fromAgent(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Limit. Resets at ${RESET}.` } } } }));
    await r.fromAgent(complete("rate_limit"));
    await tick();
    expect(calls.length).toBeGreaterThan(1);
  });
  test("rate_limit with no reset text does nothing", async () => {
    const { limit, calls } = setup();
    const r = new AcpRelay({ limit });
    r.fromClient(newSession([stdioServer]));
    await r.fromAgent(newAnswer);
    await r.fromAgent(complete("rate_limit"));
    await tick();
    expect(calls.length).toBe(0);
  });
});

describe("idle permission answer", () => {
  const perm = JSON.stringify({ jsonrpc: "2.0", id: "p1", method: "session/request_permission", params: { sessionId: "s1", options: [{ optionId: "a", kind: "allow_once" }] } });
  test("off: the request reaches the client unchanged and the relay sends nothing", async () => {
    const sent: string[] = [];
    const r = new AcpRelay({ toAgent: (l) => sent.push(l), answerIdlePermissions: false });
    expect(await r.fromAgent(perm)).toEqual([perm]);
    expect(sent).toEqual([]);
  });
  test("on (default): the relay answers it itself", async () => {
    const sent: string[] = [];
    const r = new AcpRelay({ toAgent: (l) => sent.push(l) });
    expect(await r.fromAgent(perm)).toEqual([]);
    expect(sent.length).toBe(1);
  });
});

describe("mcpCaller", () => {
  test("initialize, initialized, tools/call with the session header and authorization", async () => {
    const seen: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const f = async (_u: string, init: { headers: Record<string, string>; body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      seen.push({ body, headers: init.headers });
      if (body.id === undefined) return new Response("", { status: 202 });
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} })}\n\n`, { headers: { "content-type": "text/event-stream", "mcp-session-id": "m1" } });
    };
    await mcpCaller(f as never).call(EP, "schedule_task", { a: 1 });
    expect(seen.map((s) => s.body.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(seen[2]!.headers["mcp-session-id"]).toBe("m1");
    expect(seen[2]!.headers.authorization).toBe(EP.authorization);
    expect(seen[2]!.body.params).toEqual({ name: "schedule_task", arguments: { a: 1 } });
  });
  test("a tool error result throws", async () => {
    const f = async (_u: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as { id?: number; method: string };
      return b.id === undefined ? new Response("", { status: 202 }) : Response.json({ jsonrpc: "2.0", id: b.id, result: b.method === "tools/call" ? { isError: true } : {} });
    };
    await expect(mcpCaller(f as never).call(EP, "t", {})).rejects.toThrow("tool t");
  });
});
