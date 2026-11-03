import { describe, expect, test } from "bun:test";
import { formatCount, formatMoney } from "../../apps/web/src/lib/format.ts";

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
