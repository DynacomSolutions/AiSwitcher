import { describe, expect, test } from "bun:test";
import { AcpRelay, describeError, EMPTY_TURN_NOTICE, ERROR_SOURCE, failureMessage, TURN_FAILED_CODE, type TurnFailure } from "../../src/acp/relay.ts";
import { LineSplitter } from "../../src/acp/relay-process.ts";

const prompt = (id: number | string, sessionId = "s1") => JSON.stringify({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "SYNTHETIC_FIXTURE prompt" }] } });
const update = (kind: string, sessionId = "s1") => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: kind, content: { type: "text", text: "x" } } } });
const endTurn = (id: number | string, stopReason = "end_turn") => JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason } });
const failed: TurnFailure = { message: "Invalid request Error", code: "provider.api_error", status: 400, retryable: false };

function relay(failure?: TurnFailure | (() => Promise<TurnFailure | undefined>)) {
  const asked: Array<[string, number]> = [];
  const logs: string[] = [];
  const r = new AcpRelay({
    now: () => 1000,
    log: (l) => logs.push(l),
    adapter: {
      turnFailure: async (sessionId, startedAtMs) => {
        asked.push([sessionId, startedAtMs]);
        return typeof failure === "function" ? failure() : failure;
      },
    },
  });
  return { r, asked, logs };
}

describe("a turn the agent says ended normally", () => {
  test("a failed turn answered end_turn becomes a JSON-RPC error with the reason", async () => {
    const { r, asked, logs } = relay(failed);
    r.fromClient(prompt(7));
    const out = await r.fromAgent(endTurn(7));
    expect(out.length).toBe(1);
    expect(JSON.parse(out[0]!)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: TURN_FAILED_CODE, message: "Turn failed: Invalid request Error (HTTP 400, provider.api_error)", data: { source: ERROR_SOURCE, code: "provider.api_error", status: 400, retryable: false } },
    });
    expect(asked).toEqual([["s1", 1000]]);
    expect(logs).toEqual(["acp-relay: failed turn reported as an error (provider.api_error, HTTP 400)"]);
  });

  test("a failed turn is an error even when the agent sent output first", async () => {
    const { r } = relay(failed);
    r.fromClient(prompt(1));
    expect(await r.fromAgent(update("agent_thought_chunk"))).toEqual([update("agent_thought_chunk")]);
    expect(JSON.parse((await r.fromAgent(endTurn(1)))[0]!).error.code).toBe(TURN_FAILED_CODE);
  });

  test("a good turn passes unchanged, byte for byte", async () => {
    const { r, logs } = relay(undefined);
    r.fromClient(prompt(1));
    const chunk = update("agent_message_chunk");
    expect(await r.fromAgent(chunk)).toEqual([chunk]);
    const spaced = '{"jsonrpc":"2.0",  "id":1,"result":{"stopReason":"end_turn","usage":{"x":1}}}';
    expect(await r.fromAgent(spaced)).toEqual([spaced]);
    expect(logs).toEqual([]);
  });

  test("a turn with no output and no known failure gets a notice before its answer", async () => {
    const { r } = relay(undefined);
    r.fromClient(prompt("p-1", "s9"));
    await r.fromAgent(update("usage_update", "s9")); // not output
    await r.fromAgent(update("agent_message_chunk", "other-session"));
    const out = await r.fromAgent(endTurn("p-1"));
    expect(out.length).toBe(2);
    expect(JSON.parse(out[0]!)).toEqual({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s9", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: EMPTY_TURN_NOTICE } } } });
    expect(out[1]).toBe(endTurn("p-1"));
  });

  test("an agent with no adapter gets the notice rule only", async () => {
    const r = new AcpRelay();
    r.fromClient(prompt(1));
    expect((await r.fromAgent(endTurn(1))).length).toBe(2);
    r.fromClient(prompt(2));
    await r.fromAgent(update("tool_call"));
    expect(await r.fromAgent(endTurn(2))).toEqual([endTurn(2)]);
  });

  test("an adapter that throws never breaks the turn", async () => {
    const { r } = relay(async () => {
      throw new Error("log unreadable");
    });
    r.fromClient(prompt(1));
    await r.fromAgent(update("agent_message_chunk"));
    expect(await r.fromAgent(endTurn(1))).toEqual([endTurn(1)]);
  });

  test("other stop reasons pass unchanged and the adapter is not asked", async () => {
    for (const reason of ["cancelled", "max_tokens", "refusal", "max_turn_requests"]) {
      const { r, asked } = relay(failed);
      r.fromClient(prompt(1));
      expect(await r.fromAgent(endTurn(1, reason))).toEqual([endTurn(1, reason)]);
      expect(asked).toEqual([]);
    }
  });
});

