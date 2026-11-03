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

export type Granularity = "day" | "week" | "month";

export interface Bucket {
  [key: string]: string | number;
  date: string;
}

function parseDay(dateKey: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

/** Full "YYYY-MM-DD" key of the bucket a day belongs to: the day itself, its
 * Monday, or the first of its month. Always a day key, so bucket keys and the
 * dense axis built from them compare equal. */
export function bucketKey(dateKey: string, granularity: Granularity): string {
  if (granularity === "day") return dateKey;
  const date = parseDay(dateKey);
  if (Number.isNaN(date.getTime())) return dateKey;
  if (granularity === "month") return `${dateKey.slice(0, 7)}-01`;
  const sinceMonday = (date.getDay() + 6) % 7;
  return formatDateMs(new Date(date.getFullYear(), date.getMonth(), date.getDate() - sinceMonday).getTime());
}

/** Providers with in-period tokens, biggest first. */
export function providersByTokens(results: UsageResult[], since: SinceDays, nowMs: number = Date.now()): string[] {
  const totals = new Map<string, number>();
  for (const result of results) {
    for (const [date, tokens] of Object.entries(result.dailyUsage ?? {})) {
      if (!withinSince(date, since, nowMs)) continue;
      totals.set(result.provider, (totals.get(result.provider) ?? 0) + tokens);
    }
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([provider]) => provider);
}

/** Per-bucket token totals (input plus output) stacked by the five biggest
 * providers, the rest in "other". Buckets are padded with zeros between the
 * first and last active bucket, and a partial first or last week or month is
 * included in full for the days inside the period. */
export function buildBuckets(results: UsageResult[], granularity: Granularity, since: SinceDays, nowMs: number = Date.now()): Bucket[] {
  const perProvider = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  for (const result of results) {
    for (const [date, tokens] of Object.entries(result.dailyUsage ?? {})) {
      if (!withinSince(date, since, nowMs)) continue;
      const key = bucketKey(date, granularity);
      let series = perProvider.get(result.provider);
      if (!series) perProvider.set(result.provider, (series = new Map()));
      series.set(key, (series.get(key) ?? 0) + tokens);
      totals.set(key, (totals.get(key) ?? 0) + tokens);
    }
  }
  if (totals.size === 0) return [];
  const keys = [...totals.keys()].sort();
  const top = new Set(providersByTokens(results, since, nowMs).slice(0, 5));

  const dense: string[] = [];
  const cursor = parseDay(keys[0]!);
  const last = parseDay(keys[keys.length - 1]!);
  while (cursor <= last && dense.length < 800) {
    dense.push(formatDateMs(cursor.getTime()));
    if (granularity === "month") cursor.setMonth(cursor.getMonth() + 1);
    else cursor.setDate(cursor.getDate() + (granularity === "week" ? 7 : 1));
  }

  return dense.map((date) => {
    const bucket: Bucket = { date };
    let covered = 0;
    for (const [provider, series] of perProvider) {
      if (!top.has(provider)) continue;
      const value = series.get(date) ?? 0;
      bucket[provider] = value;
      covered += value;
    }
    bucket.other = Math.max(0, (totals.get(date) ?? 0) - covered);
    return bucket;
  });
}
