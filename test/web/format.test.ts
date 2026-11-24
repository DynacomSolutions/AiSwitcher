import { describe, expect, test } from "bun:test";
import { countdownUntil, formatCount, formatMoney } from "../../apps/web/src/lib/format.ts";

describe("money and count formatting matches the CLI", () => {
  test("money groups thousands and always has 2 decimals", () => {
    expect(formatMoney(161422.4)).toBe("$161,422.40");
    expect(formatMoney(155038.014)).toBe("$155,038.01");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(5)).toBe("$5.00");
    expect(formatMoney(1234567.891)).toBe("$1,234,567.89");
    expect(formatMoney(Number.NaN)).toBe("$0.00");
  });
  test("counts are full numbers with commas", () => {
    expect(formatCount(4453134113)).toBe("4,453,134,113");
    expect(formatCount(2483485.4)).toBe("2,483,485");
    expect(formatCount(0)).toBe("0");
  });
});

const NOW = Date.parse("2026-11-19T06:00:00.000Z");
const MIN = 60_000;

describe("countdownUntil", () => {
  test("days and hours drop the minutes", () => {
    expect(countdownUntil(NOW + (2 * 24 + 3) * 60 * MIN + 14 * MIN, NOW)).toBe("2d 3h");
  });
  test("hours and minutes below one day", () => {
    expect(countdownUntil(NOW + (3 * 60 + 14) * MIN, NOW)).toBe("3h 14m");
  });
  test("minutes only below one hour", () => {
    expect(countdownUntil(NOW + 14 * MIN, NOW)).toBe("14m");
    expect(countdownUntil(NOW + 59 * MIN + 59_000, NOW)).toBe("59m");
  });
  test("under one minute reads now", () => {
    expect(countdownUntil(NOW + 30_000, NOW)).toBe("now");
    expect(countdownUntil(NOW, NOW)).toBe("now");
  });
  test("a past instant reads now and never goes negative", () => {
    expect(countdownUntil(NOW - 5 * MIN, NOW)).toBe("now");
    expect(countdownUntil(NOW - 3 * 24 * 60 * MIN, NOW)).toBe("now");
  });
  test("unit boundaries keep the coarser pair", () => {
    expect(countdownUntil(NOW + 60 * MIN, NOW)).toBe("1h 0m");
    expect(countdownUntil(NOW + (23 * 60 + 59) * MIN, NOW)).toBe("23h 59m");
    expect(countdownUntil(NOW + 24 * 60 * MIN, NOW)).toBe("1d 0h");
  });
});
