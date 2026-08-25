import { describe, expect, test } from "bun:test";
import { aggregateAverage, formatLimitsReport } from "../../../src/cli/limits/report.ts";
import type { ToolLimitResult } from "../../../src/cli/limits/types.ts";
import type { Identity } from "../../../src/identities/types.ts";

// process.stdout.isTTY is false under `bun test` (see test/cli/colors.test.ts),
// so colors.ts's wrap functions are no-ops here — assertions below check
// plain text, not ANSI codes.

function identity(name: string, label = name): Identity {
  return { name, label, configDir: `/tmp/does-not-exist/${name}` };
}

const NOW = new Date("2026-07-15T12:00:00Z");

function claudeAcme(): ToolLimitResult {
  return {
    toolName: "claude",
    identity: identity("identity-a", "Identity A"),
    status: "live",
    capturedAt: NOW.toISOString(),
    windows: [
      { label: "session (5h)", category: "session", usedPercent: 25, resetsAt: "Jul 15 2pm" },
      { label: "week (all)", category: "week", usedPercent: 30, resetsAt: "Jul 18 8am" },
      { label: "week (Fable)", category: "week", usedPercent: 0 },
    ],
  };
}

function claudeUnauth(name: string): ToolLimitResult {
  return { toolName: "claude", identity: identity(name), status: "unavailable", windows: [], error: "not authenticated" };
}

function codexAcme(): ToolLimitResult {
  return {
    toolName: "codex",
    identity: identity("identity-a", "Identity A"),
    status: "live",
    capturedAt: NOW.toISOString(),
    windows: [{ label: "week", category: "week", usedPercent: 100, note: "credits depleted" }],
  };
}

function grokAcme(): ToolLimitResult {
  return {
    toolName: "grok",
    identity: identity("identity-a", "Identity A"),
    status: "cached",
    capturedAt: new Date("2026-07-15T10:00:00Z").toISOString(), // 2h before NOW
    windows: [{ label: "week", category: "week", usedPercent: 1, resetsAt: "period ends Jul 19" }],
  };
}

describe("aggregateAverage", () => {
  test("averages usedPercent across every window in that category, not just one per identity", () => {
    // claudeAcme() contributes session=25 (one window) and week=30,0
    // (two windows: "week (all)" and "week (Fable)") — the week average is
    // over both, i.e. (30 + 0) / 2, not just the more prominent one.
    const results = [claudeAcme(), claudeUnauth("personal")];
    const totals = aggregateAverage(results);
    expect(totals).toEqual([
      { category: "session", usedPercent: 25 },
      { category: "week", usedPercent: 15 },
    ]);
  });

  test("only emits categories with at least one real data point", () => {
    expect(aggregateAverage([codexAcme()])).toEqual([{ category: "week", usedPercent: 100 }]);
  });

  test("unavailable results contribute nothing", () => {
    expect(aggregateAverage([claudeUnauth("personal")])).toEqual([]);
  });

  test("a maxed-out identity is diluted by a healthy one, not surfaced as-is — the deliberate tradeoff of averaging over max", () => {
    const mixed = aggregateAverage([
      codexAcme(), // week: 100
      { toolName: "codex", identity: identity("personal"), status: "live", windows: [{ label: "week", category: "week", usedPercent: 0 }] },
    ]);
    expect(mixed).toEqual([{ category: "week", usedPercent: 50 }]);
  });
});

