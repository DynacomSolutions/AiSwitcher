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

test("a reading with no figure (usage API 429 or unavailable) keeps the last figure", async () => {
  let next: PoolUsage = { status: "rate-limited", maxUtilization: 100, windows: [{ label: "seven-day", utilization: 100 }], capturedAt: "a" };
  let t = 0;
  const src = createUsageSource({ fetchUsage: async () => next, ttlMs: 1000, now: () => t });
  await src.prefill("claude", "id1");
  for (const empty of [{ status: "rate-limited", error: "HTTP 429", capturedAt: "b" }, { status: "unavailable", capturedAt: "c" }] as PoolUsage[]) {
    next = empty;
    t += 5000;
    await src.get("claude", "id1");
    await src.idle();
    expect((await src.get("claude", "id1"))?.maxUtilization).toBe(100);
  }
});

// Incident 11 Nov 2026: a pinned T3 app stayed refused ("identity is at its usage reserve") after the owner reset the
// account. Anthropic's usage API kept answering 429, so the gateway kept the pre-reset 95% and refused every model call.
test("a kept figure is shown but never refuses: an account reset upstream gets through", async () => {
  let next: PoolUsage = live(95);
  let t = 0;
  const src = createUsageSource({ fetchUsage: async () => next, ttlMs: 1000, now: () => t });
  const deps = { usageFor: src.get, poolMembers: async () => ["id1"] };
  await src.prefill("claude", "id1");
  expect(await pickIdentity(app, deps)).toEqual({ reject: "reserve" }); // fresh 95%: refused
  next = { status: "rate-limited", error: "HTTP 429", capturedAt: "b" };
  t += 5000;
  await src.get("claude", "id1");
  await src.idle();
  const kept = await src.get("claude", "id1");
  expect(kept?.maxUtilization).toBe(95); // still shown
  expect(kept?.stale).toBe(true);
  expect(await pickIdentity(app, deps)).toEqual({ identity: "id1" }); // but not refused on
  next = live(90);
  t += 5000;
  await src.get("claude", "id1");
  await src.idle();
  expect((await src.get("claude", "id1"))?.stale).toBeUndefined();
  expect(await pickIdentity(app, deps)).toEqual({ reject: "reserve" }); // a fresh figure refuses again
});

test("a failed fetch also marks the kept figure stale", async () => {
  let fail = false;
  let t = 0;
  const src = createUsageSource({
    fetchUsage: async () => {
      if (fail) throw new Error("x");
      return live(97);
    },
    ttlMs: 1000,
    now: () => t,
  });
  await src.prefill("claude", "id1");
  fail = true;
  t += 5000;
  await src.get("claude", "id1");
  await src.idle();
  expect(await src.get("claude", "id1")).toMatchObject({ maxUtilization: 97, stale: true });
});

test("a pool prefers a fresh member under the reserve, and treats a stale one as unknown", async () => {
  const poolApp: GatewayApp = { ...app, target: { kind: "pool" } };
  const usages: Record<string, PoolUsage> = { a: { ...live(99), stale: true }, b: live(50) };
  const deps = { usageFor: async (_p: string, n: string) => usages[n], poolMembers: async () => ["a", "b"] };
  expect(await pickIdentity(poolApp, deps)).toEqual({ identity: "b" });
  usages.b = live(95);
  expect(await pickIdentity(poolApp, deps)).toEqual({ identity: "a" });
});

