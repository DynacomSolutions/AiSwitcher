import { describe, expect, test } from "bun:test";
import { applyPeriod, buildBuckets, bucketKey, periodLabel, providersByTokens, type Granularity } from "../../apps/web/src/lib/usage-period.ts";
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

describe("token buckets", () => {
  // Spans a month boundary and a partial week at both ends.
  const rows = [
    row({ provider: "a", dailyUsage: { "2026-09-29": 5, "2026-10-01": 7, "2026-10-14": 11, "2026-10-31": 13, "2026-11-02": 17 } }),
    row({ provider: "b", dailyUsage: { "2026-10-01": 1, "2026-11-03": 2 } }),
  ];
  const now = new Date(2026, 10, 3, 12).getTime();
  const total = (buckets: ReturnType<typeof buildBuckets>) =>
    buckets.reduce((sum, b) => sum + Object.entries(b).reduce((s, [k, v]) => (k === "date" ? s : s + Number(v)), 0), 0);

  test("bucket keys are always full day keys", () => {
    expect(bucketKey("2026-10-14", "month")).toBe("2026-10-01");
    expect(bucketKey("2026-11-01", "week")).toBe("2026-10-26");
    expect(bucketKey("2026-11-01", "day")).toBe("2026-11-01");
  });

  for (const granularity of ["day", "week", "month"] as Granularity[]) {
    test(`${granularity} buckets sum to the daily total, all time`, () => {
      const buckets = buildBuckets(rows, granularity, 0, now);
      expect(total(buckets)).toBe(56);
      expect(buckets.every((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date))).toBe(true);
    });

    test(`${granularity} buckets sum to the daily total for the last 30 days`, () => {
      // Cutoff 2026-10-04: drops 09-29 and both 10-01 days, keeps the rest.
      const buckets = buildBuckets(rows, granularity, 30, now);
      expect(total(buckets)).toBe(11 + 13 + 17 + 2);
    });
  }

  test("monthly keeps a partial first month and shows real bars", () => {
    const buckets = buildBuckets(rows, "month", 30, now);
    expect(buckets.map((b) => b.date)).toEqual(["2026-10-01", "2026-11-01"]);
    expect(Number(buckets[0]!.a)).toBe(24);
    expect(Number(buckets[1]!.a)).toBe(17);
  });

  test("weekly includes the partial first week and zero-fills gaps", () => {
    const buckets = buildBuckets(rows, "week", 0, now);
    expect(buckets[0]!.date).toBe("2026-09-28");
    expect(Number(buckets[0]!.a)).toBe(12);
    expect(buckets.length).toBeGreaterThan(5);
  });
});

describe("cost buckets", () => {
  const t = (cost: number): [number, number, number, number, number, number] => [100, 50, 0, 0, 1, cost];
  // Provider "a" has more tokens, "b" has more cost: cost mode ranks by cost.
  const rows = [
    row({ provider: "a", dailyUsage: { "2026-10-01": 1000, "2026-10-02": 1000 }, dailyTotals: { "2026-10-01": t(0.5), "2026-10-02": t(0.25) } }),
    row({ provider: "b", dailyUsage: { "2026-10-02": 10 }, dailyTotals: { "2026-10-02": t(4) } }),
    // Tokens per day but no exact per-day totals: no cost bars, as in period totals.
    row({ provider: "c", dailyUsage: { "2026-10-03": 7 } }),
  ];
  const now = new Date(2026, 10, 3, 12).getTime();

  test("daily cost buckets stack the estimated USD by provider", () => {
    const buckets = buildBuckets(rows, "day", 0, now, "cost");
    expect(buckets.map((b) => b.date)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(Number(buckets[0]!.a)).toBe(0.5);
    expect(Number(buckets[1]!.a)).toBe(0.25);
    expect(Number(buckets[1]!.b)).toBe(4);
    expect(buckets.some((b) => "c" in b)).toBe(false);
  });

  test("monthly cost sums the per-day cost totals", () => {
    const buckets = buildBuckets(rows, "month", 0, now, "cost");
    expect(buckets).toHaveLength(1);
    expect(Number(buckets[0]!.a) + Number(buckets[0]!.b)).toBe(4.75);
  });

  test("tokens stay the default metric", () => {
    const buckets = buildBuckets(rows, "day", 0, now);
    expect(buckets.map((b) => b.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(Number(buckets[2]!.c)).toBe(7);
  });

  test("providers rank by the chosen metric", () => {
    expect(providersByTokens(rows, 0, now, "tokens")).toEqual(["a", "b", "c"]);
    expect(providersByTokens(rows, 0, now, "cost")).toEqual(["b", "a"]);
  });
});
