import { expect, test } from "bun:test";
import { AppRevokedError, type GatewayStore } from "../../src/gateway/store.ts";
import type { GatewayApp, UsageRow } from "../../src/gateway/types.ts";

const base: GatewayApp = {
  name: "a",
  owner: "o",
  namespace: "ns",
  provider: "codex",
  style: "openai",
  target: { kind: "pin", identity: "id1" },
  state: "active",
  createdAt: "2026-11-01T00:00:00.000Z",
};

function row(app: string, ts: string, input: number, output: number): UsageRow {
  return {
    ts,
    app,
    provider: "codex",
    identity: "id1",
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    status: "ok",
    httpStatus: 200,
    latencyMs: 10,
    streamed: false,
  };
}

/** Behaviour every GatewayStore must share. makeStore must return an empty store. */
export function storeContract(makeStore: () => Promise<GatewayStore>): void {
  test("apps put, get, list, overwrite and revoke", async () => {
    const s = await makeStore();
    expect(await s.getApp("a")).toBeUndefined();
    const full: GatewayApp = {
      ...base,
      target: { kind: "pool", identities: ["x", "y"] },
      models: ["m1"],
      dailyTokens: 1000,
      reservePercent: 10,
      lastUsedAt: "2026-11-01T12:00:00.000Z",
    };
    await s.putApp(full);
    expect(await s.getApp("a")).toEqual(full);
    await s.putApp({ ...base, owner: "o2" });
    expect((await s.getApp("a"))?.owner).toBe("o2");
    expect(await s.listApps()).toHaveLength(1);
    await s.revokeApp("a");
    expect((await s.getApp("a"))?.state).toBe("revoked");
  });

  test("tokens add and list per app", async () => {
    const s = await makeStore();
    await s.putApp(base);
    await s.putApp({ ...base, name: "b" });
    await s.addToken({ app: "a", prefix: "p1", hash: "h1", createdAt: "2026-11-01T00:00:00.000Z" });
    await s.addToken({ app: "b", prefix: "p2", hash: "h2", createdAt: "2026-11-01T00:00:00.000Z" });
    const toks = await s.tokensFor("a");
    expect(toks).toEqual([
      { app: "a", prefix: "p1", hash: "h1", createdAt: "2026-11-01T00:00:00.000Z" },
    ]);
  });

  test("expireTokens only touches the given app and unexpired tokens", async () => {
    const s = await makeStore();
    await s.putApp(base);
    await s.putApp({ ...base, name: "b" });
    await s.addToken({ app: "a", prefix: "p1", hash: "h1", createdAt: "2026-11-01T00:00:00.000Z" });
    await s.addToken({ app: "b", prefix: "p2", hash: "h2", createdAt: "2026-11-01T00:00:00.000Z" });
    await s.expireTokens("a", "2026-11-02T00:00:00.000Z");
    await s.expireTokens("a", "2026-12-01T00:00:00.000Z");
    expect((await s.tokensFor("a"))[0]?.expiresAt).toBe("2026-11-02T00:00:00.000Z");
    expect((await s.tokensFor("b"))[0]?.expiresAt).toBeUndefined();
  });

  test("a revoked app is final: putApp and addToken throw and change nothing", async () => {
    const s = await makeStore();
    await s.putApp(base);
    await s.addToken({ app: "a", prefix: "p1", hash: "h1", createdAt: "2026-11-01T00:00:00.000Z" });
    await s.revokeApp("a");
    await expect(s.putApp({ ...base, owner: "o2", state: "active" })).rejects.toBeInstanceOf(AppRevokedError);
    expect((await s.getApp("a"))?.state).toBe("revoked");
    expect((await s.getApp("a"))?.owner).toBe("o");
    await expect(s.addToken({ app: "a", prefix: "p2", hash: "h2", createdAt: "2026-11-01T00:00:00.000Z" })).rejects.toBeInstanceOf(AppRevokedError);
    expect((await s.tokensFor("a")).map((t) => t.prefix)).toEqual(["p1"]);
  });

  test("addToken for an app that does not exist throws", async () => {
    const s = await makeStore();
    await expect(s.addToken({ app: "ghost", prefix: "p1", hash: "h1", createdAt: "2026-11-01T00:00:00.000Z" })).rejects.toBeInstanceOf(AppRevokedError);
    expect(await s.tokensFor("ghost")).toEqual([]);
  });

  test("revokeApp stops every token of that app now and leaves other apps alone", async () => {
    const s = await makeStore();
    await s.putApp(base);
    await s.putApp({ ...base, name: "b" });
    await s.addToken({ app: "a", prefix: "p1", hash: "h1", createdAt: "2026-11-01T00:00:00.000Z" });
    await s.addToken({ app: "a", prefix: "p2", hash: "h2", createdAt: "2026-11-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" });
    await s.addToken({ app: "a", prefix: "p3", hash: "h3", createdAt: "2026-11-01T00:00:00.000Z", expiresAt: "2026-11-02T00:00:00.000Z" });
    await s.addToken({ app: "b", prefix: "p4", hash: "h4", createdAt: "2026-11-01T00:00:00.000Z" });
    const before = Date.now();
    await s.revokeApp("a");
    const toks = await s.tokensFor("a");
    for (const t of toks.filter((x) => x.prefix !== "p3")) {
      expect(Date.parse(t.expiresAt!)).toBeGreaterThanOrEqual(before - 5000);
      expect(Date.parse(t.expiresAt!)).toBeLessThanOrEqual(Date.now() + 5000);
    }
    // A token that had already expired keeps its earlier expiry.
    expect(toks.find((t) => t.prefix === "p3")?.expiresAt).toBe("2026-11-02T00:00:00.000Z");
    expect((await s.tokensFor("b"))[0]?.expiresAt).toBeUndefined();
  });

  test("bumpSideCount counts per app and day and returns the running total", async () => {
    const s = await makeStore();
    expect(await s.bumpSideCount("a", "2026-11-02")).toBe(1);
    expect(await s.bumpSideCount("a", "2026-11-02")).toBe(2);
    expect(await s.bumpSideCount("b", "2026-11-02")).toBe(1);
    expect(await s.bumpSideCount("a", "2026-11-03")).toBe(1);
  });

  test("usageSince sums input, output and cache-write for the app since the cutoff", async () => {
    const s = await makeStore();
    await s.putApp(base);
    await s.putApp({ ...base, name: "b" });
    await s.appendUsage([
      row("a", "2026-11-01T00:00:00.000Z", 5, 5),
      row("a", "2026-11-02T01:00:00.000Z", 10, 20),
      row("b", "2026-11-02T01:00:00.000Z", 99, 99),
    ]);
    expect(await s.usageSince("a", new Date("2026-11-02T00:00:00.000Z"))).toBe(30);
    expect(await s.usageSince("a", new Date("2026-10-01T00:00:00.000Z"))).toBe(40);
    expect(await s.usageSince("nobody", new Date(0))).toBe(0);
    await s.appendUsage([{ ...row("a", "2026-11-02T02:00:00.000Z", 1, 1), cacheReadTokens: 100, cacheWriteTokens: 7 }]);
    expect(await s.usageSince("a", new Date("2026-11-02T00:00:00.000Z"))).toBe(39);
    const totals = await s.usageTotalsSince(new Date("2026-11-02T00:00:00.000Z"));
    expect(Object.fromEntries(totals)).toEqual({ a: 39, b: 198 });
    expect((await s.usageTotalsSince(new Date("2027-01-01T00:00:00.000Z"))).size).toBe(0);
  });

  test("usageByIdentity totals per provider and identity inside the window", async () => {
    const s = await makeStore();
    await s.appendUsage([
      { ...row("a", "2026-11-02T01:00:00.000Z", 10, 20), identity: "m1", cacheReadTokens: 5, estCostUsd: 0.5 },
      { ...row("b", "2026-11-02T02:00:00.000Z", 1, 1), identity: "m1" },
      { ...row("a", "2026-11-02T03:00:00.000Z", 3, 0), identity: "m2", estCostUsd: 0.1 },
      { ...row("a", "2026-10-01T00:00:00.000Z", 999, 0), identity: "m1" },
    ]);
    const got = await s.usageByIdentity(new Date("2026-11-02T00:00:00.000Z"));
    const sorted = [...got].sort((x, y) => `${x.identity}/${x.app}`.localeCompare(`${y.identity}/${y.app}`));
    expect(sorted).toEqual([
      { provider: "codex", identity: "m1", app: "a", inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0, estCostUsd: 0.5, unpricedRequests: 0, requests: 1 },
      { provider: "codex", identity: "m1", app: "b", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0, unpricedRequests: 1, requests: 1 },
      { provider: "codex", identity: "m2", app: "a", inputTokens: 3, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0.1, unpricedRequests: 0, requests: 1 },
    ]);
    expect(await s.usageByIdentity(new Date("2026-11-02T00:00:00.000Z"), new Date("2026-11-02T02:00:00.000Z"))).toHaveLength(1);
    expect(await s.usageByIdentity(new Date("2027-01-01T00:00:00.000Z"))).toEqual([]);
  });

  test("usageByModel totals per provider, identity, app and model inside the window", async () => {
    const s = await makeStore();
    await s.appendUsage([
      { ...row("a", "2026-11-02T01:00:00.000Z", 10, 20), identity: "m1", model: "ma", cacheReadTokens: 5, estCostUsd: 0.5 },
      { ...row("a", "2026-11-02T03:00:00.000Z", 3, 4), identity: "m1", model: "ma", estCostUsd: 0.2 },
      { ...row("b", "2026-11-02T02:00:00.000Z", 1, 1), identity: "m1", model: "ma", estCostUsd: 0.3 },
      { ...row("a", "2026-11-02T04:00:00.000Z", 7, 0), identity: "m1", model: "mb", estCostUsd: 0.1 },
      { ...row("a", "2026-11-02T05:00:00.000Z", 2, 2), identity: "m1" },
      { ...row("a", "2026-10-01T00:00:00.000Z", 999, 0), identity: "m1", model: "ma", estCostUsd: 9 },
    ]);
    const got = await s.usageByModel(new Date("2026-11-02T00:00:00.000Z"));
    const sorted = [...got].sort((x, y) => `${x.identity}/${x.app}/${x.model ?? ""}`.localeCompare(`${y.identity}/${y.app}/${y.model ?? ""}`));
    expect(sorted).toEqual([
      { provider: "codex", identity: "m1", app: "a", model: null, inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0, unpricedRequests: 1, requests: 1, firstTs: "2026-11-02T05:00:00.000Z", lastTs: "2026-11-02T05:00:00.000Z" },
      { provider: "codex", identity: "m1", app: "a", model: "ma", inputTokens: 13, outputTokens: 24, cacheReadTokens: 5, cacheWriteTokens: 0, estCostUsd: 0.7, unpricedRequests: 0, requests: 2, firstTs: "2026-11-02T01:00:00.000Z", lastTs: "2026-11-02T03:00:00.000Z" },
      { provider: "codex", identity: "m1", app: "a", model: "mb", inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0.1, unpricedRequests: 0, requests: 1, firstTs: "2026-11-02T04:00:00.000Z", lastTs: "2026-11-02T04:00:00.000Z" },
      { provider: "codex", identity: "m1", app: "b", model: "ma", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0.3, unpricedRequests: 0, requests: 1, firstTs: "2026-11-02T02:00:00.000Z", lastTs: "2026-11-02T02:00:00.000Z" },
    ]);
    const win = await s.usageByModel(new Date("2026-11-02T00:00:00.000Z"), new Date("2026-11-02T03:00:00.000Z"));
    expect(win.map((r) => `${r.app}/${r.model}`).sort()).toEqual(["a/ma", "b/ma"]);
    expect(await s.usageByModel(new Date("2027-01-01T00:00:00.000Z"))).toEqual([]);
  });

  test("usageByModelDaily buckets per day in the zone, sums apps, prices null costs and bounds the window", async () => {
    const s = await makeStore();
    await s.appendUsage([
      { ...row("a", "2026-11-02T01:00:00.000Z", 10, 20), identity: "m1", model: "ma", cacheReadTokens: 5, estCostUsd: 0.5 },
      { ...row("b", "2026-11-02T03:00:00.000Z", 3, 4), identity: "m1", model: "ma", estCostUsd: 0.25 },
      // 18:00 UTC is already the next day in Bangkok (UTC+7).
      { ...row("a", "2026-11-02T18:00:00.000Z", 7, 0), identity: "m1", model: "ma", estCostUsd: 0.125 },
      { ...row("a", "2026-11-02T05:00:00.000Z", 2, 2), identity: "m1" },
      { ...row("a", "2026-10-01T00:00:00.000Z", 999, 0), identity: "m1", model: "ma", estCostUsd: 9 },
    ]);
    const utc = await s.usageByModelDaily(new Date("2026-11-02T00:00:00.000Z"), undefined, "UTC");
    expect(utc).toEqual([
      { day: "2026-11-02", provider: "codex", identity: "m1", model: "ma", inputTokens: 20, outputTokens: 24, cacheReadTokens: 5, cacheWriteTokens: 0, estCostUsd: 0.875, unpricedRequests: 0, requests: 3 },
      { day: "2026-11-02", provider: "codex", identity: "m1", model: null, inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0, unpricedRequests: 1, requests: 1 },
    ]);
    const bkk = await s.usageByModelDaily(new Date("2026-11-02T00:00:00.000Z"), undefined, "Asia/Bangkok");
    expect(bkk.map((r) => `${r.day}/${r.model}/${r.inputTokens}`)).toEqual(["2026-11-02/ma/13", "2026-11-02/null/2", "2026-11-03/ma/7"]);
    const win = await s.usageByModelDaily(new Date("2026-11-02T00:00:00.000Z"), new Date("2026-11-02T04:00:00.000Z"), "UTC");
    expect(win.map((r) => r.requests)).toEqual([2]);
    expect(await s.usageByModelDaily(new Date("2027-01-01T00:00:00.000Z"), undefined, "UTC")).toEqual([]);
    // The days add up to the per-model totals over the same window.
    const total = (await s.usageByModel(new Date("2026-11-02T00:00:00.000Z"))).reduce((n, r) => n + r.inputTokens, 0);
    expect(utc.reduce((n, r) => n + r.inputTokens, 0)).toBe(total);
  });

  test("appendUsage accepts an empty batch", async () => {
    const s = await makeStore();
    await s.appendUsage([]);
  });
}
