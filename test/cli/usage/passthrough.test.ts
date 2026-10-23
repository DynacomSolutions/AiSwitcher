import { describe, expect, test } from "bun:test";
import { runPassthrough } from "../../../src/cli/usage/passthrough.ts";

describe("shared Tokscale TUI passthrough", () => {
  test("rejects --tool instead of silently ignoring the partition filter", async () => {
    await expect(runPassthrough({ tool: "codex" }, ["tui"])).rejects.toThrow(
      "--tool cannot select one partition in shared Tokscale TUI mode",
    );
  });

  test("rejects --identity instead of silently showing every partition", async () => {
    await expect(runPassthrough({ identity: "work" }, ["tui"])).rejects.toThrow(
      "--identity cannot select a partition in shared Tokscale TUI mode",
    );
  });
});
