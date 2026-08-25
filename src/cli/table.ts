/** Box-drawing table renderer for usage/report.ts (and any future bordered
 * report). `padRow` pads/aligns each cell and wraps the row in vertical
 * bars; `borderRow` draws the horizontal rule above/below/between sections —
 * its `widths` must be the SAME array passed to `padRow` so the "─" run
 * under each cell lines up with that cell's " content " padding exactly
 * (width + 2 for the space on each side). `rightAlignColumns` names which
 * column indices pad-start (numeric columns reading right-to-left); every
 * other column pad-ends. */
export function padRow(cells: string[], widths: number[], rightAlignColumns: Set<number> = new Set()): string {
  const padded = cells.map((cell, i) => (rightAlignColumns.has(i) ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!)));
  return `│ ${padded.join(" │ ")} │`;
}

export function borderRow(widths: number[], left: string, mid: string, right: string): string {
  return left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right;
}
