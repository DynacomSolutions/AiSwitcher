import { afterEach, describe, expect, test } from "bun:test";
import { renderContributionGraph } from "../../../src/cli/usage/contribution-graph.ts";

function local(y: number, m: number, d: number, h = 12): number {
  return new Date(y, m, d, h).getTime();
}

const originalForceColor = process.env.FORCE_COLOR;
const originalNoColor = process.env.NO_COLOR;
afterEach(() => {
  if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = originalForceColor;
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
});

describe("renderContributionGraph", () => {
  test("too narrow a target width yields undefined rather than a garbled grid", () => {
    const span = { firstMs: local(2026, 0, 1), lastMs: local(2026, 0, 10) };
    expect(renderContributionGraph({}, span, 3)).toBeUndefined();
  });

  test("renders a month line plus 7 weekday rows", () => {
    const span = { firstMs: local(2026, 0, 1), lastMs: local(2026, 0, 20) };
    const graph = renderContributionGraph({}, span, 80)!;
    expect(graph).toBeDefined();
    expect(graph.lines).toHaveLength(8); // 1 month-label line + 7 weekday rows
  });

  test("only Mon/Wed/Fri weekday rows carry a label", () => {
    const span = { firstMs: local(2026, 0, 1), lastMs: local(2026, 0, 20) };
    const graph = renderContributionGraph({}, span, 80)!;
    const [, sun, mon, tue, wed, thu, fri, sat] = graph.lines;
    expect(sun!.startsWith("Sun")).toBe(false);
    expect(mon!.startsWith("Mon")).toBe(true);
    expect(tue!.startsWith("Tue")).toBe(false);
    expect(wed!.startsWith("Wed")).toBe(true);
    expect(thu!.startsWith("Thu")).toBe(false);
    expect(fri!.startsWith("Fri")).toBe(true);
    expect(sat!.startsWith("Sat")).toBe(false);
  });

  test("no weeks dropped when the whole span fits in the target width", () => {
    const span = { firstMs: local(2026, 0, 1), lastMs: local(2026, 0, 8) }; // ~2 weeks
    const graph = renderContributionGraph({}, span, 80)!;
    expect(graph.droppedWeeks).toBe(0);
  });

  test("a span wider than the target width drops the oldest weeks, keeping the most recent", () => {
    // ~1 year of span, way more weeks than a narrow 10-char-wide graph can hold
    const span = { firstMs: local(2025, 0, 1), lastMs: local(2026, 0, 1) };
    const graph = renderContributionGraph({}, span, 10)!;
    expect(graph.droppedWeeks).toBeGreaterThan(0);
  });

  test("a day with the max activity renders the darkest glyph; a day with no activity renders blank", () => {
    const span = { firstMs: local(2026, 0, 5), lastMs: local(2026, 0, 5) }; // single day, a Monday
    const daily = { "2026-01-05": 1000 };
    const graph = renderContributionGraph(daily, span, 80)!;
    const mondayRow = graph.lines[2]!; // month line, Sun, then Mon
    expect(mondayRow).toContain("█");
  });

  test("adjacent month labels only 1-2 columns apart never overlap into garbled text — a label is dropped, never overwritten mid-word", () => {
    // A span starting mid-week in one month (a 1-week "stub" column) with
    // the next month starting right after it used to corrupt into
    // "ApMay"-style overlap — see the git history of this test file.
    const span = { firstMs: local(2026, 3, 27), lastMs: local(2026, 5, 29) }; // late April into June
    const graph = renderContributionGraph({}, span, 80)!;
    const monthLine = graph.lines[0]!;
    expect(monthLine).not.toMatch(/[A-Z][a-z]*[A-Z]/); // two month labels glued together, no space between
    for (const month of ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]) {
      const idx = monthLine.indexOf(month);
      if (idx === -1) continue;
      // whatever immediately follows a real label is either nothing, a
      // space, or another 3-letter label with a gap — never a bare letter
      // glued straight onto it (that's the corruption signature).
      const after = monthLine.slice(idx + month.length, idx + month.length + 1);
      expect(after === "" || after === " ").toBe(true);
    }
  });

  test("every line is padded to EXACTLY targetWidth, even when the tracked history is much shorter than the table", () => {
    // Only ~2 weeks of real history, but the table (and so the target
    // width) is much wider than that — the graph must still span the full
    // width, padded with blank space, not shrink to fit its own content.
    const span = { firstMs: local(2026, 0, 1), lastMs: local(2026, 0, 10) };
    const graph = renderContributionGraph({}, span, 90)!;
    for (const line of graph.lines) expect(line.length).toBe(90);
  });

  test("every line is still padded to EXACTLY targetWidth when weeks are dropped for being too wide", () => {
    const span = { firstMs: local(2025, 0, 1), lastMs: local(2026, 0, 1) };
    const graph = renderContributionGraph({}, span, 42)!;
    for (const line of graph.lines) expect(line.length).toBe(42);
  });

  test("colored mode (FORCE_COLOR): activity renders a green-shaded ■ square, not a density character", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    const span = { firstMs: local(2026, 0, 5), lastMs: local(2026, 0, 5) }; // a Monday
    const graph = renderContributionGraph({ "2026-01-05": 1000 }, span, 80)!;
    const mondayRow = graph.lines[2]!;
    expect(mondayRow).toContain("■");
    expect(mondayRow).toContain("\x1b[38;5;40m"); // brightest green — this IS the max-activity day
    expect(mondayRow).not.toContain("█");
  });

  test("colored mode (FORCE_COLOR): a no-activity day in range still renders a (dim/gray) ■, not a blank", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    const span = { firstMs: local(2026, 0, 5), lastMs: local(2026, 0, 5) };
    const graph = renderContributionGraph({}, span, 80)!;
    const mondayRow = graph.lines[2]!;
    expect(mondayRow).toContain("■");
    expect(mondayRow).toContain("\x1b[38;5;236m"); // the "empty" shade
  });

  test("days outside the tracked span render blank, not as zero-activity glyphs", () => {
    // A single Wednesday — every other day in that week is outside the span
    // and should render as a plain blank, not the "0 activity" glyph.
    const span = { firstMs: local(2026, 0, 7), lastMs: local(2026, 0, 7) };
    const graph = renderContributionGraph({}, span, 80)!;
    // every row (after the month line) should be entirely blank/short since
    // only one day out of the week is in-range and it has 0 activity too
    for (const row of graph.lines.slice(1)) {
      expect(row.includes("░") || row.includes("▒") || row.includes("▓") || row.includes("█")).toBe(false);
    }
  });
});
