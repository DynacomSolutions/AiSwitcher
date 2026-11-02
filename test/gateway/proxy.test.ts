import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PoolUsage } from "../../src/identities/pool/adapter.ts";
import { createGatewayApp, type GatewayDeps } from "../../src/gateway/app.ts";
import { extractToken } from "../../src/gateway/auth.ts";
import { checkCaps, dayStartIct } from "../../src/gateway/caps.ts";
import { GatewayCredentialError, RefreshCooldownError } from "../../src/gateway/credentials.ts";
import { providerError } from "../../src/gateway/errors.ts";
import { LedgerBuffer } from "../../src/gateway/ledger-buffer.ts";
import { noopMetrics } from "../../src/gateway/metrics.ts";
import { pickIdentity } from "../../src/gateway/select.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { generateToken, hashSecret, parseToken } from "../../src/gateway/tokens.ts";
import type { GatewayApp, UsageRow } from "../../src/gateway/types.ts";

class CapturingStore extends MemoryGatewayStore {
  readonly written: UsageRow[] = [];
  override async appendUsage(rows: UsageRow[]): Promise<void> {
    this.written.push(...rows);
    await super.appendUsage(rows);
  }
}

interface Seen {
  url: string;
  headers: Headers;
  body: Uint8Array;
}

const NOW = new Date("2026-11-02T10:00:00.000Z");
const enc = new TextEncoder();
const live = (u: number): PoolUsage => ({ status: "live", maxUtilization: u, capturedAt: NOW.toISOString() });

function baseApp(over: Partial<GatewayApp>): GatewayApp {
  return {
    name: "pin",
    owner: "o",
    namespace: "ns",
    provider: "claude",
    style: "anthropic",
    target: { kind: "pin", identity: "id1" },
    state: "active",
    createdAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

let upstream: ReturnType<typeof Bun.serve>;
let handler: (req: Request, seen: Seen) => Response | Promise<Response>;
let seen: Seen[];
let store: CapturingStore;
let ledger: LedgerBuffer;
let tokens: Record<string, string>;
let usage: Record<string, PoolUsage | undefined>;
let refreshCalls: number;
let refreshImpl: () => Promise<{ identity: string; accessToken: string }>;
let logs: string[];
let deps: GatewayDeps;
let servers: Array<ReturnType<typeof Bun.serve>>;
let origWarn: typeof console.warn;
let origInfo: typeof console.info;
let origLog: typeof console.log;

async function addApp(app: GatewayApp): Promise<string> {
  await store.putApp(app);
  const t = generateToken();
  await store.addToken({ app: app.name, prefix: t.prefix, hash: t.hash, createdAt: NOW.toISOString() });
  tokens[app.name] = t.token;
  return t.token;
}

beforeEach(async () => {
  seen = [];
  servers = [];
  tokens = {};
  usage = {};
  refreshCalls = 0;
  logs = [];
  refreshImpl = async () => ({ identity: "id1", accessToken: "fresh-id1" });
  handler = () => new Response("{}", { headers: { "content-type": "application/json" } });
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const s: Seen = { url: req.url, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) };
      seen.push(s);
      return handler(req, s);
    },
  });
  store = new CapturingStore();
  ledger = new LedgerBuffer(store, { max: 1000, flushMs: 3_600_000 });
  deps = {
    store,
    ledger,
    creds: {
      get: async (_p: string, identity: string) => ({ identity, accessToken: `tok-${identity}` }),
      refreshAfter401: async () => {
        refreshCalls += 1;
        return refreshImpl();
      },
    } as unknown as GatewayDeps["creds"],
    usageFor: async (_p, identity) => usage[identity],
    poolMembers: async () => ["a", "b"],
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const headers = new Headers(init?.headers);
      headers.set("x-orig-host", u.host);
      return fetch(`http://127.0.0.1:${upstream.port}${u.pathname}${u.search}`, { ...init, headers });
    }) as typeof fetch,
    now: () => NOW,
    metrics: noopMetrics,
    log: (line) => logs.push(line),
  };
  origWarn = console.warn;
  origInfo = console.info;
  origLog = console.log;
  console.warn = (...a: unknown[]) => void logs.push(a.join(" "));
  console.info = (...a: unknown[]) => void logs.push(a.join(" "));
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
});

