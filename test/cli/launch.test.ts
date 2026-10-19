import { expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLaunchableTools, runLaunchCommand, shimLaunchArgs, type LaunchDeps } from "../../src/cli/launch.ts";
import { shimPath } from "../../src/shared/resolve-binary.ts";
import type { Identity, ToolConfig } from "../../src/identities/types.ts";

const model = { name: "tiny", path: "/models/tiny.gguf", sizeBytes: 1 };
const work = { name: "work", label: "Work" } as Identity;
const claudeFile = { identities: [work] };

function build(over: Partial<LaunchDeps> = {}) {
  const logged: string[] = [];
  const entries: Array<{ value: string; label: string }>[] = [];
  const exec = mock(async (_p: string, _a: string[]) => undefined as never);
  const startLocal = mock(async (_m: unknown, _r: string) => undefined as never);
  const promptIdentity = mock(async () => ({ identity: work, created: false }));
  const deps: LaunchDeps = {
    tools: async () => [{ cfg: { toolName: "claude" } as ToolConfig, file: claudeFile as never }],
    online: async () => true,
    localModels: async () => ({ models: [], runner: undefined }),
    selectEntry: mock(async (e: Array<{ value: string; label: string }>) => {
      entries.push(e);
      return "claude";
    }),
    promptIdentity: promptIdentity as never,
    shimExists: () => true,
    exec,
    startLocal,
    isTty: () => true,
    log: (l) => logged.push(l),
    ...over,
  };
  return { deps, logged, entries, exec, startLocal, promptIdentity };
}

test("listLaunchableTools keeps only installed tools with an active identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ais-launch-"));
  const mk = (tool: string, ids: unknown[]) => {
    const p = join(dir, `${tool}.json`);
    writeFileSync(p, JSON.stringify({ version: 1, identities: ids }));
    return { toolName: tool, realBinaryName: tool, identitiesJsonPath: p } as unknown as ToolConfig;
  };
  const id = (name: string, retired?: boolean) => ({ name, label: name, configDir: `/x/${name}`, ...(retired ? { retired } : {}) });
  const got = await listLaunchableTools({
    configs: [mk("claude", [id("a")]), mk("codex", [id("b", true)]), mk("grok", [id("c")])],
    hasBinary: (n) => n !== "grok",
  });
  expect(got.map((t) => t.cfg.toolName)).toEqual(["claude"]);
});

test("shimLaunchArgs uses --pool for a swap pool and --identity otherwise", () => {
  expect(shimLaunchArgs({ name: "p", swapPool: { accounts: ["a"] } } as Identity)).toEqual(["--pool=p"]);
  expect(shimLaunchArgs({ name: "work" } as Identity)).toEqual(["--identity=work"]);
});

test("tool then identity then exec through the shim", async () => {
  const t = build();
  await runLaunchCommand([], {}, t.deps);
  expect(t.promptIdentity).toHaveBeenCalledWith(claudeFile, { toolName: "claude" }, 60_000, undefined, undefined, "Launch claude");
  expect(t.exec).toHaveBeenCalledWith(shimPath("claude"), ["--identity=work"], {});
});

test("a chosen pool is exec'd with --pool", async () => {
  const pool = { name: "p", swapPool: { accounts: ["a"] } } as Identity;
  const t = build({ promptIdentity: (async () => ({ identity: pool, created: false })) as never });
  await runLaunchCommand([], {}, t.deps);
  expect(t.exec).toHaveBeenCalledWith(shimPath("claude"), ["--pool=p"], {});
});

test("offline: warns, tags non-local entries, lists the local model first, still allows a tool", async () => {
  const t = build({ online: async () => false, localModels: async () => ({ models: [model], runner: "/bin/llama-cli" }) });
  await runLaunchCommand([], {}, t.deps);
  expect(t.logged.join("\n")).toContain("No internet connection");
  expect(t.entries[0]![0]!.value).toBe("local");
  expect(t.entries[0]![1]!.label).toContain("(needs internet)");
  expect(t.exec).toHaveBeenCalledWith(shimPath("claude"), ["--identity=work"], { AIS_LAUNCH_OFFLINE_WARNED: "1" });
});

test("online: no warning and no tag", async () => {
  const t = build({ localModels: async () => ({ models: [model], runner: "/bin/llama-cli" }) });
  await runLaunchCommand([], {}, t.deps);
  expect(t.logged.join("\n")).not.toContain("No internet");
  expect(t.entries[0]!.map((e) => e.label).join()).not.toContain("needs internet");
});

test("local entry starts the model and never asks for an identity", async () => {
  const t = build({
    localModels: async () => ({ models: [model], runner: "/bin/llama-cli" }),
    selectEntry: (async () => "local") as never,
  });
  await runLaunchCommand([], {}, t.deps);
  expect(t.startLocal).toHaveBeenCalledWith(model, "/bin/llama-cli");
  expect(t.promptIdentity).not.toHaveBeenCalled();
});

test("a model without a runner is not offered", async () => {
  const t = build({ localModels: async () => ({ models: [model], runner: undefined }) });
  await runLaunchCommand([], {}, t.deps);
  expect(t.entries[0]!.some((e) => e.value === "local")).toBe(false);
});

test("no tools and no model throws a CliUsageError naming ais upgrade", async () => {
  const t = build({ tools: async () => [] });
  await expect(runLaunchCommand([], {}, t.deps)).rejects.toThrow(/ais upgrade/);
});

test("non-TTY stdin throws a CliUsageError before any prompt", async () => {
  const t = build({ isTty: () => false });
  await expect(runLaunchCommand([], {}, t.deps)).rejects.toThrow(/interactive/);
  expect(t.deps.selectEntry).not.toHaveBeenCalled();
});

test("missing shim throws an error that names ais update", async () => {
  const t = build({ shimExists: () => false });
  await expect(runLaunchCommand([], {}, t.deps)).rejects.toThrow(/ais update/);
  expect(t.exec).not.toHaveBeenCalled();
});

test("extra positional arguments are rejected", async () => {
  await expect(runLaunchCommand(["claude"], {}, build().deps)).rejects.toThrow(/Usage: ais launch/);
});
