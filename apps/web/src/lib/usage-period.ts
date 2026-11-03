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

function reportFromDays(result: UsageResult, since: SinceDays, nowMs: number): TokscaleReport {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, messages = 0, cost = 0;
  for (const [day, v] of Object.entries(result.dailyTotals ?? {})) {
    if (!withinSince(day, since, nowMs)) continue;
    input += v[0]; output += v[1]; cacheRead += v[2]; cacheWrite += v[3]; messages += v[4]; cost += v[5];
  }
  return { entries: [], totalInput: input, totalOutput: output, totalCacheRead: cacheRead, totalCacheWrite: cacheWrite, totalMessages: messages, totalCost: cost };
}

export interface PeriodRows {
  rows: UsageResult[];
  /** Series with a report but no exact per-day figures: they only count under "All time". */
  withoutHistory: number;
}

/** Restrict every series to the selected period by summing its exact per-day
 * figures. "All time" returns the reports untouched, so totals equal the CLI's
 * TOTAL row exactly. Nothing is estimated: a series whose source cannot split
 * by day is left out of a period view and counted in `withoutHistory`. */
export function applyPeriod(results: UsageResult[], since: SinceDays, nowMs: number = Date.now()): PeriodRows {
  if (since === 0) return { rows: results, withoutHistory: 0 };
  const rows: UsageResult[] = [];
  let withoutHistory = 0;
  for (const result of results) {
    if (!result.report) {
      rows.push(result);
      continue;
    }
    if (!result.dailyTotals || Object.keys(result.dailyTotals).length === 0) {
      withoutHistory += 1;
      continue;
    }
    const report = reportFromDays(result, since, nowMs);
    if (report.totalMessages === 0 && report.totalCost === 0 && report.totalInput === 0 && report.totalOutput === 0) continue;
    rows.push({ ...result, report });
  }
  return { rows, withoutHistory };
}
