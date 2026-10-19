import { describe, expect, test } from "bun:test";
import { CliUsageError } from "../../src/cli/errors";
import { runLocalCommand, type LocalDeps } from "../../src/cli/local/dispatch";
import type { LocalModel } from "../../src/shared/local-models";

const MIB = 1024 * 1024;
const tiny: LocalModel = { name: "tiny", path: "/a/tiny.gguf", sizeBytes: MIB };
const other: LocalModel = { name: "other", path: "/a/other.gguf", sizeBytes: 3 * MIB };

function setup(models: LocalModel[], ...r: [runner?: string | null]) {
  const runner = r.length ? (r[0] ?? undefined) : "/bin/llama-cli";
  const out: string[] = [];
  const started: Array<[LocalModel, string]> = [];
  const deps: LocalDeps = {
    discover: async () => models,
    runner: () => runner,
    dirs: () => ["/a", "/b"],
    start: async (m, r) => {
      started.push([m, r]);
      return undefined as never;
    },
    log: (line) => out.push(line),
  };
  const run = (rest: string[], flags: Record<string, string | true> = {}) => runLocalCommand(rest, flags, deps);
  return { out, started, run };
}

describe("ais local", () => {
  test("list prints name, size and path for each model", async () => {
    const { out, run } = setup([tiny]);
    await run([]);
    const text = out.join("\n");
    expect(text).toContain("tiny");
    expect(text).toContain("1 MiB");
    expect(text).toContain("/a/tiny.gguf");
  });

  test("list --json prints { runner, models }", async () => {
    const { out, run } = setup([tiny]);
    await run(["list"], { json: true });
    expect(JSON.parse(out.join("\n"))).toEqual({ runner: "/bin/llama-cli", models: [tiny] });
  });

  test("list with no model names the searched directories", async () => {
    const { out, run } = setup([]);
    await run(["list"]);
    expect(out.join("\n")).toContain("No local model found. Looked in: /a, /b.");
  });

  test("list notes a missing runner", async () => {
    const { out, run } = setup([tiny], null);
    await run([]);
    expect(out.join("\n")).toContain("runner missing");
  });

  test("start with one model and a runner calls start(model, runner)", async () => {
    const { started, run } = setup([tiny]);
    await run(["start"]);
    expect(started).toEqual([[tiny, "/bin/llama-cli"]]);
  });

  test("start by name picks that model", async () => {
    const { started, run } = setup([tiny, other]);
    await run(["start", "other"]);
    expect(started).toEqual([[other, "/bin/llama-cli"]]);
  });

  test("start with several models and no name throws CliUsageError listing the names", async () => {
    const { run } = setup([{ ...tiny, name: "a" }, { ...tiny, name: "b" }]);
    const err = await run(["start"]).catch((e) => e);
    expect(err).toBeInstanceOf(CliUsageError);
    expect(err.message).toMatch(/Choose one of: a, b/);
  });

  test("start with an unknown name throws CliUsageError", async () => {
    const { run } = setup([tiny]);
    const err = await run(["start", "zz"]).catch((e) => e);
    expect(err).toBeInstanceOf(CliUsageError);
    expect(err.message).toMatch(/Unknown local model "zz"/);
  });

  test("start with no model throws CliUsageError", async () => {
    const { started, run } = setup([]);
    await expect(run(["start"])).rejects.toThrow(/No local model found/);
    expect(started).toEqual([]);
  });

  test("start with no runner throws and never calls start", async () => {
    const { started, run } = setup([tiny], null);
    await expect(run(["start"])).rejects.toThrow(/llama-cli/);
    expect(started).toEqual([]);
  });

  test("unknown subcommand throws CliUsageError", async () => {
    const { run } = setup([tiny]);
    const err = await run(["bogus"]).catch((e) => e);
    expect(err).toBeInstanceOf(CliUsageError);
    expect(err.message).toMatch(/Usage: ais local/);
  });
});

describe("ais help", () => {
  test("lists launch and local", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: string) => lines.push(s);
    try {
      (await import("../../src/cli/help")).runHelp();
    } finally {
      console.log = orig;
    }
    const text = lines.join("\n");
    expect(text).toContain("launch");
    expect(text).toContain("local [list|start [name]] [--json]");
  });
});
