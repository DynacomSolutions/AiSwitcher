import { describe, expect, test } from "bun:test";
import type { PoolUsage } from "../../src/identities/pool/adapter.ts";
import { FALLBACK_RESET_SECONDS, fullWindowReset, genericLimitResponse, limitMessage, nativeLimitResponse, summariseLimit } from "../../src/gateway/native-limit.ts";

/**
 * Fixtures are synthetic and scrubbed. Their shapes come from the provider-native limit answers the CLIs parse:
 * Claude Code reads the `anthropic-ratelimit-unified-*` headers (status, reset, representative-claim, 5h/7d families,
 * overage-*) and Codex reads the `usage_limit_reached` error body and the `x-codex-primary|secondary-*` headers.
 */
const NOW = new Date("2026-11-02T10:00:00.000Z"); // 1793613600
const T_1230 = "2026-11-02T12:30:00.000Z"; // 1793622600
const T_1400 = "2026-11-02T14:00:00.000Z"; // 1793628000
const T_NOV5 = "2026-11-05T09:00:00.000Z"; // 1793869200

const claudeMember = (five: number, fiveReset: string, seven: number, sevenReset: string): PoolUsage => ({
  status: "live",
  maxUtilization: Math.max(five, seven),
  capturedAt: NOW.toISOString(),
  windows: [
    { label: "five-hour", utilization: five, resetsAt: fiveReset },
    { label: "seven-day", utilization: seven, resetsAt: sevenReset },
  ],
});

const a = claudeMember(100, T_1400, 40, T_NOV5);
const b = claudeMember(95, T_1230, 30, T_NOV5);

/** The two patterns T3 Code 0.1.7 uses to snooze a limited OpenCode thread and wake it again. */
export const T3_DETECT = /^You've hit your [^\n]*\blimit\b/;
export const T3_RESET = /\bResets at (\d{4}-\d\d-\d\dT[\d:.]+Z)\.?\s*$/;

const expectT3 = (message: string, resetAtSec: number): void => {
  expect(T3_DETECT.test(message)).toBe(true);
  expect(T3_RESET.exec(message)?.[1]).toBe(new Date(resetAtSec * 1000).toISOString());
};

describe("summariseLimit", () => {
  test("picks the earliest reset across the members", () => {
    expect(summariseLimit([a, b], 80, NOW)).toMatchObject({ resetAtSec: 1793622600, claim: "short", guessed: false });
    expect(summariseLimit([b, a], 80, NOW)).toMatchObject({ resetAtSec: 1793622600 });
  });

  test("a member over the reserve on both windows is back only when the later window resets", () => {
    const both = claudeMember(90, T_1230, 85, T_NOV5);
    expect(summariseLimit([both], 80, NOW)).toMatchObject({ resetAtSec: 1793869200, claim: "long" });
    expect(summariseLimit([both, a], 80, NOW)).toMatchObject({ resetAtSec: 1793628000 });
  });

  test("members without a figure or a reset are skipped; no reset at all falls back", () => {
    expect(summariseLimit([undefined, { status: "live", maxUtilization: 99, capturedAt: "x" }, b], 80, NOW).resetAtSec).toBe(1793622600);
    expect(summariseLimit([undefined], 80, NOW)).toMatchObject({ resetAtSec: 1793613600 + FALLBACK_RESET_SECONDS, guessed: true });
  });

  test("a reset already in the past (stale figure) is ignored", () => {
    const stale = claudeMember(100, "2026-11-02T09:00:00.000Z", 10, T_NOV5);
    expect(summariseLimit([stale, a], 80, NOW).resetAtSec).toBe(1793628000);
  });
});

describe("nativeLimitResponse for claude", () => {
  test("exact Anthropic limit response: 429, rate_limit_error body, unified headers", async () => {
    const res = nativeLimitResponse("claude", [a, b], 80, NOW)!;
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "You've hit your 5-hour limit (resets 19:30 ICT Mon 2 Nov, 12:30 GMT Mon 2 Nov). Resets at 2026-11-02T12:30:00.000Z." },
    });
    expect(Object.fromEntries(res.headers)).toEqual({
      "content-type": "application/json",
      "retry-after": "9000",
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": "1793622600",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-overage-status": "rejected",
      "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": "1793622600",
      "anthropic-ratelimit-unified-5h-utilization": "1",
      "anthropic-ratelimit-unified-7d-status": "allowed",
      "anthropic-ratelimit-unified-7d-reset": "1793869200",
      "anthropic-ratelimit-unified-7d-utilization": "0.3",
    });
  });

  test("a weekly block names seven_day as the representative claim", () => {
    const res = nativeLimitResponse("claude", [claudeMember(10, T_1230, 100, T_NOV5)], 80, NOW)!;
    expect(res.headers.get("anthropic-ratelimit-unified-representative-claim")).toBe("seven_day");
    expect(res.headers.get("anthropic-ratelimit-unified-reset")).toBe("1793869200");
    expect(res.headers.get("anthropic-ratelimit-unified-7d-status")).toBe("rejected");
    expect(res.headers.get("anthropic-ratelimit-unified-5h-status")).toBe("allowed");
  });

  test("no readings at all still answers natively, with the fallback reset", () => {
    const res = nativeLimitResponse("claude", [], 80, NOW)!;
    expect(res.status).toBe(429);
    expect(res.headers.get("anthropic-ratelimit-unified-status")).toBe("rejected");
    expect(res.headers.get("anthropic-ratelimit-unified-reset")).toBe(String(1793613600 + FALLBACK_RESET_SECONDS));
    expect(res.headers.get("retry-after")).toBe(String(FALLBACK_RESET_SECONDS));
  });
});

