import { describe, expect, test } from "bun:test";
import { idleCheckIntervalMs, isIdleTooLong } from "../../src/server/serve.ts";

/**
 * The idle-shutdown timer's decision logic, tested as a pure function
 * rather than by booting a real Bun.serve instance: the real path ends in
 * `process.exit(0)`, which is not something a test process can safely
 * trigger. See src/cli/herdr.ts and src/cli/web.ts for the plumbing that
 * turns this on for a console daemon `ais herdr` spawns implicitly.
 */
describe("isIdleTooLong", () => {
  test("false while inside the idle window", () => {
    const now = 1_000_000;
    expect(isIdleTooLong(now - 1_000, now, 10 * 60_000)).toBe(false);
  });

  test("true once the idle window has elapsed", () => {
    const now = 1_000_000;
    expect(isIdleTooLong(now - 10 * 60_000, now, 10 * 60_000)).toBe(true);
  });

  test("any request resets the window (fresh lastActivityMs is never idle)", () => {
    const now = 1_000_000;
    expect(isIdleTooLong(now, now, 1)).toBe(false);
  });
});

describe("idleCheckIntervalMs", () => {
  test("quarters the idle window, clamped to [1s, 30s]", () => {
    expect(idleCheckIntervalMs(10 * 60_000)).toBe(30_000); // clamped down
    expect(idleCheckIntervalMs(4_000)).toBe(1_000); // clamped up
    expect(idleCheckIntervalMs(20_000)).toBe(5_000); // unclamped quarter
  });
});
