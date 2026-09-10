import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  classifyToolCall,
  clampBreakdownDays,
  collectIdentityBreakdown,
  formatBreakdownReport,
  splitEvenly,
  type BreakdownDeps,
  type BreakdownResult,
} from "../../../src/cli/usage/breakdown.ts";
import type { Identity } from "../../../src/identities/types.ts";

/** A synthetic in-memory "configDir": collector suites never touch the real
 * home. readdir/isDirectory/mtimeMs back listRecentFiles; readLines feeds
 * the streaming readers. */
interface FakeFile {
  mtimeMs: number;
  lines: string[];
}
function fakeDeps(files: Record<string, FakeFile>): BreakdownDeps {
  const paths = Object.keys(files);
  return {
    // Immediate children only, including implicitly-created directories:
    // listRecentFiles treats a failing readdir as an unreadable root.
    readdir: (path) => {
      const prefix = `${path}/`;
      const kids = new Set<string>();
      for (const p of paths) {
        if (!p.startsWith(prefix)) continue;
        kids.add(p.slice(prefix.length).split("/")[0]!);
      }
      return [...kids];
    },
    isDirectory: (path) => paths.some((p) => p.startsWith(`${path}/`)),
    // Directories are not real files here: always report them fresh.
    mtimeMs: (path) => files[path]?.mtimeMs ?? NOW_MS,
    readLines: async function* (path: string) {
      for (const line of files[path]?.lines ?? []) yield line;
    },
    now: () => new Date("2026-09-10T12:00:00.000Z"),
  };
}

function identity(configDir = "/synthetic/SYNTHETIC_FIXTURE/config"): Identity {
  return { name: "fixture", label: "Fixture", configDir };
}

const NOW_MS = Date.parse("2026-09-10T12:00:00.000Z");
const day = (offset: number, hour = 12) => new Date(NOW_MS - offset * 86_400_000 - (12 - hour) * 3_600_000).toISOString();

function claudeAssistantLine(opts: {
  at: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  tools?: string[];
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: opts.at,
    message: {
      role: "assistant",
      model: opts.model ?? "claude-sonnet-5",
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheWrite ?? 0,
      },
      content: [
        { type: "thinking", thinking: "..." },
        ...(opts.tools ?? []).map((name) => ({ type: "tool_use", id: "t", name, input: {} })),
        { type: "text", text: "done" },
      ],
    },
  });
}

function codexRolloutLines(opts: {
  model: string;
  turnId: string;
  calls?: Array<{ name: string; at: string }>;
  deltas?: Array<{ at: string; input: number; cached: number; cacheWrite: number; output: number }>;
}): string[] {
  const lines: string[] = [
    JSON.stringify({ timestamp: opts.calls?.[0]?.at ?? day(1), type: "turn_context", payload: { turn_id: opts.turnId, model: opts.model } }),
  ];
  for (const call of opts.calls ?? []) {
    lines.push(JSON.stringify({ timestamp: call.at, type: "response_item", payload: { type: "function_call", name: call.name, call_id: "c" } }));
  }
  for (const d of opts.deltas ?? []) {
    lines.push(
      JSON.stringify({
        timestamp: d.at,
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: { input_tokens: d.input, cached_input_tokens: d.cached, cache_write_input_tokens: d.cacheWrite, output_tokens: d.output } } },
      }),
    );
  }
  return lines;
}

async function claudeResult(files: Record<string, FakeFile>, days = 30): Promise<BreakdownResult> {
  return collectIdentityBreakdown("claude", identity(), days, fakeDeps(files));
}

async function codexResult(files: Record<string, FakeFile>, days = 30): Promise<BreakdownResult> {
  return collectIdentityBreakdown("codex", identity(), days, fakeDeps(files));
}

function category(result: BreakdownResult, name: string) {
  const found = result.categories.find((c) => c.name === name);
  expect(found).toBeDefined();
  return found!;
}

