import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateChatModelTokenCost, setFetchedChatPriceLookup } from "../../src/identities/model-pricing.ts";
import { ModelPriceSource, parseLitellmPrices, REFRESH_INTERVAL_MS } from "../../src/identities/model-price-source.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import type { UsageRow } from "../../src/gateway/types.ts";
import { estimateCostWarn } from "../../src/gateway/usage.ts";

const FIXTURE = {
  sample_spec: { mode: "chat" },
  "claude-opus-5-5": { input_cost_per_token: 4e-6, output_cost_per_token: 2e-5, cache_read_input_token_cost: 2e-7, cache_creation_input_token_cost: 5e-6, litellm_provider: "anthropic", mode: "chat" },
  "claude-opus-5-5-20261101": { input_cost_per_token: 9e-6, output_cost_per_token: 9e-5, litellm_provider: "anthropic", mode: "chat" },
  "vertex_ai/claude-sonnet-5-5": { input_cost_per_token: 9, output_cost_per_token: 9, mode: "chat" },
  "anthropic/claude-haiku-5-5": { input_cost_per_token: 1e-7, output_cost_per_token: 5e-7, cache_read_input_token_cost: 1e-8, litellm_provider: "anthropic", mode: "chat" },
  "text-embedding-3": { input_cost_per_token: 1e-7, mode: "embedding" },
};

const dir = (): string => mkdtempSync(join(tmpdir(), "ais-prices-"));
const okFetch = (doc: unknown, calls?: { n: number }): typeof fetch =>
  (async () => {
    if (calls) calls.n += 1;
    return new Response(JSON.stringify(doc), { status: 200 });
  }) as unknown as typeof fetch;

afterEach(() => setFetchedChatPriceLookup(undefined));

describe("parseLitellmPrices", () => {
  test("keeps first-party chat entries per million and drops other providers and modes", () => {
    const p = parseLitellmPrices(FIXTURE);
    expect(p["claude-opus-5-5"]).toEqual([4, 20, 0.2, 5]);
    expect(p["claude-haiku-5-5"]).toEqual([0.1, 0.5, 0.01, 0.1]);
    expect(p["claude-sonnet-5-5"]).toBeUndefined();
    expect(p["text-embedding-3"]).toBeUndefined();
  });
});

describe("ModelPriceSource", () => {
  test("fetched price wins over the hand table, and falls back when absent", async () => {
    const src = new ModelPriceSource({ fetch: okFetch(FIXTURE), cachePath: join(dir(), "p.json"), now: () => 1_700_000_000_000 });
    expect(src.lookup("claude-opus-5-5")).toBeUndefined(); // never blocks: list not loaded yet
    await src.idle();
    setFetchedChatPriceLookup((id) => src.lookup(id));
    // dated snapshot maps to base; fixture says 4/20, not the dated 9/90 entry
    expect(estimateChatModelTokenCost("claude-opus-5-5-20261101", 1_000_000, 1_000_000, 0, 0)).toBeCloseTo(24, 6);
    // not in fetched list: hand table
    expect(estimateChatModelTokenCost("claude-sonnet-4-6", 1_000_000, 0, 0, 0)).toBeCloseTo(3, 6);
    expect(estimateChatModelTokenCost("claude-nope-9", 1, 1, 0, 0)).toBeUndefined();
  });

  test("keeps the stale cache when a refresh fails", async () => {
    const path = join(dir(), "p.json");
    const logs: string[] = [];
    let t = 1_700_000_000_000;
    const first = new ModelPriceSource({ fetch: okFetch(FIXTURE), cachePath: path, now: () => t });
    first.lookup("x");
    await first.idle();
    expect(existsSync(path)).toBe(true);
    t += REFRESH_INTERVAL_MS + 1;
    const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const second = new ModelPriceSource({ fetch: failing, cachePath: path, now: () => t, log: (l) => logs.push(l) });
    expect(second.lookup("claude-opus-5-5")?.usdPer1mInput).toBe(4); // cache served at once
    await second.idle();
    expect(second.lookup("claude-opus-5-5")?.usdPer1mOutput).toBe(20);
    expect(logs.join("")).toContain("model_prices_refresh_failed");
    expect(JSON.parse(readFileSync(path, "utf8")).prices["claude-opus-5-5"]).toBeDefined();
  });

  test("refreshes at most once a day", async () => {
    const calls = { n: 0 };
    const path = join(dir(), "p.json");
    let t = 1_700_000_000_000;
    const a = new ModelPriceSource({ fetch: okFetch(FIXTURE, calls), cachePath: path, now: () => t });
    a.lookup("x");
    await a.idle();
    expect(calls.n).toBe(1);
    t += 3_600_000;
    a.lookup("x");
    const b = new ModelPriceSource({ fetch: okFetch(FIXTURE, calls), cachePath: path, now: () => t });
    b.lookup("x");
    await Promise.all([a.idle(), b.idle()]);
    expect(calls.n).toBe(1);
    t += REFRESH_INTERVAL_MS;
    a.lookup("x");
    await a.idle();
    expect(calls.n).toBe(2);
  });

  test("a corrupt cache and a failing fetch leave lookups empty without throwing", async () => {
    const path = join(dir(), "p.json");
    writeFileSync(path, "{nope");
    const failing = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const src = new ModelPriceSource({ fetch: failing, cachePath: path, log: () => {} });
    expect(src.lookup("claude-opus-5-5")).toBeUndefined();
    await src.idle();
  });
});

