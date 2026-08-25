import { describe, expect, test } from "bun:test";
import { detectNonInteractiveHint, resolveNestedIdentity, stripOwnFlags } from "../src/shared/cli-args.ts";

describe("stripOwnFlags", () => {
  test("--identity=<name> is stripped and captured", () => {
    const result = stripOwnFlags(["--identity=work", "--print", "hello"]);
    expect(result.identityFlag).toBe("work");
    expect(result.cleanedArgv).toEqual(["--print", "hello"]);
  });

  test("--id=<name> shorthand is equivalent to --identity=<name>", () => {
    const result = stripOwnFlags(["--id=work", "--print", "hello"]);
    expect(result.identityFlag).toBe("work");
    expect(result.cleanedArgv).toEqual(["--print", "hello"]);
  });

  test("--desktop is stripped and flagged", () => {
    const result = stripOwnFlags(["--id=work", "--desktop"]);
    expect(result.desktopFlag).toBe(true);
    expect(result.cleanedArgv).toEqual([]);
  });

  test("codex's native -i/--image is left untouched (only --id is ours)", () => {
    const result = stripOwnFlags(["-i", "photo.png", "describe this"]);
    expect(result.identityFlag).toBeUndefined();
    expect(result.cleanedArgv).toEqual(["-i", "photo.png", "describe this"]);
  });

  test("after a bare -- end-of-options token, our flags are forwarded literally", () => {
    const result = stripOwnFlags(["--", "--identity=foo", "--id=bar"]);
    expect(result.identityFlag).toBeUndefined();
    expect(result.cleanedArgv).toEqual(["--", "--identity=foo", "--id=bar"]);
  });
});

describe("detectNonInteractiveHint", () => {
  test("claude: -p/--print is non-interactive", () => {
    expect(detectNonInteractiveHint("claude", ["-p", "hello"])).toBe(true);
    expect(detectNonInteractiveHint("claude", ["--print", "hello"])).toBe(true);
    expect(detectNonInteractiveHint("claude", ["hello"])).toBe(false);
  });

  test("codex: a leading `exec` subcommand is non-interactive", () => {
    expect(detectNonInteractiveHint("codex", ["exec", "do the thing"])).toBe(true);
    expect(detectNonInteractiveHint("codex", ["app", "."])).toBe(false);
  });

  test("grok: -p/--single is non-interactive", () => {
    expect(detectNonInteractiveHint("grok", ["-p", "hello"])).toBe(true);
    expect(detectNonInteractiveHint("grok", ["--single", "hello"])).toBe(true);
  });

  test("grok: a leading `agent` subcommand is non-interactive", () => {
    expect(detectNonInteractiveHint("grok", ["agent", "stdio"])).toBe(true);
    expect(detectNonInteractiveHint("grok", ["dashboard"])).toBe(false);
  });

  test("grok: a plain prompt is interactive", () => {
    expect(detectNonInteractiveHint("grok", ["fix the bug"])).toBe(false);
  });

  test("kimi: -p/--prompt is non-interactive", () => {
    expect(detectNonInteractiveHint("kimi", ["-p", "hello"])).toBe(true);
    expect(detectNonInteractiveHint("kimi", ["--prompt", "hello"])).toBe(true);
    expect(detectNonInteractiveHint("kimi", ["--prompt=hello"])).toBe(true);
    expect(detectNonInteractiveHint("kimi", ["hello"])).toBe(false);
  });

  test("kimi: a leading `acp` subcommand is non-interactive", () => {
    expect(detectNonInteractiveHint("kimi", ["acp"])).toBe(true);
    expect(detectNonInteractiveHint("kimi", ["web"])).toBe(false);
  });

  test("zai: a leading `run` subcommand is non-interactive (zai's real binary is crush)", () => {
    expect(detectNonInteractiveHint("zai", ["run", "hello"])).toBe(true);
    expect(detectNonInteractiveHint("zai", ["hello"])).toBe(false);
    expect(detectNonInteractiveHint("zai", ["-p", "hello"])).toBe(false);
  });

  test("ali: a leading `run` subcommand is non-interactive (ali's real binary is also crush)", () => {
    expect(detectNonInteractiveHint("ali", ["run", "hello"])).toBe(true);
    expect(detectNonInteractiveHint("ali", ["hello"])).toBe(false);
    expect(detectNonInteractiveHint("ali", ["-p", "hello"])).toBe(false);
  });

  test("pi: print mode and package commands are non-interactive", () => {
    expect(detectNonInteractiveHint("pi", ["-p", "hello"])).toBe(true);
    expect(detectNonInteractiveHint("pi", ["install", "npm:extension"])).toBe(true);
    expect(detectNonInteractiveHint("pi", [])).toBe(false);
  });
});

describe("resolveNestedIdentity", () => {
  test("top-level and legacy-marker invocations pass the requested identity through unchanged", () => {
    expect(resolveNestedIdentity("claude", undefined, undefined)).toBeUndefined();
    expect(resolveNestedIdentity("claude", undefined, "work")).toBe("work");
    expect(resolveNestedIdentity("claude", "1", undefined)).toBeUndefined();
    expect(resolveNestedIdentity("claude", "1", "work")).toBe("work");
  });

  test("a nested launch with no --id auto-inherits the parent's identity", () => {
    expect(resolveNestedIdentity("grok", "identity-a", undefined)).toBe("identity-a");
  });

  test("a nested launch with the matching canonical identity resolves to it (no throw)", () => {
    expect(resolveNestedIdentity("codex", "identity-a", "identity-a")).toBe("identity-a");
  });

  test("rejects a nested launch that EXPLICITLY requests a different identity", () => {
    expect(() => resolveNestedIdentity("claude", "identity-a", "personal")).toThrow(
      "active identity is 'identity-a'",
    );
  });

  test("works the same for zai as every other tool", () => {
    expect(resolveNestedIdentity("zai", "identity-a", undefined)).toBe("identity-a");
    expect(() => resolveNestedIdentity("zai", "identity-a", "personal")).toThrow("active identity is 'identity-a'");
  });

  test("works the same for ali as every other tool", () => {
    expect(resolveNestedIdentity("ali", "identity-a", undefined)).toBe("identity-a");
    expect(() => resolveNestedIdentity("ali", "identity-a", "personal")).toThrow("active identity is 'identity-a'");
  });

  test("works the same for pi as every other tool", () => {
    expect(resolveNestedIdentity("pi", "all", undefined)).toBe("all");
    expect(() => resolveNestedIdentity("pi", "all", "personal")).toThrow("active identity is 'all'");
  });
});
