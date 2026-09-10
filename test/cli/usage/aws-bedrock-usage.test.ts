import { describe, expect, test } from "bun:test";
import {
  AwsNoProfileMappedError,
  costExplorerWindow,
  fetchAwsBedrockUsage,
  realCostFromCostExplorer,
  REAL_COST_LABEL,
  reportFromLocalRead,
  type CostExplorerWire,
} from "../../../src/cli/usage/aws-bedrock-usage.ts";
import type { Identity } from "../../../src/identities/types.ts";
import type { LocalSpendRead } from "../../../src/shared/local-spend.ts";

function identity(name = "pcg-bedrock"): Identity {
  return { name, label: name, configDir: `/tmp/does-not-exist/${name}` };
}

/** Verbatim shape of a GetCostAndUsage response filtered to SERVICE ==
 * "Amazon Bedrock" with metric UnblendedCost (no GroupBy, so totals live in
 * Total.UnblendedCost; amounts are STRINGS). */
function costWire(buckets: Array<{ start: string; amount: string }>): CostExplorerWire {
  return {
    ResultsByTime: buckets.map(({ start, amount }) => ({
      TimePeriod: { Start: start, End: start },
      Total: { UnblendedCost: { Amount: amount, Unit: "USD" } },
    })),
  };
}

describe("costExplorerWindow", () => {
  test("spans the trailing three calendar months in UTC, end exclusive", () => {
    expect(costExplorerWindow(new Date("2026-09-10T12:00:00Z"))).toEqual({ start: "2026-07-01", end: "2026-09-11" });
    expect(costExplorerWindow(new Date("2026-01-05T00:00:00Z"))).toEqual({ start: "2025-11-01", end: "2026-01-06" });
  });
});

describe("realCostFromCostExplorer", () => {
  test("month-to-date sums only the day buckets on/after the month start; window sums the monthly buckets", () => {
    const daily = costWire([
      { start: "2026-08-30", amount: "4.00" },
      { start: "2026-09-01", amount: "0.75" },
      { start: "2026-09-05", amount: "0.25" },
    ]);
    const monthly = costWire([
      { start: "2026-08-01", amount: "5.10" },
      { start: "2026-09-01", amount: "1.00" },
    ]);
    const { monthToDateUsd, windowUsd, dailyCostUsd } = realCostFromCostExplorer(monthly, daily, "2026-09-01");
    expect(monthToDateUsd).toBeCloseTo(1.0);
    expect(windowUsd).toBeCloseTo(6.1);
    expect(dailyCostUsd).toEqual({ "2026-08-30": 4.0, "2026-09-01": 0.75, "2026-09-05": 0.25 });
  });

  test("zero buckets are skipped; everything empty yields zeros, not undefined", () => {
    const { monthToDateUsd, windowUsd, dailyCostUsd } = realCostFromCostExplorer(costWire([]), costWire([{ start: "2026-09-02", amount: "0.00" }]), "2026-09-01");
    expect(monthToDateUsd).toBe(0);
    expect(windowUsd).toBe(0);
    expect(dailyCostUsd).toEqual({});
  });
});

describe("reportFromLocalRead", () => {
  const read: LocalSpendRead = {
    usd: 2218.66,
    unknownModelUsd: 0,
    filesRead: 3,
    notes: [],
    messages: 42,
    input: 1000,
    output: 500,
    cacheRead: 2000,
    cacheWrite: 100,
    models: [
      { model: "openai.gpt-6-astra", input: 600, output: 300, cacheRead: 1200, cacheWrite: 100, messageCount: 25, usd: 2000 },
      { model: "unknown", input: 400, output: 200, cacheRead: 800, cacheWrite: 0, messageCount: 17, usd: 218.66 },
    ],
    dailyTokens: { "2026-09-09": 800, "2026-09-10": 700 },
    firstMs: Date.parse("2026-09-09T03:00:00.000Z"),
    lastMs: Date.parse("2026-09-10T23:00:00.000Z"),
  };

  test("maps token totals and per-model entries into the standard report shape, estimate as totalCost", () => {
    const report = reportFromLocalRead(read);
    expect(report.totalMessages).toBe(42);
    expect(report.totalInput).toBe(1000);
    expect(report.totalOutput).toBe(500);
    expect(report.totalCacheRead).toBe(2000);
    expect(report.totalCacheWrite).toBe(100);
    expect(report.totalCost).toBeCloseTo(2218.66, 10);
    expect(report.entries).toHaveLength(2);
    for (const entry of report.entries) {
      expect(entry.provider).toBe("aws-bedrock");
      expect(entry.reasoning).toBe(0);
    }
  });

  test("an empty read maps to the honest zero report", () => {
    const report = reportFromLocalRead({ ...read, usd: 0, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, models: [] });
    expect(report.totalCost).toBe(0);
    expect(report.entries).toEqual([]);
  });
});

