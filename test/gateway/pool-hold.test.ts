import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PoolUsage } from "../../src/identities/pool/adapter.ts";
import { wantsStream } from "../../src/gateway/pool-hold.ts";
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
  let upstream429 = false;
  let rows: Array<{ status: string; httpStatus: number }> = [];
  let rejections = 0;
  let usageCalls = 0;

  beforeEach(() => {
    upstream429 = false;
    rows = [];
    rejections = 0;
    usageCalls = 0;
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
        if (upstream429) {
          return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "limit" } }), {
            status: 429,
            headers: { "content-type": "application/json", "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(Math.floor((T0.getTime() + 3 * HOURS) / 1000)), "retry-after": String(3 * 3600) },
          });
        }
        return new Response('event: message_start\ndata: {"type":"message_start"}\n\n', { headers: { "content-type": "text/event-stream" } });
      },
    });
    store = new MemoryGatewayStore();
    ledger = new LedgerBuffer(store, { max: 100000, flushMs: 3_600_000 });
    const push = ledger.push.bind(ledger);
    ledger.push = ((r: { status: string; httpStatus: number }) => { rows.push({ status: r.status, httpStatus: r.httpStatus }); return push(r as never); }) as typeof ledger.push;
    readings = { a: weekly(100, T0.getTime() + 3 * HOURS), b: weekly(100, T0.getTime() + 5 * HOURS) };
    deps = {
      // The fake clock: a sleep moves time forward, and a member's usage resets when its reset time has passed.
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      store, ledger,
      creds: { get: async (_p: string, id: string) => ({ identity: id, accessToken: `tok-${id}` }), refreshAfter401: async () => { throw new Error("unused"); } } as unknown as GatewayDeps["creds"],
      usageFor: async (_p, id) => {
        usageCalls++;
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
      metrics: { ...noopMetrics, poolHold: (_a: string, e: string) => { events.push(e); }, rejection: () => { rejections++; } },
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

  test("a shutdown during a hold resets the stream before any message event, and frees the slot", async () => {
    const token = await add(mk("pool", { kind: "pool" }));
    // The first ping step also starts the shutdown: the hold must end there, not wait for a reset.
    deps.sleep = async (ms) => { sleeps.push(ms); clock += ms; drain.abort(); };
    const res = await post(createGatewayApp(deps), "pool", token);
    let err: unknown;
    let text = "";
    try {
      text = await res.text();
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(text).not.toContain("message_start");
    expect(text).not.toContain("event: error");
    expect(sleeps.length).toBeLessThan(3);
    expect(events).toEqual(["held", "drained"]);
    expect(seen).toEqual([]);
    expect(rows).toEqual([{ status: "rejected", httpStatus: 503 }]);
  });

  test("B1: a real Bun server drain gives a Bun client a connection reset, not an SSE error event", async () => {
    deps.sleep = undefined as never;
    delete (deps as { sleep?: unknown }).sleep;
    const startedAt = Date.now();
    deps.now = () => new Date(T0.getTime() + (Date.now() - startedAt));
    deps.poolHold = { maxMs: 6 * HOURS, checkMs: 60_000, pingMs: 40 };
    readings = { a: weekly(100, T0.getTime() + 100 * HOURS), b: weekly(100, T0.getTime() + 100 * HOURS) };
    const token = await add(mk("pool", { kind: "pool" }));
    const gw = createGatewayApp(deps);
    const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: (r) => gw.fetch(r) });
    try {
      const r = await fetch(`http://127.0.0.1:${srv.port}/pool/v1/messages`, {
        method: "POST", body: JSON.stringify({ model: "claude-opus-4", stream: true, messages: [] }),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
      expect(r.status).toBe(200);
      const reader = r.body!.getReader();
      await reader.read(); // a ping
      drain.abort();
      let seenText = "";
      let failure: unknown;
      try {
        for (;;) {
          const c = await reader.read();
          if (c.done) break;
          seenText += new TextDecoder().decode(c.value);
        }
      } catch (e) {
        failure = e;
      }
      expect(failure).toBeDefined();
      expect(seenText).not.toContain("event: error");
      expect(seenText).not.toContain("overloaded_error");
    } finally {
      srv.stop(true);
    }
  });

  test("N1: a shutdown aborts a replay that has not answered yet", async () => {
    let upstreamAborted = false;
    await upstream.stop(true);
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0, idleTimeout: 0,
      async fetch(req) {
        seen.push("x");
        await req.arrayBuffer();
        req.signal.addEventListener("abort", () => { upstreamAborted = true; });
        drain.abort(); // the shutdown starts while the replay waits for this answer
        await new Promise((r) => setTimeout(r, 3000)); // no answer for a while
        return new Response("late");
      },
    });
    readings = { a: weekly(100, T0.getTime() + 60_000), b: weekly(100, T0.getTime() + 60_000) };
    const token = await add(mk("pool", { kind: "pool" }));
    const gw = createGatewayApp(deps);
    const res = await post(gw, "pool", token);
    let failure: unknown;
    let got = "";
    try {
      got = await res.text();
    } catch (e) {
      failure = e;
    }
    expect(got).not.toContain("event: error");
    expect(failure).toBeDefined();
    await new Promise((r) => setTimeout(r, 200));
    expect(upstreamAborted).toBe(true);
  });

  test("P1: a provider 429 on a streamed request (stale readings) is held and served after the reset, not returned with its 3 h retry-after", async () => {
    readings = { a: weekly(10, T0.getTime() + 7 * 24 * HOURS), b: weekly(10, T0.getTime() + 7 * 24 * HOURS) };
    upstream429 = true;
    const token = await add(mk("pool", { kind: "pool" }));
    // The provider stops refusing after the hold has run for a while.
    const orig = deps.sleep!;
    deps.sleep = async (ms, sig) => { await orig(ms, sig); if (clock >= T0.getTime() + 3 * HOURS) upstream429 = false; };
    const res = await post(createGatewayApp(deps), "pool", token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("message_start");
    expect(text).not.toContain("event: error");
    expect(events[0]).toBe("held");
    expect(events.at(-1)).toBe("served");
  });

  test("P2: a replay that meets a provider 429 continues the hold, and the upstream calls stay bounded", async () => {
    const token = await add(mk("pool", { kind: "pool" }));
    const gw = createGatewayApp(deps);
    const orig = deps.sleep!;
    deps.sleep = async (ms, sig) => {
      await orig(ms, sig);
      if (clock >= T0.getTime() + 60_000 && clock < T0.getTime() + 4 * HOURS) {
        // A member looks free again (stale reading), but the provider still refuses.
        readings = { a: weekly(10, T0.getTime() + 7 * 24 * HOURS), b: weekly(100, T0.getTime() + 5 * HOURS) };
        upstream429 = true;
      }
      if (clock >= T0.getTime() + 4 * HOURS) { upstream429 = false; readings = { a: weekly(10, T0.getTime() + 7 * 24 * HOURS), b: weekly(10, T0.getTime() + 7 * 24 * HOURS) }; }
    };
    const res = await post(gw, "pool", token);
    const text = await res.text();
    expect(text).not.toContain("event: error");
    expect(text).toContain("message_start");
    expect(events).not.toContain("failed");
    expect(events.at(-1)).toBe("served");
    // One refused call to member a, then the per-replica probe gate (5 min per member): far fewer than the replays.
    expect(seen.length).toBeLessThan(60);
  });

  test("P5: a quota probe that meets a provider 429 holds the request instead of ending it", async () => {
    readings = { a: weekly(10, T0.getTime() + 7 * 24 * HOURS), b: weekly(10, T0.getTime() + 7 * 24 * HOURS) };
    upstream429 = true;
    const token = await add(mk("pool", { kind: "pool" }));
    const gw = createGatewayApp(deps);
    const first = await post(gw, "pool", token, false); // marks both members quota-held from the provider's 429
    await first.arrayBuffer();
    expect(Number(first.headers.get("retry-after"))).toBeLessThanOrEqual(55);
    const before = seen.length;
    readings = { a: weekly(100, T0.getTime() + 3 * HOURS), b: weekly(100, T0.getTime() + 3 * HOURS) };
    const orig = deps.sleep!;
    deps.sleep = async (ms, sig) => { await orig(ms, sig); if (clock >= T0.getTime() + 3 * HOURS) upstream429 = false; };
    const res = await post(gw, "pool", token);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("event: error");
    expect(text).toContain("message_start");
    expect(seen.length - before).toBeLessThan(10);
  });

  test("P3/S1: one 3 h hold then served writes one ledger row and no rejection metric", async () => {
    const token = await add(mk("pool", { kind: "pool" }));
    const text = await (await post(createGatewayApp(deps), "pool", token)).text();
    expect(text).toContain("message_start");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ status: "ok", httpStatus: 200 });
    expect(rejections).toBe(0);
  });

  test("S1: a hold that times out writes one row", async () => {
    deps.poolHold = { maxMs: 60_000, checkMs: 30_000, pingMs: 15_000 };
    const token = await add(mk("pool", { kind: "pool" }));
    await (await post(createGatewayApp(deps), "pool", token)).text();
    expect(rows).toEqual([{ status: "rejected", httpStatus: 429 }]);
    expect(rejections).toBe(0);
  });

  test("S1: a client that leaves during a hold writes one row", async () => {
    const token = await add(mk("pool", { kind: "pool" }));
    const res = await post(createGatewayApp(deps), "pool", token);
    await res.body!.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(rows).toEqual([{ status: "client_aborted", httpStatus: 499 }]);
  });

  test("N3: a served replay sends its request-id and rate-limit headers as an SSE comment", async () => {
    await upstream.stop(true);
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        await req.arrayBuffer();
        return new Response('event: message_start\ndata: {"type":"message_start"}\n\n', { headers: { "content-type": "text/event-stream", "request-id": "req_123", "anthropic-ratelimit-unified-status": "allowed" } });
      },
    });
    const token = await add(mk("pool", { kind: "pool" }));
    const text = await (await post(createGatewayApp(deps), "pool", token)).text();
    expect(text).toMatch(/^: ais-replay .*request-id=req_123/m);
    expect(text).toMatch(/^: ais-replay .*anthropic-ratelimit-unified-status=allowed/m);
    expect(text).toContain("message_start");
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

