import { describe, expect, test } from "bun:test";
import { calendarDayCount, localDateKey, startOfLocalDay } from "../../../src/cli/usage/local-day.ts";

describe("startOfLocalDay", () => {
  test("zeroes out the time-of-day, keeping the local calendar date", () => {
    const ms = new Date(2026, 5, 15, 23, 59, 59).getTime();
    const start = startOfLocalDay(ms);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(5);
    expect(start.getDate()).toBe(15);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
  });
});

describe("localDateKey", () => {
  test("formats as zero-padded YYYY-MM-DD", () => {
    expect(localDateKey(new Date(2026, 0, 5, 10).getTime())).toBe("2026-01-05");
    expect(localDateKey(new Date(2026, 10, 23, 10).getTime())).toBe("2026-11-23");
  });
});

describe("calendarDayCount", () => {
  test("same calendar day, regardless of time-of-day, is 1 day — not 0 and not rounded up to 2", () => {
    const morning = new Date(2026, 2, 10, 0, 1).getTime();
    const night = new Date(2026, 2, 10, 23, 59).getTime();
    expect(calendarDayCount(morning, night)).toBe(1);
  });

  test("a span just under 24h that crosses midnight is 2 calendar days, not 1", () => {
    const lateNight = new Date(2026, 2, 10, 23, 0).getTime();
    const nextMorning = new Date(2026, 2, 11, 1, 0).getTime();
    expect(calendarDayCount(lateNight, nextMorning)).toBe(2);
  });

  test("exactly N whole days apart is N+1 inclusive days", () => {
    const start = new Date(2026, 2, 1, 8, 0).getTime();
    const end = new Date(2026, 2, 10, 8, 0).getTime();
    expect(calendarDayCount(start, end)).toBe(10);
  });
});
