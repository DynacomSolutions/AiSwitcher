import type { LimitCategory } from "./types.ts";

/** Categorize a window by its actual duration rather than trusting a tool's
 * position/naming convention — Codex's "primary" window isn't always the 5h
 * one, and a future tool might report something else entirely. Thresholds
 * are generous midpoints between the known real values (5h=300min,
 * 7d=10080min, ~30d=43200min) so odd-but-nearby durations still bucket
 * sensibly instead of falling to "other". */
export function categorizeByMinutes(minutes: number): LimitCategory {
  if (minutes <= 360) return "session"; // up to 6h
  if (minutes <= 20160) return "week"; // up to 14d
  if (minutes <= 60480) return "month"; // up to 42d
  return "other";
}

/** For tools that report a free-text label instead of a raw duration (e.g.
 * Claude's "Current session" / "Current week (all models)", Grok's
 * currentPeriod.type of "USAGE_PERIOD_TYPE_WEEKLY"). Matches on keywords
 * rather than exact strings since exact label text varies per tool/tier. */
export function categorizeByLabel(label: string): LimitCategory {
  const lower = label.toLowerCase();
  if (lower.includes("session")) return "session";
  if (lower.includes("week")) return "week";
  if (lower.includes("month")) return "month";
  return "other";
}
