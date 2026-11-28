import { describe, expect, test } from "bun:test";
import { countToolErrors } from "../../src/gateway/request-meta.ts";
import { PrometheusMetrics } from "../../src/gateway/metrics.ts";
import { MAX_STOP_REASON_CHARS, MAX_TOOL_NAME_CHARS, MAX_TOOL_NAMES, UsageTap } from "../../src/gateway/usage.ts";
import type { UsageStyle } from "../../src/gateway/providers/index.ts";

const enc = new TextEncoder();

function meta(style: UsageStyle, ct: string, text: string, size = Infinity) {
  const t = new UsageTap(style, ct);
  const b = enc.encode(text);
  for (let i = 0; i < b.length; i += Math.min(size, b.length)) t.write(b.subarray(i, i + size));
  return t.meta();
}

const sse = (events: Array<[string | null, unknown]>): string => events.map(([e, d]) => `${e ? `event: ${e}\n` : ""}data: ${typeof d === "string" ? d : JSON.stringify(d)}\n\n`).join("");

describe("anthropic messages metadata", () => {
  test("non-streamed body: stop_reason and tool_use names", () => {
    const body = JSON.stringify({
      type: "message", model: "claude-sonnet-4-5", stop_reason: "tool_use",
      content: [
        { type: "text", text: "CANARY_RESPONSE_TEXT" },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "CANARY_TOOL_INPUT" } },
        { type: "tool_use", id: "toolu_2", name: "Read", input: {} },
        { type: "tool_use", id: "toolu_3", name: "Bash", input: {} },
      ],
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(meta("anthropic", "application/json", body)).toEqual({ stopReason: "tool_use", toolCalls: 3, toolNames: ["Read", "Bash"] });
  });

  test("streamed body: stop_reason from message_delta, tool_use from content_block_start, any chunk size", () => {
    const body = sse([
      ["message_start", { type: "message_start", message: { model: "claude-sonnet-4-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Edit", input: {} } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"secret\":\"CANARY_TOOL_INPUT\"}" } }],
      ["content_block_start", { type: "content_block_start", index: 2, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 9 } }],
      ["message_stop", { type: "message_stop" }],
    ]);
    for (const size of [Infinity, 1, 7, 64]) {
      expect(meta("anthropic", "text/event-stream", body, size)).toEqual({ stopReason: "tool_use", toolCalls: 2, toolNames: ["Edit", "web_search"] });
    }
  });

  test("a plain end_turn answer has no tool calls", () => {
    const body = sse([
      ["message_start", { type: "message_start", message: { model: "m", content: [], usage: { input_tokens: 1, output_tokens: 1 } } }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }],
    ]);
    expect(meta("anthropic", "text/event-stream", body)).toEqual({ stopReason: "end_turn", toolCalls: 0, toolNames: [] });
  });
});

describe("openai responses and codex metadata", () => {
  test("streamed: a call seen in added, done and completed counts once; stop reason is the status", () => {
    const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "shell", arguments: "{\"cmd\":\"CANARY_TOOL_INPUT\"}" };
    const body = sse([
      ["response.created", { type: "response.created", response: { id: "resp_1", model: "gpt-5", status: "in_progress", output: [] } }],
      ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } }],
      ["response.output_item.added", { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } }],
      ["response.output_item.done", { type: "response.output_item.done", output_index: 1, item: call }],
      ["response.output_item.added", { type: "response.output_item.added", output_index: 2, item: { type: "web_search_call", id: "ws_1" } }],
      ["response.completed", { type: "response.completed", response: { id: "resp_1", model: "gpt-5", status: "completed", output: [{ type: "reasoning", id: "rs_1" }, call, { type: "web_search_call", id: "ws_1" }], usage: { input_tokens: 10, output_tokens: 2 } } }],
    ]);
    for (const size of [Infinity, 3, 50]) {
      expect(meta("openai-responses", "text/event-stream", body, size)).toEqual({ stopReason: "completed", toolCalls: 2, toolNames: ["shell", "web_search_call"] });
    }
  });

  test("codex SSE with no content type and an empty completed output still counts calls from output_item events", () => {
    const body = sse([
      ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_9", name: "apply_patch" } }],
      ["response.completed", { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } }],
    ]);
    expect(meta("openai-responses", "", body)).toEqual({ stopReason: "completed", toolCalls: 1, toolNames: ["apply_patch"] });
  });

  test("incomplete status gives its reason; non-streamed body reads the output list", () => {
    const body = JSON.stringify({ object: "response", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "custom_tool_call", id: "ctc_1", name: "patch" }], usage: { input_tokens: 1, output_tokens: 1 } });
    expect(meta("openai-responses", "application/json", body)).toEqual({ stopReason: "max_output_tokens", toolCalls: 1, toolNames: ["patch"] });
  });

  test("a failed response keeps its status", () => {
    const body = sse([["response.failed", { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "x" } } }]]);
    expect(meta("openai-responses", "text/event-stream", body).stopReason).toBe("failed");
  });
});

