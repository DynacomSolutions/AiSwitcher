import { describe, expect, test } from "bun:test";
import { createGatewayApp, type GatewayDeps } from "../../src/gateway/app.ts";
import { LedgerBuffer } from "../../src/gateway/ledger-buffer.ts";
import { noopMetrics } from "../../src/gateway/metrics.ts";
import { bumpSideCountOn, fallbackCount, Gate, type SqlTag } from "../../src/gateway/side-count.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { generateToken } from "../../src/gateway/tokens.ts";

describe("bumpSideCountOn", () => {
  function fakeSql() {
    const state = { cancelled: 0, queries: [] as string[] };
    const sql: SqlTag = (strings) => {
      state.queries.push(strings.join("?"));
      const p = new Promise<Array<Record<string, unknown>>>(() => {}) as Promise<Array<Record<string, unknown>>> & { cancel?: () => unknown };
      p.cancel = () => void (state.cancelled += 1);
      return p;
    };
    return { state, sql };
  }

  test("aborting the signal cancels the query in flight", async () => {
    const { state, sql } = fakeSql();
    const ctrl = new AbortController();
    void bumpSideCountOn(sql, "app", "2026-11-02", ctrl.signal);
    expect(state.cancelled).toBe(0);
    ctrl.abort();
    expect(state.cancelled).toBe(1);
    expect(state.queries[0]).toContain("gateway_side_counts");
  });

  test("a driver query without cancel() is tolerated", async () => {
    const sql: SqlTag = () => Promise.resolve([{ n: 7 }]);
    const ctrl = new AbortController();
    const p = bumpSideCountOn(sql, "app", "2026-11-02", ctrl.signal);
    ctrl.abort();
    expect(await p).toBe(7);
  });

  test("returns the running total", async () => {
    expect(await bumpSideCountOn(() => Promise.resolve([{ n: "3" }]), "a", "2026-11-02")).toBe(3);
  });
});

describe("fallbackCount", () => {
  test("counts per app and day, and drops entries of other days", () => {
    const m = new Map<string, number>();
    expect(fallbackCount(m, "a", "2026-11-02")).toBe(1);
    expect(fallbackCount(m, "a", "2026-11-02")).toBe(2);
    expect(fallbackCount(m, "b", "2026-11-02")).toBe(1);
    expect(m.size).toBe(2);
    expect(fallbackCount(m, "a", "2026-11-03")).toBe(1);
    expect([...m.keys()]).toEqual(["a\u00002026-11-03"]); // yesterday's entries are gone
  });
});

describe("the gateway prunes its fallback across days", () => {
  test("with the database down, a new day starts from one and old days do not linger", async () => {
    const store = new MemoryGatewayStore();
    store.bumpSideCount = async () => {
      throw new Error("db down");
    };
    const ledger = new LedgerBuffer(store, { max: 100, flushMs: 3_600_000 });
    const t = generateToken();
    await store.putApp({ name: "k", owner: "o", namespace: "ns", provider: "kimi", style: "openai", target: { kind: "pool" }, state: "active", createdAt: "2026-11-01T00:00:00.000Z" });
    await store.addToken({ app: "k", prefix: t.prefix, hash: t.hash, createdAt: "2026-11-01T00:00:00.000Z" });
    let now = new Date("2026-11-02T10:00:00.000Z").getTime();
    const deps = {
      sleep: async () => {},
      store,
      ledger,
      creds: { get: async (_p: string, identity: string) => ({ identity, accessToken: `tok-${identity}` }), refreshAfter401: async () => ({ identity: "a", accessToken: "x" }) } as unknown as GatewayDeps["creds"],
      usageFor: async () => undefined,
      poolMembers: async () => ["a"],
      fetch: (async () => new Response("{}")) as unknown as typeof fetch,
      now: () => new Date(now),
      metrics: noopMetrics,
      log: () => {},
      sideDailyLimit: 2,
    } satisfies GatewayDeps;
    const app = createGatewayApp(deps);
    const hit = async () => (await app.request("http://gw.test/k/search", { method: "POST", body: "{}", headers: { authorization: `Bearer ${t.token}` } })).status;
    expect([await hit(), await hit(), await hit()]).toEqual([200, 200, 429]);
    now += 24 * 3_600_000;
    expect([await hit(), await hit(), await hit()]).toEqual([200, 200, 429]);
    await ledger.close();
  });
});