describe("fetchAwsBedrockUsage", () => {
  const MAPPING_DEPS = {
    readText: (path: string): string => {
      if (path.endsWith("aws-profiles.json")) return JSON.stringify({ version: 1, identities: { "pcg-bedrock": { profile: "pcg-dev" } } });
      if (path.endsWith("config")) return "[profile pcg-dev]\nsso_account_id = 975049896933\nregion = eu-west-2\n";
      throw new Error(`unexpected path ${path}`);
    },
    awsProfilesPath: "/fixtures/aws-profiles.json",
    awsConfigPath: "/fixtures/config",
  };

  const BUDGETS_API = {
    async listBudgets() {
      return [
        {
          BudgetName: "pcg-bedrock-monthly-1000",
          BudgetType: "COST",
          TimeUnit: "MONTHLY",
          BudgetLimit: { Amount: "1000", Unit: "USD" },
          CalculatedSpend: { ActualSpend: { Amount: "0.5", Unit: "USD" } },
        },
      ];
    },
    async describeBudget() {
      return {};
    },
  };

  function ceApi(monthly: CostExplorerWire, daily: CostExplorerWire) {
    return {
      async getCostAndUsage(granularity: "DAILY" | "MONTHLY") {
        return granularity === "MONTHLY" ? monthly : daily;
      },
    };
  }

  /** Local reader stub: one month-to-date record worth a known estimate. */
  const LOCAL_READ: LocalSpendRead = {
    usd: 2218.66,
    unknownModelUsd: 0,
    filesRead: 2,
    notes: [],
    messages: 7,
    input: 1234,
    output: 567,
    cacheRead: 89,
    cacheWrite: 12,
    models: [{ model: "openai.gpt-6-astra", input: 1234, output: 567, cacheRead: 89, cacheWrite: 12, messageCount: 7, usd: 2218.66 }],
    dailyTokens: { "2026-09-09": 1801 },
    firstMs: Date.parse("2026-09-09T03:00:00.000Z"),
    lastMs: Date.parse("2026-09-09T03:00:00.000Z"),
  };
  const localSpend = () => LOCAL_READ;

  test("an unmapped identity throws the typed nothing-to-report error", async () => {
    await expect(fetchAwsBedrockUsage(identity("personal"), { awsProfileDeps: MAPPING_DEPS })).rejects.toBeInstanceOf(AwsNoProfileMappedError);
  });

  test("normal columns carry the LOCAL month-to-date figures; real AWS spend rides separately in realCost", async () => {
    const deps = {
      awsProfileDeps: MAPPING_DEPS,
      now: () => new Date("2026-09-10T12:00:00Z"),
      costExplorer: ceApi(costWire([{ start: "2026-09-01", amount: "0" }]), costWire([{ start: "2026-09-09", amount: "0" }])),
      budgets: BUDGETS_API,
      localSpend,
    };
    const { report, dateSpan, dailyUsage, dailyCostUsd, realCost } = await fetchAwsBedrockUsage(identity(), deps);
    // The estimate columns come from local tracking (reconciles with the guard).
    expect(report.totalCost).toBeCloseTo(2218.66, 10);
    expect(report.totalMessages).toBe(7);
    expect(report.totalInput).toBe(1234);
    expect(report.entries[0]?.model).toBe("openai.gpt-6-astra");
    expect(dateSpan).toEqual({ firstMs: LOCAL_READ.firstMs!, lastMs: LOCAL_READ.lastMs! });
    expect(dailyUsage).toEqual({ "2026-09-09": 1801 });
    // Real AWS cost is a separate, clearly-labelled structure, never totalCost.
    expect(realCost?.label).toBe(REAL_COST_LABEL);
    expect(realCost?.monthToDateUsd).toBe(0);
    expect(realCost?.budgetLimitUsd).toBe(1000);
    expect(realCost?.budgetActualUsd).toBeCloseTo(0.5);
    expect(realCost?.note).toBe("reported lag");
    // CE dailyCostUsd (real dollars) stays a JSON-only dimension, never dailyUsage.
    expect(dailyCostUsd).toBeUndefined(); // zero buckets are skipped
  });

  test("a Cost Explorer failure degrades into realCost.error and the local report survives intact", async () => {
    const deps = {
      awsProfileDeps: MAPPING_DEPS,
      now: () => new Date("2026-09-10T12:00:00Z"),
      costExplorer: {
        getCostAndUsage: () => Promise.reject(new Error("The SSO session has expired or is invalid")),
      },
      localSpend,
    };
    const { report, realCost } = await fetchAwsBedrockUsage(identity(), deps);
    expect(report.totalCost).toBeCloseTo(2218.66, 10);
    expect(realCost?.monthToDateUsd).toBeUndefined();
    expect(realCost?.error).toContain("aws sso login --profile pcg-dev");
    expect(realCost?.note).toBeUndefined();
  });

  test("real month-to-date slices the trailing window's daily buckets at local month start", async () => {
    const calls: Array<{ granularity: string; start: string; end: string }> = [];
    const deps = {
      awsProfileDeps: MAPPING_DEPS,
      now: () => new Date("2026-09-10T12:00:00Z"),
      costExplorer: {
        async getCostAndUsage(granularity: "DAILY" | "MONTHLY", start: string, end: string) {
          calls.push({ granularity, start, end });
          return granularity === "MONTHLY"
            ? costWire([{ start: "2026-08-01", amount: "30.00" }, { start: "2026-09-01", amount: "4.20" }])
            : costWire([{ start: "2026-08-31", amount: "30.00" }, { start: "2026-09-09", amount: "2.10" }, { start: "2026-09-10", amount: "2.10" }]);
        },
      },
      localSpend: () => ({ ...LOCAL_READ, usd: 0 }),
    };
    const { realCost, dailyCostUsd } = await fetchAwsBedrockUsage(identity(), deps);
    expect(calls).toEqual([
      { granularity: "MONTHLY", start: "2026-07-01", end: "2026-09-11" },
      { granularity: "DAILY", start: "2026-07-01", end: "2026-09-11" },
    ]);
    // Only September's daily buckets count as month-to-date; August's $30 stays window context.
    expect(realCost?.monthToDateUsd).toBeCloseTo(4.2);
    expect(realCost?.windowUsd).toBeCloseTo(34.2);
    expect(realCost?.note).toBeUndefined(); // real no longer trails the (zeroed) local estimate
    expect(dailyCostUsd).toEqual({ "2026-08-31": 30, "2026-09-09": 2.1, "2026-09-10": 2.1 });
  });

  test("a Budgets failure drops the budget context but keeps the Cost Explorer figure", async () => {
    const deps = {
      awsProfileDeps: MAPPING_DEPS,
      now: () => new Date("2026-09-10T12:00:00Z"),
      costExplorer: ceApi(costWire([{ start: "2026-09-01", amount: "1.5" }]), costWire([{ start: "2026-09-09", amount: "1.5" }])),
      budgets: {
        listBudgets: () => Promise.reject(new Error("throttled")),
        describeBudget: () => Promise.reject(new Error("throttled")),
      },
      localSpend,
    };
    const { realCost } = await fetchAwsBedrockUsage(identity(), deps);
    expect(realCost?.monthToDateUsd).toBeCloseTo(1.5);
    expect(realCost?.budgetLimitUsd).toBeUndefined();
    expect(realCost?.budgetActualUsd).toBeUndefined();
  });
});
