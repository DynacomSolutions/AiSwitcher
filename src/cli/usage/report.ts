import { bold, dim, gray, yellow } from "../colors.ts";
import type { OverageInfo } from "../limits/types.ts";
import { borderRow, padRow } from "../table.ts";
import { renderContributionGraph } from "./contribution-graph.ts";
import { calendarDayCount } from "./local-day.ts";
import { usageProviderLabel } from "./providers.ts";
import type { DateSpan } from "./tokscale.ts";
import type { UsageResult } from "./run.ts";

const HEADERS = ["PROVIDER", "IDENTITY", "MESSAGES", "INPUT", "OUTPUT", "CACHE READ", "EST. COST", "EXTRA COST"];
const NUMERIC_COLUMNS = new Set([2, 3, 4, 5, 6, 7]);

function formatNumber(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Comma-grouped, always 2 decimal places — matches formatNumber's
 * toLocaleString convention so a cost over $1,000 doesn't read as a
 * different, ungrouped species of number from every other column. */
function formatCost(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** EXTRA COST is a strict binary in this report: zero, or not zero — no
 * third "we don't know" state (deliberately collapsed after direct feedback
 * that a separate "no data" dash wasn't useful). No info at all (grok/zai,
 * which never have an overage mechanism at all, or a failed live probe for
 * claude/codex/kimi) reads as $0.00, same as a source-confirmed zero — there
 * is no evidence of spending either way, so it's shown as none. A known
 * positive dollar figure (kimi) shows that number; a confirmed-nonzero
 * status with no known figure (claude "using extra usage", codex "credits
 * depleted", etc.) shows its label, since fabricating a number would be
 * worse than showing text. The full-fidelity distinction (confirmed zero vs.
 * no data vs. not supported) still exists in OverageInfo/`--json` output for
 * anything that wants it — only this plain-text formatting collapses it. */
function formatExtraCost(info: OverageInfo | undefined): string {
  if (!info || typeof info.spentUsd === "number") return formatCost(info?.spentUsd ?? 0);
  return info.label;
}

function successRow(result: UsageResult): string[] {
  const r = result.report!;
  return [
    usageProviderLabel(result.provider),
    result.identity.name,
    formatNumber(r.totalMessages),
    formatNumber(r.totalInput),
    formatNumber(r.totalOutput),
    formatNumber(r.totalCacheRead),
    formatCost(r.totalCost),
    formatExtraCost(result.extraCost),
  ];
}

function errorRow(result: UsageResult): string[] {
  // extraCost can still be populated on an otherwise-failed row — the
  // live overage probe and the local-log tokscale fetch run independently
  // (see usage/run.ts's runOne), so a tokscale failure doesn't imply the
  // overage probe also failed.
  return [usageProviderLabel(result.provider), result.identity.name, "—", "—", "—", "—", "error", formatExtraCost(result.extraCost)];
}

function pendingRow(result: UsageResult, spinnerFrame: string): string[] {
  return [usageProviderLabel(result.provider), result.identity.name, "—", "—", "—", "—", `${spinnerFrame} loading…`, "—"];
}

interface Totals {
  messages: number;
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
  extraCost: number;
}

/** Extracted from the old totalRow so the date-range/averages section below
 * can reuse the same summed figures instead of re-deriving them — computed
 * once regardless of whether the TOTAL row itself ends up rendered (a
 * single-identity report has no TOTAL row but still gets an averages
 * section off these same totals). */
function computeTotals(successes: UsageResult[]): Totals {
  return successes.reduce(
    (acc, r) => {
      const rep = r.report!;
      acc.messages += rep.totalMessages;
      acc.input += rep.totalInput;
      acc.output += rep.totalOutput;
      acc.cacheRead += rep.totalCacheRead;
      acc.cost += rep.totalCost;
      if (typeof r.extraCost?.spentUsd === "number") acc.extraCost += r.extraCost.spentUsd;
      return acc;
    },
    { messages: 0, input: 0, output: 0, cacheRead: 0, cost: 0, extraCost: 0 },
  );
}

function totalRow(totals: Totals): string[] {
  return [
    "",
    "TOTAL",
    formatNumber(totals.messages),
    formatNumber(totals.input),
    formatNumber(totals.output),
    formatNumber(totals.cacheRead),
    formatCost(totals.cost),
    formatCost(totals.extraCost),
  ];
}

/** Same column shape as totalRow, but every figure divided by `divisor` —
 * feeds the AVG/HOUR, AVG/DAY, AVG/MONTH rows appended after TOTAL, rather
 * than a separate plain-text summary below the table. */
function avgRow(label: string, totals: Totals, divisor: number): string[] {
  return [
    "",
    label,
    formatNumber(totals.messages / divisor),
    formatNumber(totals.input / divisor),
    formatNumber(totals.output / divisor),
    formatNumber(totals.cacheRead / divisor),
    formatCost(totals.cost / divisor),
    formatCost(totals.extraCost / divisor),
  ];
}

/** Every result's own dateSpan (see run.ts's UsageResult.dateSpan doc)
 * folded into one overall first-seen/last-seen across every provider/identity
 * queried — results with no dateSpan (a failed probe, a tool with no
 * history yet) simply don't widen the range, same as how a failed row
 * doesn't contribute to computeTotals above. Since run.ts's runOne only
 * ever attaches dateSpan alongside a successful report, this never widens
 * the range using a row whose usage isn't also counted in computeTotals. */
function combinedDateSpan(results: UsageResult[]): DateSpan | undefined {
  let firstMs: number | undefined;
  let lastMs: number | undefined;
  for (const r of results) {
    if (!r.dateSpan) continue;
    firstMs = firstMs === undefined ? r.dateSpan.firstMs : Math.min(firstMs, r.dateSpan.firstMs);
    lastMs = lastMs === undefined ? r.dateSpan.lastMs : Math.max(lastMs, r.dateSpan.lastMs);
  }
  return firstMs !== undefined && lastMs !== undefined ? { firstMs, lastMs } : undefined;
}

/** Every result's own dailyUsage (see run.ts's doc — only ever the four
 * tokscale-backed tools) summed by local date, for
 * contribution-graph.ts's week grid. */
function combinedDailyUsage(results: UsageResult[]): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const r of results) {
    if (!r.dailyUsage) continue;
    for (const [day, tokens] of Object.entries(r.dailyUsage)) merged[day] = (merged[day] ?? 0) + tokens;
  }
  return merged;
}

const HOUR_MS = 60 * 60 * 1000;
/** Average Gregorian month length (365.2425 / 12) — a rough per-month
 * rate, not meant to land on any specific calendar month's real length. */
const AVG_MONTH_DAYS = 30.4368;

function formatDateRange(span: DateSpan): string {
  const fmt = (ms: number) => new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  // Calendar-day count, not raw elapsed-ms/24h rounded — a span confined to
  // one calendar day but close to 24h wall-clock (e.g. 00:01 to 23:59)
  // would otherwise round up to "2 days".
  const days = calendarDayCount(span.firstMs, span.lastMs);
  return `Tracking usage from ${fmt(span.firstMs)} to ${fmt(span.lastMs)} (${formatNumber(days)} day${days === 1 ? "" : "s"})`;
}

/** Floored at 1 hour so a span with everything in one hourly bucket (or a
 * zai identity with a single session) doesn't divide by a near-zero
 * elapsed time and blow the averages up to a meaningless figure. */
function elapsedUnits(span: DateSpan): { hours: number; days: number; months: number } {
  const hours = Math.max(1, (span.lastMs - span.firstMs) / HOUR_MS);
  const days = hours / 24;
  const months = days / AVG_MONTH_DAYS;
  return { hours, days, months };
}

function avgRows(totals: Totals, span: DateSpan): string[][] {
  const { hours, days, months } = elapsedUnits(span);
  return [avgRow("AVG/HOUR", totals, hours), avgRow("AVG/DAY", totals, days), avgRow("AVG/MONTH", totals, months)];
}

/** Renders a table of one row per (provider, identity), using each
 * result's own pre-aggregated totals (totalMessages/totalInput/... ) rather
 * than summing per-model `entries` ourselves — the source (tokscale for
 * four tools, this project's own zai-usage.ts for zai) already did that
 * math. Failed queries (tokscale not reachable, bad session data, etc.)
 * print as a placeholder row plus full detail in a trailing "Errors"
 * section, rather than aborting the whole report over one bad identity. */
export function formatUsageReport(results: UsageResult[], spinnerFrame = "⠋"): string {
  if (results.length === 0) return dim("No matching identities found.");

  // successes/errors both naturally exclude pending rows: a pending result
  // has neither `.report` nor `.error` set yet, so the TOTAL row and the
  // trailing "Errors:" section fill in progressively as real results land,
  // same as limits/report.ts's aggregate rollups do for its own live mode.
  // sourceOnlyError results render NO table row (a fabricated "Unattributed"
  // row is pseudo-provider output) — they appear only in the Errors footer
  // under their SOURCE label, so the table rows' indices are built from the
  // filtered list.
  const tableResults = results.filter((r) => !r.sourceOnlyError);
  const successes = results.filter((r) => r.report);
  const rows = tableResults.map((r) => (r.pending ? pendingRow(r, spinnerFrame) : r.report ? successRow(r) : errorRow(r)));
  const totals = successes.length > 0 ? computeTotals(successes) : undefined;
  const total = successes.length > 1 && totals ? totalRow(totals) : undefined;
  const span = totals ? combinedDateSpan(results) : undefined;
  const avgs = totals && span ? avgRows(totals, span) : [];

  const widthRows = [...rows, ...(total ? [total] : []), ...avgs];
  const widths = HEADERS.map((h, i) => Math.max(h.length, ...widthRows.map((row) => row[i]!.length)));
  const tableWidth = borderRow(widths, "┌", "┬", "┐").length;

  const lines: string[] = [];
  if (span) {
    lines.push(dim(formatDateRange(span)));
    const daily = combinedDailyUsage(results);
    if (Object.keys(daily).length > 0) {
      const graph = renderContributionGraph(daily, span, tableWidth);
      if (graph) {
        lines.push(...graph.lines.map((l) => dim(l)));
        if (graph.droppedWeeks > 0) {
          lines.push(dim(`(showing the most recent weeks that fit — ${graph.droppedWeeks} earlier week${graph.droppedWeeks === 1 ? "" : "s"} not shown)`));
        }
      }
    }
    lines.push("");
  }

  lines.push(
    borderRow(widths, "┌", "┬", "┐"),
    bold(padRow(HEADERS, widths, NUMERIC_COLUMNS)),
    borderRow(widths, "├", "┼", "┤"),
    ...rows.map((row, i) =>
      tableResults[i]!.pending
        ? dim(padRow(row, widths, NUMERIC_COLUMNS))
        : tableResults[i]!.error && !tableResults[i]!.report
          ? yellow(padRow(row, widths, NUMERIC_COLUMNS))
          : padRow(row, widths, NUMERIC_COLUMNS),
    ),
  );
  if (total) {
    lines.push(borderRow(widths, "├", "┼", "┤"));
    lines.push(gray(padRow(total, widths, NUMERIC_COLUMNS)));
  }
  if (avgs.length > 0) {
    lines.push(borderRow(widths, "├", "┼", "┤"));
    for (const row of avgs) lines.push(dim(padRow(row, widths, NUMERIC_COLUMNS)));
  }
  lines.push(borderRow(widths, "└", "┴", "┘"));

  const errors = results.filter((r) => r.error);
  if (errors.length > 0) {
    lines.push("");
    lines.push(bold("Errors:"));
    // Source-only failures are labelled by their SOURCE (pi/dynacom), never
    // by a fabricated provider — the whole point of keeping them out of the
    // table.
    for (const r of errors) {
      const label = r.sourceOnlyError && r.sourceTool ? `${r.sourceTool}/${r.identity.name}` : `${usageProviderLabel(r.provider)}/${r.identity.name}`;
      lines.push(`  ${yellow(label)}: ${r.error}`);
    }
  }

  return lines.join("\n");
}
