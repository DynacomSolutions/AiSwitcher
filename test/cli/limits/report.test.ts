import { describe, expect, test } from "bun:test";
import { aggregateAverage, formatClock, formatCountdown, formatLimitsReport, packColumns, sortByUrgency, wrapText } from "../../../src/cli/limits/report.ts";
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
    provider: "anthropic",
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
  return { toolName: "claude", provider: "anthropic", identity: identity(name), status: "unavailable", windows: [], error: "not authenticated" };
}

function codexAcme(): ToolLimitResult {
  return {
    toolName: "codex",
    provider: "openai",
    identity: identity("identity-a", "Identity A"),
    status: "live",
    capturedAt: NOW.toISOString(),
    windows: [{ label: "week", category: "week", usedPercent: 100, note: "credits depleted" }],
  };
}

function codexWithManualReset(): ToolLimitResult {
  return {
    ...codexAcme(),
    windows: [{ label: "session", category: "session", usedPercent: 57 }],
    manualReset: { availableCount: 1, label: "Full reset (Weekly + 5 hr)", expiresAt: "Oct 4, 3:12 PM" },
  };
}

function grokAcme(): ToolLimitResult {
  return {
    toolName: "grok",
    provider: "xai",
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
      { toolName: "codex", provider: "openai", identity: identity("personal"), status: "live", windows: [{ label: "week", category: "week", usedPercent: 0 }] },
    ]);
    expect(mixed).toEqual([{ category: "week", usedPercent: 50 }]);
  });
});