afterEach(async () => {
  console.warn = origWarn;
  console.info = origInfo;
  console.log = origLog;
  for (const s of servers) await s.stop(true);
  await upstream.stop(true);
  await ledger.close();
});

const rows = async (): Promise<UsageRow[]> => {
  await ledger.flush();
  return store.written;
};

const callRaw = (path: string, token: string | undefined, init: RequestInit = {}) =>
  createGatewayApp(deps).request(`http://gw.test${path}`, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers as Record<string, string>) },
  });

/** Like callRaw but drains the body, as a real client does (the ledger row is written when the body ends). */
async function call(path: string, token: string | undefined, init: RequestInit = {}): Promise<Response> {
  const res = await callRaw(path, token, init);
  const bytes = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
  return new Response(bytes, { status: res.status, headers: res.headers });
}

const anthropicJson = JSON.stringify({
  type: "message",
  model: "claude-sonnet-4-5",
  usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 3, cache_creation_input_tokens: 5 },
});

describe("helpers", () => {
  test("extractToken accepts bearer, x-api-key, api-key and basic, never the query", () => {
    const t = generateToken().token;
    const r = (init: Record<string, string>, q = "") => new Request(`http://x/app/v1${q}`, { headers: init });
    expect(extractToken(r({ authorization: `Bearer ${t}` }), "app")).toBe(t);
    expect(extractToken(r({ "x-api-key": t }), "app")).toBe(t);
    expect(extractToken(r({ "api-key": t }), "app")).toBe(t);
    expect(extractToken(r({ authorization: `Basic ${btoa(`app:${t}`)}` }), "app")).toBe(t);
    expect(extractToken(r({ authorization: `Basic ${btoa(`other:${t}`)}` }), "app")).toBeUndefined();
    expect(extractToken(r({}, `?key=${t}`), "app")).toBeUndefined();
    expect(extractToken(r({ authorization: "Bearer" }), "app")).toBeUndefined();
  });

  test("providerError shapes", async () => {
    expect(await providerError("anthropic", 401, "m").json()).toEqual({ type: "error", error: { type: "authentication_error", message: "m" } });
    const o = (await providerError("openai", 429, "m").json()) as { error: { type: string; message: string } };
    expect(o.error).toMatchObject({ type: "rate_limit_error", message: "m" });
  });

  test("checkCaps and ICT day start", () => {
    const a = baseApp({ models: ["m1"], dailyTokens: 100 });
    expect(checkCaps(a, "m2", 0)).toMatchObject({ status: 403 });
    expect(checkCaps(a, undefined, 0)).toMatchObject({ status: 403 });
    expect(checkCaps(a, "m1", 100)).toMatchObject({ status: 429 });
    expect(checkCaps(a, "m1", 99)).toEqual({ ok: true });
    // 2026-11-02T10:00Z is 17:00 ICT on 2 Nov; midnight ICT is 2026-11-01T17:00Z.
    expect(dayStartIct(NOW).toISOString()).toBe("2026-11-01T17:00:00.000Z");
    expect(dayStartIct(new Date("2026-11-01T16:59:00.000Z")).toISOString()).toBe("2026-10-31T17:00:00.000Z");
  });
});

