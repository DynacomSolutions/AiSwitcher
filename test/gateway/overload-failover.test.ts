import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolUsage } from "../../src/identities/pool/adapter.ts";
import { createGatewayApp, peekFirstEvent, type GatewayDeps } from "../../src/gateway/app.ts";
import { GatewayCredentialError } from "../../src/gateway/credentials.ts";
import { GATEWAY_ERROR_HEADER, GATEWAY_UPSTREAM_HEADER } from "../../src/gateway/errors.ts";
import { firstEventOf } from "../../src/gateway/overload.ts";
import { LedgerBuffer } from "../../src/gateway/ledger-buffer.ts";
import { noopMetrics } from "../../src/gateway/metrics.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { generateToken } from "../../src/gateway/tokens.ts";
import type { GatewayApp } from "../../src/gateway/types.ts";

const T0 = new Date("2026-11-25T00:00:00.000Z");
const HOURS = 3_600_000;
const enc = new TextEncoder();
const mk = (name: string, target: GatewayApp["target"]): GatewayApp => ({
  name, owner: "o", namespace: "n", provider: "claude", style: "anthropic", target, state: "active", createdAt: "2026-11-01T00:00:00.000Z",
});
const live = (u: number): PoolUsage => ({ status: "live", maxUtilization: u, capturedAt: T0.toISOString() });
const weekly = (u: number, resetMs: number): PoolUsage => ({
  status: "live", maxUtilization: u, capturedAt: T0.toISOString(), windows: [{ label: "weekly", utilization: u, resetsAt: new Date(resetMs).toISOString() }],
});

const OVERLOAD_BODY = (id: string): string => JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" }, request_id: id });
const overloaded = (status: number, id: string): Response =>
  new Response(OVERLOAD_BODY(id), { status, headers: { "content-type": "application/json", "request-id": id } });
