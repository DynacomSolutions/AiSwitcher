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
