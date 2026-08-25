/** Shared local-calendar-day helpers for usage/report.ts's date-range text
 * and usage/contribution-graph.ts's week grid — both need "which calendar
 * day does this ms timestamp fall on, in the timezone this machine (and
 * tokscale's own `hour` bucket keys — see tokscale.ts) already uses" rather
 * than a raw elapsed-ms/24h calculation, which drifts from the actual
 * calendar day whenever the timestamps aren't exact UTC-midnight-aligned
 * multiples (true for essentially all real activity timestamps, and for any
 * machine not running in UTC). */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Local midnight (00:00:00.000) of the calendar day `ms` falls on. */
export function startOfLocalDay(ms: number): Date {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** "YYYY-MM-DD" in local time — matches the date portion of tokscale's own
 * `hour` bucket keys (see tokscale.ts's fetchTokscaleDailyUsage doc) so the
 * two can be joined/merged by plain string equality. */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Inclusive count of distinct calendar days a [firstMs, lastMs] span
 * touches — e.g. 10:00 Monday to 14:00 Monday is 1 day, not 0 or a
 * fractional value rounded up from raw elapsed hours. */
export function calendarDayCount(firstMs: number, lastMs: number): number {
  const start = startOfLocalDay(firstMs).getTime();
  const end = startOfLocalDay(lastMs).getTime();
  return Math.round((end - start) / DAY_MS) + 1;
}
