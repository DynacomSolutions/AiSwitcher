import { bold, dim, gray } from "../colors.ts";
import { canonicalUsageProvider, usageProviderLabel } from "../usage/providers.ts";
import { renderBar, staleSuffix } from "./bar.ts";
import type { LimitCategory, ToolLimitResult } from "./types.ts";

const ANSI = /\x1b\[[0-9;]*m/g;
const COLUMN_GAP = 3;
const DEFAULT_WIDTH = 100;
/** Narrower than this and bars shrink to 10 cells. */
const NARROW_WIDTH = 80;
/** Below this width provider blocks never go side by side. */
const COLUMNS_MIN_WIDTH = 120;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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
  resetsAtMs?: number;
  note?: string;
  capturedAt?: string;
  /** Set instead of usedPercent for a no-bar row (e.g. "not authenticated") — rendered dim, no bracket. */
  plain?: string;
}

export interface ReportOptions {
  /** Terminal width; defaults to process.stdout.columns, else 100. */
  width?: number;
  /** Side-by-side provider columns; defaults to "stdout is a TTY". */
  columns?: boolean;
  /** One line per identity. */
  compact?: boolean;
}

interface Ctx {
  now: Date;
  spinnerFrame: string;
  barWidth: number;
  wrapWidth: number;
  /** Blocks share the line: plain rows wrap to their own block's width, not the terminal's. */
  columns: boolean;
  compact: boolean;
  all: ToolLimitResult[];
}

function visibleLength(s: string): number {
  return s.replace(ANSI, "").length;
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
    if (isMirroredPool(r, results)) continue;
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

function buildAggregateRows(results: ToolLimitResult[]): Row[] {
  return aggregateAverage(results).map(({ category, usedPercent }) => ({
    indent: AGGREGATE_INDENT,
    label: pluralizeCategory(category),
    usedPercent,
  }));
}

/** A swap-pool identity whose active member is also in this report: its
 * windows are a copy of that member's, so it renders as a pointer and stays
 * out of every aggregate. A pool with no known (or unlisted) active member
 * keeps its own windows — there is nothing else to show them from. */
function isMirroredPool(r: ToolLimitResult, all: ToolLimitResult[]): boolean {
  const active = r.identity.swapPool?.active;
  return active !== undefined && all.some((o) => o !== r && o.toolName === r.toolName && o.identity.name === active);
}

/** Headroom = 100 − worst window. */
function headroom(r: ToolLimitResult): number {
  return 100 - Math.max(...r.windows.map((w) => w.usedPercent));
}

/** Most headroom first; exhausted next; unavailable/empty and mirrored pools last. Stable for ties. */
export function sortByUrgency(group: ToolLimitResult[], all: ToolLimitResult[] = group): ToolLimitResult[] {
  const rank = (r: ToolLimitResult): number => {
    if (isMirroredPool(r, all)) return 3;
    if (r.status === "pending") return 0;
    if (r.status === "unavailable" || r.windows.length === 0) return 2;
    return headroom(r) <= 0 ? 1 : 0;
  };
  const key = (r: ToolLimitResult): number => (r.status === "pending" || r.windows.length === 0 ? 100 : headroom(r));
  return group
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || key(b.r) - key(a.r) || a.i - b.i)
    .map(({ r }) => r);
}

/** "in 41m" / "in 3h 41m" / "in 2d 4h" for a future instant; "now" once past. */
export function formatCountdown(resetsAtMs: number, now: Date): string {
  const minutes = Math.round((resetsAtMs - now.getTime()) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 60 * 24) return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `in ${Math.floor(minutes / (60 * 24))}d ${Math.floor((minutes % (60 * 24)) / 60)}h`;
}

/** Local 24h clock: "Sun 03:09", or "Sat 18 Oct 21:59" once ≥7 days away. */
export function formatClock(resetsAtMs: number, now: Date): string {
  const d = new Date(Math.round(resetsAtMs / 60_000) * 60_000);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const far = resetsAtMs - now.getTime() >= 7 * 24 * 60 * 60_000;
  return `${WEEKDAYS[d.getDay()]} ${far ? `${d.getDate()} ${MONTHS[d.getMonth()]} ` : ""}${hhmm}`;
}

/** "in 3h 41m (Sun 03:09)" from the exact instant, else the adapter's own string. */
function resetText(resetsAtMs: number | undefined, resetsAt: string | undefined, now: Date): string | undefined {
  if (resetsAtMs !== undefined && Number.isFinite(resetsAtMs)) {
    const countdown = formatCountdown(resetsAtMs, now);
    return countdown === "now" ? "now" : `${countdown} (${formatClock(resetsAtMs, now)})`;
  }
  return resetsAt;
}

