import { describe, expect, test } from "bun:test";
import {
  AwsNoProfileMappedError,
  costExplorerWindow,
  fetchAwsBedrockUsage,
  reportFromCostExplorer,
  type CostExplorerWire,
} from "../../../src/cli/usage/aws-bedrock-usage.ts";
import type { Identity } from "../../../src/identities/types.ts";

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

describe("reportFromCostExplorer", () => {
  test("maps monthly buckets to zero-token, real-cost entries and the total", () => {
    const monthly = costWire([
      { start: "2026-07-01", amount: "12.34" },
      { start: "2026-08-01", amount: "8.00" },
      { start: "2026-09-01", amount: "5.25" },
    ]);
    const { report, dateSpan } = reportFromCostExplorer(monthly, costWire([{ start: "2026-09-05", amount: "1.5" }]));
    expect(report.totalCost).toBeCloseTo(25.59);
    expect(report.totalInput).toBe(0);
    expect(report.totalMessages).toBe(0);
    expect(report.entries.map((e) => [e.model, e.cost])).toEqual([
      ["2026-07", 12.34],
      ["2026-08", 8.0],
      ["2026-09", 5.25],
    ]);
    for (const entry of report.entries) {
      expect(entry.provider).toBe("aws-bedrock");
      expect(entry.input).toBe(0);
      expect(entry.output).toBe(0);
      expect(entry.messageCount).toBe(0);
    }
    // Date span follows the days that actually had spend, not the window.
    expect(dateSpan).toEqual({ firstMs: Date.parse("2026-09-05T00:00:00Z"), lastMs: Date.parse("2026-09-05T23:59:59Z") });
  });

  test("daily buckets feed dailyCostUsd (UTC day keys), never dailyUsage", () => {
    const daily = costWire([
      { start: "2026-09-04", amount: "0.75" },
      { start: "2026-09-05", amount: "0.25" },
    ]);
    const { dailyCostUsd, report } = reportFromCostExplorer(costWire([]), daily);
    expect(dailyCostUsd).toEqual({ "2026-09-04": 0.75, "2026-09-05": 0.25 });
    expect("dailyUsage" in report).toBe(false);
  });

  test("zero buckets are skipped on both granularities", () => {
    const { report, dailyCostUsd, dateSpan } = reportFromCostExplorer(
      costWire([
        { start: "2026-07-01", amount: "0" },
        { start: "2026-08-01", amount: "3.10" },
      ]),
      costWire([
        { start: "2026-08-02", amount: "0.00" },
        { start: "2026-08-03", amount: "1.00" },
      ]),
    );
    expect(report.totalCost).toBeCloseTo(3.1);
    expect(dailyCostUsd).toEqual({ "2026-08-03": 1 });
    expect(dateSpan).toEqual({ firstMs: Date.parse("2026-08-03T00:00:00Z"), lastMs: Date.parse("2026-08-03T23:59:59Z") });
  });

  test("completely empty responses yield a zero report with no span and no daily costs", () => {
    const { report, dailyCostUsd, dateSpan } = reportFromCostExplorer({}, {});
    expect(report.totalCost).toBe(0);
    expect(report.entries).toEqual([]);
    expect(dailyCostUsd).toBeUndefined();
    expect(dateSpan).toBeUndefined();
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

  test("an unmapped identity throws the typed nothing-to-report error", async () => {
    await expect(fetchAwsBedrockUsage(identity("personal"), { awsProfileDeps: MAPPING_DEPS })).rejects.toBeInstanceOf(AwsNoProfileMappedError);
  });

  test("SSO expiry is reworded into the exact fix, never a raw SDK line", async () => {
    const deps = {
      awsProfileDeps: MAPPING_DEPS,
      costExplorer: {
        getCostAndUsage: () => Promise.reject(new Error("The SSO session has expired or is invalid")),
      },
    };
    await expect(fetchAwsBedrockUsage(identity(), deps)).rejects.toThrow("aws sso login --profile pcg-dev");
  });

  test("queries both granularities over the same window and maps the responses", async () => {
    const calls: Array<{ granularity: string; start: string; end: string }> = [];
    const deps = {
      awsProfileDeps: MAPPING_DEPS,
      now: () => new Date("2026-09-10T12:00:00Z"),
      costExplorer: {
        async getCostAndUsage(granularity: "DAILY" | "MONTHLY", start: string, end: string) {
          calls.push({ granularity, start, end });
          return granularity === "MONTHLY"
            ? costWire([{ start: "2026-09-01", amount: "4.2" }])
            : costWire([{ start: "2026-09-09", amount: "2.1" }]);
        },
      },
    };
    const { report, dateSpan, dailyCostUsd } = await fetchAwsBedrockUsage(identity(), deps);
    expect(calls).toEqual([
      { granularity: "MONTHLY", start: "2026-07-01", end: "2026-09-11" },
      { granularity: "DAILY", start: "2026-07-01", end: "2026-09-11" },
    ]);
    expect(report.totalCost).toBeCloseTo(4.2);
    expect(dailyCostUsd).toEqual({ "2026-09-09": 2.1 });
    expect(dateSpan).toEqual({ firstMs: Date.parse("2026-09-09T00:00:00Z"), lastMs: Date.parse("2026-09-09T23:59:59Z") });
  });
});