describe("classifyToolCall", () => {
  test("routes mcp__server__tool to an mcp server rollup", () => {
    const classified = classifyToolCall("mcp__chrome-devtools__evaluate_script");
    expect(classified.kind).toBe("mcp");
    expect(classified.server).toBe("chrome-devtools");
    expect(classified.name).toBe("mcp:chrome-devtools");
    expect(classified.detail).toBe("mcp__chrome-devtools__evaluate_script");
  });

  test("groups edit/write tools, web tools and plain built-ins", () => {
    expect(classifyToolCall("Edit").kind).toBe("edit");
    expect(classifyToolCall("Write").kind).toBe("edit");
    expect(classifyToolCall("NotebookEdit").kind).toBe("edit");
    expect(classifyToolCall("apply_patch").kind).toBe("edit");
    expect(classifyToolCall("WebFetch").kind).toBe("web");
    expect(classifyToolCall("WebSearch").kind).toBe("web");
    expect(classifyToolCall("Bash").kind).toBe("tool");
    expect(classifyToolCall("Agent").kind).toBe("tool");
  });
});

describe("splitEvenly", () => {
  test("sums back to the total and spreads the remainder", () => {
    expect(splitEvenly(400, 2)).toEqual([200, 200]);
    expect(splitEvenly(403, 2)).toEqual([202, 201]);
    expect(splitEvenly(1, 3)).toEqual([1, 0, 0]);
    expect(splitEvenly(10, 0)).toEqual([]);
  });
});

describe("claude breakdown", () => {
  test("attributes input/cache to conversation and splits output across tool calls", async () => {
    const result = await claudeResult({
      "/synthetic/SYNTHETIC_FIXTURE/config/projects/proj/a.jsonl": {
        mtimeMs: NOW_MS,
        lines: [
          claudeAssistantLine({ at: day(1), input: 100, output: 403, cacheRead: 50, cacheWrite: 10, tools: ["Bash", "mcp__github__create_issue"] }),
          // No tool calls: output stays on the conversation row.
          claudeAssistantLine({ at: day(0), input: 5, output: 30, tools: [] }),
        ],
      },
    });

    expect(result.unavailable).toBeUndefined();
    expect(result.filesRead).toBe(1);
    expect(result.windowDays).toBe(30);

    const conversation = category(result, "conversation");
    expect(conversation.kind).toBe("conversation");
    expect(conversation.inputTokens).toBe(105);
    expect(conversation.cacheReadTokens).toBe(50);
    expect(conversation.cacheWriteTokens).toBe(10);
    expect(conversation.outputTokens).toBe(30);
    expect(conversation.callCount).toBe(2);

    const bash = category(result, "Bash");
    expect(bash.outputTokens).toBe(202);
    expect(bash.callCount).toBe(1);
    expect(bash.inputTokens).toBe(0);

    const mcp = category(result, "mcp:github");
    expect(mcp.kind).toBe("mcp");
    expect(mcp.server).toBe("github");
    expect(mcp.outputTokens).toBe(201);
    expect(mcp.tools).toHaveLength(1);
    expect(mcp.tools![0]!.name).toBe("mcp__github__create_issue");
    expect(mcp.tools![0]!.outputTokens).toBe(201);
  });

  test("rolls two tools of one server into one mcp row with per-tool detail", async () => {
    const result = await claudeResult({
      "/synthetic/SYNTHETIC_FIXTURE/config/projects/proj/a.jsonl": {
        mtimeMs: NOW_MS,
        lines: [
          claudeAssistantLine({ at: day(1), output: 300, tools: ["mcp__playwright__browser_navigate", "mcp__playwright__browser_click"] }),
        ],
      },
    });
    const mcp = category(result, "mcp:playwright");
    expect(mcp.callCount).toBe(2);
    expect(mcp.outputTokens).toBe(300);
    expect(mcp.tools!.map((t) => t.name).sort()).toEqual(["mcp__playwright__browser_click", "mcp__playwright__browser_navigate"]);
    // Only the server rollup sits at the top level.
    expect(result.categories.filter((c) => c.kind === "mcp")).toHaveLength(1);
  });

  test("groups edit tools as kind edit and prices known models", async () => {
    const result = await claudeResult({
      "/synthetic/SYNTHETIC_FIXTURE/config/projects/proj/a.jsonl": {
        mtimeMs: NOW_MS,
        lines: [claudeAssistantLine({ at: day(1), output: 1000, tools: ["Edit", "Write"] })],
      },
    });
    const editRows = result.categories.filter((c) => c.kind === "edit");
    expect(editRows.map((r) => r.name).sort()).toEqual(["Edit", "Write"]);
    // 1000 output split evenly across the two edit calls.
    expect(editRows.reduce((sum, r) => sum + r.outputTokens, 0)).toBe(1000);
    // claude-sonnet-5 list rate: 1000 output tokens at $10/1M = $0.01.
    expect(editRows.reduce((sum, r) => sum + r.estCostUsd, 0)).toBeCloseTo(0.01, 6);
  });

  test("skips torn trailing lines and out-of-window entries", async () => {
    const result = await claudeResult({
      "/synthetic/SYNTHETIC_FIXTURE/config/projects/proj/a.jsonl": {
        mtimeMs: NOW_MS,
        lines: [
          claudeAssistantLine({ at: day(40), output: 999_999, tools: ["Bash"] }), // outside the 30-day window
          claudeAssistantLine({ at: day(1), output: 100, tools: ["Read"] }),
          `{"type":"assistant","timestamp":"${day(0)}","message":{"usage":{"output_tok`, // torn tail
        ],
      },
    });
    expect(result.categories.some((c) => c.outputTokens === 999_999)).toBe(false);
    expect(category(result, "Read").outputTokens).toBe(100);
    expect(result.categories).toHaveLength(2); // conversation + Read
  });

  test("mtime-pruned files are not read at all", async () => {
    const result = await claudeResult({
      "/synthetic/SYNTHETIC_FIXTURE/config/projects/proj/old.jsonl": {
        mtimeMs: NOW_MS - 40 * 86_400_000,
        lines: [claudeAssistantLine({ at: day(1), output: 500, tools: ["Bash"] })],
      },
    });
    expect(result.filesRead).toBe(0);
    expect(result.categories).toHaveLength(0);
  });

  test("notes models with tokens but no list price", async () => {
    const result = await claudeResult({
      "/synthetic/SYNTHETIC_FIXTURE/config/projects/proj/a.jsonl": {
        mtimeMs: NOW_MS,
        lines: [claudeAssistantLine({ at: day(1), output: 100, model: "mystery-model-x", tools: ["Bash"] })],
      },
    });
    expect(result.notes?.[0]).toContain("mystery-model-x");
  });
});

