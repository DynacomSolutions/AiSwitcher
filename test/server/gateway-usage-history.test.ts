import { describe, expect, test } from "bun:test";
import type { ModelDailyUsageRow, ModelUsageRow } from "../../src/gateway/types.ts";
import type { GatewayModelUsageView } from "../../src/gateway/usage-view.ts";
import { loadGatewayUsageHistory } from "../../src/gateway/usage-view.ts";
import { historyFromSnapshot } from "../../src/cli/gateway/usage-history.ts";
import { historyHostRows, mergeGatewayUsage, mergeGatewayUsageWithHistory } from "../../src/server/gateway-usage.ts";

const ZONE = "Asia/Bangkok";
const startOf = (day: string) => Date.parse(`${day}T00:00:00+07:00`);
const endOf = (day: string) => startOf(day) + 86400_000 - 1;
const identity = (name: string) => ({ name, label: name, configDir: "" });

interface Spec { provider: string; name: string; days: Record<string, number>; first: string; last: string; withCost: boolean }

/** A host result like the snapshot holds it: per-model totals that equal the day totals, whole-day span. */
function hostResult(s: Spec) {
  const days = Object.keys(s.days).sort();
  const cost = Object.values(s.days).reduce((a, b) => a + b, 0);
  const tokens = days.length * 100;
  return {
    provider: s.provider,
    identity: identity(s.name),
    report: {
      entries: [
        { model: "big", provider: s.provider, input: tokens * 0.6, output: tokens * 0.2, cacheRead: 0, cacheWrite: 0, reasoning: 0, messageCount: days.length * 2, cost: cost * 0.75 },
        { model: "small", provider: s.provider, input: tokens * 0.2, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, messageCount: days.length, cost: cost * 0.25 },
      ],
      totalInput: tokens * 0.8, totalOutput: tokens * 0.2, totalCacheRead: 0, totalCacheWrite: 0, totalMessages: days.length * 3, totalCost: cost,
    },
    dateSpan: { firstMs: startOf(s.first), lastMs: endOf(s.last) },
    dailyUsage: Object.fromEntries(days.map((d) => [d, 100])),
    ...(s.withCost ? { dailyTotals: Object.fromEntries(days.map((d) => [d, [80, 20, 0, 0, 3, s.days[d]!]])) } : {}),
  };
}

const range = (first: number, last: number, usd: number) => Object.fromEntries(Array.from({ length: last - first + 1 }, (_, i) => [`2026-11-${String(first + i).padStart(2, "0")}`, usd]));
const specs: Spec[] = [
  { provider: "anthropic", name: "m1", days: range(1, 10, 100), first: "2026-11-01", last: "2026-11-10", withCost: true },
  { provider: "openai", name: "c1", days: range(1, 5, 20), first: "2026-10-01", last: "2026-10-20", withCost: false },
  { provider: "anthropic", name: "m2", days: range(1, 20, 10), first: "2026-11-01", last: "2026-11-20", withCost: false },
  { provider: "anthropic", name: "old", days: range(1, 3, 7), first: "2026-11-01", last: "2026-11-03", withCost: true },
];
const hostResults = specs.map(hostResult);

const ledger = (provider: string, name: string, days: string[], usd: number): { rows: ModelUsageRow[]; daily: ModelDailyUsageRow[] } => {
  const zero = { cacheReadTokens: 0, cacheWriteTokens: 0, unpricedRequests: 0 };
  return {
    rows: [{ provider, identity: name, app: "web", model: "big", inputTokens: 10 * days.length, outputTokens: 5 * days.length, ...zero, estCostUsd: usd * days.length, requests: days.length, firstTs: `${days[0]}T01:00:00.000Z`, lastTs: `${days.at(-1)}T05:00:00.000Z` }],
    daily: days.map((day) => ({ day, provider, identity: name, model: "big", inputTokens: 10, outputTokens: 5, ...zero, estCostUsd: usd, requests: 1 })),
  };
};
const l1 = ledger("claude", "m1", ["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11"], 50);
const l2 = ledger("codex", "c1", ["2026-11-19", "2026-11-20"], 5);
const l3 = ledger("claude", "m2", ["2026-11-10", "2026-11-11", "2026-11-12"], 30);
const l4 = ledger("claude", "fresh", ["2026-11-15"], 40);
const view: GatewayModelUsageView = {
  configured: true,
  rows: [...l1.rows, ...l2.rows, ...l3.rows, ...l4.rows],
  daily: [...l1.daily, ...l2.daily, ...l3.daily, ...l4.daily],
};

const history = () => ({ configured: true, rows: historyFromSnapshot(hostResults, { generation: "2026-11-19T20:54:45.466Z", zone: ZONE }).rows });
const noRegistries = async () => [];
type Row = { provider: string; identity: { name: string }; report: { totalCost: number; totalInput: number; entries: Array<{ model: string }> }; dailyTotals?: Record<string, number[]>; dailyUsage?: Record<string, number> };
const byName = (out: unknown) => Object.fromEntries(((out as { results: Row[] }).results).map((r) => [`${r.provider}/${r.identity.name}`, r]));

