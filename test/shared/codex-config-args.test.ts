import { describe, expect, test } from "bun:test";
import { codexSubcommandConfigArgs } from "../../src/shared/codex-config-args.ts";

describe("Codex subcommand config placement", () => {
  test("moves shared, memory and caller root overrides before app-server overrides", () => {
    const root = ["-c", 'developer_instructions="memory"', "-c", "mcp_servers={graph={command=\"false\"}}",
      "--config=model=\"root-model\""];
    const child = ["--stdio", "-c", "features.hooks=false", "--config", 'model="child-model"'];
    expect(codexSubcommandConfigArgs([...root, "app-server", ...child]))
      .toEqual(["app-server", ...root, ...child]);
  });

  test("handles exec and its alias while preserving explicit child precedence", () => {
    for (const command of ["exec", "e"]) {
      expect(codexSubcommandConfigArgs(["-cmodel=\"root\"", command, "-c", 'model="child"', "hello"]))
        .toEqual([command, "-cmodel=\"root\"", "-c", 'model="child"', "hello"]);
    }
  });

  test("does not confuse root option values with subcommands", () => {
    expect(codexSubcommandConfigArgs(["--cd", "app-server", "-m", "exec", "-c", "features.hooks=true",
      "app-server", "--stdio", "-c", "features.hooks=false"]))
      .toEqual(["--cd", "app-server", "-m", "exec", "app-server", "-c", "features.hooks=true",
        "--stdio", "-c", "features.hooks=false"]);
  });

  test("leaves prompts, delimiters, other commands and malformed options unchanged", () => {
    for (const args of [
      ["-c", "x=1", "--", "app-server", "-c", "x=2"],
      ["-c", "x=1", "hello", "exec"],
      ["-c", "x=1", "mcp", "list", "--json"],
      ["-c", "x=1", "--unknown", "app-server"],
      ["-c"],
      ["app-server", "-c", "features.hooks=false"],
    ]) expect(codexSubcommandConfigArgs(args)).toBe(args);
  });

  test("a second placement pass is idempotent", () => {
    const once = codexSubcommandConfigArgs(["-c", "model=\"shared\"", "app-server", "--stdio"]);
    expect(codexSubcommandConfigArgs(once)).toBe(once);
  });
});
