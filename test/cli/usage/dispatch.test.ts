import { describe, expect, test } from "bun:test";
import { splitPassthroughArgs } from "../../../src/cli/usage/dispatch.ts";

describe("splitPassthroughArgs", () => {
  test("only our own recognized flags, no positional/unrecognized flag: not a passthrough invocation", () => {
    expect(splitPassthroughArgs(["--identity=identity-a", "--json"])).toBeUndefined();
    expect(splitPassthroughArgs(["--tool=codex"])).toBeUndefined();
    expect(splitPassthroughArgs([])).toBeUndefined();
  });

  test("a bare subcommand triggers passthrough with no '--' needed", () => {
    expect(splitPassthroughArgs(["tui"])).toEqual({ ownArgs: [], tokscaleArgs: ["tui"] });
    expect(splitPassthroughArgs(["--identity=personal", "monthly"])).toEqual({
      ownArgs: ["--identity=personal"],
      tokscaleArgs: ["monthly"],
    });
  });

  test("an unrecognized flag (tokscale's own, e.g. --group-by) also triggers passthrough with no '--' needed", () => {
    expect(splitPassthroughArgs(["--group-by", "workspace,model"])).toEqual({
      ownArgs: [],
      tokscaleArgs: ["--group-by", "workspace,model"],
    });
    expect(splitPassthroughArgs(["--identity=work", "--client", "codex"])).toEqual({
      ownArgs: ["--identity=work"],
      tokscaleArgs: ["--client", "codex"],
    });
  });

  test("splits our own flags from the raw tokscale args after '--'", () => {
    expect(splitPassthroughArgs(["--identity=identity-a", "--", "tui"])).toEqual({
      ownArgs: ["--identity=identity-a"],
      tokscaleArgs: ["tui"],
    });
  });

  test("tokscale args keep their own space-separated flag syntax untouched", () => {
    expect(splitPassthroughArgs(["--", "graph", "--output", "out.json"])).toEqual({
      ownArgs: [],
      tokscaleArgs: ["graph", "--output", "out.json"],
    });
  });

  test("a bare '--' with nothing after it is still a valid (empty) passthrough", () => {
    expect(splitPassthroughArgs(["--identity=identity-a", "--"])).toEqual({
      ownArgs: ["--identity=identity-a"],
      tokscaleArgs: [],
    });
  });
});