describe("formatLimitsReport", () => {
  test("empty input", () => {
    expect(formatLimitsReport([])).toBe("No matching identities found.");
  });

  describe("bar alignment", () => {
    const results = (): ToolLimitResult[] => [
      claudeAcme(),
      claudeUnauth("x"),
      { ...claudeAcme(), identity: identity("longer-name-b") },
      codexAcme(),
    ];
    const bracketColumns = (output: string): number[][] =>
      output
        .split("\n")
        .filter((l) => /\[[█░]/.test(l))
        .map((l) => [...l.matchAll(/\[[█░]/g)].map((m) => m.index!));

    test("single column: TOTAL and every provider share one bar column", () => {
      const cols = bracketColumns(formatLimitsReport(results(), NOW, "⠋", { width: 100, columns: false }));
      expect(cols.length).toBeGreaterThan(5);
      expect(new Set(cols.map((c) => c[0])).size).toBe(1);
    });

    test("columns: bars align within each column (and share one width when it fits)", () => {
      const output = formatLimitsReport(results(), NOW, "⠋", { width: 200, columns: true });
      const cols = bracketColumns(output).filter((c) => c.length === 2);
      expect(cols.length).toBeGreaterThan(0);
      expect(new Set(cols.map((c) => c[0])).size).toBe(1);
      expect(new Set(cols.map((c) => c[1])).size).toBe(1);
      // The TOTAL rows (single bar, above the columns) use the same prefix.
      expect(bracketColumns(output)[0]![0]).toBe(cols[0]![0]);
    });

    test("compact: name and label columns are global, so bars line up across providers", () => {
      const cols = bracketColumns(formatLimitsReport(results(), NOW, "⠋", { width: 100, columns: false, compact: true }));
      expect(cols.length).toBeGreaterThan(2);
      expect(new Set(cols.map((c) => c[0])).size).toBe(1);
    });
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
    // One blank line separates the rollup from the first provider section.
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("Anthropic (1 identity)");
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
    expect(oneIdentity).toContain("xAI (1 identity)");

    const twoIdentities = formatLimitsReport([claudeAcme(), claudeUnauth("personal")], NOW);
    expect(twoIdentities).toContain("Anthropic (2 identities)");
  });

  test("an aggregate block is followed directly by the first identity branch (no spacer line)", () => {
    const lines = formatLimitsReport([claudeAcme()], NOW).split("\n");
    const sessionsAggIdx = lines.findIndex((l) => l.startsWith("│   sessions"));
    expect(lines[sessionsAggIdx + 1]!.startsWith("│   week")).toBe(true);
    expect(lines[sessionsAggIdx + 2]).toContain("identity-a");
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

  test("a manual reset renders as its own dim row under the identity branch", () => {
    const output = formatLimitsReport([codexWithManualReset()], NOW);
    expect(output).toContain("manual reset available: Full reset (Weekly + 5 hr) (expires Oct 4, 3:12 PM)");
    // Dim plain row: no bar bracket on that line.
    const resetLine = output.split("\n").find((l) => l.includes("manual reset available"))!;
    expect(resetLine).not.toContain("[");
  });

  test("pluralizes and counts multiple manual resets", () => {
    const output = formatLimitsReport(
      [{ ...codexWithManualReset(), manualReset: { availableCount: 3 } }],
      NOW,
    );
    expect(output).toContain("manual resets available ×3");
  });

  test("a pending identity renders a spinner row instead of a bar, and contributes no aggregate row", () => {
    const pending: ToolLimitResult = { toolName: "claude", provider: "anthropic", identity: identity("personal"), status: "pending", windows: [] };
    const output = formatLimitsReport([pending], NOW, "⠹");
    expect(output).toContain("⠹ loading…");
    expect(output).not.toContain("["); // no bars anywhere — nothing resolved yet, nothing to aggregate
  });

  test("a pending identity alongside a resolved one still aggregates the resolved one's windows", () => {
    const pending: ToolLimitResult = { toolName: "claude", provider: "anthropic", identity: identity("personal"), status: "pending", windows: [] };
    const output = formatLimitsReport([claudeAcme(), pending], NOW, "⠹");
    const lines = output.split("\n");
    // TOTAL rollup reflects only the resolved identity (identity-a) — pending
    // contributes nothing yet, same as an "unavailable" result always has.
    expect(lines[0]!.startsWith("sessions")).toBe(true);
    expect(output).toContain("⠹ loading…");
    expect(output).toContain("Anthropic (2 identities)");
  });

  test("sections group by PROVIDER, not tool — a multi-provider client's rows land beside their native-tool counterparts", () => {
    // pi's Z.ai answer and the zai tool's own answer share one Z.ai section;
    // pi's Kimi answer sits under Kimi. No section is named after a tool.
    const piZai: ToolLimitResult = {
      toolName: "pi",
      provider: "zai",
      identity: identity("acme"),
      status: "live",
      windows: [{ label: "session", category: "session", usedPercent: 12 }],
    };
    const piKimi: ToolLimitResult = {
      toolName: "pi",
      provider: "kimi",
      identity: identity("acme"),
      status: "unavailable",
      windows: [],
      error: "not authenticated",
    };
    const output = formatLimitsReport([claudeAcme(), codexAcme(), piZai, piKimi], NOW);
    expect(output).toContain("Anthropic (1 identity)");
    expect(output).toContain("OpenAI (1 identity)");
    expect(output).toContain("Z.ai (1 identity)");
    expect(output).toContain("Kimi (1 identity)");
    expect(output).not.toContain("pi (");
    expect(output).not.toContain("zai (");
  });
});

const LOCAL = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime();
const LNOW = new Date(2026, 9, 11, 12, 0);

describe("reset countdown", () => {
  test("<1h, <24h and >=24h rules", () => {
    expect(formatCountdown(LNOW.getTime() + 41 * 60_000, LNOW)).toBe("in 41m");
    expect(formatCountdown(LNOW.getTime() + (3 * 60 + 41) * 60_000, LNOW)).toBe("in 3h 41m");
    expect(formatCountdown(LNOW.getTime() + (52 * 60) * 60_000, LNOW)).toBe("in 2d 4h");
    expect(formatCountdown(LNOW.getTime() - 5, LNOW)).toBe("now");
  });

  test("clock is local 24h with weekday; date added from 7 days out", () => {
    expect(formatClock(LOCAL(2026, 9, 12, 3, 9), LNOW)).toBe("Mon 03:09");
    expect(formatClock(LOCAL(2026, 9, 18, 21, 59), LNOW)).toBe("Sun 18 Oct 21:59");
  });

  test("report uses resetsAtMs over resetsAt, and falls back to the string", () => {
    const r = claudeAcme();
    r.windows = [
      { label: "a", category: "session", usedPercent: 1, resetsAt: "legacy", resetsAtMs: LNOW.getTime() + 41 * 60_000 },
      { label: "b", category: "week", usedPercent: 1, resetsAt: "Oct 18, 9am" },
    ];
    const out = formatLimitsReport([r], LNOW, "⠋", { width: 100, columns: false });
    expect(out).toContain("resets in 41m (Sun 12:41)".replace("Sun", formatClock(LNOW.getTime() + 41 * 60_000, LNOW).slice(0, 3)));
    expect(out).toContain("resets Oct 18, 9am");
    expect(out).not.toContain("legacy");
  });
});

function withWindows(name: string, percents: number[], status: ToolLimitResult["status"] = "live"): ToolLimitResult {
  return {
    toolName: "claude",
    provider: "anthropic",
    identity: identity(name),
    status,
    windows: percents.map((usedPercent, i) => ({ label: `w${i}`, category: "week", usedPercent })),
    ...(status === "unavailable" ? { error: "nope" } : {}),
  };
}

describe("sortByUrgency", () => {
  test("most headroom first, exhausted then unavailable last, stable on ties", () => {
    const sorted = sortByUrgency([
      withWindows("gone", [], "unavailable"),
      withWindows("full", [100, 0]),
      withWindows("busy", [80]),
      withWindows("tie-a", [20]),
      withWindows("free", [5, 10]),
      withWindows("tie-b", [20]),
    ]);
    expect(sorted.map((r) => r.identity.name)).toEqual(["free", "tie-a", "tie-b", "busy", "full", "gone"]);
  });
});

describe("swap pool row", () => {
  const pool = (): ToolLimitResult => ({
    ...withWindows("pool-x", [71]),
    identity: { ...identity("pool-x"), swapPool: { accounts: ["identity-a"], active: "identity-a" } },
  });

  test("renders one pointer line and stays out of the aggregates", () => {
    const out = formatLimitsReport([claudeAcme(), pool()], NOW, "⠋", { width: 100, columns: false });
    expect(out).toContain("→ active member: identity-a");
    expect(out).toContain("sessions          [██████░░░░░░░░░░░░░░]  25%".slice(0, 8));
    expect(out.split("\n")[0]).toContain(" 25%"); // 71 would shift the session average
    expect(out.match(/71%/g)).toBeNull();
    // pointer row sorts after real identities
    expect(out.indexOf("pool-x")).toBeGreaterThan(out.indexOf("identity-a  "));
  });

  test("a codex pool mirrors its active codex member, not a claude one of that name", () => {
    const codexPool = { ...pool(), toolName: "codex" as const };
    expect(formatLimitsReport([claudeAcme(), codexPool], NOW, "⠋", { width: 100, columns: false })).not.toContain("active member");
    expect(formatLimitsReport([claudeAcme(), codexPool, { ...codexAcme(), identity: identity("identity-a") }], NOW, "⠋", { width: 100, columns: false })).toContain("→ active member: identity-a");
  });

  test("a pool whose active member is not in the report keeps its own windows", () => {
    const out = formatLimitsReport([pool()], NOW, "⠋", { width: 100, columns: false });
    expect(out).not.toContain("active member");
    expect(out).toContain("71%");
  });
});

describe("wrapping and layout", () => {
  test("wrapText wraps with continuation indent and splits overlong words", () => {
    const lines = wrapText("aaa bbb ccc ddd", 11, "  ", "    ");
    expect(lines).toEqual(["  aaa bbb", "    ccc ddd"]);
    expect(wrapText("x".repeat(30), 12, "", "  ").every((l) => l.length <= 12)).toBe(true);
  });

  test("long errors wrap to the width", () => {
    const r = claudeUnauth("personal");
    r.error = "word ".repeat(60).trim();
    const out = formatLimitsReport([r], NOW, "⠋", { width: 60, columns: false });
    const lines = out.split("\n");
    expect(lines.length).toBeGreaterThan(4);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(60);
  });

  test("packColumns balances blocks across the widest fitting column count", () => {
    const a = ["AAAA", "a1", "a2", "a3"];
    const b = ["BBBB", "b1"];
    const c = ["CCCC", "c1"];
    expect(packColumns([a, b, c], 40, 2)).toEqual(["AAAA  BBBB  CCCC", "a1    b1    c1", "a2", "a3"]);
    expect(packColumns([a, b, c], 12, 2)).toEqual(["AAAA  BBBB", "a1    b1", "a2    CCCC", "a3    c1"]);
    expect(packColumns([a, b, c], 5, 2)).toBeUndefined();
  });

  test("columns collapse to a single column when narrow or disabled", () => {
    const rs = [claudeAcme(), codexAcme()];
    expect(formatLimitsReport(rs, NOW, "⠋", { width: 100, columns: true })).toBe(formatLimitsReport(rs, NOW, "⠋", { width: 100, columns: false }));
    const wide = formatLimitsReport(rs, NOW, "⠋", { width: 220, columns: true });
    const header = wide.split("\n").find((l) => l.includes("Anthropic"))!;
    expect(header).toContain("OpenAI");
  });
});

describe("--compact", () => {
  test("one line per identity: worst window, bar, reset and manual-reset marker", () => {
    const r = codexWithManualReset();
    r.windows = [
      { label: "session", category: "session", usedPercent: 10 },
      { label: "week", category: "week", usedPercent: 57, resetsAtMs: NOW.getTime() + 90 * 60_000 },
    ];
    const lines = formatLimitsReport([r, claudeUnauth("zed")], NOW, "⠋", { width: 100, compact: true }).split("\n");
    expect(lines[0]).toBe("OpenAI (1 identity)");
    expect(lines[1]).toMatch(/^ {2}identity-a {2}week {1,}\[.{10}\] {2}57% {2}in 1h 30m \(.*\) {2}↺1$/);
    expect(lines).toHaveLength(5);
    // Name width is global across providers, so "zed" pads to "identity-a".
    expect(lines[4]).toBe("  zed         not authenticated");
  });
});

describe("column-width wrapping and minute rounding", () => {
  test("a short plain row is not wrapped in column mode", () => {
    const r = codexWithManualReset();
    r.manualReset = { availableCount: 3, label: "Full reset", expiresAt: "Oct 23, 3:24 AM" };
    r.windows = [{ label: "week", category: "week", usedPercent: 0, resetsAtMs: NOW.getTime() + 7 * 86_400_000 }];
    const out = formatLimitsReport([r], NOW, "⠋", { width: 220, columns: true });
    const line = out.split("\n").find((l) => l.includes("manual resets"))!;
    expect(line).toContain("(expires Oct 23, 3:24 AM)");
  });

  test("a long error wraps at its block's width, not the terminal's", () => {
    const r = claudeUnauth("personal");
    r.error = "word ".repeat(60).trim();
    const lines = formatLimitsReport([r], NOW, "⠋", { width: 220, columns: true }).split("\n");
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(60);
  });

  test("clock rounds to the nearest minute", () => {
    expect(formatClock(LOCAL(2026, 9, 12, 2, 59) + 59_900, LNOW)).toBe("Mon 03:00");
  });
});