describe("reserve uses numbers only", () => {
  const pinned = (usage: PoolUsage | undefined) => pickIdentity(app, { usageFor: async () => usage, poolMembers: async () => [] });
  test("rate-limited without a number is no figure", async () => {
    expect(await pinned({ status: "rate-limited", capturedAt: "x" })).toEqual({ identity: "id1" });
    expect(await pinned({ status: "rate-limited", maxUtilization: 100, capturedAt: "x" })).toEqual({ reject: "reserve" });
  });
  test("codex at 100 percent is still rejected, and a worst window counts when there is no max", async () => {
    const codexApp = { ...app, provider: "codex" as const };
    expect(await pickIdentity(codexApp, { usageFor: async () => ({ status: "rate-limited", maxUtilization: 100, capturedAt: "x" }), poolMembers: async () => [] })).toEqual({ reject: "reserve" });
    expect(await pinned({ status: "live", windows: [{ label: "a", utilization: 10 }, { label: "b", utilization: 90 }], capturedAt: "x" })).toEqual({ reject: "reserve" });
  });
  test("a pool treats a number-less rate-limited member as unknown, not full", async () => {
    const pool: GatewayApp = { ...app, target: { kind: "pool" } };
    const usageFor = async (_p: string, i: string): Promise<PoolUsage> => (i === "a" ? { status: "rate-limited", capturedAt: "x" } : { status: "live", maxUtilization: 95, capturedAt: "x" });
    expect(await pickIdentity(pool, { usageFor: usageFor as never, poolMembers: async () => ["a", "b"] })).toEqual({ identity: "a" });
  });
});

describe("empty pool", () => {
  const pool: GatewayApp = { ...app, target: { kind: "pool" } };
  test("a provider with no identities is its own rejection", async () => {
    expect(await pickIdentity(pool, { usageFor: async () => undefined, poolMembers: async () => [] })).toEqual({ reject: "no-identities" });
  });
  test("an allow-list that matches no member is its own rejection", async () => {
    const limited: GatewayApp = { ...app, target: { kind: "pool", identities: ["ghost"] } };
    expect(await pickIdentity(limited, { usageFor: async () => undefined, poolMembers: async () => ["a"] })).toEqual({ reject: "no-identities" });
  });
  test("members that are all over the reserve stay no-headroom", async () => {
    const full = async (): Promise<PoolUsage> => ({ status: "live", maxUtilization: 99, capturedAt: "x" });
    expect(await pickIdentity(pool, { usageFor: full as never, poolMembers: async () => ["a"] })).toEqual({ reject: "no-headroom" });
  });
});

describe("pool selection details", () => {
  const pool: GatewayApp = { ...app, target: { kind: "pool" } };
  test("extra usage breaks a tie between equal members", async () => {
    const usageFor = async (_p: string, i: string): Promise<PoolUsage> => ({
      status: "live",
      maxUtilization: 50,
      capturedAt: "x",
      ...(i === "b" ? { extraUsage: { available: true } } : {}),
    }) as PoolUsage;
    expect(await pickIdentity(pool, { usageFor: usageFor as never, poolMembers: async () => ["a", "b"] })).toEqual({ identity: "b" });
  });

  test("an alias in the identities list matches the canonical member", async () => {
    const listed: GatewayApp = { ...app, target: { kind: "pool", identities: ["work-alias"] } };
    const canonical = async (_p: string, i: string): Promise<string> => (i === "work-alias" ? "work" : i);
    const r = await pickIdentity(listed, { usageFor: async () => undefined, poolMembers: async () => ["other", "work"], canonical });
    expect(r).toEqual({ identity: "work" });
  });
});

describe("refreshNow (after a quota answer)", () => {
  test("reads the source with `fresh`, once for concurrent calls, after a plain read already in flight", async () => {
    const calls: Array<boolean | undefined> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const src = createUsageSource({
      fetchUsage: async (_p, _i, opts) => {
        calls.push(opts?.fresh);
        if (!opts?.fresh) await gate;
        return live(opts?.fresh ? 77 : 10);
      },
    });
    void src.get("claude", "id1"); // a plain read that may predate the quota answer
    const both = Promise.all([src.refreshNow("claude", "id1"), src.refreshNow("claude", "id1")]);
    release();
    await both;
    expect(calls).toEqual([undefined, true]);
    expect((await src.get("claude", "id1"))?.maxUtilization).toBe(77);
  });
});
