import { dim, green, red, yellow } from "./colors.ts";

/**
 * Pure status model for `ais upgrade`'s parallel status list. This module
 * knows nothing about processes, npm, or the terminal: it holds the row
 * states and renders them from an explicit spinner frame, so the whole
 * lifecycle is unit-testable without a TTY (the same split as limits'
 * collect.ts/report.ts). upgrade.ts owns the runner that emits events and
 * the withLiveRender redraw loop that feeds render ticks in.
 */

export type UpgradeRowStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface UpgradeRow {
  id: string;
  status: UpgradeRowStatus;
  /** Human-readable outcome: a version transition, a skip reason, or a
   * failure headline. Undefined for a row that has not finished yet. */
  detail?: string;
}

export type UpgradeEvent =
  | { type: "start"; id: string }
  | { type: "finish"; id: string; ok: boolean; detail?: string }
  | { type: "skip"; id: string; detail?: string };

/** Every tool starts as a pending row so the live render has a stable line
 * per tool from the first frame (the same seed-rows-first pattern
 * limits/dispatch.ts uses). */
export function createUpgradeRows(ids: readonly string[]): UpgradeRow[] {
  return ids.map((id) => ({ id, status: "pending" as const }));
}

/** Pure transition reducer: returns a NEW rows array, never mutates, and
 * leaves rows whose id the event does not name untouched. Events for an
 * unknown id are ignored (defensive; the runner only names planned ids). */
export function applyUpgradeEvent(rows: readonly UpgradeRow[], event: UpgradeEvent): UpgradeRow[] {
  return rows.map((row) => {
    if (row.id !== event.id) return row;
    switch (event.type) {
      case "start":
        return { ...row, status: "running" as const, detail: undefined };
      case "skip":
        return { ...row, status: "skipped" as const, detail: event.detail };
      case "finish":
        return event.ok
          ? { ...row, status: "done" as const, detail: event.detail }
          : { ...row, status: "failed" as const, detail: event.detail };
    }
  });
}

/** Formats a single row: padded tool name, then a status glyph and detail.
 * No trailing newline; the caller joins lines. */
export function formatUpgradeRow(row: UpgradeRow, nameWidth: number, spinner: string): string {
  const name = row.id.padEnd(nameWidth);
  switch (row.status) {
    case "pending":
      return `${name}  ${dim("pending")}`;
    case "running":
      return `${name}  ${spinner} installing…`;
    case "done":
      return `${name}  ${green("✔")}${row.detail ? ` ${dim(row.detail)}` : ""}`;
    case "failed":
      return `${name}  ${red(`✘ ${row.detail ?? "failed"}`)}`;
    case "skipped":
      return `${name}  ${yellow("-")}${row.detail ? ` ${dim(row.detail)}` : ""}`;
  }
}

/** The full frame body (one line per row, in plan order). Line-level width
 * truncation is deliberately left to withLiveRender, which owns the
 * terminal-width cursor math. */
export function formatUpgradeFrame(rows: readonly UpgradeRow[], spinner: string): string {
  const nameWidth = rows.reduce((max, row) => Math.max(max, row.id.length), 0);
  return rows.map((row) => formatUpgradeRow(row, nameWidth, spinner)).join("\n");
}
