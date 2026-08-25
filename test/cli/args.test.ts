import { describe, expect, test } from "bun:test";
import { boolFlag, listFlag, parseArgs, requireFlag, stringFlag } from "../../src/cli/args.ts";
import { CliUsageError } from "../../src/cli/errors.ts";

describe("parseArgs", () => {
  test("splits positionals from --flag=value and bare --flag", () => {
    const { positionals, flags } = parseArgs([
      "identities",
      "create",
      "--tool=codex",
      "--yes",
      "--label=Identity A",
    ]);
    expect(positionals).toEqual(["identities", "create"]);
    expect(flags).toEqual({ tool: "codex", yes: true, label: "Identity A" });
  });

  test("a value containing '=' is preserved after the first '='", () => {
    const { flags } = parseArgs(["--description=a=b=c"]);
    expect(flags.description).toBe("a=b=c");
  });

  test("no args -> empty positionals and flags", () => {
    expect(parseArgs([])).toEqual({ positionals: [], flags: {} });
  });
});

describe("stringFlag", () => {
  test("returns the value when given as --flag=value", () => {
    expect(stringFlag({ tool: "claude" }, "tool")).toBe("claude");
  });

  test("returns undefined when the flag is absent", () => {
    expect(stringFlag({}, "tool")).toBeUndefined();
  });

  test("throws when the flag was given with no value", () => {
    expect(() => stringFlag({ tool: true }, "tool")).toThrow(CliUsageError);
  });
});

describe("requireFlag", () => {
  test("returns the value when present", () => {
    expect(requireFlag({ tool: "codex" }, "tool")).toBe("codex");
  });

  test("throws when absent", () => {
    expect(() => requireFlag({}, "tool")).toThrow(CliUsageError);
  });
});

describe("boolFlag", () => {
  test("true for a bare flag or explicit 'true'", () => {
    expect(boolFlag({ yes: true }, "yes")).toBe(true);
    expect(boolFlag({ yes: "true" }, "yes")).toBe(true);
  });

  test("false when absent or any other value", () => {
    expect(boolFlag({}, "yes")).toBe(false);
    expect(boolFlag({ yes: "no" }, "yes")).toBe(false);
  });
});

describe("listFlag", () => {
  test("splits and trims a comma-separated value", () => {
    expect(listFlag({ aliases: "a, b ,c" }, "aliases")).toEqual(["a", "b", "c"]);
  });

  test("drops empty segments", () => {
    expect(listFlag({ aliases: "a,,b," }, "aliases")).toEqual(["a", "b"]);
  });

  test("returns undefined when absent", () => {
    expect(listFlag({}, "aliases")).toBeUndefined();
  });
});