describe("auth", () => {
  test("unknown app 404 in provider shape", async () => {
    const res = await call("/v1/messages", undefined, {});
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { type: string } };
    expect(body.error?.type).toBeDefined();
    const res2 = await call("/nope/v1/messages", "x");
    expect(res2.status).toBe(404);
    expect(((await res2.json()) as { type: string }).type).toBe("error");
    const res3 = await call("/nope/v1/chat/completions", "x");
    expect(res3.status).toBe(404);
    expect(((await res3.json()) as { error: object }).error).toBeDefined();
  });

  test("bad token 401", async () => {
    await addApp(baseApp({}));
    expect((await call("/pin/v1/messages", undefined, { method: "POST", body: "{}" })).status).toBe(401);
    const other = generateToken().token;
    expect((await call("/pin/v1/messages", other, { method: "POST", body: "{}" })).status).toBe(401);
    expect(seen.length).toBe(0);
  });

  test("revoked app token is rejected", async () => {
    const t = await addApp(baseApp({}));
    await store.revokeApp("pin");
    expect((await call("/pin/v1/messages", t, { method: "POST", body: "{}" })).status).toBe(401);
  });

  test("token in query string is rejected and never logged", async () => {
    const t = await addApp(baseApp({}));
    const secret = parseToken(t)!.secret;
    const res = await call(`/pin/v1/messages?api_key=${t}`, undefined, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    // Even with valid header auth the raw query token is refused, and nothing reaches upstream.
    const res2 = await call(`/pin/v1/messages?api_key=${t}`, t, { method: "POST", body: "{}" });
    expect(res2.status).toBe(401);
    const res3 = await call("/pin/v1/messages", undefined, { method: "POST", body: "{}", headers: { authorization: `Bearer ${t} extra` } });
    expect(res3.status).toBe(401);
    expect(seen.length).toBe(0);
    const all = logs.join("\n");
    expect(all).not.toContain(t);
    expect(all).not.toContain(secret);
    expect(all).not.toContain(hashSecret(secret));
  });

  test("bearer, x-api-key and basic all authenticate", async () => {
    const t = await addApp(baseApp({}));
    const mk = (headers: Record<string, string>) => call("/pin/v1/messages", undefined, { method: "POST", body: "{}", headers });
    expect((await mk({ authorization: `Bearer ${t}` })).status).toBe(200);
    expect((await mk({ "x-api-key": t })).status).toBe(200);
    expect((await mk({ "api-key": t })).status).toBe(200);
    expect((await mk({ authorization: `Basic ${btoa(`pin:${t}`)}` })).status).toBe(200);
    expect(seen.length).toBe(4);
  });
});

describe("forwarding", () => {
  test("body bytes reach upstream unchanged and url keeps path and query", async () => {
    const t = await addApp(baseApp({}));
    const body = new Uint8Array(4096);
    for (let i = 0; i < body.length; i++) body[i] = (i * 31) % 256;
    const res = await call("/pin/v1/messages?beta=true", t, { method: "POST", body, headers: { "content-type": "application/octet-stream" } });
    expect(res.status).toBe(200);
    expect(Buffer.from(seen[0]!.body).equals(Buffer.from(body))).toBe(true);
    expect(seen[0]!.url.endsWith("/v1/messages?beta=true")).toBe(true);
    expect(seen[0]!.headers.get("x-orig-host")).toBe("api.anthropic.com");
    expect(seen[0]!.headers.get("accept-encoding")).toBe("identity");
  });

  test("response sse bytes reach client unchanged", async () => {
    const t = await addApp(baseApp({}));
    const sse = enc.encode(
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":1}}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n',
    );
    handler = () => new Response(sse, { headers: { "content-type": "text/event-stream" } });
    const res = await call("/pin/v1/messages", t, { method: "POST", body: "{}" });
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(sse))).toBe(true);
    const r = await rows();
    expect(r[0]).toMatchObject({ inputTokens: 10, outputTokens: 42, streamed: true, status: "ok" });
  });

  test("gateway token never reaches upstream; credential comes from the adapter", async () => {
    const t = await addApp(baseApp({}));
    await call("/pin/v1/messages", t, {
      method: "POST",
      body: "{}",
      headers: { "x-api-key": t, "api-key": t, cookie: "a=b", "proxy-authorization": "x", "anthropic-beta": "foo", "anthropic-version": "2023-06-01" },
    });
    const h = seen[0]!.headers;
    expect(h.get("authorization")).toBe("Bearer tok-id1");
    expect(h.get("x-api-key")).toBeNull();
    expect(h.get("api-key")).toBeNull();
    expect(h.get("cookie")).toBeNull();
    expect(h.get("proxy-authorization")).toBeNull();
    expect(h.get("anthropic-beta")).toBe("foo,oauth-2025-04-20");
    expect(h.get("anthropic-version")).toBe("2023-06-01");
    const all = [...h.entries()].map(([k, v]) => `${k}:${v}`).join("\n");
    expect(all).not.toContain(t);
  });

  test("one ledger row per request with identity and counts", async () => {
    const t = await addApp(baseApp({}));
    handler = () => new Response(anthropicJson, { headers: { "content-type": "application/json" } });
    const res = await call("/pin/v1/messages", t, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-5" }) });
    expect(await res.text()).toBe(anthropicJson);
    const r = await rows();
    expect(r.length).toBe(1);
    expect(r[0]).toMatchObject({
      app: "pin", provider: "claude", identity: "id1", model: "claude-sonnet-4-5",
      inputTokens: 12, outputTokens: 34, cacheReadTokens: 3, cacheWriteTokens: 5, status: "ok", httpStatus: 200, streamed: false,
    });
    expect(JSON.stringify(r[0])).not.toContain(t);
  });

  test("upstream error status passes through and is recorded", async () => {
    const t = await addApp(baseApp({}));
    handler = () => new Response('{"error":"x"}', { status: 500, headers: { "content-type": "application/json" } });
    const res = await call("/pin/v1/messages", t, { method: "POST", body: "{}" });
    expect(res.status).toBe(500);
    const r = await rows();
    expect(r.length).toBe(1);
    expect(r[0]).toMatchObject({ httpStatus: 500, status: "upstream_error" });
  });

  test("openai chat stream without usage records zeros and logs tap status", async () => {
    const t = await addApp(baseApp({ name: "oa", provider: "kimi", style: "openai" }));
    const sse = 'data: {"model":"k2","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    handler = () => new Response(sse, { headers: { "content-type": "text/event-stream" } });
    const req = JSON.stringify({ model: "k2", stream: true });
    const res = await call("/oa/v1/chat/completions", t, { method: "POST", body: req });
    expect(await res.text()).toBe(sse);
    expect(Buffer.from(seen[0]!.body).toString()).toBe(req);
    const r = await rows();
    expect(r[0]).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(logs.join("\n")).toContain('"tap":"none"');
  });
});

