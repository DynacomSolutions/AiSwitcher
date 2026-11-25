import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PoolUsage } from "../../src/identities/pool/adapter.ts";
import { createGatewayApp, type GatewayDeps } from "../../src/gateway/app.ts";
import { LedgerBuffer } from "../../src/gateway/ledger-buffer.ts";
import { PrometheusMetrics, noopMetrics } from "../../src/gateway/metrics.ts";
import { weeklyUtilisation } from "../../src/gateway/native-limit.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { generateToken } from "../../src/gateway/tokens.ts";
import type { GatewayApp } from "../../src/gateway/types.ts";

const T0 = new Date("2026-11-25T00:00:00.000Z");
const HOURS = 3_600_000;
const mk = (name: string, target: GatewayApp["target"]): GatewayApp => ({
  name, owner: "o", namespace: "n", provider: "claude", style: "anthropic", target, state: "active", createdAt: "2026-11-01T00:00:00.000Z",
});
const weekly = (u: number, resetMs: number): PoolUsage => ({
  status: "live", maxUtilization: u, capturedAt: T0.toISOString(), windows: [{ label: "weekly", utilization: u, resetsAt: new Date(resetMs).toISOString() }],
});

describe("a full pool holds a streamed request until a member has room", () => {
  let upstream: ReturnType<typeof Bun.serve>;
  let store: MemoryGatewayStore;
  let ledger: LedgerBuffer;
  let deps: GatewayDeps;
  let clock = T0.getTime();
  let readings: Record<string, PoolUsage | undefined>;
  let seen: string[];
  let sleeps: number[];
  let drain: AbortController;
  const events: string[] = [];

  beforeEach(() => {
    clock = T0.getTime();
    seen = [];
    sleeps = [];
    events.length = 0;
    drain = new AbortController();
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        seen.push(req.headers.get("authorization") ?? "");
        await req.arrayBuffer();
        return new Response('event: message_start\ndata: {"type":"message_start"}\n\n', { headers: { "content-type": "text/event-stream" } });
      },
    });
    store = new MemoryGatewayStore();
    ledger = new LedgerBuffer(store, { max: 1000, flushMs: 3_600_000 });
    readings = { a: weekly(100, T0.getTime() + 3 * HOURS), b: weekly(100, T0.getTime() + 5 * HOURS) };
    deps = {
      // The fake clock: a sleep moves time forward, and a member's usage resets when its reset time has passed.
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      store, ledger,
      creds: { get: async (_p: string, id: string) => ({ identity: id, accessToken: `tok-${id}` }), refreshAfter401: async () => { throw new Error("unused"); } } as unknown as GatewayDeps["creds"],
      usageFor: async (_p, id) => {
        const r = readings[id];
        const reset = Date.parse(r?.windows?.[0]?.resetsAt ?? "");
        return r && reset <= clock ? weekly(10, clock + 7 * 24 * HOURS) : r;
      },
      poolMembers: async () => ["a", "b"],
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        return fetch(`http://127.0.0.1:${upstream.port}${u.pathname}${u.search}`, init);
      }) as typeof fetch,
      now: () => new Date(clock),
      metrics: { ...noopMetrics, poolHold: (_a: string, e: string) => { events.push(e); } },
      log: () => {},
      drainSignal: drain.signal,
      poolHold: { maxMs: 6 * HOURS, checkMs: 30_000, pingMs: 15_000 },
    };
  });
  afterEach(async () => {
    await upstream.stop(true);
    await ledger.close();
  });

  const add = async (app: GatewayApp) => {
    await store.putApp(app);
    const t = generateToken();
    await store.addToken({ app: app.name, prefix: t.prefix, hash: t.hash, createdAt: T0.toISOString() });
    return t.token;
  };
  const post = (gw: ReturnType<typeof createGatewayApp>, app: string, token: string, stream = true) =>
    gw.request(`http://gw.test/${app}/v1/messages`, {
      method: "POST", body: JSON.stringify({ model: "claude-opus-4", stream, messages: [] }),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });

  test("a request that arrives while the pool is full is served after the earliest reset, with no client-visible failure", async () => {
    const token = await add(mk("pool", { kind: "pool" }));
    const res = await post(createGatewayApp(deps), "pool", token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: ping");
    expect(text).toContain("message_start");
    expect(text).not.toContain("event: error");
    // The clock passed the earliest reset (3 h) and no more than one check step beyond it.
    expect(clock - T0.getTime()).toBeGreaterThanOrEqual(3 * HOURS);
    expect(clock - T0.getTime()).toBeLessThan(3 * HOURS + 60_000);
    expect(seen).toHaveLength(1);
    expect(events).toEqual(["held", "served"]);
  });

  test("a full pool with no known reset (300 s) is held too, and served when a member frees", async () => {
    // No resetsAt: the answer falls back to 300 s, over the client's 60 s limit.
    readings = { a: { status: "live", maxUtilization: 100, capturedAt: T0.toISOString(), windows: [{ label: "weekly", utilization: 100 }] }, b: { status: "live", maxUtilization: 100, capturedAt: T0.toISOString(), windows: [{ label: "weekly", utilization: 100 }] } };
    const token = await add(mk("pool", { kind: "pool" }));
    const gw = createGatewayApp(deps);
    const body = (await post(gw, "pool", token)).text();
    // After 10 minutes a member frees.
    const orig = deps.usageFor;
    deps.usageFor = async (p, id) => (clock >= T0.getTime() + 600_000 ? weekly(20, clock + 7 * 24 * HOURS) : orig(p, id));
    expect(await body).toContain("message_start");
    expect(clock - T0.getTime()).toBeGreaterThanOrEqual(600_000);
  });

  test("a request that is not streamed gets a retry-after the client accepts, not a hold", async () => {
    const token = await add(mk("pool", { kind: "pool" }));
    const res = await post(createGatewayApp(deps), "pool", token, false);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBe(55);
    expect(events).toEqual([]);
  });

  test("a pinned app keeps its answer: 429 with the real reset, never held", async () => {
    const token = await add(mk("pin", { kind: "pin", identity: "a" }));
    const res = await post(createGatewayApp(deps), "pin", token);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBe(3 * 3600);
    expect(events).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("a shutdown during a hold ends it at once with a retryable error and frees the slot", async () => {
    const token = await add(mk("pool", { kind: "pool" }));
    // The first ping step also starts the shutdown: the hold must end there, not wait for a reset.
    deps.sleep = async (ms) => { sleeps.push(ms); clock += ms; drain.abort(); };
    const res = await post(createGatewayApp(deps), "pool", token);
    const text = await res.text();
    expect(text).toContain("overloaded_error");
    expect(text).not.toContain("message_start");
    expect(sleeps.length).toBeLessThan(3);
    expect(events).toEqual(["held", "drained"]);
    expect(seen).toEqual([]);
  });

  test("a hold that outlasts its limit ends with the rate-limit error, never silently", async () => {
    deps.poolHold = { maxMs: 60_000, checkMs: 30_000, pingMs: 15_000 };
    const token = await add(mk("pool", { kind: "pool" }));
    const text = await (await post(createGatewayApp(deps), "pool", token)).text();
    expect(text).toContain("rate_limit_error");
    expect(events).toEqual(["held", "timeout"]);
  });

  test("held requests are capped: the request over the cap gets the plain 429 (retry-after under 60 s)", async () => {
    deps.poolHold = { maxHeld: 0 };
    const token = await add(mk("pool", { kind: "pool" }));
    const res = await post(createGatewayApp(deps), "pool", token);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBe(55);
  });
});

describe("weeklyUtilisation", () => {
  test("takes the weekly window, ignores a per-model window, and has no figure for a noPlan member", () => {
    const u: PoolUsage = { status: "live", capturedAt: "x", windows: [{ label: "5h", utilization: 99 }, { label: "weekly", utilization: 40 }, { label: "weekly", utilization: 95, model: "Fable" }] };
    expect(weeklyUtilisation(u)).toBe(40);
    expect(weeklyUtilisation({ ...u, noPlan: true })).toBeUndefined();
    expect(weeklyUtilisation(undefined)).toBeUndefined();
  });
});

describe("pool headroom metric", () => {
  test("exports counts per provider and threshold, with no member name", () => {
    const m = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
    m.poolHeadroom("claude", 90, 1, 9);
    const text = m.render();
    expect(text).toContain('ais_gateway_pool_members_with_headroom{provider="claude",threshold="0.9"} 1');
    expect(text).toContain('ais_gateway_pool_members_with_reading{provider="claude"} 9');
  });
});
