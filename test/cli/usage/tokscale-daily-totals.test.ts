import { describe, expect, test } from "bun:test";
import { dailyUsageFromHourlyEntries, mergeDailyTotals } from "../../../src/cli/usage/tokscale.ts";

describe("exact per-day totals", () => {
  test("hourly buckets roll up per local day with every field", () => {
    const daily = dailyUsageFromHourlyEntries([
      { hour: "2026-11-01 01:00", input: 1, output: 2, cacheRead: 3, cacheWrite: 4, messageCount: 5, cost: 0.5 },
      { hour: "2026-11-01 23:00", input: 10, output: 20, cacheRead: 30, cacheWrite: 40, messageCount: 50, cost: 1.5 },
      { hour: "2026-11-02 00:00", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, messageCount: 1, cost: 2 },
    ]);
    expect(daily?.totals["2026-11-01"]).toEqual([11, 22, 33, 44, 55, 2]);
    expect(daily?.totals["2026-11-02"]).toEqual([1, 1, 0, 0, 1, 2]);
    expect(daily?.daily["2026-11-01"]).toBe(33);
  });

  test("merging adds days and keeps unmatched ones", () => {
    const merged = mergeDailyTotals({ a: [1, 1, 1, 1, 1, 1] }, { a: [1, 1, 1, 1, 1, 1], b: [2, 0, 0, 0, 0, 0] });
    expect(merged).toEqual({ a: [2, 2, 2, 2, 2, 2], b: [2, 0, 0, 0, 0, 0] });
  });
});