describe("caps and selection", () => {
  test("model outside allowlist 403, with a ledger row", async () => {
    const t = await addApp(baseApp({ models: ["claude-sonnet-4-5"] }));
    const res = await call("/pin/v1/messages", t, { method: "POST", body: JSON.stringify({ model: "claude-opus-4" }) });
    expect(res.status).toBe(403);
    expect(seen.length).toBe(0);
    const ok = await call("/pin/v1/messages", t, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-5" }) });
    expect(ok.status).toBe(200);
    const r = await rows();
    expect(r.length).toBe(2);
    expect(r[0]).toMatchObject({ httpStatus: 403, status: "rejected" });
  });

  test("daily cap 429 and in-flight stream completes", async () => {
    const t = await addApp(baseApp({ dailyTokens: 50 }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    handler = () => {
      const body = new ReadableStream({
        async start(c) {
          c.enqueue(enc.encode('event: message_start\ndata: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":40,"output_tokens":1}}}\n\n'));
          await gate;
          c.enqueue(enc.encode('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":30}}\n\n'));
          c.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    const first = await callRaw("/pin/v1/messages", t, { method: "POST", body: "{}" });
    expect(first.status).toBe(200);
    release();
    await first.text();
    await rows();
    handler = () => new Response("{}");
    const second = await call("/pin/v1/messages", t, { method: "POST", body: "{}" });
    expect(second.status).toBe(429);
    expect(seen.length).toBe(1);
    const r = await rows();
    expect(r.length).toBe(2);
    expect(r[0]).toMatchObject({ inputTokens: 40, outputTokens: 30, status: "ok" });
    expect(r[1]).toMatchObject({ httpStatus: 429, status: "rejected" });
  });

  test("daily cap counts cache-write tokens", async () => {
    const t = await addApp(baseApp({ dailyTokens: 50 }));
    handler = () => new Response(anthropicJson, { headers: { "content-type": "application/json" } });
    await call("/pin/v1/messages", t, { method: "POST", body: "{}" }); // 12 + 34 + 5 = 51
    await rows();
    expect((await call("/pin/v1/messages", t, { method: "POST", body: "{}" })).status).toBe(429);
  });

  test("pinned identity over reserve 429 names reason", async () => {
    const t = await addApp(baseApp({ reservePercent: 70 }));
    usage.id1 = live(75);
    const res = await call("/pin/v1/messages", t, { method: "POST", body: "{}" });
    expect(res.status).toBe(429);
    expect(JSON.stringify(await res.json())).toContain("reserve");
    expect(seen.length).toBe(0);
    usage.id1 = live(60);
    expect((await call("/pin/v1/messages", t, { method: "POST", body: "{}" })).status).toBe(200);
    usage.id1 = undefined;
    expect((await call("/pin/v1/messages", t, { method: "POST", body: "{}" })).status).toBe(200);
  });

  test("pool picks lowest utilisation below reserve", async () => {
    const app = baseApp({ name: "pool", target: { kind: "pool" } });
    usage.a = live(70);
    usage.b = live(20);
    expect(await pickIdentity(app, deps)).toEqual({ identity: "b" });
    expect(await pickIdentity(app, deps, "b")).toEqual({ identity: "a" });
    usage.a = live(90);
    expect(await pickIdentity(app, deps, "b")).toEqual({ reject: "no-headroom" });
    usage.a = undefined;
    expect(await pickIdentity(app, deps, "b")).toEqual({ identity: "a" });
    const t = await addApp({ ...app, name: "pool" });
    usage.a = live(70);
    usage.b = live(20);
    await call("/pool/v1/messages", t, { method: "POST", body: "{}" });
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer tok-b");
    expect((await rows())[0]!.identity).toBe("b");
  });
});

describe("failover and refresh", () => {
  test("pool fails over once on 429 before first byte", async () => {
    const t = await addApp(baseApp({ name: "pool", target: { kind: "pool" } }));
    usage.a = live(10);
    usage.b = live(20);
    handler = (_req, s) =>
      s.headers.get("authorization") === "Bearer tok-a"
        ? new Response('{"e":"rl"}', { status: 429, headers: { "content-type": "application/json" } })
        : new Response(anthropicJson, { headers: { "content-type": "application/json" } });
    const body = JSON.stringify({ model: "claude-sonnet-4-5", n: 1 });
    const res = await call("/pool/v1/messages", t, { method: "POST", body });
    expect(res.status).toBe(200);
    expect(seen.length).toBe(2);
    expect(Buffer.from(seen[1]!.body).toString()).toBe(body);
    const r = await rows();
    expect(r.length).toBe(1);
    expect(r[0]).toMatchObject({ identity: "b", httpStatus: 200 });
  });

  test("failover happens at most once", async () => {
    const t = await addApp(baseApp({ name: "pool", target: { kind: "pool" } }));
    usage.a = live(10);
    usage.b = live(20);
    handler = () => new Response("{}", { status: 429, headers: { "content-type": "application/json" } });
    const res = await call("/pool/v1/messages", t, { method: "POST", body: "{}" });
    expect(res.status).toBe(429);
    expect(seen.length).toBe(2);
    expect((await rows()).length).toBe(1);
  });

  test("429 on a pinned app passes through without failover", async () => {
    const t = await addApp(baseApp({}));
    handler = () => new Response("{}", { status: 429 });
    expect((await call("/pin/v1/messages", t, { method: "POST", body: "{}" })).status).toBe(429);
    expect(seen.length).toBe(1);
  });

  test("no failover after first byte", async () => {
    const t = await addApp(baseApp({ name: "pool", target: { kind: "pool" } }));
    usage.a = live(10);
    usage.b = live(20);
    handler = () => {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode("data: one\n\n"));
          setTimeout(() => c.error(new Error("boom")), 20);
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    const res = await call("/pool/v1/messages", t, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(seen.length).toBe(1);
    const r = await rows();
    expect(r.length).toBe(1);
    expect(r[0]!.status).toBe("stream_error");
  });

  test("body over replay limit streams through without failover", async () => {
    const t = await addApp(baseApp({ name: "pool", target: { kind: "pool" } }));
    usage.a = live(10);
    usage.b = live(20);
    handler = () => new Response("{}", { status: 429, headers: { "content-type": "application/json" } });
    const big = new Uint8Array(8 * 1024 * 1024 + 1000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 251;
    const res = await call("/pool/v1/messages", t, { method: "POST", body: big, headers: { "content-type": "application/octet-stream" } });
    expect(res.status).toBe(429);
    expect(seen.length).toBe(1);
    expect(seen[0]!.body.length).toBe(big.length);
    expect(Buffer.from(seen[0]!.body).equals(Buffer.from(big))).toBe(true);
  });

  test("401 triggers one refresh and retry", async () => {
    const t = await addApp(baseApp({}));
    handler = (_req, s) =>
      s.headers.get("authorization") === `Bearer ${"fresh"}-id1`
        ? new Response(anthropicJson, { headers: { "content-type": "application/json" } })
        : new Response('{"e":"auth"}', { status: 401 });
    const body = '{"model":"x"}';
    const res = await call("/pin/v1/messages", t, { method: "POST", body });
    expect(res.status).toBe(200);
    expect(refreshCalls).toBe(1);
    expect(seen.length).toBe(2);
    expect(Buffer.from(seen[1]!.body).toString()).toBe(body);
    expect((await rows()).length).toBe(1);
  });

  test("a second 401 is passed through without another refresh", async () => {
    const t = await addApp(baseApp({}));
    handler = () => new Response('{"e":"auth"}', { status: 401 });
    const res = await call("/pin/v1/messages", t, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(refreshCalls).toBe(1);
    expect(seen.length).toBe(2);
  });

  test("refresh cooldown passes the upstream 401 through unchanged", async () => {
    const t = await addApp(baseApp({}));
    handler = () => new Response('{"upstream":"401"}', { status: 401 });
    refreshImpl = async () => {
      throw new RefreshCooldownError("claude", "id1");
    };
    const res = await call("/pin/v1/messages", t, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('{"upstream":"401"}');
  });

  test("credential errors give a provider-shaped error with the reason only", async () => {
    const t = await addApp(baseApp({}));
    handler = () => new Response("{}", { status: 401 });
    refreshImpl = async () => {
      throw new GatewayCredentialError("refresh-failed", "claude", "id1", new Error("cause-marker-path leak-marker"));
    };
    const res = await call("/pin/v1/messages", t, { method: "POST", body: "{}" });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("refresh-failed");
    expect(text).not.toContain("cause-marker");
    expect(text).not.toContain("id1");
    expect(logs.join("\n")).not.toContain("leak-marker");
    const r = await rows();
    expect(r.length).toBe(1);
    expect(r[0]).toMatchObject({ httpStatus: 502, status: "credential_error" });
  });
});

describe("client abort", () => {
  test("client abort mid-stream aborts upstream and records client_aborted", async () => {
    const t = await addApp(baseApp({}));
    let upstreamAborted!: () => void;
    const aborted = new Promise<void>((r) => (upstreamAborted = r));
    handler = (req) => {
      req.signal.addEventListener("abort", () => upstreamAborted());
      const body = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('event: message_start\ndata: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":9,"output_tokens":1}}}\n\n'));
        },
        cancel() {
          upstreamAborted();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    const gw = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createGatewayApp(deps).fetch });
    servers.push(gw);
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${gw.port}/pin/v1/messages`, {
      method: "POST",
      body: "{}",
      headers: { authorization: `Bearer ${t}` },
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.value?.length).toBeGreaterThan(0);
    ac.abort();
    await reader.read().catch(() => undefined);
    await Promise.race([aborted, new Promise((_, rej) => setTimeout(() => rej(new Error("upstream not aborted")), 3000))]);
    let r: UsageRow[] = [];
    for (let i = 0; i < 50 && r.length === 0; i++) {
      r = await rows();
      if (r.length === 0) await new Promise((x) => setTimeout(x, 40));
    }
    expect(r.length).toBe(1);
    expect(r[0]).toMatchObject({ status: "client_aborted", inputTokens: 9, streamed: true });
  });
});
