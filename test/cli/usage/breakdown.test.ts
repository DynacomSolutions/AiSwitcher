import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { inferMissingRepos, orgFolderOwner, parseRemoteUrl, resolveProjectFromFs, type BreakdownProject } from "../../../src/cli/usage/breakdown.ts";
import { breakdownProjectionCachePath } from "../../../src/cli/usage/breakdown-projection-cache.ts";
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
const projectionDirs: string[] = [];
afterEach(() => { for (const dir of projectionDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const day = (offset: number, hour = 12) => new Date(NOW_MS - offset * 86_400_000 - (12 - hour) * 3_600_000).toISOString();

function claudeAssistantLine(opts: {
  at: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  tools?: string[];
  cwd?: string;
}): string {
  return JSON.stringify({
    type: "assistant",
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
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
  cwd?: string;
  calls?: Array<{ name: string; at: string }>;
  deltas?: Array<{ at: string; input: number; cached: number; cacheWrite: number; output: number }>;
}): string[] {
  const lines: string[] = [
    JSON.stringify({ timestamp: opts.calls?.[0]?.at ?? day(1), type: "turn_context", payload: { turn_id: opts.turnId, model: opts.model, ...(opts.cwd ? { cwd: opts.cwd } : {}) } }),
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
  test("marks a Claude result incomplete when a stream fails after a valid usage row", async () => {
    const files = {
      "/synthetic/SYNTHETIC_FIXTURE/config/projects/proj/a.jsonl": { mtimeMs: NOW_MS, lines: [] },
    };
    const deps = fakeDeps(files);
    deps.readLines = async function* () {
      yield claudeAssistantLine({ at: day(1), input: 100, output: 20, tools: ["Bash"] });
      throw new Error("private source path");
    };

    const result = await collectIdentityBreakdown("claude", identity(), 30, deps);
    expect(category(result, "conversation").inputTokens).toBe(100);
    expect(result.sourceError).toBe("source-error");
  });

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

  test("counts a message once when its usage repeats per content block (5.187)", async () => {
    const block = (extra: Record<string, unknown>, output: number, tools: string[], id?: string) => JSON.stringify({
      type: "assistant",
      timestamp: day(1),
      requestId: "req_1",
      message: {
        ...(id ? { id } : {}),
        model: "claude-sonnet-5",
        content: tools.map((name) => ({ type: "tool_use", name })),
        usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
      },
      ...extra,
    });
    const result = await claudeResult({
      "/synthetic/SYNTHETIC_FIXTURE/config/projects/proj/a.jsonl": {
        mtimeMs: NOW_MS,
        lines: [
          block({}, 50, ["Read"], "msg_1"),
          block({}, 80, ["Bash"], "msg_1"),
          block({}, 100, ["Read"], "msg_1"), // last line's usage wins
          block({}, 40, [], undefined), // no id: counted as before
          block({}, 40, [], undefined),
        ],
      },
    });
    const conversation = category(result, "conversation");
    // msg_1 once (input 10, output 100) plus two id-less lines.
    expect(conversation.inputTokens).toBe(30);
    expect(conversation.cacheReadTokens).toBe(15);
    // Output split across the union of tool names {Read, Bash}, plus the id-less outputs on conversation.
    expect(category(result, "Read").outputTokens + category(result, "Bash").outputTokens).toBe(100);
    expect(conversation.outputTokens).toBe(80);
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
  test("marks a Codex result incomplete when a stream fails after a valid usage row", async () => {
    const files = {
      "/synthetic/SYNTHETIC_FIXTURE/config/sessions/2026/09/09/rollout.jsonl": { mtimeMs: NOW_MS, lines: [] },
    };
    const deps = fakeDeps(files);
    deps.readLines = async function* () {
      yield JSON.stringify({
        timestamp: day(1),
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: { input_tokens: 25, output_tokens: 5 } } },
      });
      throw new Error("private source path");
    };

    const result = await collectIdentityBreakdown("codex", identity(), 30, deps);
    expect(category(result, "conversation").inputTokens).toBe(25);
    expect(result.sourceError).toBe("source-error");
  });

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

  test("distinguishes an absent source root from denied or failed source discovery", async () => {
    const absentDeps = fakeDeps({});
    absentDeps.readdir = () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
    const absent = await collectIdentityBreakdown("claude", identity(), 30, absentDeps);
    expect(absent.unavailable).toContain("no local session logs");
    expect(absent.sourceError).toBeUndefined();

    const deniedDeps = fakeDeps({});
    deniedDeps.readdir = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
    const denied = await collectIdentityBreakdown("claude", identity(), 30, deniedDeps);
    expect(denied.sourceError).toBe("source-error");
    expect(denied.unavailable).toBeUndefined();

    const statDeps = fakeDeps({
      "/synthetic/SYNTHETIC_FIXTURE/config/projects/proj/a.jsonl": { mtimeMs: NOW_MS, lines: [] },
    });
    statDeps.isDirectory = (path) => {
      if (path.endsWith("/projects/proj")) throw Object.assign(new Error("io"), { code: "EIO" });
      return path.endsWith("/projects/proj");
    };
    const statFailed = await collectIdentityBreakdown("claude", identity(), 30, statDeps);
    expect(statFailed.sourceError).toBe("source-error");
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

describe("durable breakdown projections", () => {
  function cachedDeps(files: Record<string, FakeFile>, cacheDir: string, fingerprints: Record<string, string>, reads: string[]): BreakdownDeps {
    return {
      ...fakeDeps(files),
      projectionCacheDir: cacheDir,
      sourceFingerprint: (path) => fingerprints[path]!,
      onSourceFileRead: (path) => reads.push(path),
    };
  }

  test("Claude cached projection matches uncached windows without losing boundary timestamps", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "ais-breakdown-cache-"));
    projectionDirs.push(cacheDir);
    const path = `${identity().configDir}/projects/proj/a.jsonl`;
    const files = { [path]: { mtimeMs: NOW_MS, lines: [claudeAssistantLine({ at: day(0), input: 20, output: 3, tools: ["Bash"] }), claudeAssistantLine({ at: day(2), input: 40, output: 5, tools: ["Read"] }), claudeAssistantLine({ at: day(31), input: 80, output: 7 })] } };
    const fingerprints = { [path]: "claude-v1" };
    const reads: string[] = [];
    for (const days of [1, 30]) {
      const uncached = await claudeResult(files, days);
      const first = await collectIdentityBreakdown("claude", identity(), days, cachedDeps(files, cacheDir, fingerprints, reads));
      const restarted = await collectIdentityBreakdown("claude", identity(), days, cachedDeps(files, cacheDir, fingerprints, reads));
      expect(first).toEqual(uncached);
      expect(restarted).toEqual(uncached);
    }
    expect(reads).toEqual([path]);
  });

  test("Codex cached projection preserves model, call split, and exact window filtering", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "ais-breakdown-cache-"));
    projectionDirs.push(cacheDir);
    const path = `${identity().configDir}/sessions/a.jsonl`;
    const lines = [
      ...codexRolloutLines({ model: "gpt-5", turnId: "in", calls: [{ name: "Bash", at: day(0) }, { name: "Read", at: day(0) }], deltas: [{ at: day(0), input: 100, cached: 20, cacheWrite: 10, output: 9 }] }),
      ...codexRolloutLines({ model: "gpt-5", turnId: "out", calls: [{ name: "Write", at: day(2) }], deltas: [{ at: day(2), input: 50, cached: 0, cacheWrite: 0, output: 4 }] }),
    ];
    const files = { [path]: { mtimeMs: NOW_MS, lines } };
    const fingerprints = { [path]: "codex-v1" };
    const reads: string[] = [];
    for (const days of [1, 30]) {
      const uncached = await codexResult(files, days);
      const cached = await collectIdentityBreakdown("codex", identity(), days, cachedDeps(files, cacheDir, fingerprints, reads));
      expect(cached).toEqual(uncached);
    }
    expect(reads).toEqual([path]);
  });

  test("changed files, including a completed trailing partial line, are reparsed", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "ais-breakdown-cache-"));
    projectionDirs.push(cacheDir);
    const path = `${identity().configDir}/projects/proj/a.jsonl`;
    const complete = claudeAssistantLine({ at: day(0), input: 10 });
    const added = claudeAssistantLine({ at: day(0), input: 30 });
    const files = { [path]: { mtimeMs: NOW_MS, lines: [complete, '{"message":'] } };
    const fingerprints: Record<string, string> = { [path]: "v1" };
    const reads: string[] = [];
    const options = () => cachedDeps(files, cacheDir, fingerprints, reads);
    expect(category(await collectIdentityBreakdown("claude", identity(), 30, options()), "conversation").inputTokens).toBe(10);
    files[path]!.lines = [complete, added];
    fingerprints[path] = "v2";
    expect(category(await collectIdentityBreakdown("claude", identity(), 30, options()), "conversation").inputTokens).toBe(40);
    expect(reads).toEqual([path, path]);
  });

  test("malformed matching-fingerprint cache is rebuilt from the source", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "ais-breakdown-cache-"));
    projectionDirs.push(cacheDir);
    const path = `${identity().configDir}/projects/proj/a.jsonl`;
    const files = { [path]: { mtimeMs: NOW_MS, lines: [claudeAssistantLine({ at: day(0), input: 22 })] } };
    const fingerprints = { [path]: "stable" };
    const reads: string[] = [];
    const cachePath = breakdownProjectionCachePath("claude", identity().name, identity().configDir, path, { cacheDir });
    await collectIdentityBreakdown("claude", identity(), 30, cachedDeps(files, cacheDir, fingerprints, reads));
    writeFileSync(cachePath, JSON.stringify({ schemaVersion: 3, fingerprint: "stable", events: [[null, "bad", "not-a-number"]] }));
    const result = await collectIdentityBreakdown("claude", identity(), 30, cachedDeps(files, cacheDir, fingerprints, reads));
    expect(category(result, "conversation").inputTokens).toBe(22);
    expect(reads).toEqual([path, path]);
    expect(JSON.parse(readFileSync(cachePath, "utf8")).events[0]).toHaveLength(8);
  });
});