describe("history rows shaped like host rows", () => {
  test("builds one result per identity from the three sources, each kept apart", () => {
    const rows = historyHostRows(history());
    const m1 = rows.find((r) => r.identity.name === "m1")!;
    expect(m1.provider).toBe("anthropic");
    expect(m1.report!.totalCost).toBeCloseTo(1000, 6);
    expect(Object.keys(m1.dailyTotals!)).toHaveLength(10);
    const c1 = rows.find((r) => r.identity.name === "c1")!;
    expect(c1.dailyTotals).toBeUndefined();
    expect(Object.keys(c1.dailyUsage!)).toHaveLength(5);
    expect(m1.dateSpan).toEqual({ firstMs: startOf("2026-11-01"), lastMs: endOf("2026-11-10") });
  });

  test("applies the tool and identity filters and ignores a failed view", () => {
    expect(historyHostRows(history(), { tool: "codex" }).map((r) => r.identity.name)).toEqual(["c1"]);
    expect(historyHostRows(history(), { identity: "old" }).map((r) => r.identity.name)).toEqual(["old"]);
    expect(historyHostRows({ configured: true, rows: [], error: "x" })).toEqual([]);
  });
});

describe("gateway-only merge", () => {
  test("equals the host-based merge within $1 per identity", async () => {
    const fromHost = byName(await mergeGatewayUsage({ results: hostResults }, view, {}, noRegistries, async () => []));
    const fromGateway = byName(await mergeGatewayUsageWithHistory(view, history(), {}, noRegistries));
    expect(Object.keys(fromGateway).sort()).toEqual(Object.keys(fromHost).sort());
    for (const [key, host] of Object.entries(fromHost)) {
      expect(Math.abs(fromGateway[key]!.report.totalCost - host.report.totalCost)).toBeLessThan(1);
      expect(Math.abs(fromGateway[key]!.report.totalInput - host.report.totalInput)).toBeLessThan(1);
    }
  });

  test("history before coverage, ledger from the first ledger day, no double counting", async () => {
    const out = byName(await mergeGatewayUsageWithHistory(view, history(), {}, noRegistries));
    const m1 = out["anthropic/m1"]!;
    // Days 1 to 7 from history ($100 each), days 8 to 11 from the ledger ($50 each).
    expect(Object.keys(m1.dailyTotals!).sort()).toEqual(Object.keys(range(1, 11, 0)));
    expect(m1.dailyTotals!["2026-11-07"]![5]).toBe(100);
    expect(m1.dailyTotals!["2026-11-08"]![5]).toBe(50);
    expect(m1.dailyTotals!["2026-11-10"]![5]).toBe(50);
    const dayCost = Object.values(m1.dailyTotals!).reduce((n, v) => n + v[5]!, 0);
    expect(dayCost).toBe(7 * 100 + 4 * 50);
    // The model split adds up to the same figure: 70% of the history plus the ledger.
    expect(m1.report.totalCost).toBeCloseTo(700 + 200, 6);
    // A result with no days (tokens only) overlapping coverage keeps a time share, not the whole row.
    const m2 = out["anthropic/m2"]!;
    expect(m2.report.totalCost).toBeGreaterThan(90);
    expect(m2.report.totalCost).toBeLessThan(200 + 90 + 1);
    // History that ends before coverage stays whole, and the ledger-only identity stays as the ledger says.
    expect(out["openai/c1"]!.report.totalCost).toBeCloseTo(100 + 10, 6);
    expect(out["anthropic/fresh"]!.report.totalCost).toBe(40);
    // An identity with history and no ledger rows stays as history.
    expect(out["anthropic/old"]!.report.totalCost).toBeCloseTo(21, 6);
  });
});

describe("loadGatewayUsageHistory", () => {
  const ok = (history: unknown[]) => new Response(JSON.stringify({ history }), { status: 200 });
  const withEnv = async <T>(fn: () => Promise<T>): Promise<T> => {
    const saved = [process.env.AIS_GATEWAY_ADMIN_URL, process.env.AIS_GATEWAY_ADMIN_TOKEN];
    process.env.AIS_GATEWAY_ADMIN_URL = "https://gateway.example/";
    process.env.AIS_GATEWAY_ADMIN_TOKEN = "t";
    try { return await fn(); } finally {
      for (const [i, k] of ["AIS_GATEWAY_ADMIN_URL", "AIS_GATEWAY_ADMIN_TOKEN"].entries()) { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; }
    }
  };
  test("reads the latest generation of each source with GET only", () => withEnv(async () => {
    const calls: string[] = [];
    const out = await loadGatewayUsageHistory({ secretsPath: "/nonexistent", fetch: (async (u: string, init?: RequestInit) => { calls.push(`${init?.method ?? "GET"} ${u}`); return ok([]); }) as unknown as typeof fetch });
    expect(out).toEqual({ configured: true, rows: [] });
    expect(calls).toEqual(["host-snapshot-models", "host-snapshot-daily", "host-snapshot-daily-tokens"].map((s) => `GET https://gateway.example/usage/history?source=${s}&generation=latest`));
  }));
  test("a failed source is an error, never a partial answer", () => withEnv(async () => {
    let n = 0;
    const out = await loadGatewayUsageHistory({ secretsPath: "/nonexistent", fetch: (async () => (++n === 2 ? new Response("no", { status: 500 }) : ok([]))) as unknown as typeof fetch });
    expect(out).toEqual({ configured: true, rows: [], error: "admin answered 500" });
  }));
});
