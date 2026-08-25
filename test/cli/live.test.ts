import { describe, expect, test } from "bun:test";
import { moveUpAndClear, spinnerChar, truncateToWidth } from "../../src/cli/live.ts";

function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

describe("spinnerChar", () => {
  test("cycles through the same 10-frame sequence deterministically", () => {
    const frames = Array.from({ length: 10 }, (_, tick) => spinnerChar(tick));
    expect(new Set(frames).size).toBe(10); // all distinct within one full cycle
    expect(spinnerChar(0)).toBe(spinnerChar(10)); // wraps back around
    expect(spinnerChar(3)).toBe(spinnerChar(13));
  });
});

describe("moveUpAndClear", () => {
  test("zero lines is a no-op (nothing drawn yet)", () => {
    expect(moveUpAndClear(0)).toBe("");
  });

  test("moves the cursor up N lines then clears to end of screen", () => {
    expect(moveUpAndClear(5)).toBe("\x1b[5A\x1b[J");
  });
});

describe("truncateToWidth", () => {
  test("a line already within width passes through completely untouched", () => {
    const line = "session    [████████████████████] 100%  resets Jul 20 at 6:31 PM";
    expect(truncateToWidth(line, 80)).toBe(line);
  });

  test("a plain line longer than width is cut to maxWidth-1 visible chars plus an ellipsis", () => {
    const line = "x".repeat(100);
    const out = truncateToWidth(line, 20);
    expect(visibleLength(out)).toBe(20); // 19 kept chars + the ellipsis itself
    expect(out.endsWith("…\x1b[0m")).toBe(true);
  });

  test("never produces a physical row wider than maxWidth, the actual bug this guards against", () => {
    // The real trigger: claude-limits.ts's long timeout error message, which
    // wraps on anything narrower than ~150 columns and desyncs
    // withLiveRender's cursor-up line count (see live.ts's own comment).
    const longError =
      '      claude -p "/usage" did not respond within 90s (hung — not a billing issue; try re-authenticating or check for an Anthropic-side incident)';
    expect(visibleLength(longError)).toBeGreaterThan(80);
    const out = truncateToWidth(longError, 80);
    expect(visibleLength(out)).toBeLessThanOrEqual(80);
  });

  test("ANSI color codes don't count against width, and pass through untouched", () => {
    const colored = `${"\x1b[31m"}${"y".repeat(30)}${"\x1b[39m"}`;
    // 30 visible chars fits comfortably within 40 — the ~9 escape-code bytes
    // must NOT push it over and trigger truncation.
    expect(truncateToWidth(colored, 40)).toBe(colored);
  });

  test("a cut made mid-color always ends with a full reset, so color can't bleed into later output", () => {
    const colored = `${"\x1b[31m"}${"z".repeat(100)}${"\x1b[39m"}`;
    const out = truncateToWidth(colored, 20);
    expect(out.endsWith("\x1b[0m")).toBe(true);
  });
});
