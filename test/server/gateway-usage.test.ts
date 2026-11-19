import { describe, expect, test } from "bun:test";
import type { Identity } from "../../src/identities/types.ts";
import type { ModelDailyUsageRow, ModelUsageRow } from "../../src/gateway/types.ts";
import type { GatewayModelUsageView } from "../../src/gateway/usage-view.ts";
import { GATEWAY_USAGE_WINDOW_DAYS, gatewayUsageResults, mergeGatewayUsage } from "../../src/server/gateway-usage.ts";

const FIRST = "2026-11-19T07:00:00.000Z";
const LAST = "2026-11-19T10:00:00.000Z";
const STAMP = "2026-11-19T08:00:00.000Z";

const identity = (name: string): Identity => ({ name, label: `Label ${name}`, configDir: `/profiles/${name}` });

const modelRow = (provider: string, name: string, app: string, model: string | null, over: Partial<ModelUsageRow> = {}): ModelUsageRow => ({
  provider,
  identity: name,
  app,
  model,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estCostUsd: 0,
  unpricedRequests: 0,
  requests: 0,
  ...over,
});

const view = (rows: ModelUsageRow[], over: Partial<GatewayModelUsageView> = {}): GatewayModelUsageView => ({ configured: true, rows, ...over });

/** A host usage row as the snapshot serves it: canonical provider, full registry entry, entries without client. */
const hostRow = (provider: string, name: string, over: Record<string, unknown> = {}) => ({
  provider,
  identity: identity(name),
  report: {
    entries: [{ model: "host-model", provider, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, messageCount: 1, cost: 0.01 }],
    totalInput: 1, totalOutput: 1, totalCacheRead: 0, totalCacheWrite: 0, totalMessages: 1, totalCost: 0.01,
  },
  dailyTotals: { "2026-11-19": [1, 1, 0, 0, 1, 0.01] },
  dailyUsage: { "2026-11-19": 2 },
  ...over,
});
const payload = (results: unknown[]) => ({ results, generatedAt: STAMP, stale: false, pending: false });
const noRegistries = async () => [];
const noManaged = async () => [];

describe("gatewayUsageResults", () => {
  const rows = [
    modelRow("claude", "m1", "web", "sonnet", { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, estCostUsd: 0.5, requests: 2, firstTs: "2026-11-19T08:00:00.000Z", lastTs: "2026-11-19T09:00:00.000Z" }),
    modelRow("claude", "m1", "cli", "sonnet", { inputTokens: 1, outputTokens: 1, estCostUsd: 0.1, requests: 1, firstTs: FIRST, lastTs: FIRST }),
    modelRow("claude", "m1", "web", null, { inputTokens: 2, outputTokens: 2, requests: 1, firstTs: LAST, lastTs: LAST }),
    modelRow("codex", "c1", "web", "gpt", { inputTokens: 3, outputTokens: 3, estCostUsd: 1, requests: 1, firstTs: FIRST, lastTs: LAST }),
  ];

  test("sums each model across apps, maps the provider, keeps a null model and spans the dates", () => {
    const results = gatewayUsageResults(view(rows));
    expect(results.map((r) => `${r.provider}/${r.identity.name}`)).toEqual(["anthropic/m1", "openai/c1"]);
    const m1 = results[0]!;
    expect(m1.report!.entries.map((e) => e.model)).toEqual(["sonnet", "(unknown)"]);
    expect(m1.report!.entries[0]).toMatchObject({ provider: "anthropic", input: 11, output: 6, cacheRead: 100, cacheWrite: 0, reasoning: 0, messageCount: 3, cost: 0.6 });
    expect(m1.report!.entries[1]).toMatchObject({ input: 2, output: 2, messageCount: 1, cost: 0 });
    expect(m1.report).toMatchObject({ totalInput: 13, totalOutput: 8, totalCacheRead: 100, totalCacheWrite: 0, totalMessages: 4, totalCost: 0.6 });
    expect(m1.dateSpan).toEqual({ firstMs: Date.parse(FIRST), lastMs: Date.parse(LAST) });
    expect(m1.identity).toEqual({ name: "m1", label: "m1", configDir: "" });
  });

  test("the tool and identity filters select gateway rows", () => {
    expect(gatewayUsageResults(view(rows), { tool: "claude" }).map((r) => r.identity.name)).toEqual(["m1"]);
    expect(gatewayUsageResults(view(rows), { identity: "c1" }).map((r) => r.provider)).toEqual(["openai"]);
    expect(gatewayUsageResults(view(rows), { tool: "codex", identity: "m1" })).toEqual([]);
  });

  test("unconfigured or errored reads build nothing", () => {
    expect(gatewayUsageResults({ configured: false, rows })).toEqual([]);
    expect(gatewayUsageResults(view(rows, { error: "admin unreachable" }))).toEqual([]);
  });

  test("the window matches the admin API bound", () => {
    expect(GATEWAY_USAGE_WINDOW_DAYS).toBe(90);
  });
});

