import { describe, expect, test } from "bun:test";
import { formatUsageReport } from "../../../src/cli/usage/report.ts";
import type { UsageResult } from "../../../src/cli/usage/run.ts";
import type { TokscaleReport } from "../../../src/cli/usage/tokscale.ts";
import type { Identity } from "../../../src/identities/types.ts";

// process.stdout.isTTY is false under `bun test` (see test/cli/colors.test.ts),
// so colors.ts's wrap functions are no-ops here — assertions below check
// plain text, not ANSI codes.

function identity(name: string): Identity {
  return { name, label: name, configDir: `/tmp/does-not-exist/${name}` };
}

function success(toolName: "claude" | "codex" | "grok", name: string, overrides: Partial<TokscaleReport> = {}): UsageResult {
  const provider = { claude: "anthropic", codex: "openai", grok: "xai" }[toolName];
  return {
    provider,
    identity: identity(name),
    report: {
      entries: [],
      totalInput: 1000,
      totalOutput: 500,
      totalCacheRead: 2000,
      totalCacheWrite: 100,
      totalMessages: 42,
      totalCost: 1.5,
      ...overrides,
    },
  };
}

describe("formatUsageReport", () => {
  test("empty results", () => {
    expect(formatUsageReport([])).toBe("No matching identities found.");
  });

  test("single identity: no total row (would be redundant)", () => {
    const output = formatUsageReport([success("claude", "identity-a")]);
    expect(output).toContain("Anthropic");
    expect(output).toContain("PROVIDER");
    expect(output).not.toContain("TOOL");
    expect(output).toContain("identity-a");
    expect(output).toContain("42");
    expect(output).toContain("$1.50");
    expect(output).not.toContain("TOTAL");
  });

  test("multiple identities: adds a TOTAL row summing all successes", () => {
    const output = formatUsageReport([
      success("claude", "identity-a", { totalMessages: 10, totalCost: 1 }),
      success("codex", "identity-a", { totalMessages: 20, totalCost: 2 }),
    ]);
    expect(output).toContain("TOTAL");
    expect(output).toContain("30"); // summed messages
    expect(output).toContain("$3.00"); // summed cost
  });

  test("error rows show a placeholder in the table and detail in an Errors section", () => {
    const results: UsageResult[] = [
      success("claude", "identity-a"),
      { provider: "openai", identity: identity("identity-a"), error: "tokscale exited with code 1" },
    ];
    const output = formatUsageReport(results);
    expect(output).toContain("error");
    expect(output).toContain("Errors:");
    expect(output).toContain("OpenAI/identity-a: tokscale exited with code 1");
  });

  test("Z.ai renders exactly like any other provider once it has a real report", () => {
    const output = formatUsageReport([success("claude", "identity-a"), { provider: "zai", identity: identity("identity-a"), report: { entries: [], totalInput: 298004, totalOutput: 1970, totalCacheRead: 0, totalCacheWrite: 0, totalMessages: 26, totalCost: 0.15 } }]);
    expect(output).toContain("Z.ai");
    expect(output).toContain("identity-a");
    expect(output).toContain("298,004");
    expect(output).toContain("$0.15");
    expect(output).not.toContain("Quota");
  });

  test("OpenCode Go keeps its official capitalisation", () => {
    const output = formatUsageReport([
      { ...success("claude", "personal"), provider: "opencode-go" },
    ]);
    expect(output).toContain("OpenCode Go");
  });

  test("a pending identity renders a spinner placeholder, and contributes to neither TOTAL nor Errors", () => {
    const results: UsageResult[] = [
      success("claude", "identity-a", { totalMessages: 10, totalCost: 1 }),
      { provider: "openai", identity: identity("identity-a"), pending: true },
    ];
    const output = formatUsageReport(results, "⠹");
    expect(output).toContain("⠹ loading…");
    expect(output).not.toContain("TOTAL"); // only one resolved success — same "no redundant total" rule as always
    expect(output).not.toContain("Errors:");
  });

  test("a pending row does not count as an error even though it also lacks a report", () => {
    const results: UsageResult[] = [
      success("claude", "identity-a"),
      success("codex", "identity-a"),
      { provider: "xai", identity: identity("identity-a"), pending: true },
    ];
    const output = formatUsageReport(results, "⠹");
    expect(output).toContain("TOTAL");
    expect(output).not.toContain("Errors:");
    expect(output).toContain("⠹ loading…");
  });

  test("EXTRA COST shows a real dollar figure when the live probe returns one (kimi)", () => {
    const result = { ...success("claude", "identity-a"), extraCost: { active: true, label: "extra usage: $4.20 of $20.00 cap this month", spentUsd: 4.2, limitUsd: 20 } };
    const output = formatUsageReport([result]);
    expect(output).toContain("$4.20");
  });

  test("EXTRA COST shows a confirmed $0.00, not a text label, when the source knows the spend is definitely zero", () => {
    // Mirrors claude-limits.ts's "subscription only" / "not available on
    // this seat" cases, which carry spentUsd: 0 precisely so this renders as
    // a real number instead of being visually identical to "no data at all".
    const result = { ...success("claude", "identity-a"), extraCost: { active: false, label: "subscription only", spentUsd: 0 } };
    const output = formatUsageReport([result]);
    const dataLine = output.split("\n").find((l) => l.includes("identity-a"))!;
    expect(dataLine).toContain("$0.00");
    expect(dataLine).not.toContain("subscription only");
  });

  test("EXTRA COST shows the status label as-is when active/recent spend is real but the amount is unknown (claude/codex)", () => {
    const result = { ...success("claude", "identity-a"), extraCost: { active: true, label: "using extra usage" } };
    const output = formatUsageReport([result]);
    expect(output).toContain("using extra usage");
  });

  test("EXTRA COST reads as a confirmed $0.00 when absent — no separate 'no data' state (grok, zai, or a failed live probe)", () => {
    const output = formatUsageReport([success("grok", "identity-a")]);
    const dataLine = output.split("\n").find((l) => l.includes("identity-a"))!;
    // "$0.00 │" (not a bare endsWith("$0.00")) confirms it's the LAST cell
    // in the row — i.e. EXTRA COST specifically, not some other column —
    // now that every row closes with a border bar.
    expect(dataLine.trimEnd().endsWith("$0.00 │")).toBe(true);
  });

  test("TOTAL sums only the numeric extraCost figures across successes, ignoring label-only ones", () => {
    const results: UsageResult[] = [
      { ...success("claude", "identity-a"), extraCost: { active: true, label: "extra usage: $4.20 this month", spentUsd: 4.2 } },
      { ...success("codex", "identity-a"), extraCost: { active: false, label: "subscription only" } },
    ];
    const output = formatUsageReport(results);
    const totalLine = output.split("\n").find((l) => l.includes("TOTAL"))!;
    expect(totalLine).toContain("$4.20");
  });

  test("TOTAL shows $0.00 for EXTRA COST when no success contributed a numeric figure", () => {
    const output = formatUsageReport([
      success("claude", "identity-a"),
      success("codex", "identity-a"),
    ]);
    const totalLine = output.split("\n").find((l) => l.includes("TOTAL"))!;
    expect(totalLine.trimEnd().endsWith("$0.00 │")).toBe(true);
  });

  test("an error row can still show a real extraCost — the live probe and the local-log fetch are independent", () => {
    const results: UsageResult[] = [
      {
        provider: "openai",
        identity: identity("identity-a"),
        error: "tokscale exited with code 1",
        extraCost: { active: false, label: "credits depleted" },
      },
    ];
    const output = formatUsageReport(results);
    expect(output).toContain("error");
    expect(output).toContain("credits depleted");
  });

  test("the table is drawn as a full box-drawing grid: outer border, header rule, and a rule before TOTAL", () => {
    const output = formatUsageReport([success("claude", "identity-a"), success("codex", "identity-a")]);
    const lines = output.split("\n");
    expect(lines[0]!.startsWith("┌")).toBe(true);
    expect(lines[0]!.endsWith("┐")).toBe(true);
    expect(lines.some((l) => l.startsWith("├") && l.endsWith("┤"))).toBe(true);
    expect(lines.some((l) => l.startsWith("└") && l.endsWith("┘"))).toBe(true);
    // one header rule + one rule immediately before the TOTAL row
    expect(lines.filter((l) => l.startsWith("├")).length).toBe(2);
  });

  test("COST uses comma separators above $1,000, matching every other numeric column", () => {
    const output = formatUsageReport([success("claude", "identity-a", { totalCost: 12345.6 })]);
    expect(output).toContain("$12,345.60");
  });

  test("TOTAL's summed COST also gets comma separators above $1,000", () => {
    const output = formatUsageReport([
      success("claude", "identity-a", { totalCost: 900 }),
      success("codex", "identity-a", { totalCost: 900 }),
    ]);
    const totalLine = output.split("\n").find((l) => l.includes("TOTAL"))!;
    expect(totalLine).toContain("$1,800.00");
  });

  test("no dateSpan on any result: no date-range caption or AVG rows are rendered", () => {
    const output = formatUsageReport([success("claude", "identity-a")]);
    expect(output).not.toContain("Tracking usage");
    expect(output).not.toContain("AVG/HOUR");
    expect(output).not.toContain("AVG/DAY");
    expect(output).not.toContain("AVG/MONTH");
  });

  test("dateSpan present: renders the tracked date range caption plus AVG/HOUR, AVG/DAY, AVG/MONTH as rows inside the table", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const elapsedHours = 9 * 24; // firstMs..lastMs below spans exactly 9*24 hours
    const result: UsageResult = {
      ...success("claude", "identity-a", { totalInput: 1_000_000, totalOutput: 200_000, totalCost: elapsedHours }),
      dateSpan: { firstMs: 0, lastMs: 9 * dayMs }, // inclusive display rounds this up to "10 days"
    };
    const output = formatUsageReport([result]);
    expect(output).toContain("Tracking usage from");
    expect(output).toContain("10 days");
    const hourLine = output.split("\n").find((l) => l.includes("AVG/HOUR"))!;
    const dayLine = output.split("\n").find((l) => l.includes("AVG/DAY"))!;
    const monthLine = output.split("\n").find((l) => l.includes("AVG/MONTH"))!;
    expect(hourLine).toBeDefined();
    expect(dayLine).toBeDefined();
    expect(monthLine).toBeDefined();
    // cost == elapsed hours by construction, so the hourly rate is exactly $1.00
    expect(hourLine).toContain("$1.00");
    // every AVG row lives INSIDE the table's own border columns
    expect(hourLine!.trimStart().startsWith("│")).toBe(true);
    expect(hourLine!.trimEnd().endsWith("│")).toBe(true);
  });

  test("AVG rows only appear once real totals exist — never for an empty/error-only report", () => {
    const results: UsageResult[] = [{ provider: "openai", identity: identity("identity-a"), error: "boom" }];
    const output = formatUsageReport(results);
    expect(output).not.toContain("AVG/HOUR");
  });

  test("combined dateSpan across multiple identities uses the overall min/max, not any single one's own range", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const results: UsageResult[] = [
      { ...success("claude", "identity-a"), dateSpan: { firstMs: 5 * dayMs, lastMs: 10 * dayMs } },
      { ...success("codex", "identity-a"), dateSpan: { firstMs: 0, lastMs: 3 * dayMs } },
    ];
    const output = formatUsageReport(results);
    // overall span is day 0 -> day 10, not either identity's own narrower range
    expect(output).toContain("11 days");
  });

  test("a result with no dateSpan doesn't prevent the section from rendering off the others that do have one", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const results: UsageResult[] = [
      { ...success("claude", "identity-a"), dateSpan: { firstMs: 0, lastMs: dayMs } },
      success("codex", "identity-a"), // no dateSpan — e.g. a failed hourly probe
    ];
    const output = formatUsageReport(results);
    expect(output).toContain("Tracking usage from");
  });

  test("a span confined to one calendar day but close to 24h wall-clock reads as 1 day, not 2", () => {
    const result: UsageResult = {
      ...success("claude", "identity-a"),
      dateSpan: { firstMs: new Date(2026, 2, 10, 0, 1).getTime(), lastMs: new Date(2026, 2, 10, 23, 59).getTime() },
    };
    const output = formatUsageReport([result]);
    expect(output).toContain("(1 day)");
  });

  test("dailyUsage present: renders a GitHub-style contribution graph above the table, exactly the table's width", () => {
    const result: UsageResult = {
      ...success("claude", "identity-a"),
      dateSpan: { firstMs: new Date(2026, 0, 1).getTime(), lastMs: new Date(2026, 0, 20).getTime() },
      dailyUsage: { "2026-01-05": 1000, "2026-01-12": 500 },
    };
    const output = formatUsageReport([result]);
    const lines = output.split("\n");
    const tableTop = lines.findIndex((l) => l.startsWith("┌"));
    expect(tableTop).toBeGreaterThan(0); // the graph rendered ABOVE the table, not at line 0
    const tableWidth = lines[tableTop]!.length;

    // lines[0] is the "Tracking usage from..." caption; the 8 grid lines
    // (1 month-label + 7 weekday rows) immediately follow it, then a blank
    // separator line right before the table itself.
    const graphLines = lines.slice(1, 1 + 8);
    expect(graphLines.some((l) => /[░▒▓█]/.test(l))).toBe(true);
    for (const l of graphLines) expect(l.length).toBe(tableWidth);
    expect(lines[1 + 8]).toBe(""); // blank separator before the table border
  });

  test("dateSpan present but no dailyUsage at all (e.g. zai-only): no graph, but the date-range caption still renders", () => {
    const result: UsageResult = {
      ...success("claude", "identity-a"),
      dateSpan: { firstMs: new Date(2026, 0, 1).getTime(), lastMs: new Date(2026, 0, 20).getTime() },
    };
    const output = formatUsageReport([result]);
    expect(output).not.toMatch(/[░▒▓█]/);
    expect(output).toContain("Tracking usage from");
  });
});

