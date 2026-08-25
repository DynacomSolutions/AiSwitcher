const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 80;
const FALLBACK_WIDTH = 80;
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const RESET = "\x1b[0m";

export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";

/** Cursor-up-N-lines + clear-to-end, the same in-place-redraw trick
 * limits/watch.ts already used before this module existed — factored out
 * here so both watch.ts's own poll loop and withLiveRender below share one
 * implementation. */
export function moveUpAndClear(lineCount: number): string {
  return lineCount > 0 ? `\x1b[${lineCount}A\x1b[J` : "";
}

/** Cycles a braille spinner animation, one frame per `tick`. Pure and
 * deterministic (no timer involved) so callers — and tests — don't need a
 * real clock. */
export function spinnerChar(tick: number): string {
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;
}

/** Visible length of a line — ANSI color codes (colors.ts's own `\x1b[Nm`
 * output) don't consume a terminal column, so they're stripped before
 * measuring. */
function visibleLength(line: string): number {
  return line.replace(ANSI_ESCAPE, "").length;
}

/**
 * Truncates a line to fit within `maxWidth` VISIBLE columns, always ending
 * with a full reset so a cut made mid-color-sequence can never bleed color
 * into whatever's drawn after it. A line already within width passes
 * through untouched (the common case — no allocation, no reset appended).
 *
 * withLiveRender's cursor math (moveUpAndClear) assumes one logical line
 * (one "\n"-separated entry in the rendered body) is exactly one physical
 * terminal row. A real-world row can break that: a long error message (e.g.
 * claude-limits.ts's "did not respond within 90s (hung — ...)" text, ~140
 * chars with its indent) soft-wraps onto a second physical row on anything
 * narrower than ~150 columns, so the terminal actually consumed one MORE
 * row than `body.split("\n").length` accounted for. moveUpAndClear then
 * moves the cursor up too few rows on every subsequent redraw, leaving that
 * row's old content on screen above the new frame — and since each tick
 * repeats the same undercount, the leftover content compounds tick over
 * tick (confirmed live, 2026-07-20: a single wrapped error line during a
 * 30s+ timeout produced dozens of stacked duplicate rollup rows, and the
 * mess was still there once the command finished, since the FINAL draw has
 * the exact same wrong previousLineCount). Truncating every line to fit
 * within the terminal's actual width guarantees the 1-logical-line
 * = 1-physical-row assumption always holds, regardless of how long any
 * single row's content gets.
 */
export function truncateToWidth(line: string, maxWidth: number): string {
  if (visibleLength(line) <= maxWidth) return line;
  let visible = 0;
  let out = "";
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    const escape = /^\x1b\[[0-9;]*m/.exec(rest);
    if (escape) {
      out += escape[0];
      i += escape[0].length;
      continue;
    }
    if (visible >= maxWidth - 1) break;
    out += line[i];
    visible++;
    i++;
  }
  return `${out}…${RESET}`;
}

/**
 * Drives an in-place, per-row terminal render while `run()` is in flight.
 * `render(tick)` returns the FULL current frame (every row, resolved or
 * still pending) — this module only owns the redraw loop, not the fetching
 * or the pending/resolved bookkeeping. Callers close over their own mutable
 * results array, filling entries in as their own concurrency-limited fetch
 * resolves each one; `render` reads whatever's currently in that array. The
 * frame is redrawn every TICK_MS (so a still-pending row's spinner actually
 * animates, since nothing else would trigger a redraw while it's waiting)
 * and once more after `run()` settles, so the final state is what's left on
 * screen before the cursor is restored.
 *
 * Requires a real TTY, same requirement watch.ts already has for the same
 * reason: an in-place redraw means nothing when piped/redirected. Callers
 * are expected to check `process.stdout.isTTY` themselves before calling
 * this — it's not checked here, since a non-TTY caller should skip the
 * whole live-rendering path (including the per-item progress callback
 * plumbing) rather than call in and get a silent single-frame no-op.
 */
export async function withLiveRender(render: (tick: number) => string, run: () => Promise<void>): Promise<void> {
  process.stdout.write(HIDE_CURSOR);
  let previousLineCount = 0;
  let tick = 0;

  function draw(): void {
    const width = process.stdout.columns || FALLBACK_WIDTH;
    const body = render(tick)
      .split("\n")
      .map((line) => truncateToWidth(line, width))
      .join("\n");
    process.stdout.write(moveUpAndClear(previousLineCount) + body + "\n");
    previousLineCount = body.split("\n").length;
  }

  const restoreCursor = () => process.stdout.write(SHOW_CURSOR);
  const onSignal = () => {
    restoreCursor();
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const timer = setInterval(() => {
    tick++;
    draw();
  }, TICK_MS);

  try {
    draw();
    await run();
  } finally {
    clearInterval(timer);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    draw();
    restoreCursor();
  }
}
