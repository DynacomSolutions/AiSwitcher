import { describe, expect, test } from "bun:test";
import { applyPeriod, periodLabel } from "../../apps/web/src/lib/usage-period.ts";
import type { Identity, TokscaleReport, UsageResult } from "../../apps/web/src/types/api.ts";

const identity: Identity = { name: "SYNTHETIC_FIXTURE_identity", label: "SYNTHETIC_FIXTURE_identity", configDir: "SYNTHETIC_FIXTURE_dir" };
// Noon local time, so the local calendar day is unambiguous in any timezone.
const NOW = new Date(2026, 10, 3, 12, 0, 0).getTime();
const day = (offset: number) => {
  const d = new Date(NOW - offset * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function report(cost: number, input: number, messages = 10): TokscaleReport {
  return { entries: [], totalInput: input, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0, totalMessages: messages, totalCost: cost };
}
function row(overrides: Partial<UsageResult>): UsageResult {
  return { provider: "SYNTHETIC_FIXTURE_provider", identity, ...overrides };
}

describe("period labels", () => {
  test("name the period", () => {
    expect(periodLabel(0)).toBe("all time");
    expect(periodLabel(30)).toBe("last 30 days");
  });
});

describe("applyPeriod", () => {
  const rows = [
    row({ report: report(150, 1000, 10), dailyTotals: { [day(1)]: [100, 5, 7, 3, 2, 50], [day(5)]: [100, 5, 0, 0, 1, 10], [day(100)]: [800, 0, 0, 0, 7, 90] } }),
    row({ report: report(40, 400, 4), dailyTotals: { [day(200)]: [400, 0, 0, 0, 4, 40] } }),
    row({ report: report(7, 70, 1) }),
    row({ error: "SYNTHETIC_FIXTURE_error" }),
  ];

  test("all time returns the very same rows, so totals equal the CLI TOTAL", () => {
    const { rows: shown, withoutHistory } = applyPeriod(rows, 0, NOW);
    expect(shown).toBe(rows);
    expect(withoutHistory).toBe(0);
  });

  test("a period is the exact sum of the in-window days", () => {
    const { rows: shown, withoutHistory } = applyPeriod(rows, 30, NOW);
    expect(withoutHistory).toBe(1);
    expect(shown).toHaveLength(2);
    const r = shown[0]!.report!;
    expect(r.totalCost).toBe(60);
    expect(r.totalInput).toBe(200);
    expect(r.totalOutput).toBe(10);
    expect(r.totalCacheRead).toBe(7);
    expect(r.totalCacheWrite).toBe(3);
    expect(r.totalMessages).toBe(3);
    expect(shown[1]!.error).toBe("SYNTHETIC_FIXTURE_error");
  });

  test("a series with no activity in the period is hidden", () => {
    expect(applyPeriod([rows[1]!], 90, NOW).rows).toHaveLength(0);
  });
});