const errorStream = (id: string, type = "overloaded_error"): Response =>
  new Response(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message: "Overloaded" }, request_id: id })}\n\n`, { headers: { "content-type": "text/event-stream", "request-id": id } });
const okStream = (): Response =>
  new Response('event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-4","usage":{"input_tokens":1,"output_tokens":1}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } });

describe("pool failover on overload and server errors before content", () => {
  let upstream: ReturnType<typeof Bun.serve>;
  let store: MemoryGatewayStore;
  let ledger: LedgerBuffer;
  let deps: GatewayDeps;
  let clock = T0.getTime();
  let usage: Record<string, PoolUsage | undefined>;
  let who: string[];
  let handler: (member: string, n: number) => Response | Promise<Response>;
  let logs: string[];
  let failovers: Array<{ app: string; reason: string }>;
  let token = "";

  beforeEach(async () => {
    clock = T0.getTime();
    who = [];
    logs = [];
    failovers = [];
    usage = { a: live(10), b: live(20) };
    handler = () => okStream();
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        const member = (req.headers.get("authorization") ?? "").replace("Bearer tok-", "");
        await req.arrayBuffer();
        who.push(member);
        return handler(member, who.length);
      },
    });
    store = new MemoryGatewayStore();
    ledger = new LedgerBuffer(store, { max: 100000, flushMs: 3_600_000 });
    deps = {
      sleep: async (ms) => { clock += ms; },
      store, ledger,
      creds: { get: async (_p: string, id: string) => ({ identity: id, accessToken: `tok-${id}` }), refreshAfter401: async () => { throw new Error("unused"); } } as unknown as GatewayDeps["creds"],
      usageFor: async (_p, id) => usage[id],
      poolMembers: async () => ["a", "b"],
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        return fetch(`http://127.0.0.1:${upstream.port}${u.pathname}${u.search}`, init);
      }) as typeof fetch,
      now: () => new Date(clock),
      metrics: { ...noopMetrics, failover: (app: string, reason: string) => { failovers.push({ app, reason }); } },
      log: (line) => logs.push(line),
      poolHold: { maxMs: 6 * HOURS, checkMs: 30_000, pingMs: 15_000 },
    };
    const app = mk("pool", { kind: "pool" });
    await store.putApp(app);
    const t = generateToken();
    await store.addToken({ app: app.name, prefix: t.prefix, hash: t.hash, createdAt: T0.toISOString() });
    token = t.token;
  });
  afterEach(async () => {
    await upstream.stop(true);
    await ledger.close();
  });

  const post = (gw: ReturnType<typeof createGatewayApp>, over: { stream?: boolean; app?: string; body?: string | Uint8Array } = {}) =>
    gw.request(`http://gw.test/${over.app ?? "pool"}/v1/messages`, {
      method: "POST", body: over.body ?? JSON.stringify({ model: "claude-opus-4", stream: over.stream ?? false, messages: [] }),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });

  test.each([529, 500, 502, 503, 504])("HTTP %i from one member goes to the next member, and the client gets that answer", async (status) => {
    handler = (m) => (m === "a" ? (status === 529 ? overloaded(status, "req_a") : new Response(OVERLOAD_BODY("req_a").replace("overloaded_error", "api_error"), { status, headers: { "request-id": "req_a" } })) : new Response('{"type":"message"}', { headers: { "content-type": "application/json", "request-id": "req_b" } }));
    const res = await post(createGatewayApp(deps));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"type":"message"}');
    expect(res.headers.get("request-id")).toBe("req_b");
    expect(who).toEqual(["a", "b"]);
    expect(failovers).toEqual([{ app: "pool", reason: status === 529 ? "overloaded" : "server_error" }]);
    const line = logs.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; } }).find((l) => l.event === "failover");
    expect(line).toMatchObject({ app: "pool", reason: status === 529 ? "overloaded" : "server_error", http: status, requestId: "req_a" });
  });

  test("a 200 stream whose first event is an overloaded error goes to the next member", async () => {
    handler = (m) => (m === "a" ? errorStream("req_a") : okStream());
    const res = await post(createGatewayApp(deps), { stream: true });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("message_start");
    expect(text).not.toContain("overloaded_error");
    expect(who).toEqual(["a", "b"]);
    expect(failovers).toEqual([{ app: "pool", reason: "overloaded" }]);
    const line = logs.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; } }).find((l) => l.event === "failover");
    expect(line).toMatchObject({ reason: "overloaded", http: 200, errorType: "overloaded_error", requestId: "req_a" });
  });

  test("a 200 stream whose first event is an api_error also fails over; other error types do not", async () => {
    handler = (m) => (m === "a" ? errorStream("req_a", "api_error") : okStream());
    expect(await (await post(createGatewayApp(deps), { stream: true })).text()).toContain("message_start");
    expect(who).toEqual(["a", "b"]);
    who.length = 0;
    handler = () => errorStream("req_x", "invalid_request_error");
    const res = await post(createGatewayApp(deps), { stream: true });
    expect(await res.text()).toContain("invalid_request_error");
    expect(who).toEqual(["a"]);
  });

  test("when every member overloads, the last upstream answer comes back unchanged with its request id", async () => {
    handler = (m) => overloaded(529, `req_${m}`);
    const res = await post(createGatewayApp(deps));
    expect(res.status).toBe(529);
    expect(await res.text()).toBe(OVERLOAD_BODY("req_b"));
    expect(res.headers.get("request-id")).toBe("req_b");
    expect(res.headers.get(GATEWAY_UPSTREAM_HEADER)).toBe("claude");
    expect(res.headers.get(GATEWAY_ERROR_HEADER)).toBeNull();
    expect(who).toEqual(["a", "b"]); // each member once
  });

  test("when every member answers a stream error first, the exact bytes of the last one are re-sent", async () => {
    handler = (m) => errorStream(`req_${m}`);
    const res = await post(createGatewayApp(deps), { stream: true });
    expect(res.status).toBe(200);
    const expected = await errorStream("req_b").text();
    expect(await res.text()).toBe(expected);
    expect(res.headers.get("request-id")).toBe("req_b");
    expect(who).toEqual(["a", "b"]);
  });

  test("an overload does not mark the member exhausted: the next request tries it first again", async () => {
    let calls = 0;
    handler = (m) => (m === "a" && calls++ === 0 ? overloaded(529, "req_a") : okStream());
    const gw = createGatewayApp(deps);
    expect((await post(gw)).status).toBe(200);
    expect(who).toEqual(["a", "b"]);
    who.length = 0;
    expect((await post(gw)).status).toBe(200);
    expect(who).toEqual(["a"]);
  });

  test("a normal stream is not delayed or changed: its first event arrives while the rest is still pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    const rest = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    handler = () =>
      new Response(new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(enc.encode(first));
          await gate;
          c.enqueue(enc.encode(rest));
          c.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    const res = await post(createGatewayApp(deps), { stream: true });
    const reader = res.body!.getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toBe(first);
    release();
    let all = "";
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      all += new TextDecoder().decode(r.value);
    }
    expect(all).toBe(rest);
    expect(who).toEqual(["a"]);
    expect(failovers).toEqual([]);
  });

  test("a stream that starts with a ping and then message_start is passed through", async () => {
    handler = () => new Response(`: ping\n\nevent: ping\ndata: {"type":"ping"}\n\n${(await_ok())}`, { headers: { "content-type": "text/event-stream" } });
    const res = await post(createGatewayApp(deps), { stream: true });
    expect((await res.text()).endsWith(await_ok())).toBe(true);
    expect(who).toEqual(["a"]);
  });

  test("a body over the replay limit is not replayed: the overload passes through", async () => {
    handler = () => overloaded(529, "req_a");
    const big = new Uint8Array(32 * 1024 * 1024 + 1000);
    const res = await post(createGatewayApp(deps), { body: big });
    expect(res.status).toBe(529);
    expect(await res.text()).toBe(OVERLOAD_BODY("req_a"));
    expect(who).toEqual(["a"]);
    expect(failovers).toEqual([]);
  });

  test("a pinned app passes an overload through without failover", async () => {
    await store.putApp(mk("pin", { kind: "pin", identity: "a" }));
    const t = generateToken();
    await store.addToken({ app: "pin", prefix: t.prefix, hash: t.hash, createdAt: T0.toISOString() });
    token = t.token;
    handler = () => overloaded(529, "req_a");
    const res = await post(createGatewayApp(deps), { app: "pin" });
    expect(res.status).toBe(529);
    expect(await res.text()).toBe(OVERLOAD_BODY("req_a"));
    expect(who).toEqual(["a"]);
  });

  test("a held request whose replay meets an overload fails over to the other member", async () => {
    usage = { a: weekly(100, T0.getTime() + 3 * HOURS), b: weekly(100, T0.getTime() + 3 * HOURS) };
    deps.usageFor = async (_p, id) => {
      const r = usage[id];
      const reset = Date.parse(r?.windows?.[0]?.resetsAt ?? "");
      return r && reset <= clock ? weekly(10, clock + 7 * 24 * HOURS) : r;
    };
    let n = 0;
    handler = () => (n++ === 0 ? overloaded(529, "req_first") : okStream());
    const res = await post(createGatewayApp(deps), { stream: true });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: ping");
    expect(text).toContain("message_start");
    expect(text).not.toContain("event: error");
    expect(who).toHaveLength(2);
    expect(who[0]).not.toBe(who[1]!);
    expect(failovers).toEqual([{ app: "pool", reason: "overloaded" }]);
  });

  const quota429 = (): Response => new Response("{}", { status: 429, headers: { "content-type": "application/json", "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(Math.floor((T0.getTime() + 3 * HOURS) / 1000)), "retry-after": "10800" } });
  const three = () => {
    deps.poolMembers = async () => ["a", "b", "c"];
    usage = { a: live(10), b: live(20), c: live(30) };
  };

  test("an error event split across two chunks is still seen", async () => {
    const whole = `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`;
    const cut = 30;
    handler = (m) =>
      m === "a"
        ? new Response(new ReadableStream<Uint8Array>({ async start(c) { c.enqueue(enc.encode(whole.slice(0, cut))); await Bun.sleep(20); c.enqueue(enc.encode(whole.slice(cut))); c.close(); } }), { headers: { "content-type": "text/event-stream" } })
        : okStream();
    const res = await post(createGatewayApp(deps), { stream: true });
    expect(await res.text()).toContain("message_start");
    expect(who).toEqual(["a", "b"]);
  });

  test("peekFirstEvent puts every byte it read back in front of the rest", async () => {
    const whole = `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "x" } })}\n\nevent: ping\ndata: {}\n\n`;
    const parts = [whole.slice(0, 12), whole.slice(12, 40), whole.slice(40)];
    const src = new Response(new ReadableStream<Uint8Array>({ start(c) { for (const q of parts) c.enqueue(enc.encode(q)); c.close(); } }), { headers: { "content-type": "text/event-stream", "x-k": "v" } });
    const p = await peekFirstEvent(src, 64 * 1024);
    expect(p.first).toMatchObject({ state: "error", errorType: "api_error" });
    expect(p.res.headers.get("x-k")).toBe("v");
    expect(await p.res.text()).toBe(whole);
  });

  test("a stream with CRLF line ends is read the same way", async () => {
    handler = (m) => (m === "a" ? new Response(`event: error\r\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\r\n\r\n`, { headers: { "content-type": "text/event-stream" } }) : okStream());
    const res = await post(createGatewayApp(deps), { stream: true });
    expect(await res.text()).toContain("message_start");
    expect(who).toEqual(["a", "b"]);
    expect(firstEventOf(enc.encode("event: message_start\r\ndata: {}\r\n\r\n")).state).toBe("pass");
  });

  test("quota then overload then a healthy member: the third member answers", async () => {
    three();
    handler = (m) => (m === "a" ? quota429() : m === "b" ? overloaded(529, "req_b") : okStream());
    const res = await post(createGatewayApp(deps), { stream: true });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("message_start");
    expect(who).toEqual(["a", "b", "c"]);
    expect(failovers.map((f) => f.reason)).toEqual(["quota", "overloaded"]);
  });

  test("overload then quota then a healthy member: the third member answers", async () => {
    three();
    handler = (m) => (m === "a" ? overloaded(529, "req_a") : m === "b" ? quota429() : okStream());
    const res = await post(createGatewayApp(deps), { stream: true });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("message_start");
    expect(who).toEqual(["a", "b", "c"]);
    expect(failovers.map((f) => f.reason)).toEqual(["overloaded", "quota"]);
  });

  test("a credential failure on the first member, an overload on the second, then a healthy third", async () => {
    three();
    const get = deps.creds.get.bind(deps.creds);
    deps.creds = { ...deps.creds, get: async (p: GatewayApp["provider"], id: string) => { if (id === "a") throw new GatewayCredentialError("refresh-failed", p, id); return get(p, id); } } as GatewayDeps["creds"];
    handler = (m) => (m === "b" ? overloaded(529, "req_b") : okStream());
    const res = await post(createGatewayApp(deps), { stream: true });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("message_start");
    expect(who).toEqual(["b", "c"]);
  });

  test("a body that breaks while it is read does not end the request: the next member answers", async () => {
    const real = deps.fetch;
    deps.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth === "Bearer tok-a") {
        who.push("a");
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("connection reset")); } }), { headers: { "content-type": "text/event-stream" } }));
      }
      return real(input, init);
    }) as typeof fetch;
    const res = await post(createGatewayApp(deps), { stream: true });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("message_start");
    expect(who).toEqual(["a", "b"]);
  });

  test("a second member whose body breaks leaves the first member's overload answer standing", async () => {
    const real = deps.fetch;
    deps.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth === "Bearer tok-b") {
        who.push("b");
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("connection reset")); } }), { headers: { "content-type": "text/event-stream" } }));
      }
      return real(input, init);
    }) as typeof fetch;
    handler = () => overloaded(529, "req_a");
    const res = await post(createGatewayApp(deps));
    expect(res.status).toBe(529);
    expect(await res.text()).toBe(OVERLOAD_BODY("req_a"));
    expect(res.headers.get("request-id")).toBe("req_a");
    expect(who).toEqual(["a", "b"]);
  });

  test("a short-hold wait never sends the request back to a member that overloaded", async () => {
    let bCalls = 0;
    handler = (m) => (m === "a" ? overloaded(529, "req_a") : bCalls++ === 0 ? new Response("{}", { status: 429, headers: { "content-type": "application/json" } }) : okStream());
    const res = await post(createGatewayApp(deps), { stream: false });
    expect(who.filter((m) => m === "a")).toHaveLength(1);
    expect(who.filter((m) => m === "b").length).toBeLessThanOrEqual(2);
    expect(res.status).toBe(200);
  });

  test("the failover log line names the member left and the member tried", async () => {
    handler = (m) => (m === "a" ? overloaded(529, "req_a") : okStream());
    await (await post(createGatewayApp(deps))).text();
    const line = logs.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; } }).find((l) => l.event === "failover");
    expect(line).toMatchObject({ from: "a", to: "b" });
  });

  test("a file upload or a message batch never fails over on an overload", async () => {
    handler = () => overloaded(529, "req_a");
    for (const path of ["/pool/v1/files", "/pool/v1/messages/batches"]) {
      who.length = 0;
      const res = await createGatewayApp(deps).request(`http://gw.test${path}`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
      expect(res.status).toBe(529);
      expect(await res.text()).toBe(OVERLOAD_BODY("req_a"));
      expect(who).toEqual(["a"]);
    }
    expect(failovers).toEqual([]);
  });

  test("firstEventOf decides on the first event line, waits for a whole error event, and passes odd input", () => {
    const d = (s: string) => enc.encode(s);
    expect(firstEventOf(d("event: mess")).state).toBe("pending");
    expect(firstEventOf(d("event: message_start\n")).state).toBe("pass");
    expect(firstEventOf(d("event: error\ndata: {\"type\":\"error\",\"er")).state).toBe("pending");
    expect(firstEventOf(d("event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}\n\n"))).toMatchObject({ state: "error", errorType: "overloaded_error" });
    expect(firstEventOf(d("{\"not\":\"sse\"}\n")).state).toBe("pass");
  });
});