describe("background flag", () => {
  test("preload reads the cache with no fetch; refresh starts only once enabled", async () => {
    const path = join(dir(), "p.json");
    const seed = new ModelPriceSource({ fetch: okFetch(FIXTURE), cachePath: path, now: () => 1_700_000_000_000 });
    seed.lookup("x");
    await seed.idle();
    const calls = { n: 0 };
    const cli = new ModelPriceSource({ fetch: okFetch(FIXTURE, calls), cachePath: path, now: () => 1_700_000_000_000 + 3 * REFRESH_INTERVAL_MS, background: false });
    cli.preload();
    expect(cli.lookup("claude-opus-5-5")?.usdPer1mOutput).toBe(20);
    await cli.idle();
    expect(calls.n).toBe(0);
    cli.enableBackgroundRefresh();
    await cli.idle();
    expect(calls.n).toBe(1);
  });
});

describe("read-time pricing and warnings", () => {
  test("NULL-cost rows are priced from tokens and model at read time", async () => {
    setFetchedChatPriceLookup((id) => (id === "claude-opus-5-5" ? { usdPer1mInput: 4, usdPer1mOutput: 20, usdPer1mCacheRead: 0.2, usdPer1mCacheWrite: 5 } : undefined));
    const s = new MemoryGatewayStore();
    const rows: UsageRow[] = [];
    const base = { ts: "2026-11-02T01:00:00.000Z", app: "a", provider: "claude" as const, identity: "i", cacheReadTokens: 0, cacheWriteTokens: 0, status: "ok", httpStatus: 200, latencyMs: 1, streamed: false };
    rows.push({ ...base, model: "claude-opus-5-5", inputTokens: 1_000_000, outputTokens: 1_000_000 });
    rows.push({ ...base, model: "claude-opus-4-7", inputTokens: 1_000_000, outputTokens: 0, estCostUsd: 5 });
    rows.push({ ...base, model: "mystery-1", inputTokens: 10, outputTokens: 0 });
    await s.appendUsage(rows);
    const [row] = await s.usageByIdentity(new Date("2026-11-01T00:00:00.000Z"));
    expect(row!.estCostUsd).toBeCloseTo(29, 6);
    expect(row!.unpricedRequests).toBe(1);
  });

  test("unknown model warns once per model", () => {
    const lines: string[] = [];
    const c = { model: "never-heard-of-it", inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(estimateCostWarn("claude", c, (l) => lines.push(l))).toBeUndefined();
    estimateCostWarn("claude", c, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ event: "unpriced_model", provider: "claude", model: "never-heard-of-it" });
    const other = { ...c, model: "other-unknown" };
    estimateCostWarn("claude", other, (l) => lines.push(l));
    expect(lines).toHaveLength(2);
  });
});