describe("source-only errors (multi-provider source failures)", () => {
  test("never render a table row and are labelled by SOURCE in the Errors footer", () => {
    // A pi reader failure has no honest provider to name; fabricating an
    // "Unattributed" table row is exactly the pseudo-provider output the
    // provider-first rule forbids. The failure stays visible, but only in
    // the Errors footer under its source label.
    const failure: UsageResult = {
      provider: "unattributed",
      identity: identity("dynacom"),
      sourceTool: "pi",
      sourceOnlyError: true,
      error: "Could not read Pi usage: disk unavailable",
    };
    const output = formatUsageReport([failure]);
    expect(output).toContain("Errors:");
    expect(output).toContain("pi/dynacom: Could not read Pi usage: disk unavailable");
    expect(output).not.toContain("Unattributed");
    // The table renders its (always-present) header but NO data rows: the
    // only result was a source-only error.
    expect(output.split("\n").filter((l) => l.startsWith("│"))).toHaveLength(1);
  });

  test("sit alongside real provider rows without perturbing them", () => {
    const ok = success("codex", "dynacom");
    const failure: UsageResult = {
      provider: "unattributed",
      identity: identity("dynacom"),
      sourceTool: "pi",
      sourceOnlyError: true,
      error: "Could not read Pi usage: boom",
    };
    const output = formatUsageReport([ok, failure]);
    const tableLines = output.split("\n").filter((l) => l.startsWith("│"));
    expect(tableLines).toHaveLength(2); // header + the one real provider row
    expect(output).toContain("pi/dynacom: Could not read Pi usage: boom");
  });
});
