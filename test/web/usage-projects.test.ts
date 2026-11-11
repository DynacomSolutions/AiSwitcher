import { describe, expect, test } from "bun:test";
import { filterProjectRows, groupProjects, projectCoverage } from "../../apps/web/src/lib/usage-projects.ts";
import type { UsageProjectRow } from "../../apps/web/src/types/api.ts";

const NOW = new Date(2026, 10, 12, 12, 0, 0).getTime();
const day = (offset: number) => {
  const d = new Date(NOW - offset * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const row = (over: Partial<UsageProjectRow>): UsageProjectRow => ({
  path: "/work/acme/widget", repo: "acme/widget", org: "acme", host: "example.com", source: "git",
  provider: "anthropic", identity: "alice", tool: "claude", date: day(0),
  cost: 1, input: 10, output: 5, cacheRead: 100, cacheWrite: 20, messages: 2, lastMs: 1000, ...over,
});

describe("filterProjectRows", () => {
  const rows = [row({}), row({ provider: "openai", identity: "bob" }), row({ date: day(40) }), row({ date: day(7) })];
  test("All time keeps every day; provider and identity narrow", () => {
    expect(filterProjectRows(rows, { provider: "all", identity: "all", since: 0 }, NOW)).toHaveLength(4);
    expect(filterProjectRows(rows, { provider: "openai", identity: "all", since: 0 }, NOW)).toHaveLength(1);
    expect(filterProjectRows(rows, { provider: "all", identity: "alice", since: 0 }, NOW)).toHaveLength(3);
  });
  test("periods use the local date like applyPeriod (cutoff day included)", () => {
    expect(filterProjectRows(rows, { provider: "all", identity: "all", since: 7 }, NOW)).toHaveLength(3);
    expect(filterProjectRows(rows, { provider: "all", identity: "all", since: 30 }, NOW)).toHaveLength(3);
    expect(filterProjectRows(rows, { provider: "all", identity: "all", since: 90 }, NOW)).toHaveLength(4);
  });
});

describe("groupProjects", () => {
  const rows = [
    row({ cost: 5 }),
    row({ cost: 1, path: "/work/acme/widget-wt", source: "missing", inferred: true, lastMs: 9000 }),
    row({ cost: 2, path: "/work/solo", repo: undefined, org: undefined, host: undefined, source: "plain" }),
  ];
  test("projects, repos and orgs sum to the same total, biggest first", () => {
    for (const grouping of ["project", "repo", "org"] as const) {
      const groups = groupProjects(rows, grouping);
      expect(groups.reduce((s, g) => s + g.cost, 0)).toBe(8);
      expect(groups[0]!.cost).toBeGreaterThanOrEqual(groups[groups.length - 1]!.cost);
    }
    const repos = groupProjects(rows, "repo");
    expect(repos[0]).toMatchObject({ label: "acme/widget", cost: 6, turns: 4, cache: 240 });
    expect(repos.find((g) => g.noRemote)?.label).toBe("solo");
    expect(groupProjects(rows, "org").find((g) => g.noRemote)?.label).toBe("(no git remote)");
  });
});

describe("projectCoverage", () => {
  test("reports the remainder as spend without session logs, never negative", () => {
    expect(projectCoverage([row({ cost: 8 })], 10)).toEqual({ projectsCost: 8, usageCost: 10, remainder: 2 });
    expect(projectCoverage([row({ cost: 8 })], 5).remainder).toBe(0);
  });
});