describe("wantsStream", () => {
  const enc = (o: string): Uint8Array => new TextEncoder().encode(o);
  test("reads the top-level stream key only", () => {
    expect(wantsStream(enc('{"stream":true}'))).toBe(true);
    expect(wantsStream(enc('{"stream":false}'))).toBe(false);
    expect(wantsStream(enc('{"model":"m","messages":[{"stream":true}]}'))).toBe(false);
    expect(wantsStream(enc('{"stream":true,"stream":false}'))).toBe(false);
    expect(wantsStream(enc('{ "a" : "x\\"y" , "stream" : true }'))).toBe(true);
    expect(wantsStream(enc('{"str\\u0065am":true}'))).toBe(true);
    expect(wantsStream(enc("not json"))).toBe(false);
    expect(wantsStream(enc('{"stream":"true"}'))).toBe(false);
  });
  test("a 32 MiB body with stream at the start and at the end is scanned without a full parse", () => {
    const filler = `"x".repeat`; void filler;
    const big = "a".repeat(32 * 1024 * 1024);
    const start = enc(`{"stream":true,"messages":[{"c":"${big}"}]}`);
    const end = enc(`{"messages":[{"c":"${big}"}],"stream":true}`);
    const original = JSON.parse;
    let parses = 0;
    JSON.parse = ((...a: Parameters<typeof JSON.parse>) => { parses++; return original(...a); }) as typeof JSON.parse;
    try {
      expect(wantsStream(start)).toBe(true);
      expect(wantsStream(end)).toBe(true);
    } finally {
      JSON.parse = original;
    }
    expect(parses).toBe(0);
  });
});