describe("openai chat completions metadata", () => {
  test("streamed tool_calls are counted once per call index; finish_reason is kept", () => {
    const body = sse([
      [null, { model: "m", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "lookup", arguments: "" } }] } }] }],
      [null, { model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"q\":\"CANARY_TOOL_INPUT\"}" } }] } }] }],
      [null, { model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "fetch", arguments: "{}" } }] } }] }],
      [null, { model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }],
      [null, "[DONE]"],
    ]);
    for (const size of [Infinity, 5]) expect(meta("openai-chat", "text/event-stream", body, size)).toEqual({ stopReason: "tool_calls", toolCalls: 2, toolNames: ["lookup", "fetch"] });
  });

  test("non-streamed message with tool_calls", () => {
    const body = JSON.stringify({ model: "m", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "a", arguments: "{}" } }, { id: "c2", type: "function", function: { name: "a", arguments: "{}" } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    expect(meta("openai-chat", "application/json", body)).toEqual({ stopReason: "tool_calls", toolCalls: 2, toolNames: ["a"] });
  });

  test("a plain stop has no tool calls", () => {
    expect(meta("openai-chat", "application/json", JSON.stringify({ model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "CANARY_RESPONSE_TEXT" } }] }))).toEqual({ stopReason: "stop", toolCalls: 0, toolNames: [] });
  });
});

describe("bounds", () => {
  test("names are distinct, at most 32, each at most 64 characters; the count stays exact", () => {
    const content = Array.from({ length: 50 }, (_, i) => ({ type: "tool_use", id: `t${i}`, name: `tool_${i}_${"x".repeat(100)}` }));
    content.push({ type: "tool_use", id: "dup", name: `tool_0_${"x".repeat(100)}` });
    const m = meta("anthropic", "application/json", JSON.stringify({ stop_reason: "tool_use", content }));
    expect(m.toolCalls).toBe(51);
    expect(m.toolNames).toHaveLength(MAX_TOOL_NAMES);
    expect(new Set(m.toolNames).size).toBe(MAX_TOOL_NAMES);
    expect(m.toolNames.every((n) => n.length <= MAX_TOOL_NAME_CHARS)).toBe(true);
  });

  test("a stop reason is cut and control characters are removed", () => {
    const m = meta("anthropic", "application/json", JSON.stringify({ stop_reason: `a\nb${"z".repeat(200)}`, content: [{ type: "tool_use", name: "bad\u0000name" }] }));
    expect(m.stopReason).toHaveLength(MAX_STOP_REASON_CHARS);
    expect(m.stopReason).not.toContain("\n");
    expect(m.toolNames).toEqual(["bad name"]);
  });

  test("an unreadable body gives empty metadata and never throws", () => {
    expect(meta("anthropic", "application/json", "not json")).toEqual({ toolCalls: 0, toolNames: [] });
    expect(meta("openai-chat", "text/event-stream", "data: {broken\n\n")).toEqual({ toolCalls: 0, toolNames: [] });
  });

  test("no content text reaches the metadata", () => {
    const body = JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "CANARY_RESPONSE_TEXT" }, { type: "tool_use", name: "Read", input: { x: "CANARY_TOOL_INPUT" } }] });
    expect(JSON.stringify(meta("anthropic", "application/json", body))).not.toContain("CANARY");
  });
});