describe("Gate", () => {
  test("holders beyond the maximum queue in order and are served as slots free", async () => {
    const g = new Gate(1);
    const first = (await g.acquire(100))!;
    const order: number[] = [];
    const a = g.acquire(1000).then((r) => (order.push(1), r));
    const b = g.acquire(1000).then((r) => (order.push(2), r));
    first();
    (await a)!();
    (await b)!();
    expect(order).toEqual([1, 2]);
  });
  test("a waiter gives up after its own deadline and a double release frees only one slot", async () => {
    const g = new Gate(1);
    const held = (await g.acquire(10))!;
    expect(await g.acquire(30)).toBeUndefined();
    held();
    held();
    const x = await g.acquire(10);
    expect(x).toBeDefined();
    expect(await g.acquire(20)).toBeUndefined(); // only one slot exists
  });
  test("a waiter whose signal aborts leaves the queue without taking a slot", async () => {
    const g = new Gate(1);
    const held = (await g.acquire(10))!;
    const ctrl = new AbortController();
    const waiting = g.acquire(5000, ctrl.signal);
    ctrl.abort();
    expect(await waiting).toBeUndefined();
    expect(await g.acquire(5, new AbortController().signal)).toBeUndefined(); // still held by the first
    held();
    expect(await g.acquire(10)).toBeDefined(); // nobody else was handed the slot
    expect(await g.acquire(10, AbortSignal.abort())).toBeUndefined(); // already aborted: no slot
  });
});

describe("a client that disconnects while waiting for a count slot", () => {
  test("is not counted and does not use the shared limit", async () => {
    const store = new MemoryGatewayStore();
    const ledger = new LedgerBuffer(store, { max: 100, flushMs: 3_600_000 });
    const t = generateToken();
    await store.putApp({ name: "k", owner: "o", namespace: "ns", provider: "kimi", style: "openai", target: { kind: "pool" }, state: "active", createdAt: "2026-11-01T00:00:00.000Z" });
    await store.addToken({ app: "k", prefix: t.prefix, hash: t.hash, createdAt: "2026-11-01T00:00:00.000Z" });
    let bumps = 0;
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => (release = r));
    store.bumpSideCount = async () => {
      bumps += 1;
      await gateOpen;
      return bumps;
    };
    const deps = {
      sleep: async () => {},
      store,
      ledger,
      creds: { get: async (_p: string, identity: string) => ({ identity, accessToken: `tok-${identity}` }), refreshAfter401: async () => ({ identity: "a", accessToken: "x" }) } as unknown as GatewayDeps["creds"],
      usageFor: async () => undefined,
      poolMembers: async () => ["a"],
      fetch: (async () => new Response("{}")) as unknown as typeof fetch,
      now: () => new Date("2026-11-02T10:00:00.000Z"),
      metrics: noopMetrics,
      log: () => {},
      sideCountTimeoutMs: 5_000,
    } satisfies GatewayDeps;
    const app = createGatewayApp(deps);
    const send = (signal?: AbortSignal): Promise<Response> => Promise.resolve(app.request("http://gw.test/k/search", { method: "POST", body: "{}", headers: { authorization: `Bearer ${t.token}` }, ...(signal ? { signal } : {}) }));
    const holders = Array.from({ length: 4 }, () => send()); // fill the four slots
    await Bun.sleep(30);
    expect(bumps).toBe(4);
    const ctrl = new AbortController();
    const waiter = send(ctrl.signal).then((r) => r.status, () => "aborted");
    await Bun.sleep(30);
    ctrl.abort();
    expect(await waiter).toBe(499); // the gateway answers a gone client with 499
    release();
    await Promise.all(holders);
    expect(bumps).toBe(4); // the waiter never reached the store
    await ledger.close();
  });
});
