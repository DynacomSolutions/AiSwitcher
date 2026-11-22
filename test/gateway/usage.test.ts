import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { estimateCost, UsageTap } from "../../src/gateway/usage.ts";
import type { UsageStyle } from "../../src/gateway/providers/index.ts";

const fx = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../fixtures/gateway/usage/${name}`, import.meta.url)));

function tap(style: UsageStyle, ct: string, bytes: Uint8Array, size = bytes.length) {
  const t = new UsageTap(style, ct);
  for (let i = 0; i < bytes.length; i += size) t.write(bytes.subarray(i, i + size));
  return t.result();
}

describe("usage tap", () => {
  test("anthropic json usage", () => {
    expect(tap("anthropic", "application/json", fx("anthropic.json"))).toEqual({
      model: "claude-sonnet-4-5", inputTokens: 12, outputTokens: 34, cacheReadTokens: 78, cacheWriteTokens: 56,
    });
  });

  test("anthropic sse sums message_start and message_delta", () => {
    expect(tap("anthropic", "text/event-stream", fx("anthropic.sse"))).toEqual({
      model: "claude-sonnet-4-5", inputTokens: 10, outputTokens: 42, cacheReadTokens: 7, cacheWriteTokens: 5,
    });
  });

  test("openai responses sse reads response.completed usage", () => {
    // input excludes cached tokens: 100 prompt - 40 cached
    expect(tap("openai-responses", "text/event-stream", fx("openai-responses.sse"))).toEqual({
      model: "gpt-5", inputTokens: 60, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 0,
    });
  });

  test("openai chat sse reads final usage chunk", () => {
    expect(tap("openai-chat", "text/event-stream", fx("openai-chat.sse"))).toEqual({
      model: "gpt-5", inputTokens: 20, outputTokens: 9, cacheReadTokens: 30, cacheWriteTokens: 0,
    });
  });

  test("event split across chunks parses", () => {
    const want = tap("anthropic", "text/event-stream", fx("anthropic.sse"));
    for (const size of [1, 2, 3, 7, 13]) {
      expect(tap("anthropic", "text/event-stream", fx("anthropic.sse"), size)).toEqual(want);
    }
    const j = tap("anthropic", "application/json", fx("anthropic.json"), 5);
    expect(j.cacheReadTokens).toBe(78);
  });

  test("unknown shape returns zero counts without throwing", () => {
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const enc = new TextEncoder();
    expect(tap("anthropic", "application/json", enc.encode("not json {"))).toEqual(zero);
    expect(tap("openai-chat", "application/json", enc.encode('{"usage":"x"}'))).toEqual(zero);
    expect(tap("openai-responses", "text/event-stream", enc.encode("data: {oops\n\ndata: [1]\n\ndata: null\n\n"))).toEqual(zero);
    expect(new UsageTap("anthropic", "").result()).toEqual(zero);
  });

  test("json body beyond the cap gives zero counts", () => {
    const t = new UsageTap("anthropic", "application/json");
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    for (let i = 0; i < 5; i++) t.write(chunk);
    t.write(new TextEncoder().encode('{"usage":{"input_tokens":1,"output_tokens":1}}'));
    expect(t.result().inputTokens).toBe(0);
  });

  test("oversized sse event is dropped, later events still parse", () => {
    const t = new UsageTap("anthropic", "text/event-stream");
    const enc = new TextEncoder();
    t.write(enc.encode("data: " + "x".repeat(3 * 1024 * 1024)));
    t.write(enc.encode("\n\ndata: " + '{"type":"message_delta","usage":{"output_tokens":3}}' + "\n\n"));
    expect(t.result().outputTokens).toBe(3);
  });
});

describe("content-type sniffing", () => {
  const codex = { model: "gpt-5", inputTokens: 20, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 0 };
  test("sse with no content-type is read as sse, whole or in small chunks", () => {
    expect(tap("openai-responses", "", fx("codex-responses.sse"))).toEqual(codex);
    expect(tap("openai-responses", "", fx("codex-responses.sse"), 7)).toEqual(codex);
  });
  test("a content-type that is neither json nor event-stream is sniffed too", () => {
    expect(tap("openai-responses", "application/octet-stream", fx("codex-responses.sse"))).toEqual(codex);
  });
  test("leading whitespace and a comment line still mean sse", () => {
    const body = new TextEncoder().encode("\n  : keep-alive\n\n" + new TextDecoder().decode(fx("codex-responses.sse")));
    expect(tap("openai-responses", "", body)).toEqual(codex);
  });
  test("json with no content-type is still json", () => {
    expect(tap("anthropic", "", fx("anthropic.json"))).toEqual({ model: "claude-sonnet-4-5", inputTokens: 12, outputTokens: 34, cacheReadTokens: 78, cacheWriteTokens: 56 });
  });
  test("id: and retry: first lines mean sse", () => {
    const body = new TextDecoder().decode(fx("codex-responses.sse"));
    expect(tap("openai-responses", "", new TextEncoder().encode("id: 1\n" + body))).toEqual(codex);
    expect(tap("openai-responses", "", new TextEncoder().encode("retry: 3000\n\n" + body), 3)).toEqual(codex);
  });
  test("a plain-text body that starts like a field name is not sse", () => {
    for (const text of ["error: something broke", "error 500 internal", "data stream unavailable", "idle"]) {
      const t = new UsageTap("openai-responses", "");
      t.write(new TextEncoder().encode(text));
      expect(t.status()).toBe("unparseable");
      expect(t.isSse()).toBe(false);
    }
  });
  test("isSse reports the resolved mode", () => {
    const a = new UsageTap("openai-responses", "");
    a.write(fx("codex-responses.sse"));
    expect(a.isSse()).toBe(true);
    expect(new UsageTap("anthropic", "text/event-stream").isSse()).toBe(true);
    expect(new UsageTap("anthropic", "application/json").isSse()).toBe(false);
  });
  test("status is ok for a sniffed sse body", () => {
    const t = new UsageTap("openai-responses", "");
    t.write(fx("codex-responses.sse"));
    expect(t.status()).toBe("ok");
  });
});

describe("usage tap edge cases", () => {
  const enc = new TextEncoder();
  const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const sse = (style: UsageStyle, text: string) => {
    const t = new UsageTap(style, "text/event-stream");
    t.write(enc.encode(text));
    return t;
  };

  test("anthropic max rule keeps input when message_delta sends zero", () => {
    const t = sse("anthropic", 'data: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":1}}}\n\ndata: {"type":"message_delta","usage":{"input_tokens":0,"output_tokens":5}}\n\n');
    expect(t.result()).toEqual({ ...zero, inputTokens: 9, outputTokens: 5 });
  });

  test("lone CR terminators parse", () => {
    const t = sse("anthropic", 'data: {"type":"message_delta","usage":{"output_tokens":4}}\r\r');
    expect(t.result().outputTokens).toBe(4);
  });

  test("multi-line data event joins lines", () => {
    const t = sse("anthropic", 'data: {"type":"message_delta",\ndata: "usage":{"output_tokens":6}}\n\n');
    expect(t.result().outputTokens).toBe(6);
  });

  test("many empty data lines stay bounded and later events parse", () => {
    const t = new UsageTap("anthropic", "text/event-stream");
    const burst = enc.encode("data:\n".repeat(100_000));
    for (let i = 0; i < 20; i++) t.write(burst);
    t.write(enc.encode('\n' + 'data: {"type":"message_delta","usage":{"output_tokens":2}}\n\n'));
    expect(t.result().outputTokens).toBe(2);
    expect(t.status()).toBe("overflow");
  });

  test("status ok, none, unparseable, overflow", () => {
    expect(new UsageTap("anthropic", "application/json").status()).toBe("none");
    expect(sse("anthropic", 'data: {"type":"ping"}\n\n').status()).toBe("none");
    expect(sse("anthropic", 'data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n').status()).toBe("ok");
    const bad = new UsageTap("anthropic", "application/json");
    bad.write(enc.encode("nope {"));
    expect(bad.status()).toBe("unparseable");
    expect(sse("openai-chat", "data: {oops\n\n").status()).toBe("unparseable");
    const big = new UsageTap("anthropic", "application/json");
    big.write(new Uint8Array(5 * 1024 * 1024));
    expect(big.status()).toBe("overflow");
  });
});

describe("errors inside a 200 body", () => {
  const enc = new TextEncoder();
  const feed = (style: UsageStyle, text: string, ct = "text/event-stream", size = 7) => {
    const t = new UsageTap(style, ct);
    const b = enc.encode(text);
    for (let i = 0; i < b.length; i += size) t.write(b.subarray(i, i + size));
    return t;
  };

  test("responses `error` event keeps type, code and message", () => {
    const t = feed("openai-responses", 'event: error\ndata: {"type":"error","code":"server_error","message":"The model failed SYNTHETIC_FIXTURE","param":null}\n\n');
    expect(t.streamError()).toEqual({ event: "error", code: "server_error", message: "The model failed SYNTHETIC_FIXTURE" });
  });

  test("responses `response.failed` reads the nested error and the response id", () => {
    const t = feed("openai-responses", 'data: {"type":"response.failed","response":{"id":"resp_abc","status":"failed","error":{"code":"rate_limit_exceeded","message":"Slow down"}}}\n\n');
    expect(t.streamError()).toEqual({ event: "response.failed", code: "rate_limit_exceeded", message: "Slow down", requestId: "resp_abc" });
  });

  test("responses `response.failed` without an error object is still an error", () => {
    expect(feed("openai-responses", 'data: {"type":"response.failed","response":{"status":"failed"}}\n\n').streamError()).toEqual({ event: "response.failed" });
  });

  test("an error event with no message is still found", () => {
    expect(feed("openai-responses", 'data: {"type":"error"}\n\n').streamError()).toEqual({ event: "error" });
    expect(feed("anthropic", 'event: error\ndata: {"type":"error"}\n\n').streamError()).toEqual({ event: "error" });
    expect(feed("openai-chat", 'data: {"error":{"code":"x"}}\n\n').streamError()).toEqual({ event: "error", code: "x" });
  });

  test("anthropic `event: error` keeps error type, message and request id", () => {
    const t = feed("anthropic", 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_123"}\n\n');
    expect(t.streamError()).toEqual({ event: "error", type: "overloaded_error", message: "Overloaded", requestId: "req_123" });
  });

  test("anthropic error event named only by its SSE event line", () => {
    expect(feed("anthropic", 'event: error\ndata: {"error":{"type":"api_error","message":"boom"}}\n\n').streamError()).toMatchObject({ event: "error", type: "api_error", message: "boom" });
  });

  test("chat completions error chunk", () => {
    const t = feed("openai-chat", 'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"error":{"message":"upstream timeout","type":"server_error","code":"timeout"}}\n\n');
    expect(t.streamError()).toEqual({ event: "error", type: "server_error", code: "timeout", message: "upstream timeout" });
  });

  test("chat completions error as a plain string, and a failed non-streamed responses body", () => {
    expect(feed("openai-chat", 'data: {"error":"bad gateway"}\n\n').streamError()).toEqual({ event: "error", message: "bad gateway" });
    const body = '{"object":"response","status":"failed","error":{"code":"server_error","message":"x"}}';
    expect(feed("openai-responses", body, "application/json", 11).streamError()).toEqual({ event: "response.failed", code: "server_error", message: "x" });
  });

  test("healthy streams and null errors are not errors", () => {
    expect(feed("openai-responses", 'data: {"type":"response.completed","response":{"model":"gpt-5","error":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n').streamError()).toBeUndefined();
    expect(feed("openai-chat", 'data: {"error":null,"choices":[]}\n\ndata: [DONE]\n\n').streamError()).toBeUndefined();
    expect(feed("openai-chat", 'data: {"error":{}}\n\n').streamError()).toBeUndefined();
    expect(feed("anthropic", 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n').streamError()).toBeUndefined();
  });

  test("the first error wins, the message is redacted and cut, and counts stay readable", () => {
    const long = `${"word ".repeat(200)}Bearer SYNTHETIC_FIXTURE_abcdefgh`;
    const t = feed("openai-responses", `data: {"type":"error","message":${JSON.stringify(long)}}\n\ndata: {"type":"error","message":"second"}\n\n`);
    const e = t.streamError()!;
    expect(e.message!.length).toBeLessThanOrEqual(300);
    expect(e.message).not.toContain("second");
    expect(feed("openai-responses", 'data: {"type":"error","message":"auth Bearer SYNTHETIC_FIXTURE_abcdefgh"}\n\n').streamError()!.message).toBe("auth Bearer [redacted]");
  });

  test("an event name does not leak into the next event", () => {
    expect(feed("anthropic", 'event: error\ndata: {"type":"error"}\n\nevent: ping\ndata: {"type":"ping"}\n\n').streamError()).toEqual({ event: "error" });
    expect(feed("anthropic", 'event: ping\ndata: {"type":"ping"}\n\n').streamError()).toBeUndefined();
  });
});

describe("estimateCost", () => {
  const c = { model: "glm-4.6", inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 };
  test("unknown model or missing model is undefined", () => {
    expect(estimateCost("zai", { ...c, model: "nope-9" })).toBeUndefined();
    expect(estimateCost("claude", { ...c, model: undefined })).toBeUndefined();
    expect(estimateCost("claude", { ...c, model: "nope-9" })).toBeUndefined();
  });
  test("known zai model prices", () => {
    expect(estimateCost("zai", c)).toBeGreaterThan(0);
  });
  test("zai cache reads use the cached rate", () => {
    const cost = estimateCost("zai", { ...c, inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 });
    expect(cost).toBeCloseTo(0.11, 6);
  });
});
