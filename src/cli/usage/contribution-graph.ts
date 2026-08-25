import { fg256, isColorEnabled } from "../colors.ts";
import { DAY_MS, localDateKey, startOfLocalDay } from "./local-day.ts";
import type { DateSpan } from "./tokscale.ts";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Only label Mon/Wed/Fri, same as GitHub's own contribution graph — every
 * row would otherwise burn width on a label that just repeats the pattern
 * of the row above/below it. */
const LABELED_WEEKDAYS = new Set([1, 3, 5]);
const GUTTER = 4; // "Mon " / "    " — the weekday-label column + 1 space
const WEEK_MS = 7 * DAY_MS;

/** Solid square glyph, colored per-cell — not a density ramp of different
 * CHARACTERS — so a real terminal renders an actual GitHub-style grid of
 * green squares rather than a mix of ▒▓░ shading characters. */
const SQUARE = "■";
/** xterm-256 palette indices, darkest/emptiest to brightest — a standard
 * "GitHub green" ramp. Index 0 is the empty/no-activity cell. */
const LEVEL_COLORS_256 = [236, 22, 28, 34, 40];
/** Plain-text fallback when color is off (NO_COLOR, piped/redirected
 * output, no TTY): a monochrome "■" can't show 5 activity levels on its
 * own, so density shading via character choice stands in for color there. */
const LEVEL_GLYPHS = [" ", "░", "▒", "▓", "█"];
const LEVEL_COUNT = LEVEL_GLYPHS.length;

export interface ContributionGraph {
  lines: string[];
  /** >0 when the tracked span has more weeks than fit in `targetWidth` —
   * only the most recent ones are shown; the caller should surface this
   * count rather than let the truncation pass silently as "the whole
   * history". */
  droppedWeeks: number;
}

/**
 * Renders a GitHub-style weeks-as-columns/weekdays-as-rows activity grid of
 * colored squares, right-padded to EXACTLY `targetWidth` visible characters
 * on every line — callers pass the usage table's own border width so the
 * graph always spans the identical width as the table below it, whether the
 * tracked history is short (padded with blank space) or long enough to
 * overflow it (oldest weeks dropped instead, see `droppedWeeks`). `daily`
 * keys are local "YYYY-MM-DD" dates (see local-day.ts/tokscale.ts's
 * dailyUsageFromHourlyEntries) mapped to a raw activity figure (this
 * project always passes total tokens); any date in `span` with no entry —
 * including every date from a source with no per-day breakdown at all, e.g.
 * zai — renders as the empty/lowest level rather than a guessed figure.
 * Returns undefined when `targetWidth` is too narrow to draw even one week
 * column.
 *
 * Padding is done by APPENDING a known count of plain spaces, never by
 * measuring the rendered string's `.length` — once a cell is wrapped in an
 * ANSI color escape, `.length` no longer equals its visible width, so
 * padding/measuring off it would either under-pad or corrupt the layout.
 */
export function renderContributionGraph(daily: Record<string, number>, span: DateSpan, targetWidth: number): ContributionGraph | undefined {
  const availableForColumns = targetWidth - GUTTER;
  if (availableForColumns < 2) return undefined;
  const maxColumns = Math.floor((availableForColumns + 1) / 2);

  const startDay = startOfLocalDay(span.firstMs);
  const endDay = startOfLocalDay(span.lastMs);

  const endSunday = new Date(endDay);
  endSunday.setDate(endSunday.getDate() - endSunday.getDay());
  const startSunday = new Date(startDay);
  startSunday.setDate(startSunday.getDate() - startSunday.getDay());

  const totalWeeks = Math.round((endSunday.getTime() - startSunday.getTime()) / WEEK_MS) + 1;
  const shownWeeks = Math.max(1, Math.min(totalWeeks, maxColumns));
  const droppedWeeks = totalWeeks - shownWeeks;
  // The grid itself only ever occupies shownWeeks*2 of the available
  // columns-width — pad the rest so every line still comes out to EXACTLY
  // targetWidth, even when there's much less tracked history than the
  // table is wide (a short history must never render a narrower graph).
  const trailingPad = " ".repeat(Math.max(0, targetWidth - (GUTTER + shownWeeks * 2)));

  const firstShownSunday = new Date(endSunday);
  firstShownSunday.setDate(firstShownSunday.getDate() - (shownWeeks - 1) * 7);

  const maxValue = Math.max(0, ...Object.values(daily));
  const levelFor = (value: number): number => {
    if (value <= 0 || maxValue <= 0) return 0;
    return Math.min(LEVEL_COUNT - 1, Math.ceil((value / maxValue) * (LEVEL_COUNT - 1)));
  };

  const useColor = isColorEnabled();
  const gridWidth = shownWeeks * 2;

  // A flat per-CHARACTER grid (width = shownWeeks*2, matching one glyph
  // column + its trailing space each), not a per-COLUMN array joined with
  // spaces afterward — writing a 3-letter label into 3 separate column
  // slots that each then get their own trailing space inserted spreads it
  // out as "M a y" instead of "May". Label text is allowed to overflow into
  // the following column's space, same as GitHub's own graph.
  const monthGrid: string[] = new Array(gridWidth).fill(" ");
  let prevMonth = -1;
  for (let col = 0; col < shownWeeks; col++) {
    const sunday = new Date(firstShownSunday);
    sunday.setDate(sunday.getDate() + col * 7);
    if (sunday.getMonth() !== prevMonth) {
      const label = sunday.toLocaleDateString("en-US", { month: "short" });
      const startPos = col * 2;
      // Only write if the WHOLE label fits into still-blank cells — a
      // narrow one-week "stub" column at the very start of the graph can
      // otherwise get its short label immediately followed (1-2 columns
      // later) by the next month's, overlapping into "ApMay"-style
      // corruption. Skipping a label some months don't have room for is
      // fine; overwriting an already-placed one into garbage isn't.
      const fits = Array.from({ length: label.length }).every((_, i) => startPos + i < gridWidth && monthGrid[startPos + i] === " ");
      if (fits) {
        for (let i = 0; i < label.length; i++) monthGrid[startPos + i] = label[i]!;
      }
      prevMonth = sunday.getMonth();
    }
  }
  // monthLine never contains color codes, so padEnd off its own (accurate)
  // .length is fine here — unlike the weekday rows below.
  const monthLine = (" ".repeat(GUTTER) + monthGrid.join("")).padEnd(targetWidth);

  const lines: string[] = [monthLine];
  for (let weekday = 0; weekday < 7; weekday++) {
    const label = LABELED_WEEKDAYS.has(weekday) ? WEEKDAY_LABELS[weekday]! : "";
    let row = label.padEnd(GUTTER);
    for (let col = 0; col < shownWeeks; col++) {
      const day = new Date(firstShownSunday);
      day.setDate(day.getDate() + col * 7 + weekday);
      if (day.getTime() < startDay.getTime() || day.getTime() > endDay.getTime()) {
        row += "  "; // outside the tracked range entirely — blank, not "zero activity"
        continue;
      }
      const level = levelFor(daily[localDateKey(day.getTime())] ?? 0);
      const glyph = useColor ? fg256(LEVEL_COLORS_256[level]!)(SQUARE) : LEVEL_GLYPHS[level]!;
      row += `${glyph} `;
    }
    lines.push(row + trailingPad);
  }

  return { lines, droppedWeeks };
}
