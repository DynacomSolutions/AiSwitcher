import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PoolUsage } from "../../src/identities/pool/adapter.ts";
import { PoolHoldGate, heldStreamResponse, wantsStream, type PoolHoldLimits } from "../../src/gateway/pool-hold.ts";
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
  let confirmed429 = true;
  let rows: Array<{ status: string; httpStatus: number }> = [];
  let rejections = 0;
  let usageCalls = 0;

  beforeEach(() => {
    upstream429 = false;
    confirmed429 = true;
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
            headers: { "content-type": "application/json", ...(confirmed429 ? { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(Math.floor((T0.getTime() + 3 * HOURS) / 1000)) } : {}), "retry-after": "5" },
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

  test("fresh full usage readings report the earliest reset without a hold", async () => {
    const token = await add(mk("pool", { kind: "pool" }));
    const res = await post(createGatewayApp(deps), "pool", token);
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("Resets at");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(60);
    expect(clock - T0.getTime()).toBeLessThan(1_000);
    expect(seen).toEqual([]);
    expect(events).toEqual([]);
  });

  test("fresh full usage readings without a reset report the bounded fallback promptly", async () => {
    readings = { a: { status: "live", maxUtilization: 100, capturedAt: T0.toISOString(), windows: [{ label: "weekly", utilization: 100 }] }, b: { status: "live", maxUtilization: 100, capturedAt: T0.toISOString(), windows: [{ label: "weekly", utilization: 100 }] } };
    const token = await add(mk("pool", { kind: "pool" }));
    const res = await post(createGatewayApp(deps), "pool", token);
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("Resets at");
    expect(clock - T0.getTime()).toBeLessThan(1_000);
    expect(events).toEqual([]);
  });

  test("a request that is not streamed gets a retry-after the client accepts, not a hold", async () => {
    const token = await add(mk("pool", { kind: "pool" }));
    const res = await post(createGatewayApp(deps), "pool", token, false);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(60);
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
    readings = { a: weekly(95, T0.getTime() + 3 * HOURS), b: weekly(95, T0.getTime() + 5 * HOURS) };
    const token = await add({ ...mk("pool", { kind: "pool" }), reservePercent: 90 });
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
    readings = { a: weekly(95, T0.getTime() + 3 * HOURS), b: weekly(95, T0.getTime() + 5 * HOURS) };
    deps.sleep = undefined as never;
    delete (deps as { sleep?: unknown }).sleep;
    const startedAt = Date.now();
    deps.now = () => new Date(T0.getTime() + (Date.now() - startedAt));
    deps.poolHold = { maxMs: 6 * HOURS, checkMs: 60_000, pingMs: 40 };
    readings = { a: weekly(95, T0.getTime() + 100 * HOURS), b: weekly(95, T0.getTime() + 100 * HOURS) };
    const token = await add({ ...mk("pool", { kind: "pool" }), reservePercent: 90 });
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
    readings = { a: weekly(95, T0.getTime() + 3 * HOURS), b: weekly(95, T0.getTime() + 5 * HOURS) };
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
    readings = { a: weekly(95, T0.getTime() + 60_000), b: weekly(95, T0.getTime() + 60_000) };
    const token = await add({ ...mk("pool", { kind: "pool" }), reservePercent: 90 });
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

  test("P1: confirmed provider quota returns the reset error without a 55-second retry loop", async () => {
    readings = { a: weekly(10, T0.getTime() + 7 * 24 * HOURS), b: weekly(10, T0.getTime() + 7 * 24 * HOURS) };
    upstream429 = true;
    const token = await add(mk("pool", { kind: "pool" }));
    const res = await post(createGatewayApp(deps), "pool", token);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(60);
    expect((await res.text())).toContain("Resets at");
    expect(clock - T0.getTime()).toBeLessThan(60_000);
  });

  test("P2: a transient provider throttle during replay surfaces its status and detail", async () => {
    readings = { a: weekly(95, T0.getTime() + 3 * HOURS), b: weekly(95, T0.getTime() + 5 * HOURS) };
    const token = await add({ ...mk("pool", { kind: "pool" }), reservePercent: 90 });
    const gw = createGatewayApp(deps);
    upstream429 = true;
    confirmed429 = false;
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
    expect(text).toContain("event: error");
    expect(text).toContain("provider returned HTTP 429: limit");
    expect(text).not.toContain("message_start");
    expect(events).toContain("failed");
    expect(clock - T0.getTime()).toBeLessThan(120_000);
  });

  test("P5: real quota probes retain the provider reset for immediate client snooze", async () => {
    readings = { a: weekly(10, T0.getTime() + 7 * 24 * HOURS), b: weekly(10, T0.getTime() + 7 * 24 * HOURS) };
    upstream429 = true;
    const token = await add(mk("pool", { kind: "pool" }));
    const gw = createGatewayApp(deps);
    const first = await post(gw, "pool", token, false); // marks both members quota-held from the provider's 429
    await first.arrayBuffer();
    expect(Number(first.headers.get("retry-after"))).toBeGreaterThan(60);
    const before = seen.length;
    readings = { a: weekly(100, T0.getTime() + 3 * HOURS), b: weekly(100, T0.getTime() + 3 * HOURS) };
    const orig = deps.sleep!;
    deps.sleep = async (ms, sig) => { await orig(ms, sig); if (clock >= T0.getTime() + 3 * HOURS) upstream429 = false; };
    const res = await post(gw, "pool", token);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(60);
    expect((await res.text())).toContain("Resets at");
    expect(seen.length - before).toBeLessThan(10);
  });

  test("a held replay ends with the native reset error as soon as every member confirms exhaustion", async () => {
    readings = { a: weekly(95, T0.getTime() + 3 * HOURS), b: weekly(95, T0.getTime() + 5 * HOURS) };
    const token = await add({ ...mk("pool", { kind: "pool" }), reservePercent: 90 });
    const gw = createGatewayApp(deps);
    deps.sleep = async (ms) => {
      sleeps.push(ms);
      clock += ms;
      upstream429 = true;
    };
    deps.poolHold = { maxMs: 6 * HOURS, checkMs: 1_000, pingMs: 250 };
    const res = await post(gw, "pool", token);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain("rate_limit_error");
    expect(text).toContain("Resets at");
    expect(events).toContain("failed");
    expect(clock - T0.getTime()).toBeLessThan(120_000);
  });

  test("P3/S1: one 3 h hold then served writes one ledger row and no rejection metric", async () => {
    readings = { a: weekly(95, T0.getTime() + 3 * HOURS), b: weekly(95, T0.getTime() + 5 * HOURS) };
    const token = await add({ ...mk("pool", { kind: "pool" }), reservePercent: 90 });
    const text = await (await post(createGatewayApp(deps), "pool", token)).text();
    expect(text).toContain("message_start");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ status: "ok", httpStatus: 200 });
    expect(rejections).toBe(0);
  });

  test("a transient throttle ends a reserve hold with its provider status and detail", async () => {
    readings = { a: weekly(95, T0.getTime() + 3 * HOURS), b: weekly(95, T0.getTime() + 5 * HOURS) };
    upstream429 = true;
    confirmed429 = false;
    const token = await add({ ...mk("pool", { kind: "pool" }), reservePercent: 90 });
    const text = await (await post(createGatewayApp(deps), "pool", token)).text();
    expect(text).toContain("event: error");
    expect(text).toContain("provider returned HTTP 429: limit");
    expect(events).toContain("failed");
  });

  test("S1: a client that leaves during a held request writes one row", async () => {
    readings = { a: weekly(95, T0.getTime() + 3 * HOURS), b: weekly(95, T0.getTime() + 5 * HOURS) };
    deps.sleep = async (_ms, signal) => await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    const token = await add({ ...mk("pool", { kind: "pool" }), reservePercent: 90 });
    const res = await post(createGatewayApp(deps), "pool", token);
    await res.body!.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(rows).toEqual([{ status: "client_aborted", httpStatus: 499 }]);
  });

  test("N3: a served replay sends its request-id and rate-limit headers as an SSE comment", async () => {
    readings = { a: weekly(95, T0.getTime() + 3 * HOURS), b: weekly(95, T0.getTime() + 5 * HOURS) };
    await upstream.stop(true);
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        await req.arrayBuffer();
        return new Response('event: message_start\ndata: {"type":"message_start"}\n\n', { headers: { "content-type": "text/event-stream", "request-id": "req_123", "anthropic-ratelimit-unified-status": "allowed" } });
      },
    });
    const token = await add({ ...mk("pool", { kind: "pool" }), reservePercent: 90 });
    const text = await (await post(createGatewayApp(deps), "pool", token)).text();
    expect(text).toMatch(/^: ais-replay .*request-id=req_123/m);
    expect(text).toMatch(/^: ais-replay .*anthropic-ratelimit-unified-status=allowed/m);
    expect(text).toContain("message_start");
  });

  test("an unknown reset reports promptly when every fresh usage window is full", async () => {
    readings = { a: { status: "live", maxUtilization: 100, capturedAt: T0.toISOString(), windows: [{ label: "weekly", utilization: 100 }] }, b: { status: "live", maxUtilization: 100, capturedAt: T0.toISOString(), windows: [{ label: "weekly", utilization: 100 }] } };
    const token = await add(mk("pool", { kind: "pool" }));
    const res = await post(createGatewayApp(deps), "pool", token);
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("Resets at");
    expect(events).toEqual([]);
  });

  test("held requests are capped: an unconfirmed reserve request gets retry-after under 60 s", async () => {
    readings = { a: weekly(95, T0.getTime() + 3 * HOURS), b: weekly(95, T0.getTime() + 5 * HOURS) };
    deps.poolHold = { maxHeld: 0 };
    const token = await add({ ...mk("pool", { kind: "pool" }), reservePercent: 90 });
    const res = await post(createGatewayApp(deps), "pool", token);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBe(55);
  });

  test("a chunked original request: the replay reserves its real size from the body budget, not the 32 MiB cap", async () => {
    readings = { a: weekly(95, T0.getTime() + 3 * HOURS), b: weekly(95, T0.getTime() + 5 * HOURS) };
    const waiting: number[] = [];
    deps.bodyBudgetBytes = 40 * 1024 * 1024;
    deps.metrics = { ...deps.metrics, bodyBudgetWaiting: (n: number) => { waiting.push(n); } };
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    deps.sleep = async (ms) => { await gate; sleeps.push(ms); clock += ms; };
    const token = await add({ ...mk("pool", { kind: "pool" }), reservePercent: 90 });
    const gw = createGatewayApp(deps);
    const chunked = (): Promise<Response> => {
      const payload = new TextEncoder().encode(JSON.stringify({ model: "claude-opus-4", stream: true, messages: [] }));
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(payload); c.close(); } });
      return Promise.resolve(gw.request(new Request("http://gw.test/pool/v1/messages", {
        method: "POST", body, duplex: "half",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "transfer-encoding": "chunked" },
      } as RequestInit)));
    };
    const a = await chunked();
    const b = await chunked();
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    waiting.length = 0; // only the replays count from here
    open();
    await Promise.all([a.text(), b.text()]);
    // Two replays of 32 MiB would not fit in 40 MiB at once: one would queue. Real sizes (a few bytes) never queue.
    expect(waiting.filter((n) => n > 0)).toEqual([]);
  });
});

