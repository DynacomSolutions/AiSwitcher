import { describe, expect, test } from "bun:test";
import { applyPeriod, periodLabel, periodShare } from "../../apps/web/src/lib/usage-period.ts";
import type { Identity, TokscaleReport, UsageResult } from "../../apps/web/src/types/api.ts";

const identity: Identity = { name: "SYNTHETIC_FIXTURE_identity", label: "SYNTHETIC_FIXTURE_identity", configDir: "SYNTHETIC_FIXTURE_dir" };
// Noon local time, so the local calendar day is unambiguous in any timezone.
const NOW = new Date(2026, 10, 3, 12, 0, 0).getTime();
const day = (offset: number) => {
  const d = new Date(NOW - offset * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function report(cost: number, input: number, messages = 10): TokscaleReport {
  return {
    entries: [{ client: "claude", model: "m", provider: "anthropic", input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, messageCount: messages, cost }],
    totalInput: input, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0, totalMessages: messages, totalCost: cost,
  };
}

function row(overrides: Partial<UsageResult>): UsageResult {
  return { provider: "SYNTHETIC_FIXTURE_provider", identity, ...overrides };
}

describe("period shares", () => {
  test("all time is exactly 1, even without history", () => {
    expect(periodShare(row({}), 0, NOW)).toBe(1);
  });

  test("share is the in-window fraction of daily tokens", () => {
    const r = row({ dailyUsage: { [day(1)]: 25, [day(5)]: 25, [day(60)]: 50 } });
    expect(periodShare(r, 7, NOW)).toBe(0.5);
    expect(periodShare(r, 90, NOW)).toBe(1);
  });

  test("no daily history has no share", () => {
    expect(periodShare(row({ dailyUsage: {} }), 30, NOW)).toBeUndefined();
    expect(periodShare(row({}), 30, NOW)).toBeUndefined();
  });

  test("labels name the period", () => {
    expect(periodLabel(0)).toBe("all time");
    expect(periodLabel(30)).toBe("last 30 days");
  });
});

describe("applyPeriod", () => {
  const rows = [
    row({ report: report(100, 1000, 10), dailyUsage: { [day(1)]: 100, [day(100)]: 300 } }),
    row({ report: report(40, 400, 4), dailyUsage: { [day(200)]: 10 } }),
    row({ report: report(7, 70, 1) }),
    row({ error: "SYNTHETIC_FIXTURE_error" }),
  ];

  test("all time returns the very same rows, so totals equal the CLI TOTAL", () => {
    const { rows: shown, withoutHistory } = applyPeriod(rows, 0, NOW);
    expect(shown).toBe(rows);
    expect(withoutHistory).toBe(0);
    expect(shown.reduce((sum, r) => sum + (r.report?.totalCost ?? 0), 0)).toBe(147);
  });

  test("a period pro-rates cost, tokens and entries, and hides out-of-window series", () => {
    const { rows: shown, withoutHistory } = applyPeriod(rows, 30, NOW);
    expect(withoutHistory).toBe(1);
    expect(shown).toHaveLength(2);
    const [first, errored] = shown;
    expect(first!.report!.totalCost).toBeCloseTo(25, 9);
    expect(first!.report!.totalInput).toBeCloseTo(250, 9);
    expect(first!.report!.totalMessages).toBe(3);
    expect(first!.report!.entries[0]!.cost).toBeCloseTo(25, 9);
    expect(errored!.error).toBe("SYNTHETIC_FIXTURE_error");
  });

  test("period cost never exceeds the all-time cost", () => {
    const total = (list: UsageResult[]) => list.reduce((sum, r) => sum + (r.report?.totalCost ?? 0), 0);
    for (const since of [7, 30, 90] as const) {
      expect(total(applyPeriod(rows, since, NOW).rows)).toBeLessThanOrEqual(total(rows));
    }
  });
});
