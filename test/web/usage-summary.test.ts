import { describe, expect, test } from "bun:test";
import {
  classifyUsageError,
  formatUsageResponseTime,
  hasPartialUsageCoverage,
  isInitialUsageScanPending,
  summarizeUsageSources,
  usageErrorLabel,
  usageFreshness,
} from "../../apps/web/src/lib/usage-summary.ts";
import type { Identity, UsageResult } from "../../apps/web/src/types/api.ts";

const identity: Identity = {
  name: "SYNTHETIC_FIXTURE_identity",
  label: "SYNTHETIC_FIXTURE_identity",
  configDir: "SYNTHETIC_FIXTURE_config_dir",
};

function result(overrides: Partial<UsageResult> = {}): UsageResult {
  return {
    provider: "SYNTHETIC_FIXTURE_provider",
    identity,
    ...overrides,
  };
}

function report(totalCost: number, tokens = 0): NonNullable<UsageResult["report"]> {
  return {
    entries: [],
    totalInput: tokens,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalMessages: 0,
    totalCost,
  };
}

describe("usage summary metadata", () => {
  test("counts safe source statuses and only reports missing history when other sources have daily coverage", () => {
    const summary = summarizeUsageSources([
      result({ report: report(1.25, 100), dailyUsage: { "2026-10-20": 100 } }),
      result({ error: "SYNTHETIC_FIXTURE_error" }),
      result({ pending: true }),
      result({ report: report(0, 500) }),
      result({ report: report(0) }),
    ]);

    expect(summary).toEqual({ sources: 5, errors: 1, pending: 1, historyUnavailable: 2 });
  });

  test("does not claim missing history or unpriced usage before any daily coverage exists", () => {
    const summary = summarizeUsageSources([
      result({ report: report(0, 500) }),
      result({ report: report(1.25, 100) }),
    ]);

    expect(summary).toEqual({ sources: 2, errors: 0, pending: 0, historyUnavailable: 0 });
  });

  test("classifies source failures into bounded labels without exposing arbitrary error details", () => {
    const cases = [
      ["tokscale timed out after 20s at /private/path", "timeout", "Source timed out"],
      ["process exited with code 1: /private/path", "process-failure", "Source process failed"],
      ["explicit out of memory failure at /private/path", "out-of-memory", "Source ran out of memory"],
      ["pricing unavailable for model secret-model", "unpriced", "Pricing unavailable"],
      ["source unavailable at /private/path", "unavailable", "Source unavailable"],
      ["arbitrary secret /private/path", "source-error", "Source error"],
    ] as const;

    for (const [error, kind, label] of cases) {
      expect(classifyUsageError(error)).toBe(kind);
      expect(usageErrorLabel(classifyUsageError(error))).toBe(label);
      expect(usageErrorLabel(classifyUsageError(error))).not.toContain("/private/path");
    }
  });

  test("shows loading only while the initial scan is pending without results", () => {
    expect(isInitialUsageScanPending({ pending: true, results: [] })).toBe(true);
    expect(isInitialUsageScanPending({ pending: true, results: [result({ report: report(0) })] })).toBe(false);
    expect(isInitialUsageScanPending(undefined)).toBe(false);
  });

  test("keeps source failures in partial coverage when the date-filtered series omits them", () => {
    const results = [
      result({ provider: "selected", sourceTool: "claude", report: report(1), dailyUsage: { "2020-01-01": 10 } }),
      result({ provider: "selected", sourceTool: "codex", error: "timed out" }),
      result({ provider: "other", sourceTool: "claude", error: "timed out" }),
    ];

    expect(hasPartialUsageCoverage(results, { provider: "selected", tool: "all", identity: "all" })).toBe(true);
    expect(hasPartialUsageCoverage(results, { provider: "selected", tool: "claude", identity: "all" })).toBe(false);
  });

  test("formats valid generated timestamps and ignores invalid or absent timestamps", () => {
    expect(formatUsageResponseTime("2026-10-23T05:30:00.000Z")).toContain("2026");
    expect(formatUsageResponseTime("not-a-date")).toBeUndefined();
    expect(formatUsageResponseTime(undefined)).toBeUndefined();
  });

  test("reports a server refresh failure without exposing its error text", () => {
    expect(usageFreshness({
      stale: true,
      lastError: "SYNTHETIC_FIXTURE_private_error_text",
      lastErrorAt: "2026-10-23T05:30:00.000Z",
    })).toEqual({
      stale: true,
      refreshFailed: true,
      lastErrorAt: "2026-10-23T05:30:00.000Z",
    });
  });

  test("distinguishes an active stale refresh from a failed client refresh", () => {
    expect(usageFreshness({ stale: true })).toEqual({ stale: true, refreshFailed: false });
    expect(usageFreshness(undefined, true)).toEqual({ stale: true, refreshFailed: true });
    expect(usageFreshness({ stale: false })).toEqual({ stale: false, refreshFailed: false });
  });
});