describe("request tool errors", () => {
  const body = (messages: unknown[]): Uint8Array => enc.encode(JSON.stringify({ model: "m", messages }));
  const result = (isError: boolean | undefined, content = "CANARY_TOOL_RESULT") => ({ type: "tool_result", tool_use_id: "t", content, ...(isError === undefined ? {} : { is_error: isError }) });

  test("counts is_error tool_results in the last message only", () => {
    const messages = [
      { role: "user", content: [result(true)] },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] },
      { role: "user", content: [result(true), result(false), result(undefined), result(true)] },
    ];
    expect(countToolErrors(body(messages))).toBe(2);
  });

  test("a request without errors, with string content, or without the marker counts 0", () => {
    expect(countToolErrors(body([{ role: "user", content: "hello" }]))).toBe(0);
    expect(countToolErrors(body([{ role: "user", content: [result(false)] }]))).toBe(0);
    expect(countToolErrors(body([{ role: "user", content: [{ type: "text", text: "mentions is_error in prose" }] }]))).toBe(0);
  });

  test("text that only looks like a flag does not count", () => {
    expect(countToolErrors(body([{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: '"is_error":true' }] }]))).toBe(0);
  });

  test("a body that is not a Messages request is unknown", () => {
    expect(countToolErrors(enc.encode("{}"))).toBeUndefined();
    expect(countToolErrors(enc.encode("[1]"))).toBeUndefined();
    expect(countToolErrors(enc.encode('{"is_error":true'))).toBeUndefined();
    expect(countToolErrors(new Uint8Array(0))).toBeUndefined();
  });
});

describe("metrics", () => {
  const gauges = { ledgerDepth: () => 0, ledgerDropped: () => 0 };

  test("ttfb histogram and tool counters carry provider and model labels only", () => {
    const m = new PrometheusMetrics(gauges);
    m.request({ app: "app-one", provider: "claude", identity: "id-one", status: "ok", httpStatus: 200, latencyMs: 900, model: "claude-sonnet-4-5", ttfbMs: 300, toolCalls: 3, toolErrors: 1 });
    m.request({ app: "app-two", provider: "claude", identity: "id-two", status: "ok", httpStatus: 200, latencyMs: 90, model: "claude-sonnet-4-5", ttfbMs: 30, toolCalls: 2 });
    const out = m.render();
    expect(out).toContain('ais_gateway_tool_calls_total{provider="claude",model="claude-sonnet-4-5"} 5');
    expect(out).toContain('ais_gateway_tool_errors_total{provider="claude",model="claude-sonnet-4-5"} 1');
    expect(out).toContain('ais_gateway_ttfb_seconds_bucket{provider="claude",model="claude-sonnet-4-5",le="0.05"} 1');
    expect(out).toContain('ais_gateway_ttfb_seconds_bucket{provider="claude",model="claude-sonnet-4-5",le="0.5"} 2');
    expect(out).toContain('ais_gateway_ttfb_seconds_count{provider="claude",model="claude-sonnet-4-5"} 2');
    expect(out.match(/# TYPE ais_gateway_ttfb_seconds histogram/g)).toHaveLength(1);
    for (const line of out.split("\n").filter((l) => /^ais_gateway_(ttfb_seconds|tool_calls_total|tool_errors_total)/.test(l))) {
      expect(line).not.toMatch(/app=|identity=|session|tool=|name=/);
    }
  });

  test("a request with no first byte or tools adds no series; unknown model is a dash", () => {
    const m = new PrometheusMetrics(gauges);
    m.request({ app: "a", provider: "claude", identity: "i", status: "rejected", httpStatus: 429, latencyMs: 5 });
    expect(m.render()).not.toMatch(/ais_gateway_ttfb_seconds_bucket|ais_gateway_tool_calls_total\{/);
    m.request({ app: "a", provider: "claude", identity: "i", status: "ok", httpStatus: 200, latencyMs: 5, ttfbMs: 4 });
    expect(m.render()).toContain('ais_gateway_ttfb_seconds_count{provider="claude",model="-"} 1');
  });

  test("model labels are bounded: past 64 distinct names a new one is other", () => {
    const m = new PrometheusMetrics(gauges);
    for (let i = 0; i < 80; i++) m.request({ app: "a", provider: "claude", identity: "i", status: "ok", httpStatus: 200, latencyMs: 5, model: `model-${i}`, toolCalls: 1 });
    const series = m.render().split("\n").filter((l) => l.startsWith("ais_gateway_tool_calls_total{"));
    expect(series).toHaveLength(65);
    expect(series).toContain('ais_gateway_tool_calls_total{provider="claude",model="other"} 16');
  });
});