describe("mergeGatewayUsage", () => {
  const gatewayRows = [
    modelRow("claude", "m1", "web", "sonnet", { inputTokens: 10, outputTokens: 5, estCostUsd: 0.5, requests: 2, firstTs: FIRST, lastTs: LAST }),
    modelRow("codex", "c1", "web", "gpt", { inputTokens: 3, outputTokens: 3, estCostUsd: 1, requests: 1, firstTs: FIRST, lastTs: LAST }),
  ];

  test("gateway rows replace the host report and date span, keeping the host identity and overage", async () => {
    const extraCost = { active: true, label: "using extra usage" };
    const host = payload([
      hostRow("anthropic", "m1", { extraCost, error: "host scan partial" }),
      hostRow("anthropic", "pool"),
      hostRow("openai", "c1"),
    ]);
    const merged = (await mergeGatewayUsage(host, view(gatewayRows), {}, noRegistries, noManaged)) as typeof host;
    expect(merged.generatedAt).toBe(STAMP);
    expect(merged.results).toHaveLength(3);
    const m1 = merged.results[0] as Record<string, any>;
    expect(m1).toMatchObject({ provider: "anthropic", identity: identity("m1"), extraCost });
    expect(m1.report.totalInput).toBe(10);
    expect(m1.report.entries[0].model).toBe("sonnet");
    expect(m1.report.entries[0].client).toBeUndefined();
    expect(m1.dateSpan).toEqual({ firstMs: Date.parse(FIRST), lastMs: Date.parse(LAST) });
    // The view has no per-day rows here, so the host day splits and stale error are dropped, never faked.
    expect(m1.dailyTotals).toBeUndefined();
    expect(m1.dailyUsage).toBeUndefined();
    expect(m1.error).toBeUndefined();
    expect(merged.results[1]).toEqual(host.results[1]); // the pool is not a managed member row
    const c1 = merged.results[2] as Record<string, any>;
    expect(c1.report.totalInput).toBe(3);
    expect(c1.identity).toEqual(identity("c1"));
  });

  test("gateway rows with no host row are added with their registry entry when one exists", async () => {
    const host = payload([hostRow("anthropic", "m1")]);
    const registries = async () => [{ cfg: { toolName: "claude" } as never, file: { identities: [identity("m9")] } as never }];
    const rows = [
      modelRow("claude", "m9", "web", "sonnet", { inputTokens: 4, outputTokens: 4, estCostUsd: 0.2, requests: 1 }),
      modelRow("codex", "c9", "web", "gpt", { inputTokens: 5, outputTokens: 5, estCostUsd: 0.3, requests: 1 }),
    ];
    const merged = (await mergeGatewayUsage(host, view(rows), {}, registries)) as typeof host;
    expect(merged.results.map((r: any) => `${r.provider}/${r.identity.name}`)).toEqual(["anthropic/m1", "anthropic/m9", "openai/c9"]);
    expect((merged.results[1] as any).identity).toEqual(identity("m9"));
    expect((merged.results[2] as any).identity).toEqual({ name: "c9", label: "c9", configDir: "" });
    expect((merged.results[1] as any).report.entries[0].client).toBeUndefined();
  });

  test("an unconfigured gateway read leaves the host payload unchanged", async () => {
    const host = payload([hostRow("anthropic", "m1")]);
    expect(await mergeGatewayUsage(host, { configured: false, rows: [] }, {}, noRegistries, noManaged)).toBe(host);
    expect(await mergeGatewayUsage({ generatedAt: STAMP }, view(gatewayRows), {}, noRegistries, noManaged)).toEqual({ generatedAt: STAMP });
  });

  test("a failed gateway read marks managed identities with an error and keeps other host rows", async () => {
    const host = payload([hostRow("anthropic", "m1", { extraCost: { active: false, label: "x" } }), hostRow("anthropic", "pool"), hostRow("openai", "c1")]);
    const managed = async () => [{ provider: "anthropic", name: "m1" }, { provider: "openai", name: "c1" }];
    const merged = (await mergeGatewayUsage(host, view([], { error: "admin unreachable" }), {}, noRegistries, managed)) as typeof host;
    const m1 = merged.results[0] as Record<string, any>;
    expect(m1.error).toBe("gateway usage unavailable: admin unreachable");
    expect(m1.report).toBeUndefined();
    expect(m1.dailyTotals).toBeUndefined();
    expect(m1.dailyUsage).toBeUndefined();
    expect(m1.extraCost).toEqual({ active: false, label: "x" });
    expect(m1.identity).toEqual(identity("m1"));
    expect(merged.results[1]).toEqual(host.results[1]); // not managed by the gateway: host numbers stay
    expect((merged.results[2] as any).error).toContain("gateway usage unavailable");
  });

  test("a managed identity with no ledger rows shows zero, never host numbers", async () => {
    const host = payload([hostRow("anthropic", "m1"), hostRow("anthropic", "pool")]);
    const managed = async () => [{ provider: "anthropic", name: "m1" }];
    const merged = (await mergeGatewayUsage(host, view([modelRow("codex", "c1", "web", "gpt", { inputTokens: 1 })]), {}, noRegistries, managed)) as typeof host;
    const m1 = merged.results[0] as Record<string, any>;
    expect(m1.report).toMatchObject({ totalInput: 0, totalOutput: 0, totalMessages: 0, totalCost: 0, entries: [] });
    expect(m1.error).toBeUndefined();
    expect(merged.results[1]).toEqual(host.results[1]);
  });

  test("per-day rows fill dailyUsage and dailyTotals in the host shape, summed across models", async () => {
    const day = (d: string, model: string | null, over: Partial<ModelDailyUsageRow> = {}): ModelDailyUsageRow => ({
      day: d, provider: "claude", identity: "m1", model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0, unpricedRequests: 0, requests: 0, ...over,
    });
    const daily = [
      day("2026-11-19", "sonnet", { inputTokens: 6, outputTokens: 3, cacheReadTokens: 50, estCostUsd: 0.3, requests: 1 }),
      day("2026-11-19", null, { inputTokens: 1, outputTokens: 1, requests: 1 }),
      day("2026-11-18", "sonnet", { inputTokens: 4, outputTokens: 2, cacheWriteTokens: 7, estCostUsd: 0.2, requests: 1 }),
      { ...day("2026-11-19", "gpt", { inputTokens: 3, outputTokens: 3, estCostUsd: 1, requests: 1 }), provider: "codex", identity: "c1" },
    ];
    const host = payload([hostRow("anthropic", "m1"), hostRow("openai", "c1")]);
    const merged = (await mergeGatewayUsage(host, view(gatewayRows, { daily, dailyZone: "UTC" }), {}, noRegistries, noManaged)) as typeof host;
    const m1 = merged.results[0] as Record<string, any>;
    expect(m1.dailyUsage).toEqual({ "2026-11-19": 11, "2026-11-18": 6 });
    expect(m1.dailyTotals).toEqual({
      "2026-11-19": [7, 4, 50, 0, 2, 0.3],
      "2026-11-18": [4, 2, 0, 7, 1, 0.2],
    });
    expect((merged.results[1] as any).dailyTotals).toEqual({ "2026-11-19": [3, 3, 0, 0, 1, 1] });
  });

  test("the daily filters follow the tool and identity filters", () => {
    const daily: ModelDailyUsageRow[] = [
      { day: "2026-11-19", provider: "claude", identity: "m1", model: "s", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0, unpricedRequests: 0, requests: 1 },
      { day: "2026-11-19", provider: "codex", identity: "c1", model: "g", inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0, unpricedRequests: 0, requests: 1 },
    ];
    const results = gatewayUsageResults(view([], { daily }), { tool: "codex" });
    expect(results.map((r) => r.identity.name)).toEqual(["c1"]);
    expect(results[0]!.dailyUsage).toEqual({ "2026-11-19": 4 });
  });

  test("the tool and identity filters apply to the gateway rows too", async () => {
    const host = payload([hostRow("anthropic", "m1"), hostRow("openai", "c1")]);
    const rows = [
      modelRow("claude", "m1", "web", "sonnet", { inputTokens: 10, outputTokens: 5, estCostUsd: 0.5, requests: 2 }),
      modelRow("claude", "m9", "web", "sonnet", { inputTokens: 4, outputTokens: 4, estCostUsd: 0.2, requests: 1 }),
      modelRow("codex", "c9", "web", "gpt", { inputTokens: 5, outputTokens: 5, estCostUsd: 0.3, requests: 1 }),
    ];
    const byTool = (await mergeGatewayUsage(host, view(rows), { tool: "claude" }, noRegistries, noManaged)) as typeof host;
    expect(byTool.results.map((r: any) => `${r.provider}/${r.identity.name}`)).toEqual(["anthropic/m1", "openai/c1", "anthropic/m9"]);
    const byIdentity = (await mergeGatewayUsage(host, view(rows), { identity: "m1" }, noRegistries, noManaged)) as typeof host;
    expect(byIdentity.results.map((r: any) => r.identity.name)).toEqual(["m1", "c1"]);
    expect((byIdentity.results[0] as any).report.totalInput).toBe(10);
  });
});