import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../../src/cli/args.ts";
import { parseIntervalSeconds } from "../../../src/cli/limits/dispatch.ts";

describe("parseIntervalSeconds", () => {
  test("defaults to 30 when --interval is omitted", () => {
    expect(parseIntervalSeconds(parseArgs([]).flags)).toBe(30);
  });

  test("accepts a positive number", () => {
    expect(parseIntervalSeconds(parseArgs(["--interval=5"]).flags)).toBe(5);
  });

  test("rejects zero, negative, and non-numeric values", () => {
    expect(() => parseIntervalSeconds(parseArgs(["--interval=0"]).flags)).toThrow();
    expect(() => parseIntervalSeconds(parseArgs(["--interval=-5"]).flags)).toThrow();
    expect(() => parseIntervalSeconds(parseArgs(["--interval=abc"]).flags)).toThrow();
  });

  test("a bare --interval with no value is a usage error (matches stringFlag's convention)", () => {
    expect(() => parseIntervalSeconds(parseArgs(["--interval"]).flags)).toThrow();
  });
});
