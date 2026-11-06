import { describe, expect, test } from "bun:test";
import { partialLabel, summarisePools } from "../../apps/web/src/lib/pool-usage.ts";
import type { GatewayIdentityUsage, GatewayPeriod, PoolRef, ToolLimitResult, UsageResult } from "../../apps/web/src/types/api.ts";

const id = (name: string) => ({ name, label: name, configDir: "SYNTHETIC_FIXTURE_dir" });
const pool: PoolRef = { tool: "claude", name: "pool-a", members: [{ name: "m1", allowed: true }, { name: "m2", allowed: true }, { name: "m3", allowed: false }] };

function native(name: string, days: Record<string, [number, number, number, number, number, number]>, extra: Partial<UsageResult> = {}): UsageResult {
  return {
    provider: "anthropic",
    identity: id(name),
    report: { entries: [], totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0, totalMessages: 0, totalCost: 0 },
    dailyTotals: days,
    ...extra,
  };
}

const gw = (identity: string, tokens: number, cost: number, extra: Partial<GatewayIdentityUsage> = {}): GatewayIdentityUsage => ({
  provider: "claude", identity, app: "other-app", inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: cost, unpricedRequests: 0, requests: 1, ...extra,
});
const ok = (rows: GatewayIdentityUsage[]): GatewayPeriod => ({ configured: true, rows });
const resp = (today: GatewayPeriod, week: GatewayPeriod) => ({ todayKey: "2026-11-06", weekStartKey: "2026-10-31", gateway: { today, week } });
const lim = (name: string, windows: Array<[string, number]>, status: ToolLimitResult["status"] = "live"): ToolLimitResult => ({
  toolName: "claude", provider: "anthropic", identity: id(name), status, windows: windows.map(([label, usedPercent]) => ({ label, category: "week", usedPercent })),
});

describe("summarisePools", () => {
  const usage = [
    native("m1", { "2026-11-06": [1, 2, 3, 4, 1, 1.5], "2026-11-01": [10, 0, 0, 0, 1, 2], "2026-10-01": [999, 0, 0, 0, 1, 99] }),
    native("m2", { "2026-11-06": [5, 0, 0, 0, 1, 0.5] }),
    native("m3", { "2026-11-05": [7, 0, 0, 0, 1, 1] }),
  ];

  test("sums native and gateway usage across members for today and the week", () => {
    const [s] = summarisePools([pool], usage, [], resp(ok([gw("m1", 100, 0.25), gw("m2", 50, 0.5)]), ok([gw("m1", 300, 1), gw("m2", 50, 0.5), gw("other", 9999, 9)])));
    expect(s!.today.nativeTokens).toBe(10 + 5);
    expect(s!.today.gatewayTokens).toBe(150);
    expect(s!.today.tokens).toBe(165);
    expect(s!.today.costUsd).toBeCloseTo(1.5 + 0.5 + 0.25 + 0.5);
    expect(s!.week.nativeTokens).toBe(10 + 10 + 5 + 7);
    expect(s!.week.gatewayTokens).toBe(350);
    expect(s!.week.covered).toBe(3);
    expect(partialLabel(s!.week)).toBeUndefined();
  });

  test("a member without a native record makes the pool partial with a reason, not zero or unavailable", () => {
    const [s] = summarisePools([pool], usage.slice(0, 2), [], resp(ok([gw("m1", 100, 0)]), ok([gw("m1", 100, 0)])));
    expect(partialLabel(s!.today)).toBe("partial (2 of 3 members)");
    expect(s!.today.missing).toEqual([{ member: "m3", reason: "no native usage record" }]);
    expect(s!.today.tokens).toBe(10 + 5 + 100);
  });

  test("a failed or still-scanning native source is a missing figure", () => {
    const u = [native("m1", {}, { error: "boom" }), native("m2", {}, { pending: true }), { provider: "anthropic", identity: id("m3") } as UsageResult];
    const [s] = summarisePools([pool], u, [], resp(ok([]), ok([])));
    expect(s!.today.covered).toBe(0);
    expect(s!.today.missing.map((m) => m.reason)).toEqual(["native usage failed", "native usage still scanning", "no native usage report"]);
  });

  test("an unreachable gateway ledger marks every member partial and keeps the native sum", () => {
    const [s] = summarisePools([pool], usage, [], resp({ configured: true, rows: [], error: "admin unreachable" }, { configured: false, rows: [] }));
    expect(s!.today.covered).toBe(0);
    expect(s!.today.nativeTokens).toBe(15);
    expect(s!.today.missing[0]!.reason).toContain("gateway ledger unavailable (admin unreachable)");
    expect(s!.week.missing[0]!.reason).toContain("not configured");
  });

  test("a member absent from a reachable ledger is a confirmed zero for gateway usage", () => {
    const [s] = summarisePools([pool], usage, [], resp(ok([]), ok([])));
    expect(s!.today.gatewayTokens).toBe(0);
    expect(s!.today.covered).toBe(3);
  });

  test("agent-app ledger rows are inside the native figure and are not added twice", () => {
    const agent = gw("m1", 1000, 9, { app: "agents-claude" });
    const [s] = summarisePools([pool], usage, [], resp(ok([agent, gw("m1", 100, 0.25)]), ok([agent])));
    expect(s!.today.gatewayTokens).toBe(100);
    expect(s!.today.gatewayCoveredByNative).toBe(1000);
    expect(s!.today.tokens).toBe(15 + 100);
    expect(s!.today.costUsd).toBeCloseTo(1.5 + 0.5 + 0.25);
    expect(s!.week.gatewayTokens).toBe(0);
  });

  test("gateway usage counts every token kind, flags unpriced requests, and ignores other providers", () => {
    const row = gw("m1", 1, 0.1, { outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, unpricedRequests: 2 });
    const other = { ...gw("m1", 5000, 5), provider: "codex" };
    const [s] = summarisePools([pool], usage, [], resp(ok([row, other]), ok([row])));
    expect(s!.today.gatewayTokens).toBe(10);
    expect(s!.today.unpricedRequests).toBe(2);
  });

  test("per-member worst window and pool windows", () => {
    const [s] = summarisePools([pool], usage, [lim("m1", [["session", 10], ["week", 40]]), lim("m2", [["week", 100]]), lim("m3", [], "unavailable")], resp(ok([]), ok([])));
    expect(s!.members[0]).toMatchObject({ worstPercent: 40, worstLabel: "week" });
    expect(s!.members[1]).toMatchObject({ worstPercent: 100 });
    expect(s!.members[2]).toMatchObject({ limitMissing: "limits unavailable" });
    expect(s!.members[2]!.worstPercent).toBeUndefined();
    expect(s!.windows.find((w) => w.label === "week")).toEqual({ label: "week", worstPercent: 100, meanPercent: 70, reporting: 2, total: 3 });
  });
});