/** Word-wraps to `width` columns; continuation lines get `continuation` as their indent. */
export function wrapText(text: string, width: number, indent: string, continuation: string): string[] {
  const lines: string[] = [];
  let line = indent;
  let empty = true;
  const flush = () => {
    lines.push(line);
    line = continuation;
    empty = true;
  };
  for (let word of text.split(/\s+/).filter(Boolean)) {
    const room = Math.max(8, width - continuation.length);
    while (word.length > room) {
      if (!empty) flush();
      line += word.slice(0, room);
      word = word.slice(room);
      empty = false;
      flush();
    }
    if (!empty && line.length + 1 + word.length > width) flush();
    line += (empty ? "" : " ") + word;
    empty = false;
  }
  lines.push(line);
  return lines;
}

function worstWindow(r: ToolLimitResult) {
  return r.windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
}

function identityHeading(result: ToolLimitResult): string {
  const { name, label } = result.identity;
  return label.toLowerCase() === name.toLowerCase() ? bold(name) : `${bold(name)}  ${dim(`(${label})`)}`;
}

function poolPointer(result: ToolLimitResult): string {
  return `→ active member: ${result.identity.swapPool?.active}`;
}

function buildIdentityBlock(result: ToolLimitResult, isLast: boolean, ctx: Ctx): { branch: string; rows: Row[] } {
  const connector = isLast ? BRANCH_LAST : BRANCH;
  const continuation = isLast ? DETAIL_INDENT_LAST : DETAIL_INDENT;
  const branch = `${connector}${identityHeading(result)}`;

  if (isMirroredPool(result, ctx.all)) {
    return { branch, rows: [{ indent: continuation, label: "", plain: poolPointer(result) }] };
  }
  if (result.status === "pending") {
    return { branch, rows: [{ indent: continuation, label: "", plain: `${ctx.spinnerFrame} loading…` }] };
  }
  if (result.status === "unavailable" || result.windows.length === 0) {
    return { branch, rows: [{ indent: continuation, label: "", plain: result.error ?? "no data" }] };
  }

  const rows: Row[] = result.windows.map((w) => ({
    indent: continuation,
    label: w.label,
    usedPercent: w.usedPercent,
    resetsAt: w.resetsAt,
    resetsAtMs: w.resetsAtMs,
    note: w.note,
    capturedAt: result.capturedAt,
  }));
  // A manually-spendable reset (e.g. codex's "Full reset (Weekly + 5 hr)"
  // credits, or Claude's /limit-reset grants) is account-level, not a property of any one window, so it gets
  // its own dim row under the identity branch instead of being glued onto a
  // window's extras. Only ever set on live results alongside real windows.
  if (result.manualReset && result.manualReset.availableCount > 0) {
    const reset = result.manualReset;
    const noun = reset.availableCount > 1 ? `manual resets available ×${reset.availableCount}` : "manual reset available";
    const text = [noun, reset.label].filter(Boolean).join(": ") + (reset.expiresAt ? ` (expires ${reset.expiresAt})` : "");
    rows.push({ indent: continuation, label: "", plain: text });
  }
  return { branch, rows };
}

function renderRow(row: Row, prefixWidth: number, ctx: Ctx): string {
  if (row.plain !== undefined) {
    return wrapText(row.plain, ctx.wrapWidth, row.indent, `${row.indent}  `).map(gray).join("\n");
  }

  const { bar, pct } = renderBar(row.usedPercent!, ctx.barWidth);
  const pad = " ".repeat(Math.max(1, prefixWidth - row.indent.length - row.label.length));
  let line = `${row.indent}${row.label}${pad}${bar} ${pct}`;

  const extras: string[] = [];
  const reset = resetText(row.resetsAtMs, row.resetsAt, ctx.now);
  if (reset) extras.push(`resets ${reset}`);
  if (row.note) extras.push(row.note);
  if (extras.length) line += `  ${extras.join("  ")}`;

  const stale = staleSuffix(row.capturedAt, ctx.now);
  if (stale) line += `  ${stale}`;

  return line;
}