describe("codex breakdown", () => {
  test("splits a turn's output deltas across the turn's calls", async () => {
    const result = await codexResult({
      "/synthetic/SYNTHETIC_FIXTURE/config/sessions/2026/09/09/rollout.jsonl": {
        mtimeMs: NOW_MS,
        lines: codexRolloutLines({
          model: "gpt-5.6-luna",
          turnId: "turn-1",
          calls: [
            { name: "exec", at: day(1, 10) },
            { name: "apply_patch", at: day(1, 11) },
          ],
          deltas: [{ at: day(1, 12), input: 1000, cached: 200, cacheWrite: 100, output: 301 }],
        }),
      },
    });

    const conversation = category(result, "conversation");
    // Codex input_tokens cover the cached subsets: 1000 = 700 new + 200 read + 100 write.
    expect(conversation.inputTokens).toBe(700);
    expect(conversation.cacheReadTokens).toBe(200);
    expect(conversation.cacheWriteTokens).toBe(100);

    const exec = category(result, "exec");
    expect(exec.callCount).toBe(1);
    expect(exec.outputTokens).toBe(151); // 301 split over 2 calls
    const patch = category(result, "apply_patch");
    expect(patch.kind).toBe("edit");
    expect(patch.outputTokens).toBe(150);
  });

  test("keeps call-less turns on the conversation row and tracks the turn model", async () => {
    const result = await codexResult({
      "/synthetic/SYNTHETIC_FIXTURE/config/sessions/2026/09/09/rollout.jsonl": {
        mtimeMs: NOW_MS,
        lines: [
          ...codexRolloutLines({ model: "gpt-5.6-luna", turnId: "t1", deltas: [{ at: day(1), input: 10, cached: 0, cacheWrite: 0, output: 50 }] }),
          ...codexRolloutLines({ model: "gpt-5.6-terra", turnId: "t2", calls: [{ name: "exec", at: day(0) }], deltas: [{ at: day(0), input: 10, cached: 0, cacheWrite: 0, output: 60 }] }),
        ],
      },
    });
    const conversation = category(result, "conversation");
    expect(conversation.outputTokens).toBe(50);
    const exec = category(result, "exec");
    expect(exec.outputTokens).toBe(60);
    // exec: gpt-5.6-terra output at $12/1M. conversation: 50 luna output at
    // $1.2/1M plus each turn's 10 new input tokens (10 at luna $0.2/1M,
    // 10 at terra $2/1M).
    expect(exec.estCostUsd).toBeCloseTo((60 * 12) / 1_000_000, 8);
    expect(conversation.estCostUsd).toBeCloseTo((50 * 1.2 + 10 * 0.2 + 10 * 2) / 1_000_000, 8);
  });

  test("excludes out-of-window calls and deltas", async () => {
    const result = await codexResult({
      "/synthetic/SYNTHETIC_FIXTURE/config/sessions/2026/09/09/rollout.jsonl": {
        mtimeMs: NOW_MS,
        lines: codexRolloutLines({
          model: "gpt-5.6-luna",
          turnId: "t1",
          calls: [
            { name: "exec", at: day(60) },
            { name: "wait", at: day(1) },
          ],
          deltas: [
            { at: day(60), input: 5, cached: 0, cacheWrite: 0, output: 9_999 },
            { at: day(1), input: 5, cached: 0, cacheWrite: 0, output: 10 },
          ],
        }),
      },
    });
    expect(result.categories.some((c) => c.outputTokens === 9_999)).toBe(false);
    expect(result.categories.some((c) => c.name === "exec")).toBe(false);
    expect(category(result, "wait").outputTokens).toBe(10);
  });
});

