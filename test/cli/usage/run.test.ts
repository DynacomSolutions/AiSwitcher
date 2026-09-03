import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliUsageError } from "../../../src/cli/errors.ts";
import {
  aggregateUsageResults,
  collectTargets,
  providerReportsFromTokscale,
  usageResultsForJson,
  type UsageResult,
} from "../../../src/cli/usage/run.ts";
import type { ToolConfig } from "../../../src/identities/types.ts";
import type { TokscaleEntry, TokscaleReport } from "../../../src/cli/usage/tokscale.ts";

// Mirrors test/cli/resolve-tool.test.ts's makeRegistry — collectTargets does
// real Bun.file I/O via loadIdentitiesFile, so exercise it against real temp
// files rather than in-memory objects, never the user's actual registries.
const tempDirs: string[] = [];

const ENV_VAR_NAMES = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  grok: "GROK_HOME",
} as const;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRegistry(toolName: "claude" | "codex" | "grok", identities: unknown[]): Promise<ToolConfig> {
  const dir = await mkdtemp(join(tmpdir(), "ais-usage-run-test-"));
  tempDirs.push(dir);
  const identitiesJsonPath = join(dir, "identities.json");
  await writeFile(identitiesJsonPath, JSON.stringify({ version: 1, identities }));
  return {
    toolName,
    realBinaryName: toolName,
    envVarName: ENV_VAR_NAMES[toolName],
    globalMemoryProjection: "claude-append-file",
    identitiesJsonPath,
    identitiesRootDir: join(dir, "identities"),
  };
}

describe("collectTargets", () => {
  test("with no filters, returns every identity across every registry", async () => {
    const claude = await makeRegistry("claude", [
      { name: "personal", label: "Personal", configDir: "/tmp/does-not-exist/personal" },
    ]);
    const codex = await makeRegistry("codex", [
      { name: "work", label: "Work", configDir: "/tmp/does-not-exist/work" },
    ]);

    const targets = await collectTargets({}, [claude, codex]);
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.toolName).sort()).toEqual(["claude", "codex"]);
  });

  test("--identity matching more than one registry returns every match, not an error", async () => {
    const claude = await makeRegistry("claude", [
      { name: "shared", label: "Shared", configDir: "/tmp/does-not-exist/shared-claude" },
    ]);
    const codex = await makeRegistry("codex", [
      { name: "shared", label: "Shared", configDir: "/tmp/does-not-exist/shared-codex" },
    ]);

    const targets = await collectTargets({ identity: "shared" }, [claude, codex]);
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.toolName).sort()).toEqual(["claude", "codex"]);
  });

  test("--identity resolves via alias too", async () => {
    const claude = await makeRegistry("claude", [
      { name: "work", label: "Work", configDir: "/tmp/does-not-exist/work", aliases: ["w"] },
    ]);

    const targets = await collectTargets({ identity: "w" }, [claude]);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.identity.name).toBe("work");
  });

  test("throws when --identity matches nothing", async () => {
    const claude = await makeRegistry("claude", []);

    await expect(collectTargets({ identity: "ghost" }, [claude])).rejects.toThrow(CliUsageError);
  });

  test("empty result (no filters, no identities anywhere) is not an error", async () => {
    const claude = await makeRegistry("claude", []);

    const targets = await collectTargets({}, [claude]);
    expect(targets).toEqual([]);
  });
});

function entry(provider: string, overrides: Partial<TokscaleEntry> = {}): TokscaleEntry {
  return {
    client: "codex",
    provider,
    model: "model",
    input: 10,
    output: 5,
    cacheRead: 20,
    cacheWrite: 2,
    reasoning: 0,
    messageCount: 1,
    cost: 0.5,
    ...overrides,
  };
}

function report(entries: TokscaleEntry[]): TokscaleReport {
  return {
    entries,
    totalInput: entries.reduce((sum, item) => sum + item.input, 0),
    totalOutput: entries.reduce((sum, item) => sum + item.output, 0),
    totalCacheRead: entries.reduce((sum, item) => sum + item.cacheRead, 0),
    totalCacheWrite: entries.reduce((sum, item) => sum + item.cacheWrite, 0),
    totalMessages: entries.reduce((sum, item) => sum + item.messageCount, 0),
    totalCost: entries.reduce((sum, item) => sum + item.cost, 0),
  };
}