function await_ok(): string {
  return 'event: message_start\ndata: {"type":"message_start"}\n\n';
}

describe("answers the gateway builds itself say so", () => {
  let store: MemoryGatewayStore;
  let ledger: LedgerBuffer;
  let deps: GatewayDeps;
  beforeEach(async () => {
    store = new MemoryGatewayStore();
    ledger = new LedgerBuffer(store, { max: 1000, flushMs: 3_600_000 });
    deps = {
      sleep: async () => {}, store, ledger,
      creds: { get: async (_p: string, id: string) => ({ identity: id, accessToken: `tok-${id}` }), refreshAfter401: async () => { throw new Error("unused"); } } as unknown as GatewayDeps["creds"],
      usageFor: async () => live(100),
      poolMembers: async () => ["a", "b"],
      fetch: (async () => { throw new Error("no upstream"); }) as unknown as typeof fetch,
      now: () => T0, metrics: noopMetrics, log: () => {},
    };
  });
  afterEach(async () => {
    await ledger.close();
  });

  const gatewayAnswers = async (): Promise<Response[]> => {
    const gw = createGatewayApp(deps);
    const app = mk("pool", { kind: "pool" });
    await store.putApp(app);
    const t = generateToken();
    await store.addToken({ app: app.name, prefix: t.prefix, hash: t.hash, createdAt: T0.toISOString() });
    const auth = { authorization: `Bearer ${t.token}`, "content-type": "application/json" };
    const body = JSON.stringify({ model: "claude-opus-4", messages: [] });
    return [
      await gw.request("http://gw.test/pool/v1/messages", { method: "POST", body, headers: { "content-type": "application/json" } }), // no token
      await gw.request("http://gw.test/nobody/v1/messages", { method: "POST", body, headers: auth }), // unknown app
      await gw.request("http://gw.test/pool/v1/messages", { method: "POST", body, headers: auth }), // pool full (native limit answer)
      await gw.request("http://gw.test/pool/v1/%2e%2e/messages", { method: "POST", body, headers: auth }), // path refused
    ];
  };

  test("each gateway-built error names the gateway in its message or reason, and carries x-ais-gateway-error", async () => {
    for (const res of await gatewayAnswers()) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get(GATEWAY_ERROR_HEADER)).toMatch(/^[a-z0-9_-]+$/);
      expect(res.headers.get(GATEWAY_UPSTREAM_HEADER)).toBeNull();
      const message = ((await res.json()) as { error: { message: string } }).error.message;
      expect(message).toContain("AIS gateway: ");
    }
  });

  test("limit answers keep the opening that clients read and keep their status", async () => {
    const res = (await gatewayAnswers())[2]!;
    expect(res.status).toBe(429);
    const message = ((await res.json()) as { error: { message: string } }).error.message;
    expect(message).toMatch(/^You've hit your [^\n]*\blimit\b/);
    expect(message).toMatch(/\bResets at \d{4}-\d\d-\d\dT[\d:.]+Z\.$/);
    expect(message).toContain("AIS gateway: ");
  });

  test("no gateway-built answer uses status 529 or the overloaded_error type", async () => {
    for (const res of await gatewayAnswers()) {
      expect(res.status).not.toBe(529);
      expect(await res.text()).not.toContain("overloaded_error");
    }
    // Source guard: only the failover module may name them.
    const dir = join(import.meta.dir, "../../src/gateway");
    for (const f of readdirSync(dir, { recursive: true }) as string[]) {
      if (!f.endsWith(".ts") || f === "overload.ts") continue;
      const text = readFileSync(join(dir, f), "utf8");
      expect(text.includes("overloaded_error")).toBe(false);
    }
  });
});