describe("a turn the agent answers with an error", () => {
  const rpcError = (error: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, error });

  test("a generic message is replaced by the detail in data", async () => {
    const { r, asked } = relay(failed);
    r.fromClient(prompt(1));
    const out = await r.fromAgent(rpcError({ code: -32603, message: "Internal error", data: { details: "API error (status 429): rate limit reached" } }));
    expect(JSON.parse(out[0]!)).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "API error (status 429): rate limit reached", data: { details: "API error (status 429): rate limit reached" } } });
    expect(asked).toEqual([]);
  });

  test("describeError: where the detail is read from, and when nothing changes", () => {
    expect(describeError({ code: -32603, message: "Internal error", data: "upstream said no" })?.message).toBe("upstream said no");
    expect(describeError({ code: -32603, message: "Internal error", data: { error: { message: "nested reason" } } })?.message).toBe("nested reason");
    expect(describeError({ code: -32000, message: "Authentication required", data: { message: "run login" } })?.message).toBe("Authentication required: run login");
    expect(describeError({ code: -32603, message: "Provider failed: bad key", data: { details: "bad key" } })).toBeUndefined();
    expect(describeError({ code: -32603, message: "Internal error" })).toBeUndefined();
    expect(describeError({ code: -32603, message: "Internal error", data: { status: 500 } })).toBeUndefined();
    expect(describeError("nope")).toBeUndefined();
  });

  test("an error with nothing to add passes unchanged", async () => {
    const { r } = relay(failed);
    r.fromClient(prompt(1));
    const line = rpcError({ code: -32602, message: "Invalid params" });
    expect(await r.fromAgent(line)).toEqual([line]);
  });

  test("secrets in a reason never reach the client, and a long reason is cut", () => {
    const m = describeError({ code: -32603, message: "Internal error", data: `bad key sk-SYNTHETIC_FIXTURE_0123456789abcdef ${"word ".repeat(300)}` })?.message as string;
    expect(m.startsWith("bad key [redacted] word")).toBe(true);
    expect(m.length).toBe(500);
    expect(failureMessage({ message: "Bearer SYNTHETIC_FIXTURE.tok-en refused", retryable: true })).toBe("Turn failed: Bearer [redacted] refused (the agent's retries ran out)");
    expect(failureMessage({ message: "Request timed out" })).toBe("Turn failed: Request timed out");
  });
});

describe("everything else", () => {
  test("lines that are not answers to a prompt pass unchanged", async () => {
    const { r, asked } = relay(failed);
    const before = '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}';
    expect(await r.fromAgent(before)).toEqual([before]); // no prompt seen yet
    r.fromClient(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/x" } }));
    r.fromClient(prompt(2));
    for (const line of [
      '{"jsonrpc":"2.0","id":1,"result":{"sessionId":"s1"}}',
      '{"jsonrpc":"2.0","id":2,"method":"session/request_permission","params":{"sessionId":"s1"}}', // the agent's own request with the same id
      "not json at all",
      "[1,2]",
      "",
    ]) {
      expect(await r.fromAgent(line)).toEqual([line]);
    }
    expect(asked).toEqual([]);
    expect(JSON.parse((await r.fromAgent(endTurn(2)))[0]!).error.code).toBe(TURN_FAILED_CODE);
    // the prompt is answered once: a second answer with the same id is not a prompt answer
    expect(await r.fromAgent(endTurn(2))).toEqual([endTurn(2)]);
  });

  test("number and string ids are different requests", async () => {
    const { r } = relay(failed);
    r.fromClient(prompt("1"));
    expect(await r.fromAgent(endTurn(1))).toEqual([endTurn(1)]);
    expect(JSON.parse((await r.fromAgent(endTurn("1")))[0]!).error).toBeDefined();
  });

  test("output is counted for the prompt in flight of its own session", async () => {
    const { r } = relay(undefined);
    r.fromClient(prompt(1, "a"));
    r.fromClient(prompt(2, "b"));
    await r.fromAgent(update("agent_message_chunk", "b"));
    expect((await r.fromAgent(endTurn(1))).length).toBe(2); // session a had no output
    expect(await r.fromAgent(endTurn(2))).toEqual([endTurn(2)]);
  });

  test("a client line that is not a prompt is ignored", () => {
    const { r } = relay(failed);
    r.fromClient('{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s1"}}');
    r.fromClient('broken "session/prompt" {');
    r.fromClient(JSON.stringify({ jsonrpc: "2.0", method: "session/prompt", params: { sessionId: "s1" } })); // no id
  });
});

describe("LineSplitter", () => {
  test("keeps the bytes of each line across chunks", () => {
    const s = new LineSplitter();
    const text = (bufs: Buffer[]) => bufs.map((b) => b.toString("utf8"));
    expect(text(s.push(Buffer.from('{"a":1}\n{"b"')))).toEqual(['{"a":1}']);
    expect(text(s.push(Buffer.from(":")))).toEqual([]);
    const euro = Buffer.from("2€}\n\nlast");
    expect(text(s.push(euro.subarray(0, 2)))).toEqual([]); // cut inside a multi-byte character
    expect(text(s.push(euro.subarray(2)))).toEqual(['{"b":2€}', ""]);
    expect(s.rest().toString()).toBe("last");
    expect(s.rest().length).toBe(0);
  });
});