/** `name  worst-label [bar] pct  resets …  ↺N` — one line per identity. */
function compactLine(result: ToolLimitResult, nameWidth: number, labelWidth: number, ctx: Ctx): string {
  const name = result.identity.name.padEnd(nameWidth);
  if (isMirroredPool(result, ctx.all)) return `  ${bold(name)}  ${gray(poolPointer(result))}`;
  if (result.status === "pending") return `  ${bold(name)}  ${gray(`${ctx.spinnerFrame} loading…`)}`;
  if (result.status === "unavailable" || result.windows.length === 0) {
    const text = (result.error ?? "no data").replace(/\s+/g, " ");
    const room = Math.max(10, (ctx.columns ? Math.min(ctx.wrapWidth, 60) : ctx.wrapWidth) - nameWidth - 4);
    return `  ${bold(name)}  ${gray(text.length > room ? `${text.slice(0, room - 1)}…` : text)}`;
  }
  const w = worstWindow(result);
  const { bar, pct } = renderBar(w.usedPercent, ctx.barWidth);
  let line = `  ${bold(name)}  ${w.label.padEnd(labelWidth)} ${bar} ${pct}`;
  const reset = resetText(w.resetsAtMs, w.resetsAt, ctx.now);
  if (reset) line += `  ${reset}`;
  if (result.manualReset && result.manualReset.availableCount > 0) line += `  ↺${result.manualReset.availableCount}`;
  return line;
}

interface Widths {
  /** Indent + label + gap: the column every bar starts at. */
  prefix: number;
  name: number;
  label: number;
}

function sectionRows(group: ToolLimitResult[], ctx: Ctx) {
  const sorted = sortByUrgency(group, ctx.all);
  const aggregateRows = buildAggregateRows(group.filter((r) => !isMirroredPool(r, ctx.all)));
  const blocks = sorted.map((r, i) => buildIdentityBlock(r, i === sorted.length - 1, ctx));
  const dataRows = [...aggregateRows, ...blocks.flatMap((b) => b.rows)].filter((r) => r.plain === undefined);
  return { sorted, aggregateRows, blocks, dataRows };
}

const rowPrefix = (rows: Row[]): number => Math.max(0, ...rows.map((r) => r.indent.length + r.label.length)) + GAP;

/** Widest prefix, name and worst-window label over the given groups. */
function measure(groups: ToolLimitResult[][], extraRows: Row[], ctx: Ctx): Widths {
  const sorted = groups.flatMap((g) => g);
  return {
    prefix: rowPrefix([...extraRows, ...groups.flatMap((g) => sectionRows(g, ctx).dataRows)]),
    name: Math.max(0, ...sorted.map((r) => r.identity.name.length)),
    label: Math.max(0, ...sorted.filter((r) => r.windows.length > 0).map((r) => worstWindow(r).label.length)),
  };
}

function buildSection(provider: string, group: ToolLimitResult[], ctx: Ctx, widths: Widths): string[] {
  const header = `${bold(usageProviderLabel(provider))} ${dim(`(${identityCount(group.length)})`)}`;
  const { sorted, aggregateRows, blocks, dataRows } = sectionRows(group, ctx);
  if (ctx.compact) return [header, ...sorted.map((r) => compactLine(r, widths.name, widths.label, ctx))];
  const prefixWidth = widths.prefix;
  // In columns mode a plain row wraps at its block's data width (min 40), so
  // it never widens the block; single column wraps at the terminal width.
  const natural = Math.max(
    40,
    visibleLength(header),
    ...blocks.map((b) => visibleLength(b.branch)),
    ...dataRows.map((r) => visibleLength(renderRow(r, prefixWidth, ctx))),
  );
  const rowCtx = ctx.columns ? { ...ctx, wrapWidth: Math.min(ctx.wrapWidth, natural) } : ctx;
  const lines = [header];
  for (const row of aggregateRows) lines.push(renderRow(row, prefixWidth, rowCtx));
  for (const block of blocks) {
    lines.push(block.branch);
    for (const row of block.rows) lines.push(renderRow(row, prefixWidth, rowCtx));
  }
  return lines.flatMap((l) => l.split("\n"));
}

/** Lays blocks out side by side: the most columns that fit `width`, each
 * block going to the currently shortest column, with one blank line between
 * blocks stacked in the same column. `weights` (one per block) replace the
 * real block heights for that choice, so placement does not shift as rows
 * load; widths are always measured from the real lines. Returns undefined
 * when even two columns do not fit (caller falls back to a single column). */
