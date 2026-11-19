import { describe, expect, test } from "bun:test";
import type { Identity } from "../../src/identities/types.ts";
import type { ModelUsageRow } from "../../src/gateway/types.ts";
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
    const merged = (await mergeGatewayUsage(host, view(gatewayRows), {}, noRegistries)) as typeof host;
    expect(merged.generatedAt).toBe(STAMP);
    expect(merged.results).toHaveLength(3);
    const m1 = merged.results[0] as Record<string, any>;
    expect(m1).toMatchObject({ provider: "anthropic", identity: identity("m1"), extraCost });
    expect(m1.report.totalInput).toBe(10);
    expect(m1.report.entries[0].model).toBe("sonnet");
    expect(m1.report.entries[0].client).toBeUndefined();
    expect(m1.dateSpan).toEqual({ firstMs: Date.parse(FIRST), lastMs: Date.parse(LAST) });
    // The gateway cannot split by day, so the host day splits and stale error are dropped, never faked.
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

  test("an unconfigured or failed gateway read leaves the host payload unchanged", async () => {
    const host = payload([hostRow("anthropic", "m1")]);
    expect(await mergeGatewayUsage(host, { configured: false, rows: [] }, {}, noRegistries)).toBe(host);
    expect(await mergeGatewayUsage(host, view(gatewayRows, { error: "admin unreachable" }), {}, noRegistries)).toBe(host);
    expect(await mergeGatewayUsage({ generatedAt: STAMP }, view(gatewayRows), {}, noRegistries)).toEqual({ generatedAt: STAMP });
  });

  test("the tool and identity filters apply to the gateway rows too", async () => {
    const host = payload([hostRow("anthropic", "m1"), hostRow("openai", "c1")]);
    const rows = [
      modelRow("claude", "m1", "web", "sonnet", { inputTokens: 10, outputTokens: 5, estCostUsd: 0.5, requests: 2 }),
      modelRow("claude", "m9", "web", "sonnet", { inputTokens: 4, outputTokens: 4, estCostUsd: 0.2, requests: 1 }),
      modelRow("codex", "c9", "web", "gpt", { inputTokens: 5, outputTokens: 5, estCostUsd: 0.3, requests: 1 }),
    ];
    const byTool = (await mergeGatewayUsage(host, view(rows), { tool: "claude" }, noRegistries)) as typeof host;
    expect(byTool.results.map((r: any) => `${r.provider}/${r.identity.name}`)).toEqual(["anthropic/m1", "openai/c1", "anthropic/m9"]);
    const byIdentity = (await mergeGatewayUsage(host, view(rows), { identity: "m1" }, noRegistries)) as typeof host;
    expect(byIdentity.results.map((r: any) => r.identity.name)).toEqual(["m1", "c1"]);
    expect((byIdentity.results[0] as any).report.totalInput).toBe(10);
  });
});