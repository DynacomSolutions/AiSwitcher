import { describe, expect, test } from "bun:test";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
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

describe("MemoryGatewayStore", () => {
  test("apps put, get, list and revoke", async () => {
    const s = new MemoryGatewayStore();
    expect(await s.getApp("a")).toBeUndefined();
    await s.putApp(base);
    expect((await s.getApp("a"))?.state).toBe("active");
    expect(await s.listApps()).toHaveLength(1);
    await s.revokeApp("a");
    expect((await s.getApp("a"))?.state).toBe("revoked");
  });

  test("expireTokens only touches the given app and unexpired tokens", async () => {
    const s = new MemoryGatewayStore();
    await s.addToken({ app: "a", prefix: "p1", hash: "h1", createdAt: "t" });
    await s.addToken({ app: "b", prefix: "p2", hash: "h2", createdAt: "t" });
    await s.expireTokens("a", "2026-11-02T00:00:00.000Z");
    await s.expireTokens("a", "2026-12-01T00:00:00.000Z");
    expect((await s.tokensFor("a"))[0]?.expiresAt).toBe("2026-11-02T00:00:00.000Z");
    expect((await s.tokensFor("b"))[0]?.expiresAt).toBeUndefined();
  });

  test("usageSince sums input and output for the app since the cutoff", async () => {
    const s = new MemoryGatewayStore();
    await s.appendUsage([
      row("a", "2026-11-01T00:00:00.000Z", 5, 5),
      row("a", "2026-11-02T01:00:00.000Z", 10, 20),
      row("b", "2026-11-02T01:00:00.000Z", 99, 99),
    ]);
    expect(await s.usageSince("a", new Date("2026-11-02T00:00:00.000Z"))).toBe(30);
    expect(await s.usageSince("a", new Date("2026-10-01T00:00:00.000Z"))).toBe(40);
  });
});
