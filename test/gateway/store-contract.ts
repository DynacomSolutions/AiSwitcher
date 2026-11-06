import { expect, test } from "bun:test";
import type { GatewayStore } from "../../src/gateway/store.ts";
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

  test("appendUsage accepts an empty batch", async () => {
    const s = await makeStore();
    await s.appendUsage([]);
  });
}