describe("a served hold, an unserved stream and the pings (unit)", () => {
  const limits: PoolHoldLimits = { maxMs: 60_000, checkMs: 1, pingMs: 1, maxHeld: 10, maxBytes: 10_000 };
  const input = (gate: PoolHoldGate, replay: () => Promise<Response>, drain?: AbortSignal) => ({
    limits, gate, bytes: 1000, now: () => new Date(), sleep: async () => { await new Promise((r) => setTimeout(r, 1)); }, drain, replay, limitMessage: "limit",
  });
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  /** A served answer that the test opens, feeds and closes by hand. */
  const manual = () => {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
    return { res: new Response(body, { headers: { "content-type": "text/event-stream" } }), ctl };
  };
  const readUntil = async (r: { read(): Promise<{ done: boolean; value?: Uint8Array }> }, needle: string): Promise<string> => {
    let text = "";
    while (!text.includes(needle)) {
      const x = await r.read();
      if (x.done) break;
      text += dec.decode(x.value);
    }
    return text;
  };

  test("F1: a served hold leaves the hold count at once, but its body stays in the byte count until the stream ends", async () => {
    const gate = new PoolHoldGate(limits);
    expect(gate.tryEnter(1000)).toBe(true);
    const m = manual();
    const res = heldStreamResponse(input(gate, async () => m.res));
    const reader = res.body!.getReader();
    m.ctl.enqueue(enc.encode("event: message_start\ndata: {}\n\n"));
    await readUntil(reader, "message_start");
    expect(gate.held).toBe(0);
    expect(gate.bytes).toBe(1000); // old code: 0 here, while the body is still in memory
    m.ctl.close();
    while (!(await reader.read()).done);
    expect(gate.bytes).toBe(0);
  });

  test("F1: a client that leaves a served stream frees its bytes", async () => {
    const gate = new PoolHoldGate(limits);
    gate.tryEnter(1000);
    const m = manual();
    const res = heldStreamResponse(input(gate, async () => m.res));
    const reader = res.body!.getReader();
    m.ctl.enqueue(enc.encode("event: message_start\ndata: {}\n\n"));
    await readUntil(reader, "message_start");
    expect(gate.bytes).toBe(1000);
    await reader.cancel();
    expect(gate.bytes).toBe(0);
  });

  test("F4: a served answer that fails before its first event resets the stream, no SSE error event", async () => {
    const gate = new PoolHoldGate(limits);
    gate.tryEnter(1000);
    const failing = new Response(new ReadableStream<Uint8Array>({ pull() { throw new Error("upstream gone"); } }), { headers: { "content-type": "text/event-stream" } });
    const reader = heldStreamResponse(input(gate, async () => failing)).body!.getReader();
    let text = "";
    let err: unknown;
    try {
      text = await readUntil(reader, "never");
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(text).not.toContain("event: error");
    expect(gate.bytes).toBe(0);
  });

  test("F4: a served answer that fails after an event still ends with the SSE error event", async () => {
    const gate = new PoolHoldGate(limits);
    gate.tryEnter(1000);
    const m = manual();
    const reader = heldStreamResponse(input(gate, async () => m.res)).body!.getReader();
    m.ctl.enqueue(enc.encode("event: message_start\ndata: {}\n\n"));
    await readUntil(reader, "message_start");
    m.ctl.error(new Error("cut"));
    expect(await readUntil(reader, "event: error")).toContain("the upstream stream broke");
  });

  test("F5: pings continue while a replay is in flight", async () => {
    const gate = new PoolHoldGate(limits);
    gate.tryEnter(1000);
    let finish!: () => void;
    const slow = new Promise<Response>((resolve) => {
      finish = () => resolve(new Response('event: message_start\ndata: {}\n\n', { headers: { "content-type": "text/event-stream" } }));
    });
    const reader = heldStreamResponse(input(gate, () => slow)).body!.getReader();
    // The replay waits (a scaled stand-in for 60 s: 60 ping steps of 1 ms); pings must keep coming meanwhile.
    let pings = 0;
    const started = Date.now();
    while (pings < 15 && Date.now() - started < 5000) {
      const x = await reader.read();
      if (x.done) break;
      pings += (dec.decode(x.value).match(/event: ping/g) ?? []).length;
    }
    expect(pings).toBeGreaterThanOrEqual(15);
    finish();
    expect(await readUntil(reader, "message_start")).toContain("message_start");
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
