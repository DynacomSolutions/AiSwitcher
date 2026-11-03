import { formatDateMs } from "./format";
import type { TokscaleReport, UsageResult } from "../types/api";

export type SinceDays = 7 | 30 | 90 | 0;

/** Local calendar day on or after the cutoff for the period, or every day for "All time". */
export function withinSince(dateKey: string, since: SinceDays, nowMs: number = Date.now()): boolean {
  if (since === 0) return true;
  return dateKey >= formatDateMs(nowMs - since * 86_400_000);
}

/** Human label for a period, used in card and column headings. */
export function periodLabel(since: SinceDays): string {
  return since === 0 ? "all time" : `last ${since} days`;
}

/** Share of a series' tokens (input plus output, the only per-day figure the API
 * carries) that falls inside the period. "All time" is exactly 1. A series with
 * no daily history cannot be placed in a period, so it has no share. */
export function periodShare(result: UsageResult, since: SinceDays, nowMs: number = Date.now()): number | undefined {
  if (since === 0) return 1;
  const days = Object.entries(result.dailyUsage ?? {});
  let total = 0;
  let inside = 0;
  for (const [day, tokens] of days) {
    total += tokens;
    if (withinSince(day, since, nowMs)) inside += tokens;
  }
  if (total <= 0) return undefined;
  return Math.min(1, inside / total);
}

function scaleReport(report: TokscaleReport, share: number): TokscaleReport {
  if (share === 1) return report;
  return {
    entries: report.entries.map((entry) => ({
      ...entry,
      input: entry.input * share,
      output: entry.output * share,
      cacheRead: entry.cacheRead * share,
      cacheWrite: entry.cacheWrite * share,
      reasoning: entry.reasoning * share,
      messageCount: Math.round(entry.messageCount * share),
      cost: entry.cost * share,
    })),
    totalInput: report.totalInput * share,
    totalOutput: report.totalOutput * share,
    totalCacheRead: report.totalCacheRead * share,
    totalCacheWrite: report.totalCacheWrite * share,
    totalMessages: Math.round(report.totalMessages * share),
    totalCost: report.totalCost * share,
  };
}

export interface PeriodRows {
  rows: UsageResult[];
  /** Series with a report but no daily history: they only count under "All time". */
  withoutHistory: number;
}

/** Restrict every series' report to the selected period. The API reports cost
 * and token counts for a series' whole history and only the input plus output
 * tokens per day, so a period figure is the all-time figure pro-rated by the
 * series' in-period share of those daily tokens. "All time" returns the
 * reports untouched, so totals equal the CLI's TOTAL row exactly. */
export function applyPeriod(results: UsageResult[], since: SinceDays, nowMs: number = Date.now()): PeriodRows {
  if (since === 0) return { rows: results, withoutHistory: 0 };
  const rows: UsageResult[] = [];
  let withoutHistory = 0;
  for (const result of results) {
    if (!result.report) {
      rows.push(result);
      continue;
    }
    const share = periodShare(result, since, nowMs);
    if (share === undefined) {
      withoutHistory += 1;
      continue;
    }
    if (share === 0) continue;
    rows.push({ ...result, report: scaleReport(result.report, share) });
  }
  return { rows, withoutHistory };
}
