import { afterEach, describe, expect, test } from "bun:test";
import { bold, cyan, dim, fg256, gray, green, isColorEnabled, yellow } from "../../src/cli/colors.ts";

// process.stdout.isTTY is false under `bun test`, so every wrap function is a
// no-op by default; NO_COLOR/FORCE_COLOR let us exercise both branches
// without needing a real TTY.
const ENV_KEYS = ["NO_COLOR", "FORCE_COLOR"] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("colors", () => {
  test("passes text through unchanged when not a TTY and no FORCE_COLOR", () => {
    delete process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    expect(bold("x")).toBe("x");
    expect(dim("x")).toBe("x");
    expect(green("x")).toBe("x");
    expect(yellow("x")).toBe("x");
    expect(cyan("x")).toBe("x");
    expect(gray("x")).toBe("x");
  });

  test("wraps text in ANSI codes when FORCE_COLOR is set", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    expect(bold("x")).toBe("\x1b[1mx\x1b[22m");
    expect(green("x")).toBe("\x1b[32mx\x1b[39m");
  });

  test("NO_COLOR wins over FORCE_COLOR", () => {
    process.env.FORCE_COLOR = "1";
    process.env.NO_COLOR = "1";
    expect(bold("x")).toBe("x");
  });

  test("fg256 wraps in a 256-color escape and passes through when color is off", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    expect(fg256(40)("■")).toBe("\x1b[38;5;40m■\x1b[39m");

    delete process.env.FORCE_COLOR;
    expect(fg256(40)("■")).toBe("■");
  });

  test("isColorEnabled mirrors the same NO_COLOR/FORCE_COLOR/TTY logic every wrap function uses", () => {
    delete process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    expect(isColorEnabled()).toBe(false); // not a TTY under bun test

    process.env.FORCE_COLOR = "1";
    expect(isColorEnabled()).toBe(true);

    process.env.NO_COLOR = "1";
    expect(isColorEnabled()).toBe(false);
  });
});
