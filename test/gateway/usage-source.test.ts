import { describe, expect, test } from "bun:test";
import type { PoolUsage } from "../../src/identities/pool/adapter.ts";
import { pickIdentity } from "../../src/gateway/select.ts";
import { createUsageSource } from "../../src/gateway/usage-source.ts";
import type { GatewayApp } from "../../src/gateway/types.ts";

const live = (u: number): PoolUsage => ({ status: "live", maxUtilization: u, capturedAt: "2026-11-02T00:00:00.000Z" });
const app: GatewayApp = {
  name: "a", owner: "o", namespace: "n", provider: "claude", style: "anthropic",
  target: { kind: "pin", identity: "id1" }, reservePercent: 80, state: "active", createdAt: "2026-11-01T00:00:00.000Z",
};

describe("usage source", () => {
  test("reserve rejects once the cache holds usage above the threshold", async () => {
    const src = createUsageSource({ fetchUsage: async () => live(95), ttlMs: 45_000 });
    const deps = { usageFor: src.get, poolMembers: async () => ["id1"] };
    expect(await pickIdentity(app, deps)).toEqual({ identity: "id1" }); // cold miss allows
    await src.idle();
    expect(await pickIdentity(app, deps)).toEqual({ reject: "reserve" });
  });

  test("cold miss returns undefined at once and fills in the background", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const src = createUsageSource({ fetchUsage: async () => (await hold, live(10)) });
    expect(await src.get("claude", "id1")).toBeUndefined();
    release();
    await src.idle();
    expect(await src.get("claude", "id1")).toEqual(live(10));
  });

  test("concurrent misses trigger one fetch", async () => {
    let calls = 0;
    const src = createUsageSource({ fetchUsage: async () => (calls++, live(1)) });
    await Promise.all([src.get("claude", "id1"), src.get("claude", "id1"), src.get("claude", "id1")]);
    await src.idle();
    expect(calls).toBe(1);
  });

  test("stale value is served while a refresh runs, once", async () => {
    let t = 0;
    let calls = 0;
    let value = live(10);
    let gate: Promise<void> = Promise.resolve();
    const src = createUsageSource({ fetchUsage: async () => (calls++, await gate, value), ttlMs: 1000, now: () => t });
    await src.prefill("claude", "id1");
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    expect(await src.get("claude", "id1")).toEqual(live(10));
    t = 2000;
    value = live(60);
    expect(await src.get("claude", "id1")).toEqual(live(10));
    expect(await src.get("claude", "id1")).toEqual(live(10));
    open();
    await src.idle();
    expect(calls).toBe(2);
    expect(await src.get("claude", "id1")).toEqual(live(60));
  });

  test("unavailable means no figure, and a failing fetch keeps the old value", async () => {
    let mode: "unavailable" | "throw" = "unavailable";
    let t = 0;
    const src = createUsageSource({
      fetchUsage: async () => {
        if (mode === "throw") throw new Error("x");
        return { status: "unavailable", capturedAt: "x" } as PoolUsage;
      },
      ttlMs: 1000,
      now: () => t,
    });
    await src.prefill("claude", "id1");
    expect(await src.get("claude", "id1")).toBeUndefined();
    mode = "throw";
    t = 5000;
    await src.get("claude", "id1");
    await src.idle();
    expect(await src.get("claude", "id1")).toBeUndefined();
  });
});