describe("unavailable tools", () => {
  test("grok degrades with its real reason and no fabricated rows", async () => {
    const result = await collectIdentityBreakdown("grok", identity(), 30, fakeDeps({}));
    expect(result.unavailable).toContain("no token usage");
    expect(result.categories).toHaveLength(0);
  });

  test("every tool without a reader answers unavailable", async () => {
    for (const tool of ["kimi", "zai", "ali", "pi", "opencode"] as const) {
      const result = await collectIdentityBreakdown(tool, identity(), 30, fakeDeps({}));
      expect(result.unavailable, tool).toBeDefined();
    }
  });
});

describe("misc", () => {
  test("days clamp into the supported range", () => {
    expect(clampBreakdownDays(0)).toBe(30);
    expect(clampBreakdownDays(7)).toBe(7);
    expect(clampBreakdownDays(100000)).toBe(365);
    expect(clampBreakdownDays(Number.NaN)).toBe(30);
  });

  test("a tool with no logs at all reports no categories, not unavailable", async () => {
    const result = await claudeResult({});
    expect(result.unavailable).toBeUndefined();
    expect(result.categories).toHaveLength(0);
  });

  test("categories sort cost-desc and the render lists rows plus unavailable", async () => {
    const result = await claudeResult({
      "/synthetic/SYNTHETIC_FIXTURE/config/projects/proj/a.jsonl": {
        mtimeMs: NOW_MS,
        lines: [
          claudeAssistantLine({ at: day(1), output: 1000, tools: ["Bash"] }),
          claudeAssistantLine({ at: day(1), output: 100, tools: ["Read"] }),
        ],
      },
    });
    const costs = result.categories.map((c) => c.estCostUsd);
    expect([...costs].sort((a, b) => b - a)).toEqual(costs);

    const grok = await collectIdentityBreakdown("grok", identity(), 30, fakeDeps({}));
    const rendered = formatBreakdownReport([result, grok]);
    expect(rendered).toContain("Bash");
    expect(rendered).toContain("EST. COST");
    expect(rendered).toContain("Unavailable:");
    expect(rendered).toContain("grok/fixture");
  });
});