describe("provider-first usage results", () => {
  const usageIdentity = { name: "work", label: "Work", configDir: "/tmp/work" };

  test("splits a client report by its recorded providers", () => {
    const results = providerReportsFromTokscale(
      { toolName: "codex", identity: usageIdentity },
      report([entry("openai"), entry("anthropic", { input: 30 })]),
    );
    expect(results.map((result) => result.provider).sort()).toEqual(["anthropic", "openai"]);
    expect(results.find((result) => result.provider === "anthropic")?.report?.totalInput).toBe(30);
  });

  test("opencode reports group under the same upstreams as other clients (zai_coding_plan -> zai), never crash on an unlisted tool", () => {
    const results = providerReportsFromTokscale(
      { toolName: "opencode", identity: usageIdentity },
      report([entry("zai_coding_plan", { client: "opencode", input: 100 }), entry("alibaba_token_plan", { client: "opencode", input: 20 })]),
    );
    expect(results.map((result) => result.provider).sort()).toEqual(["alibaba", "zai"]);
    expect(results.find((result) => result.provider === "zai")?.report?.totalInput).toBe(100);
    expect(results.find((result) => result.provider === "zai")?.identity).toBe(usageIdentity);
  });

  test("merges native and Pi traffic for the same provider and identity", () => {
    const results: UsageResult[] = [
      { provider: "openai", identity: usageIdentity, report: report([entry("openai", { input: 100 })]) },
      { provider: "openai-codex", identity: usageIdentity, report: report([entry("openai-codex", { input: 50, client: "pi" })]) },
    ];
    const merged = aggregateUsageResults(results);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.provider).toBe("openai");
    expect(merged[0]?.report?.totalInput).toBe(150);
  });

  test("does not double-count Pi CLI adapters when their native history is present", () => {
    const native: UsageResult = {
      provider: "openai",
      identity: usageIdentity,
      sourceTool: "codex",
      report: report([entry("openai", { input: 100 })]),
    };
    const piBridge: UsageResult = {
      provider: "openai",
      identity: usageIdentity,
      sourceTool: "pi",
      nativeCoverageTool: "codex",
      report: report([entry("openai", { input: 50, client: "pi" })]),
    };
    expect(aggregateUsageResults([native, piBridge])[0]?.report?.totalInput).toBe(100);
    expect(aggregateUsageResults([piBridge])[0]?.report?.totalInput).toBe(50);
  });

  test("an empty tokscale report renders no row unless the source was explicitly asked for", () => {
    // A registered-but-never-used client otherwise shows up as a "0 messages"
    // row under a pseudo-provider label — noise in a provider-first view.
    const target = { toolName: "opencode" as const, identity: usageIdentity };
    expect(providerReportsFromTokscale(target, report([]))).toEqual([]);
    const explicit = providerReportsFromTokscale(target, report([]), { explicitTool: true });
    expect(explicit).toHaveLength(1);
    expect(explicit[0]!.provider).toBe("opencode");
    expect(explicit[0]!.report?.entries).toHaveLength(0);
  });

  test("JSON exposes providers and models, not wrapper/client names", () => {
    const [json] = usageResultsForJson([
      {
        provider: "openai",
        identity: usageIdentity,
        sourceTool: "pi",
        nativeCoverageTool: "codex",
        report: report([entry("openai")]),
      },
    ]) as Array<Record<string, unknown>>;
    expect(json).not.toHaveProperty("toolName");
    expect(json).not.toHaveProperty("sourceTool");
    expect(json).not.toHaveProperty("nativeCoverageTool");
    const jsonReport = json!.report as { entries: Array<Record<string, unknown>> };
    expect(jsonReport.entries[0]).not.toHaveProperty("client");
    expect(jsonReport.entries[0]?.provider).toBe("openai");
  });
});

describe("source-only error results", () => {
  const usageIdentity = { name: "work", label: "Work", configDir: "/tmp/work" };

  test("pass through aggregation unmerged — each source's failure stays its own footer line", () => {
    const piFailure: UsageResult = {
      provider: "unattributed", identity: usageIdentity, sourceTool: "pi", sourceOnlyError: true, error: "pi boom",
    };
    const opencodeFailure: UsageResult = {
      provider: "unattributed", identity: usageIdentity, sourceTool: "opencode", sourceOnlyError: true, error: "opencode boom",
    };
    const merged = aggregateUsageResults([piFailure, opencodeFailure]);
    expect(merged).toHaveLength(2);
    expect(merged.map((r) => r.sourceTool).sort()).toEqual(["opencode", "pi"]);
  });

  test("are stripped from JSON output like the other internal provenance", () => {
    const [json] = usageResultsForJson([
      { provider: "unattributed", identity: usageIdentity, sourceTool: "pi", sourceOnlyError: true, error: "boom" },
    ]) as Array<Record<string, unknown>>;
    expect(json).not.toHaveProperty("sourceOnlyError");
    expect(json).not.toHaveProperty("sourceTool");
    expect(json?.error).toBe("boom");
  });
});
