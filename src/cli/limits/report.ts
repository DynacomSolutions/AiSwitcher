import { bold, dim, gray } from "../colors.ts";
import { canonicalUsageProvider, usageProviderLabel } from "../usage/providers.ts";
import { renderBar, staleSuffix } from "./bar.ts";
import type { LimitCategory, ToolLimitResult } from "./types.ts";

const BRANCH = "├── ";
const BRANCH_LAST = "└── ";
// Aggregate rows hang directly off the provider header, before any identity
// branch — narrower than an identity's own detail-row indent so the two
// visually read as different nesting depths.
const AGGREGATE_INDENT = "│   ";
const DETAIL_INDENT = "│     ";
const DETAIL_INDENT_LAST = "      ";
const GAP = 4;

const CATEGORY_ORDER: LimitCategory[] = ["session", "week", "month", "other"];

interface Row {
  indent: string;
  label: string;
  usedPercent?: number;
  resetsAt?: string;
  note?: string;
  capturedAt?: string;
  /** Set instead of usedPercent for a no-bar row (e.g. "not authenticated") — rendered dim, no bracket. */
  plain?: string;
}

function pluralizeCategory(category: LimitCategory): string {
  return category === "session" ? "sessions" : category;
}

function identityCount(n: number): string {
  return n === 1 ? "1 identity" : `${n} identities`;
}

/** Average usedPercent per category, across every window with that category
 * anywhere in the given results (i.e. every sub-item actually listed under
 * the group being rolled up — an identity contributing two "week" windows,
 * e.g. Claude's "week (all)" and "week (Fable)", counts as two data points,
 * not one). Only categories with at least one real data point are included
 * — never a fabricated zero row for a category nothing reported. */
export function aggregateAverage(results: ToolLimitResult[]): Array<{ category: LimitCategory; usedPercent: number }> {
  const totals = new Map<LimitCategory, { sum: number; count: number }>();
  for (const r of results) {
    for (const w of r.windows) {
      const entry = totals.get(w.category) ?? { sum: 0, count: 0 };
      entry.sum += w.usedPercent;
      entry.count += 1;
      totals.set(w.category, entry);
    }
  }
  return CATEGORY_ORDER.filter((c) => totals.has(c)).map((category) => {
    const { sum, count } = totals.get(category)!;
    return { category, usedPercent: sum / count };
  });
}

function buildTotalRows(results: ToolLimitResult[]): Row[] {
  return aggregateAverage(results).map(({ category, usedPercent }) => ({ indent: "", label: pluralizeCategory(category), usedPercent }));
}

function buildAggregateRows(results: ToolLimitResult[]): Row[] {
  return aggregateAverage(results).map(({ category, usedPercent }) => ({
    indent: AGGREGATE_INDENT,
    label: pluralizeCategory(category),
    usedPercent,
  }));
}

function buildIdentityBlock(result: ToolLimitResult, isLast: boolean, spinnerFrame: string): { branch: string; rows: Row[] } {
  const connector = isLast ? BRANCH_LAST : BRANCH;
  const continuation = isLast ? DETAIL_INDENT_LAST : DETAIL_INDENT;
  const branch = `${connector}${bold(result.identity.name)}  ${dim(`(${result.identity.label})`)}`;

  if (result.status === "pending") {
    return { branch, rows: [{ indent: continuation, label: "", plain: `${spinnerFrame} loading…` }] };
  }
  if (result.status === "unavailable" || result.windows.length === 0) {
    return { branch, rows: [{ indent: continuation, label: "", plain: result.error ?? "no data" }] };
  }

  const rows: Row[] = result.windows.map((w) => ({
    indent: continuation,
    label: w.label,
    usedPercent: w.usedPercent,
    resetsAt: w.resetsAt,
    note: w.note,
    capturedAt: result.capturedAt,
  }));
  return { branch, rows };
}

function renderRow(row: Row, prefixWidth: number, now: Date): string {
  if (row.plain !== undefined) return `${row.indent}${gray(row.plain)}`;

  const { bar, pct } = renderBar(row.usedPercent!);
  const pad = " ".repeat(Math.max(1, prefixWidth - row.indent.length - row.label.length));
  let line = `${row.indent}${row.label}${pad}${bar} ${pct}`;

  const extras: string[] = [];
  if (row.resetsAt) extras.push(`resets ${row.resetsAt}`);
  if (row.note) extras.push(row.note);
  if (extras.length) line += `  ${extras.join("  ")}`;

  const stale = staleSuffix(row.capturedAt, now);
  if (stale) line += `  ${stale}`;

  return line;
}

/** Renders the full tree: an unlabeled TOTAL rollup at the top (session/week/
 * month, averaged across every provider and identity), then one section per
 * PROVIDER — its own rollup hanging directly off the header, then one branch
 * per identity with that provider's actual windows underneath. Provider is
 * the grouping key, not the tool: a multi-provider client (pi, opencode)
 * contributes rows to the same Anthropic/Z.ai/... sections its native-tool
 * counterparts do, and collect.ts's aggregation has already merged any
 * duplicate provider+identity answers into one branch before this renders.
 * Every bar in the whole report shares one bracket column, computed
 * dynamically (like usage/report.ts's own column-width convention) rather
 * than a hardcoded width, so it stays correct as label text changes. */
export function formatLimitsReport(results: ToolLimitResult[], now: Date = new Date(), spinnerFrame = "⠋"): string {
  if (results.length === 0) return dim("No matching identities found.");

  const groups = new Map<string, ToolLimitResult[]>();
  for (const r of results) {
    const provider = canonicalUsageProvider(r.provider);
    const list = groups.get(provider) ?? [];
    list.push(r);
    groups.set(provider, list);
  }

  // Aggregate/TOTAL rows are computed from whatever's resolved so far — a
  // "pending" result's windows are always [], so it naturally contributes
  // nothing yet. In live mode (see limits/dispatch.ts) this means the
  // rollups fill in progressively as identities resolve, same as the
  // per-identity rows below, rather than staying blank until every target
  // is done.
  const totalRows = buildTotalRows(results);
  const sections = Array.from(groups.entries()).map(([provider, group]) => ({
    header: `${bold(usageProviderLabel(provider))} ${dim(`(${identityCount(group.length)})`)}`,
    aggregateRows: buildAggregateRows(group),
    identityBlocks: group.map((r, i) => buildIdentityBlock(r, i === group.length - 1, spinnerFrame)),
  }));

  const allDataRows = [
    ...totalRows,
    ...sections.flatMap((s) => [...s.aggregateRows, ...s.identityBlocks.flatMap((b) => b.rows)]),
  ].filter((r) => r.plain === undefined);
  const prefixWidth = Math.max(0, ...allDataRows.map((r) => r.indent.length + r.label.length)) + GAP;

  const lines: string[] = [];
  for (const row of totalRows) lines.push(renderRow(row, prefixWidth, now));
  lines.push("");
  lines.push("");

  sections.forEach((section, i) => {
    if (i > 0) lines.push("");
    lines.push(section.header);
    for (const row of section.aggregateRows) lines.push(renderRow(row, prefixWidth, now));
    if (section.aggregateRows.length > 0) lines.push("│");
    for (const block of section.identityBlocks) {
      lines.push(block.branch);
      for (const row of block.rows) lines.push(renderRow(row, prefixWidth, now));
    }
  });

  return lines.join("\n");
}