describe("nativeLimitResponse for codex", () => {
  const codexMember = (short: number, shortReset: string, long: number, longReset: string): PoolUsage => ({
    status: "live",
    maxUtilization: Math.max(short, long),
    capturedAt: NOW.toISOString(),
    windows: [
      { label: "session", utilization: short, resetsAt: shortReset },
      { label: "week", utilization: long, resetsAt: longReset },
    ],
  });

  test("exact Codex usage-limit response: usage_limit_reached with resets_at and x-codex headers", async () => {
    const res = nativeLimitResponse("codex", [codexMember(100, T_1400, 20, T_NOV5), codexMember(100, T_1230, 25, T_NOV5)], 100, NOW)!;
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: { type: "usage_limit_reached", message: "You've hit your 5-hour limit (resets 19:30 ICT Mon 2 Nov, 12:30 GMT Mon 2 Nov). Resets at 2026-11-02T12:30:00.000Z.", resets_at: 1793622600, resets_in_seconds: 9000 },
    });
    expect(Object.fromEntries(res.headers)).toEqual({
      "content-type": "application/json",
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "1793622600",
      "x-codex-secondary-used-percent": "25",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": "1793869200",
    });
  });

  test("providers without a native shape get no synthetic answer", () => {
    expect(nativeLimitResponse("kimi", [a], 80, NOW)).toBeUndefined();
  });

  test("every limit message matches both T3 patterns", async () => {
    const claude = nativeLimitResponse("claude", [a, b], 80, NOW)!;
    expectT3(((await claude.json()) as { error: { message: string } }).error.message, 1793622600);
    const codex = nativeLimitResponse("codex", [codexMember(100, T_1400, 20, T_NOV5)], 100, NOW)!;
    expectT3(((await codex.json()) as { error: { message: string } }).error.message, 1793628000);
    expectT3(limitMessage("usage", 1793622600, "identity is at its usage reserve"), 1793622600);
  });

  test("generic limit answer keeps the provider style and carries retry-after", async () => {
    const res = genericLimitResponse("openai", 1793622600, NOW, "identity is at its usage reserve");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("9000");
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.message).toBe("You've hit your usage limit (identity is at its usage reserve; resets 19:30 ICT Mon 2 Nov, 12:30 GMT Mon 2 Nov). Resets at 2026-11-02T12:30:00.000Z.");
    expectT3(body.error.message, 1793622600);
    expect(genericLimitResponse("anthropic", 1, NOW, "x").headers.get("retry-after")).toBe("1");
  });
});

describe("true reset at full capacity (OpenCode Go shapes)", () => {
  const go = (fiveUsed: number, weekUsed: number, weekReset: string): PoolUsage => ({
    status: "rate-limited",
    maxUtilization: Math.max(fiveUsed, weekUsed),
    capturedAt: NOW.toISOString(),
    windows: [
      { label: "session (5h)", utilization: fiveUsed, resetsAt: T_1400 },
      { label: "week", utilization: weekUsed, resetsAt: weekReset },
      { label: "month", utilization: 20, resetsAt: "2026-12-01T00:00:00.000Z" },
    ],
  });
  const T_WEEK = "2026-11-05T09:00:00.000Z"; // 1793869200

  test("one member weekly 100%, 5h 51%, three members with no windows: the weekly reset", () => {
    const info = summariseLimit([go(51, 100, T_WEEK), undefined, undefined, undefined], 100, NOW);
    expect(info).toMatchObject({ resetAtSec: 1793869200, claim: "long", guessed: false });
  });

  test("a short quota hold candidate later than nothing does not beat the weekly reading", () => {
    expect(fullWindowReset([go(51, 100, T_WEEK), undefined, undefined, undefined], 100, NOW)).toBe(1793869200);
  });

  test("no window over the reserve gives no full-window reset (a burst stays short)", () => {
    expect(fullWindowReset([go(51, 40, T_WEEK), undefined], 100, NOW)).toBeUndefined();
  });

  test("a full monthly window counts in the long slot and sets the reset", () => {
    const m: PoolUsage = { status: "rate-limited", maxUtilization: 100, capturedAt: NOW.toISOString(), windows: [{ label: "session (5h)", utilization: 10, resetsAt: T_1400 }, { label: "week", utilization: 30, resetsAt: T_WEEK }, { label: "month", utilization: 100, resetsAt: "2026-12-01T00:00:00.000Z" }] };
    expect(summariseLimit([m], 100, NOW)).toMatchObject({ resetAtSec: Date.parse("2026-12-01T00:00:00.000Z") / 1000, claim: "long" });
  });

  test("with two blocked members the earliest member time wins, each member at its latest full window", () => {
    const x = go(100, 100, T_WEEK); // 5h and week full: latest is the week
    const y = go(100, 100, "2026-11-08T09:00:00.000Z");
    expect(summariseLimit([y, x], 100, NOW).resetAtSec).toBe(1793869200);
  });
});
