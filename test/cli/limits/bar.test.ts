import { describe, expect, test } from "bun:test";
import { renderBar, staleSuffix } from "../../../src/cli/limits/bar.ts";

// process.stdout.isTTY is false under `bun test` (see test/cli/colors.test.ts),
// so colors.ts's wrap functions are no-ops here — assertions below check
// plain text, not ANSI codes.

describe("renderBar", () => {
  test("0% is an empty bar", () => {
    const { bar, pct } = renderBar(0);
    expect(bar).toBe(`[${"░".repeat(20)}]`);
    expect(pct.trim()).toBe("0%");
  });

  test("100% is a full bar", () => {
    const { bar, pct } = renderBar(100);
    expect(bar).toBe(`[${"█".repeat(20)}]`);
    expect(pct.trim()).toBe("100%");
  });

  test("25% fills a quarter of the bar", () => {
    const { bar } = renderBar(25);
    expect(bar).toBe(`[${"█".repeat(5)}${"░".repeat(15)}]`);
  });

  test("clamps out-of-range percentages instead of producing a malformed bar", () => {
    expect(renderBar(150).bar).toBe(`[${"█".repeat(20)}]`);
    expect(renderBar(-10).bar).toBe(`[${"░".repeat(20)}]`);
  });
});

describe("staleSuffix", () => {
  const now = new Date("2026-07-15T12:00:00Z");

  test("undefined capturedAt produces no suffix", () => {
    expect(staleSuffix(undefined, now)).toBeUndefined();
  });

  test("under a minute old produces no suffix", () => {
    expect(staleSuffix(new Date("2026-07-15T11:59:31Z").toISOString(), now)).toBeUndefined();
  });

  test("minutes-old data renders 'Nm ago'", () => {
    expect(staleSuffix(new Date("2026-07-15T11:45:00Z").toISOString(), now)).toContain("15m ago");
  });

  test("hours-old data renders 'Nh ago'", () => {
    expect(staleSuffix(new Date("2026-07-15T09:00:00Z").toISOString(), now)).toContain("3h ago");
  });

  test("days-old data renders 'Nd ago'", () => {
    expect(staleSuffix(new Date("2026-07-12T12:00:00Z").toISOString(), now)).toContain("3d ago");
  });

  test("a future timestamp (clock skew) produces no suffix rather than a negative age", () => {
    expect(staleSuffix(new Date("2026-07-15T13:00:00Z").toISOString(), now)).toBeUndefined();
  });
});
