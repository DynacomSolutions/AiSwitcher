import { describe, expect, test } from "bun:test";
import { HIDE_CURSOR, SHOW_CURSOR, withLiveRender } from "../../src/cli/live.ts";

/**
 * Byte-level regression tests for withLiveRender's rendered stream. The
 * regression these pin down (2026-09-11): `ais limits`' report grew taller
 * than the terminal (89 physical lines), ANSI cursor-up clamps at the
 * screen's top row, and every 80ms redraw then scrolled — the terminal
 * streamed an endless log instead of holding ONE frame in place. These
 * tests patch process.stdout.write and assert the raw control-sequence
 * stream: every redraw must be prefixed with cursor-up + clear, frame
 * height must never exceed the terminal, and the final phase must either
 * redraw the settled frame once or erase it (eraseOnFinish).
 */

interface Capture {
  chunks: string[];
  restore(): void;
}

function captureStdout(rows: number | undefined, columns: number | undefined): Capture {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  const columnDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
  process.stdout.write = function (chunk: unknown): boolean {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  } as typeof process.stdout.write;
  return {
    chunks,
    restore: () => {
      process.stdout.write = originalWrite;
      if (descriptor) Object.defineProperty(process.stdout, "rows", descriptor);
      else delete (process.stdout as { rows?: number }).rows;
      if (columnDescriptor) Object.defineProperty(process.stdout, "columns", columnDescriptor);
      else delete (process.stdout as { columns?: number }).columns;
    },
  };
}

const CURSOR_UP_PREFIX = /\x1b\[(\d+)A\x1b\[J/;
const TICK_MS = 80;

/** 30 distinct logical rows, tall enough to overflow a 10-row terminal. */
const THIRTY_ROW_RENDER = (tick: number) =>
  Array.from({ length: 30 }, (_, i) => `row${i} tick${tick}`).join("\n");

async function runTwoTicks(): Promise<void> {
  await Bun.sleep(TICK_MS * 2 + 20);
}

describe("withLiveRender byte stream", () => {
  test("every redraw after the first is prefixed with cursor-up + clear (never bare appended frames)", async () => {
    const capture = captureStdout(undefined, 120);
    try {
      await withLiveRender((tick) => `frame ${tick}`, runTwoTicks);
      const bodies = capture.chunks.filter((chunk) => chunk !== HIDE_CURSOR && chunk !== SHOW_CURSOR);
      expect(bodies.length).toBeGreaterThanOrEqual(3);
      // The very first frame starts with no cursor-up prefix...
      expect(CURSOR_UP_PREFIX.test(bodies[0]!)).toBe(false);
      // ...every subsequent frame MUST carry one: a frame written without
      // the prefix is a new appended line, i.e. the streaming regression.
      for (const body of bodies.slice(1)) {
        const match = CURSOR_UP_PREFIX.exec(body);
        expect(match).not.toBeNull();
        expect(body.startsWith(match![0])).toBe(true);
      }
      expect(capture.chunks[0]).toBe(HIDE_CURSOR);
      expect(capture.chunks.at(-1)).toBe(SHOW_CURSOR);
    } finally {
      capture.restore();
    }
  });

  test("frames taller than the terminal are clamped to rows-1 lines with a +N marker, cursor-up never exceeds the frame", async () => {
    const capture = captureStdout(10, 120);
    try {
      await withLiveRender(THIRTY_ROW_RENDER, runTwoTicks);
      const bodies = capture.chunks.filter((chunk) => chunk !== HIDE_CURSOR && chunk !== SHOW_CURSOR);
      expect(bodies.length).toBeGreaterThanOrEqual(3);
      for (const body of bodies) {
        // 8 kept rows + 1 marker = 9 lines = rows - 1 (the chunk carries a
        // trailing "\n", hence the trim): the frame always fits, so
        // moveUpAndClear can always reach the frame's top row.
        expect(body.replace(/\n$/, "").split("\n")).toHaveLength(9);
        expect(body).toContain("… +22 more lines (use --tool=<tool> to narrow the report)");
        const match = CURSOR_UP_PREFIX.exec(body);
        if (match) expect(Number(match[1])).toBeLessThanOrEqual(9);
      }
      // The visible rows are the TOP of the render (never silently dropped).
      expect(bodies[0]).toContain("row0");
      expect(bodies[0]).not.toContain("row8 ");
    } finally {
      capture.restore();
    }
  });

  test("constant-height frames hold ONE stable frame: same prefix and height every redraw", async () => {
    const capture = captureStdout(10, 120);
    try {
      await withLiveRender(THIRTY_ROW_RENDER, runTwoTicks);
      const bodies = capture.chunks.filter((chunk) => chunk !== HIDE_CURSOR && chunk !== SHOW_CURSOR);
      const prefixes = bodies.slice(1).map((body) => CURSOR_UP_PREFIX.exec(body)![0]);
      expect(new Set(prefixes).size).toBe(1); // identical \x1b[9A\x1b[J every time
      expect(new Set(bodies.map((body) => body.replace(/\n$/, "").split("\n").length))).toEqual(new Set([9]));
    } finally {
      capture.restore();
    }
  });

  test("a pty reporting no window size falls back to the 24-row minimum clamp", async () => {
    const capture = captureStdout(undefined, undefined);
    try {
      await withLiveRender(THIRTY_ROW_RENDER, runTwoTicks);
      const bodies = capture.chunks.filter((chunk) => chunk !== HIDE_CURSOR && chunk !== SHOW_CURSOR);
      expect(bodies.length).toBeGreaterThanOrEqual(3);
      for (const body of bodies) {
        expect(body.replace(/\n$/, "").split("\n")).toHaveLength(23); // 24 - 1
        expect(body).toContain("… +8 more lines (use --tool=<tool> to narrow the report)");
      }
    } finally {
      capture.restore();
    }
  });

  test("eraseOnFinish erases the frame instead of redrawing it, then restores the cursor", async () => {
    const capture = captureStdout(undefined, 120);
    try {
      await withLiveRender((tick) => `frame ${tick}`, runTwoTicks, { eraseOnFinish: true });
      const last = capture.chunks.at(-2)!;
      expect(last).toMatch(CURSOR_UP_PREFIX);
      // Nothing but the erase sequence: the caller prints its own output.
      expect(last.replace(CURSOR_UP_PREFIX, "")).toBe("");
      expect(capture.chunks.at(-1)).toBe(SHOW_CURSOR);
    } finally {
      capture.restore();
    }
  });

  test("without eraseOnFinish the settled frame is redrawn once before the cursor is restored", async () => {
    const capture = captureStdout(undefined, 120);
    try {
      await withLiveRender((tick) => `frame ${tick}`, runTwoTicks);
      const last = capture.chunks.at(-2)!;
      expect(last.startsWith("\x1b[1A\x1b[J")).toBe(true);
      expect(last).toContain("frame");
      expect(capture.chunks.at(-1)).toBe(SHOW_CURSOR);
    } finally {
      capture.restore();
    }
  });
});