export function packColumns(
  blocks: string[][],
  width: number,
  gap = COLUMN_GAP,
  /** Re-renders the blocks at these indices with their own (column-local) alignment; tried when the shared one does not fit. */
  relayout?: (indices: number[]) => string[][],
  weights: number[] = blocks.map((b) => b.length),
): string[] | undefined {
  for (let k = Math.min(blocks.length, 6); k >= 2; k--) {
    let cols: string[][][] = Array.from({ length: k }, () => []);
    const idx: number[][] = Array.from({ length: k }, () => []);
    const heights = new Array<number>(k).fill(0);
    blocks.forEach((block, i) => {
      const j = heights.indexOf(Math.min(...heights));
      // +1 for the blank separator above every block after the first.
      heights[j]! += weights[i]! + (cols[j]!.length > 0 ? 1 : 0);
      cols[j]!.push(block);
      idx[j]!.push(i);
    });
    const measureCols = (cs: string[][][]) => {
      const ls = cs.map((c) => c.flatMap((b, i) => (i > 0 ? ["", ...b] : b)));
      return { ls, ws: ls.map((c) => Math.max(0, ...c.map(visibleLength))) };
    };
    let { ls: lines, ws: widths } = measureCols(cols);
    const fits = () => widths.reduce((a, b) => a + b, 0) + gap * (k - 1) <= width;
    if (!fits() && relayout) {
      cols = idx.map((i) => relayout(i));
      ({ ls: lines, ws: widths } = measureCols(cols));
    }
    if (!fits()) continue;
    const out: string[] = [];
    for (let i = 0; i < Math.max(...lines.map((c) => c.length)); i++) {
      out.push(
        lines
          .map((c, j) => {
            const cell = c[i] ?? "";
            return cell + " ".repeat(widths[j]! - visibleLength(cell));
          })
          .join(" ".repeat(gap))
          .trimEnd(),
      );
    }
    return out;
  }
  return undefined;
}

/** Renders the report: an unlabeled TOTAL rollup at the top (session/week/
 * month, averaged across every provider and identity), then one block per
 * PROVIDER — its own rollup hanging directly off the header, then one branch
 * per identity (most headroom first) with that provider's actual windows
 * underneath. Provider is the grouping key, not the tool: a multi-provider
 * client (pi, opencode) contributes rows to the same Anthropic/Z.ai/...
 * blocks its native-tool counterparts do, and collect.ts's aggregation has
 * already merged any duplicate provider+identity answers into one branch
 * before this renders. On a wide TTY the blocks sit side by side in columns
 * (see packColumns); `compact` collapses each identity to a single line. */
export function formatLimitsReport(
  results: ToolLimitResult[],
  now: Date = new Date(),
  spinnerFrame = "⠋",
  options: ReportOptions = {},
): string {
  if (results.length === 0) return dim("No matching identities found.");

  const width = options.width ?? process.stdout.columns ?? DEFAULT_WIDTH;
  const columns = (options.columns ?? Boolean(process.stdout.isTTY)) && width >= COLUMNS_MIN_WIDTH;
  const compact = options.compact ?? false;
  const ctx: Ctx = {
    now,
    spinnerFrame,
    barWidth: compact || width < NARROW_WIDTH ? 10 : 20,
    wrapWidth: width,
    columns,
    compact,
    all: results,
  };

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
  // per-identity rows, rather than staying blank until every target
  // is done.
  const totalRows: Row[] = compact
    ? []
    : aggregateAverage(results).map(({ category, usedPercent }) => ({ indent: "", label: pluralizeCategory(category), usedPercent }));
  // One prefix width over every row of every block (TOTAL included), so all bars start at the same column.
  const entries = Array.from(groups.entries());
  const shared = measure(entries.map(([, g]) => g), totalRows, ctx);
  const blocks = entries.map(([provider, group]) => buildSection(provider, group, ctx, shared));
  // Fallback when the shared width does not fit: each column aligns to its own widest prefix.
  const relayout = (indices: number[]) => {
    const own = measure(indices.map((i) => entries[i]![1]), [], ctx);
    return indices.map((i) => buildSection(entries[i]![0], entries[i]![1], ctx, { ...shared, prefix: own.prefix }));
  };
  // Load-independent heights: header + aggregate rows + one branch and a few detail rows per identity.
  const weights = entries.map(([, g]) => 4 + 4 * g.length);
  const body =
    (columns ? packColumns(blocks, width, COLUMN_GAP, ctx.compact ? undefined : relayout, weights) : undefined) ??
    blocks.flatMap((b, i) => (i > 0 ? ["", ...b] : b));

  const lines = totalRows.map((row) => renderRow(row, shared.prefix, ctx));
  if (lines.length > 0) lines.push("");
  return [...lines, ...body].join("\n");
}