describe("formatLimitsReport", () => {
  test("empty input", () => {
    expect(formatLimitsReport([])).toBe("No matching identities found.");
  });

  test("every bar's opening bracket lines up at the same column", () => {
    const output = formatLimitsReport([claudeAcme(), codexAcme(), grokAcme()], NOW);
    const bracketColumns = output
      .split("\n")
      .filter((line) => line.includes("["))
      .map((line) => line.indexOf("["));
    expect(new Set(bracketColumns).size).toBe(1);
  });

  test("TOTAL rollup has no title and sits at the very top, flush left", () => {
    // claudeAcme() + codexAcme() together contribute two categories
    // (session, week) — so two flush-left TOTAL rows before the blank-line
    // separator, in that order (CATEGORY_ORDER: session, week, month, other).
    const output = formatLimitsReport([claudeAcme(), codexAcme()], NOW);
    const lines = output.split("\n");
    expect(lines[0]).not.toContain("TOTAL");
    expect(lines[0]!.startsWith(" ")).toBe(false);
    expect(lines[0]!.startsWith("sessions")).toBe(true);
    expect(lines[1]!.startsWith("week")).toBe(true);
    expect(lines[1]!.startsWith(" ")).toBe(false);
    // Two blank lines separate the rollup from the first provider section.
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("claude (1 identity)");
  });

  test("category is pluralized in the TOTAL/aggregate rollups but not in per-identity rows", () => {
    const output = formatLimitsReport([claudeAcme()], NOW);
    const lines = output.split("\n");
    expect(lines[0]!.startsWith("sessions")).toBe(true); // TOTAL row, no indent
    expect(output).toContain("│   sessions"); // aggregate row, matches AGGREGATE_INDENT exactly
    expect(output).toContain("session (5h)"); // per-identity row stays singular
  });

  test("provider header pluralizes identity count correctly", () => {
    const oneIdentity = formatLimitsReport([grokAcme()], NOW);
    expect(oneIdentity).toContain("grok (1 identity)");

    const twoIdentities = formatLimitsReport([claudeAcme(), claudeUnauth("personal")], NOW);
    expect(twoIdentities).toContain("claude (2 identities)");
  });

  test("an aggregate block is followed by a bare pipe connector before the first identity branch", () => {
    // claudeAcme() contributes two aggregate rows (session, week), so the
    // connector sits right after both, not right after the first.
    const output = formatLimitsReport([claudeAcme()], NOW);
    const lines = output.split("\n");
    const sessionsAggIdx = lines.findIndex((l) => l.startsWith("│   sessions"));
    expect(lines[sessionsAggIdx + 1]!.startsWith("│   week")).toBe(true);
    expect(lines[sessionsAggIdx + 2]).toBe("│");
    expect(lines[sessionsAggIdx + 3]).toContain("identity-a");
  });

  test("an unavailable identity renders its error message with no bar, and contributes no aggregate row", () => {
    const output = formatLimitsReport([claudeUnauth("personal")], NOW);
    expect(output).toContain("not authenticated");
    expect(output).not.toContain("["); // no bars anywhere — nothing to aggregate, nothing to render
  });

  test("stale (cached) data carries an 'as of ... ago' suffix; live data does not", () => {
    const output = formatLimitsReport([codexAcme(), grokAcme()], NOW);
    const lines = output.split("\n");
    const codexLine = lines.find((l) => l.includes("credits depleted"))!;
    const grokLine = lines.find((l) => l.includes("period ends"))!;
    expect(codexLine).not.toContain("ago");
    expect(grokLine).toContain("2h ago");
  });

  test("a note (e.g. credits depleted) renders alongside resets/percentage", () => {
    const output = formatLimitsReport([codexAcme()], NOW);
    expect(output).toContain("credits depleted");
  });

  test("a pending identity renders a spinner row instead of a bar, and contributes no aggregate row", () => {
    const pending: ToolLimitResult = { toolName: "claude", identity: identity("personal"), status: "pending", windows: [] };
    const output = formatLimitsReport([pending], NOW, "⠹");
    expect(output).toContain("⠹ loading…");
    expect(output).not.toContain("["); // no bars anywhere — nothing resolved yet, nothing to aggregate
  });

  test("a pending identity alongside a resolved one still aggregates the resolved one's windows", () => {
    const pending: ToolLimitResult = { toolName: "claude", identity: identity("personal"), status: "pending", windows: [] };
    const output = formatLimitsReport([claudeAcme(), pending], NOW, "⠹");
    const lines = output.split("\n");
    // TOTAL rollup reflects only the resolved identity (identity-a) — pending
    // contributes nothing yet, same as an "unavailable" result always has.
    expect(lines[0]!.startsWith("sessions")).toBe(true);
    expect(output).toContain("⠹ loading…");
    expect(output).toContain("claude (2 identities)");
  });
});
