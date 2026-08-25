import { dim, green, red, yellow } from "../colors.ts";

const BAR_WIDTH = 20;
const FILLED = "█";
const EMPTY = "░";

/** green <50%, yellow 50-79%, red >=80% — matches the same thresholds used
 * to color the percentage number itself, so bar and number never disagree. */
function colorFor(usedPercent: number): (s: string) => string {
  if (usedPercent >= 80) return red;
  if (usedPercent >= 50) return yellow;
  return green;
}

/** Renders a `[████████░░░░░░░░░░░░]` bar, colored by severity, plus the
 * matching colored percentage. Clamped to [0, 100] since a source (e.g. an
 * "overage" state) could in principle report >100. */
export function renderBar(usedPercent: number, width = BAR_WIDTH): { bar: string; pct: string } {
  const clamped = Math.max(0, Math.min(100, usedPercent));
  const filledCount = Math.round((clamped / 100) * width);
  const color = colorFor(clamped);
  const raw = FILLED.repeat(filledCount) + EMPTY.repeat(width - filledCount);
  return { bar: `[${color(raw)}]`, pct: color(`${Math.round(clamped)}%`.padStart(4)) };
}

/** "Xm ago"/"Xh ago"/"Xd ago" bucketing for an already-non-negative minute
 * count, shared with resume/report.ts's own relative-time column so the two
 * don't drift out of sync: callers decide separately what a sub-minute
 * duration should render as (staleSuffix below omits the suffix entirely;
 * resume/report.ts shows "just now"). */
export function formatElapsedMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (60 * 24))}d ago`;
}

/** Stale-data suffix (e.g. "[as of 2h ago]") always renders dim regardless of
 * the bar's own severity color, so staleness reads as a distinct signal from
 * usage severity rather than inheriting red/yellow/green. */
export function staleSuffix(capturedAt: string | undefined, now: Date): string | undefined {
  if (!capturedAt) return undefined;
  const ms = now.getTime() - new Date(capturedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return undefined;
  return dim(`[as of ${formatElapsedMinutes(minutes)}]`);
}