describe("project / repo / org attribution", () => {
  function fixtureTree() {
    const root = mkdtempSync(join(tmpdir(), "ais-breakdown-projects-"));
    projectionDirs.push(root);
    // Main checkout holding the shared config, plus a linked worktree.
    const main = join(root, "widget");
    mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
    mkdirSync(join(main, ".git", "objects"));
    writeFileSync(join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(main, ".git", "config"), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@example.com:acme/widget.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
    writeFileSync(join(main, ".git", "worktrees", "wt", "HEAD"), "ref: refs/heads/wt\n");
    writeFileSync(join(main, ".git", "worktrees", "wt", "commondir"), "../..\n");
    const worktree = join(root, "widget-wt");
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
    const plain = join(root, "scratch");
    mkdirSync(plain);
    const missing = join(root, "gone", "elsewhere");
    return { worktree, plain, missing };
  }

  const sumTokens = (rows: Array<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>) =>
    rows.reduce((n, r) => n + r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens, 0);

  test("claude: git worktree, plain dir, missing path and no cwd; token sums match categories", async () => {
    const { worktree, plain, missing } = fixtureTree();
    const path = `${identity().configDir}/projects/p/a.jsonl`;
    const files = { [path]: { mtimeMs: NOW_MS, lines: [
      claudeAssistantLine({ at: day(0), input: 1000, output: 100, cacheRead: 50, cacheWrite: 10, tools: ["Bash", "Read"], cwd: join(worktree, "src") }),
      claudeAssistantLine({ at: day(0), input: 200, output: 21, tools: ["Bash"], cwd: worktree }),
      claudeAssistantLine({ at: day(0), input: 30, output: 3, cwd: plain }),
      claudeAssistantLine({ at: day(0), input: 40, output: 4, cwd: missing }),
      claudeAssistantLine({ at: day(0), input: 5, output: 1 }),
      claudeAssistantLine({ at: day(40), input: 9999, output: 9999, cwd: plain }),
    ] } };
    const result = await claudeResult(files);
    const projects = result.projects!;
    expect(projects).toHaveLength(4);
    const git = projects.find((p) => p.source === "git")!;
    expect(git).toMatchObject({ path: worktree, repo: "acme/widget", org: "acme", host: "example.com", turns: 2, inputTokens: 1200, outputTokens: 121, cacheReadTokens: 50, cacheWriteTokens: 10 });
    expect(git.estCostUsd).toBeGreaterThan(0);
    expect(projects.find((p) => p.source === "plain")).toMatchObject({ path: plain, turns: 1, inputTokens: 30 });
    expect(projects.find((p) => p.source === "plain")!.repo).toBeUndefined();
    expect(projects.find((p) => p.source === "missing")).toMatchObject({ path: missing, inputTokens: 40 });
    expect(projects.find((p) => p.source === "unknown")).toMatchObject({ path: "", inputTokens: 5 });
    expect(sumTokens(projects)).toBe(sumTokens(result.categories));
    const costs = projects.map((p) => p.estCostUsd);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
  });

  test("codex: cwd from session_meta/turn_context applies to following usage events", async () => {
    const { worktree, plain } = fixtureTree();
    const path = `${identity().configDir}/sessions/a.jsonl`;
    const files = { [path]: { mtimeMs: NOW_MS, lines: [
      JSON.stringify({ timestamp: day(0), type: "session_meta", payload: { id: "s", cwd: worktree } }),
      ...codexRolloutLines({ model: "gpt-5", turnId: "a", calls: [{ name: "Bash", at: day(0) }], deltas: [{ at: day(0), input: 100, cached: 20, cacheWrite: 10, output: 9 }] }),
      ...codexRolloutLines({ model: "gpt-5", turnId: "b", cwd: plain, deltas: [{ at: day(0), input: 50, cached: 0, cacheWrite: 0, output: 4 }] }),
    ] } };
    const result = await codexResult(files);
    const projects = result.projects!;
    expect(projects.find((p) => p.source === "git")).toMatchObject({ repo: "acme/widget", org: "acme", host: "example.com", turns: 1, inputTokens: 70, cacheReadTokens: 20, cacheWriteTokens: 10, outputTokens: 9 });
    expect(projects.find((p) => p.source === "plain")).toMatchObject({ turns: 1, inputTokens: 50, outputTokens: 4 });
    expect(sumTokens(projects)).toBe(sumTokens(result.categories));
  });

  test("injected resolver is used and unavailable tools carry no projects", async () => {
    const path = `${identity().configDir}/projects/p/a.jsonl`;
    const files = { [path]: { mtimeMs: NOW_MS, lines: [claudeAssistantLine({ at: day(0), input: 7, cwd: "/work/acme/widget/sub" })] } };
    const result = await collectIdentityBreakdown("claude", identity(), 30, { ...fakeDeps(files), resolveProject: (cwd) => ({ path: "/work/acme/widget", source: "git", repo: "acme/widget", org: "acme", host: "example.com" }) });
    expect(result.projects).toEqual([expect.objectContaining({ path: "/work/acme/widget", repo: "acme/widget", turns: 1 })]);
    expect((await collectIdentityBreakdown("grok", identity(), 30, {})).projects).toBeUndefined();
  });

  test("old 7-length claude cache (schema 1) is rejected and re-read", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "ais-breakdown-cache-"));
    projectionDirs.push(cacheDir);
    const path = `${identity().configDir}/projects/proj/a.jsonl`;
    const files = { [path]: { mtimeMs: NOW_MS, lines: [claudeAssistantLine({ at: day(0), input: 22, cwd: "/work/acme/widget" })] } };
    const cachePath = breakdownProjectionCachePath("claude", identity().name, identity().configDir, path, { cacheDir });
    mkdirSync(join(cachePath, ".."), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ schemaVersion: 1, fingerprint: "stable", events: [[NOW_MS, "claude-sonnet-5", 99, 0, 0, 0, []]] }));
    const reads: string[] = [];
    const result = await collectIdentityBreakdown("claude", identity(), 30, { ...fakeDeps(files), projectionCacheDir: cacheDir, sourceFingerprint: () => "stable", onSourceFileRead: (p) => reads.push(p) });
    expect(reads).toEqual([path]);
    expect(category(result, "conversation").inputTokens).toBe(22);
    expect(JSON.parse(readFileSync(cachePath, "utf8")).schemaVersion).toBe(3);
  });

  test("resolver: a stray .git folder is skipped; a bare mirror resolves from its own config", () => {
    const root = mkdtempSync(join(tmpdir(), "ais-breakdown-resolve-"));
    projectionDirs.push(root);
    // An empty `.git` folder (not a repository) above a plain directory.
    const group = join(root, "group");
    mkdirSync(join(group, ".git", "info"), { recursive: true });
    mkdirSync(join(group, "notes"));
    expect(resolveProjectFromFs(join(group, "notes"))).toEqual({ path: join(group, "notes"), source: "plain" });
    // A bare mirror: HEAD, objects and config directly in the folder.
    const mirror = join(root, "acme", "widget");
    mkdirSync(join(mirror, "objects"), { recursive: true });
    writeFileSync(join(mirror, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(mirror, "config"), '[core]\n\tbare = true\n[remote "origin"]\n\turl = https://example.com/acme/widget.git\n');
    expect(resolveProjectFromFs(mirror)).toEqual({ path: mirror, source: "git", repo: "acme/widget", org: "acme", host: "example.com" });
  });

  test("resolver: an org folder takes its child repositories' owner", () => {
    const root = mkdtempSync(join(tmpdir(), "ais-breakdown-org-"));
    projectionDirs.push(root);
    const repo = (dir: string, url: string) => {
      mkdirSync(join(dir, ".git", "objects"), { recursive: true });
      writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`);
    };
    // A folder named after its children's owner, and a plain subfolder of it.
    const group = join(root, "AcmeGroup");
    repo(join(group, "widget"), "git@example.com:acme-group/widget.git");
    repo(join(group, "fork"), "https://example.com/someone/fork");
    mkdirSync(join(group, "notes"));
    const want = { source: "plain", org: "acme-group", host: "example.com" };
    expect(resolveProjectFromFs(group)).toEqual({ path: group, ...want } as never);
    expect(resolveProjectFromFs(join(group, "notes"))).toEqual({ path: join(group, "notes"), ...want } as never);
    // A folder that merely holds repositories, even of one owner, is not an org folder.
    const projects = join(root, "projects");
    repo(join(projects, "one"), "https://example.com/beta/one");
    repo(join(projects, "two"), "https://example.com/beta/two");
    mkdirSync(join(projects, "scratch"));
    expect(resolveProjectFromFs(projects)).toEqual({ path: projects, source: "plain" });
    expect(resolveProjectFromFs(join(projects, "scratch"))).toEqual({ path: join(projects, "scratch"), source: "plain" });
    // The walk stops at the home directory.
    expect(orgFolderOwner(join(group, "notes"), group)).toBeUndefined();
  });

  test("parseRemoteUrl handles https, scp-like and ssh:// remotes", () => {
    const want = { host: "example.com", repo: "acme/widget", org: "acme" };
    expect(parseRemoteUrl("https://example.com/acme/widget.git")).toEqual(want);
    expect(parseRemoteUrl("https://user@example.com:8443/acme/widget")).toEqual(want);
    expect(parseRemoteUrl("git@example.com:acme/widget.git")).toEqual(want);
    expect(parseRemoteUrl("ssh://git@example.com:2222/acme/widget.git")).toEqual(want);
    expect(parseRemoteUrl("/srv/local/repo.git")).toBeUndefined();
  });
});

describe("inferMissingRepos", () => {
  const row = (path: string, source: BreakdownProject["source"], repo?: string): BreakdownProject => ({
    path, source, ...(repo ? { repo, org: repo.split("/")[0], host: "example.com" } : {}),
    turns: 1, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0, lastUsedAt: null,
  });
  const result = (projects: BreakdownProject[]) => ({ identity: "a", tool: "claude" as const, windowDays: 7, generatedAt: "", filesRead: 1, categories: [], projects });

  test("a missing folder named like exactly one known repo takes that repo, marked inferred", () => {
    const known = result([row("/work/acme/widget", "git", "acme/widget"), row("/work/x/gadget", "git", "acme/gadget"), row("/work/y/gadget", "git", "other/gadget")]);
    const gone = result([row("/work/tasks/t1/widget", "missing"), row("/work/tasks/t2/gadget", "missing"), row("/work/tasks/t3/nothing", "missing")]);
    inferMissingRepos([known, gone]);
    expect(gone.projects[0]).toMatchObject({ repo: "acme/widget", org: "acme", host: "example.com", inferred: true, source: "missing" });
    expect(gone.projects[1]!.repo).toBeUndefined(); // ambiguous: two repos named gadget
    expect(gone.projects[2]!.repo).toBeUndefined();
  });
});
