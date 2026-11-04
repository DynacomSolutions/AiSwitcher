import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAlerter } from "../../src/gateway/alerts.ts";
import { createGatewayApp, styleForPath } from "../../src/gateway/app.ts";
import { instrumentRefresh, recoverOnSuccess, startGateway, type GatewayHooks } from "../../src/gateway/serve.ts";
import { PrometheusMetrics } from "../../src/gateway/metrics.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { LedgerBuffer } from "../../src/gateway/ledger-buffer.ts";
import { generateToken } from "../../src/gateway/tokens.ts";
import type { GatewayApp, UsageRow } from "../../src/gateway/types.ts";

const ADMIN = "adm-test-value-0001-0123456789abcdef";
const enc = new TextEncoder();
const UPSTREAM_CRED = ["upstream", "cred", "fixture"].join("-");
const WRONG_TOKEN = ["aisg", "abcdefgh", "wrongwrong"].join("_");

class CapturingStore extends MemoryGatewayStore {
  readonly written: UsageRow[] = [];
  override async appendUsage(rows: UsageRow[]): Promise<void> {
    this.written.push(...rows);
    await super.appendUsage(rows);
  }
}

let upstream: ReturnType<typeof Bun.serve>;
let release: () => void;
let gate: Promise<void>;
let store: CapturingStore;
let started: Array<{ stop(): Promise<void> }>;
let alerts: Array<{ kind: string; key: string }>;
let exits: number[];
let migrateFails: boolean;
let credFails: boolean;
let origWarn: typeof console.warn;
let origInfo: typeof console.info;
let origErr: typeof console.error;

const app: GatewayApp = {
  name: "web",
  owner: "o",
  namespace: "ns",
  provider: "claude",
  style: "anthropic",
  target: { kind: "pin", identity: "id1" },
  state: "active",
  createdAt: "2026-11-01T00:00:00.000Z",
};

async function seed(): Promise<string> {
  await store.putApp(app);
  const t = generateToken();
  await store.addToken({ app: "web", prefix: t.prefix, hash: t.hash, createdAt: app.createdAt });
  return t.token;
}

function hooks(over: Partial<GatewayHooks> = {}): GatewayHooks {
  return {
    host: "127.0.0.1",
    migrate: async () => {
      if (migrateFails) throw new Error("connect ECONNREFUSED");
    },
    openStore: () => store,
    creds: {
      get: async (_p: string, identity: string) => {
        if (credFails) throw new Error("no credential");
        return { identity, accessToken: UPSTREAM_CRED };
      },
      refreshAfter401: async () => ({ identity: "id1", accessToken: "x" }),
    } as unknown as GatewayHooks["creds"],
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return fetch(`http://127.0.0.1:${upstream.port}${u.pathname}${u.search}`, init);
    }) as typeof fetch,
    usageFor: async () => undefined,
    poolMembers: async () => ["id1"],
    notify: (a) => void alerts.push({ kind: a.kind, key: a.key }),
    warmBackoff: { initialMs: 10, maxMs: 20 },
    ledger: { max: 1000, flushMs: 3_600_000 },
    refreshIntervalMs: 3_600_000,
    exit: (code) => void exits.push(code),
    ...over,
  };
}

async function boot(over: Partial<GatewayHooks> = {}, handleSignals = false) {
  const g = await startGateway({ port: 0, adminPort: 0, databaseUrl: "postgres://unused", adminToken: ADMIN, handleSignals }, hooks(over));
  started.push(g);
  return g;
}
const base = (g: { port: number }) => `http://127.0.0.1:${g.port}`;
const status = (url: string) => fetch(url).then((r) => r.status, () => 0);
async function waitFor(fn: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(10);
  }
  throw new Error("waitFor timed out");
}

beforeEach(() => {
  store = new CapturingStore();
  started = [];
  alerts = [];
  exits = [];
  migrateFails = false;
  credFails = false;
  gate = new Promise<void>((r) => (release = r));
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname.endsWith("/slow")) {
        return gate.then(() => new Response("{}", { headers: { "content-type": "application/json" } }));
      }
      if (new URL(req.url).pathname.endsWith("/stream")) {
        return new Response(
          new ReadableStream({
            async start(c) {
              c.enqueue(enc.encode('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\n'));
              await gate;
              c.enqueue(enc.encode('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n'));
              c.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response('{"ok":true,"usage":{"input_tokens":2,"output_tokens":4}}', { headers: { "content-type": "application/json" } });
    },
  });
  origWarn = console.warn;
  origInfo = console.info;
  origErr = console.error;
  console.warn = () => {};
  console.info = () => {};
  console.error = () => {};
});

afterEach(async () => {
  release();
  for (const g of started) await g.stop().catch(() => undefined);
  await upstream.stop(true);
  console.warn = origWarn;
  console.info = origInfo;
  console.error = origErr;
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
});

describe("serve lifecycle", () => {
  test("cold start without db stays unready", async () => {
    migrateFails = true;
    const g = await boot();
    expect(await status(`${base(g)}/healthz`)).toBe(200);
    await Bun.sleep(80);
    expect(await status(`${base(g)}/readyz`)).toBe(503);
    expect((await fetch(`${base(g)}/web/v1/messages`, { method: "POST" })).status).toBe(503);
    migrateFails = false;
    await waitFor(async () => (await status(`${base(g)}/readyz`)) === 200);
  });

  test("ready after warm-up", async () => {
    await seed();
    const g = await boot();
    await waitFor(async () => (await status(`${base(g)}/readyz`)) === 200);
  });

  test("an app pinned to a missing identity does not make the gateway unready", async () => {
    const token = await seed();
    await store.putApp({ ...app, name: "broken", target: { kind: "pin", identity: "missing" } });
    const t2 = generateToken();
    await store.addToken({ app: "broken", prefix: t2.prefix, hash: t2.hash, createdAt: app.createdAt });
    const base0 = hooks().creds as { get(p: string, i: string): Promise<unknown> };
    const g = await boot({
      creds: {
        get: async (p: string, i: string) => {
          if (i === "missing") throw new Error("unknown identity");
          return base0.get(p, i);
        },
        refreshAfter401: async () => ({ identity: "x", accessToken: "x" }),
      } as unknown as GatewayHooks["creds"],
    });
    await waitFor(async () => (await status(`${base(g)}/readyz`)) === 200);
    const ok = await fetch(`${base(g)}/web/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
    expect(ok.status).toBe(200);
    const bad = await fetch(`${base(g)}/broken/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${t2.token}` }, body: "{}" });
    expect(bad.status).toBe(502);
    await waitFor(async () => (await (await fetch(`${base(g)}/metrics`)).text()).includes("ais_gateway_credential_unreadable_total"));
    const text = await (await fetch(`${base(g)}/metrics`)).text();
    expect(text).toContain('ais_gateway_credential_unreadable_total{app="broken",provider="claude",identity="missing"} 1');
  });

  test("admin token shorter than 32 characters fails startup without printing it", async () => {
    const short = "short-token-value";
    const err = await startGateway({ port: 0, adminPort: 0, databaseUrl: "postgres://unused", adminToken: short }, hooks()).then(() => undefined, (e: Error) => e);
    expect(err?.message).toContain("32");
    expect(err?.message).not.toContain(short);
  });

  test("warm-up finishing after stop does not start the cache refresh", async () => {
    let release2!: () => void;
    const hold = new Promise<void>((r) => (release2 = r));
    let listCalls = 0;
    const counting = new CapturingStore();
    counting.listApps = async () => {
      listCalls += 1;
      return [];
    };
    const g = await boot({ migrate: () => hold, openStore: () => counting, refreshIntervalMs: 20 });
    await g.stop();
    release2();
    await Bun.sleep(150);
    expect(listCalls).toBeLessThanOrEqual(1);
  });

  test("responses finishing while draining ask the client to close the connection", async () => {
    const token = await seed();
    const g = await boot({}, true);
    await waitFor(async () => (await status(`${base(g)}/readyz`)) === 200);
    let buf = "";
    let wake!: () => void;
    const got = new Promise<void>((r) => (wake = r));
    const sock = await Bun.connect({
      hostname: "127.0.0.1",
      port: g.port,
      socket: {
        data(_s, d) {
          buf += new TextDecoder().decode(d);
          if (buf.includes("\r\n\r\n")) wake();
        },
        open(s) {
          s.write(`POST /web/v1/slow HTTP/1.1\r\nHost: x\r\nauthorization: Bearer ${token}\r\ncontent-length: 2\r\n\r\n{}`);
        },
      },
    });
    await Bun.sleep(100);
    process.emit("SIGTERM");
    await Bun.sleep(50);
    release();
    await Promise.race([got, Bun.sleep(2000)]);
    sock.end();
    expect(buf).toContain("HTTP/1.1 200");
    expect(buf.toLowerCase()).toContain("connection: close");
  });

  test("database lost after warm keeps serving from cache", async () => {
    const token = await seed();
    const g = await boot();
    await waitFor(async () => (await status(`${base(g)}/readyz`)) === 200);
    const broken = async (): Promise<never> => {
      throw new Error("db down");
    };
    store.getApp = broken;
    store.listApps = broken;
    store.tokensFor = broken;
    store.appendUsage = broken;
    const res = await fetch(`${base(g)}/web/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
    expect(res.status).toBe(200);
    expect(await status(`${base(g)}/readyz`)).toBe(200);
  });

  test("sigterm flips readiness, finishes in-flight stream, then exits", async () => {
    const token = await seed();
    const g = await boot({}, true);
    await waitFor(async () => (await status(`${base(g)}/readyz`)) === 200);
    const res = await fetch(`${base(g)}/web/v1/stream`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("message_start");

    process.emit("SIGTERM");
    // Readiness is false at once; the open connection can still ask.
    await Bun.sleep(100);
    expect(exits).toEqual([]);
    expect(await status(`${base(g)}/readyz`)).not.toBe(200);
    // No new connections.
    expect(await fetch(`${base(g)}/healthz`, { headers: { connection: "close" } }).then((r) => r.status, () => 0)).toBe(0);

    // The stream is still alive and completes.
    release();
    let rest = "";
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      rest += new TextDecoder().decode(r.value);
    }
    expect(rest).toContain("message_delta");
    await waitFor(() => exits.length > 0);
    expect(exits).toEqual([0]);
    // The ledger was flushed before exit.
    expect(store.written.length).toBe(1);
    expect(store.written[0]!.outputTokens).toBe(9);
  });
});

describe("metrics", () => {
  test("metrics expose counters without token or body content", async () => {
    const token = await seed();
    const g = await boot();
    await waitFor(async () => (await status(`${base(g)}/readyz`)) === 200);
    const secretBody = "PROMPT-SECRET-TEXT";
    const ok = await fetch(`${base(g)}/web/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ prompt: secretBody }) });
    expect(ok.status).toBe(200);
    await ok.text();
    await fetch(`${base(g)}/web/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${WRONG_TOKEN}` }, body: "{}" });
    await fetch(`${base(g)}/nosuchapp-${"x".repeat(20)}/v1/messages`, { method: "POST", body: "{}" });
    const text = await (await fetch(`${base(g)}/metrics`)).text();
    expect(text).toContain('ais_gateway_requests_total{app="web",provider="claude",identity="id1",status="ok"} 1');
    expect(text).toContain('ais_gateway_tokens_total{app="web",provider="claude",identity="id1",kind="output"} 4');
    expect(text).toContain('ais_gateway_rejections_total{app="web",reason="bad-token"} 1');
    expect(text).toContain('ais_gateway_rejections_total{app="-",reason="unknown-app"} 1');
    expect(text).toContain("ais_gateway_upstream_seconds_bucket");
    expect(text).toContain("ais_gateway_upstream_seconds_count 1");
    expect(text).toContain("ais_gateway_ledger_buffer_depth");
    expect(text).toContain("ais_gateway_ledger_dropped_total 0");
    expect(text).not.toContain(token);
    expect(text).not.toContain("aisg_");
    expect(text).not.toContain(secretBody);
    expect(text).not.toContain(UPSTREAM_CRED);
    expect(text).not.toContain("nosuchapp");
  });

  test("refresh counter and escaping", () => {
    const m = new PrometheusMetrics({ ledgerDepth: () => 3, ledgerDropped: () => 2 });
    m.refresh("claude", "refreshed");
    m.request({ app: 'we"b\n', provider: "claude", identity: "i", status: "ok", httpStatus: 200, latencyMs: 1500 });
    const text = m.render();
    expect(text).toContain('ais_gateway_refresh_total{provider="claude",outcome="refreshed"} 1');
    expect(text).toContain('app="we\\"b\\n"');
    expect(text).toContain("ais_gateway_ledger_buffer_depth 3");
    expect(text).toContain("ais_gateway_ledger_dropped_total 2");
    expect(text).toContain('ais_gateway_upstream_seconds_bucket{le="2.5"} 1');
    expect(text).toContain('ais_gateway_upstream_seconds_bucket{le="1"} 0');
  });
});

describe("owner alerts", () => {
  test("refresh failure alerts once until recovery", async () => {
    const seen: Array<{ kind: string; key: string }> = [];
    const alerter = createAlerter((a) => void seen.push({ kind: a.kind, key: a.key }));
    const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
    let mode: "fail" | "throw" | "ok" = "fail";
    const refresh = instrumentRefresh(
      (async (_tool: string, id: { name: string }) => {
        if (mode === "throw") throw new Error("boom");
        return { tool: "claude", identity: id.name, outcome: mode === "fail" ? "failed" : "refreshed", written: [], writeFailures: [] };
      }) as never,
      { metrics, alerter },
    );
    const id = { name: "id1", label: "id1", configDir: "/x" } as never;
    await refresh("claude", id, {});
    await refresh("claude", id, {});
    mode = "throw";
    await refresh("claude", id, {}).catch(() => undefined);
    expect(seen).toEqual([{ kind: "refresh-failed", key: "claude/id1" }]);
    mode = "ok";
    await refresh("claude", id, {});
    mode = "fail";
    await refresh("claude", id, {});
    await refresh("claude", { name: "id2", label: "id2", configDir: "/y" } as never, {});
    expect(seen.map((s) => s.key)).toEqual(["claude/id1", "claude/id1", "claude/id2"]);
    const text = metrics.render();
    expect(text).toContain('ais_gateway_refresh_total{provider="claude",outcome="refreshed"} 1');
    expect(text).toContain('ais_gateway_refresh_total{provider="claude",outcome="failed"} 5');
  });

  test("ledger drops alert once until the buffer recovers", async () => {
    const seen: string[] = [];
    const down = new MemoryGatewayStore();
    let fail = true;
    down.appendUsage = async () => {
      if (fail) throw new Error("db down");
    };
    const ledger = new LedgerBuffer(down, { max: 2, flushMs: 3_600_000 });
    const alerter = createAlerter((a) => void seen.push(a.kind));
    const { watchLedger } = await import("../../src/gateway/alerts.ts");
    const check = watchLedger(ledger, alerter);
    const row = (n: number): UsageRow => ({ ts: "2026-11-02T00:00:00.000Z", app: "a", provider: "claude", identity: "i", inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, status: "ok", httpStatus: 200, latencyMs: 1, streamed: false });
    for (let i = 0; i < 5; i++) ledger.push(row(i));
    check();
    ledger.push(row(9));
    check();
    expect(seen).toEqual(["ledger-drop"]);
    fail = false;
    await ledger.flush();
    check();
    for (let i = 0; i < 5; i++) ledger.push(row(i));
    check();
    expect(seen).toEqual(["ledger-drop", "ledger-drop"]);
    await ledger.close();
  });
});

describe("rejection reasons", () => {
  test("rejections carry cap, model, reserve and no-headroom reasons", async () => {
    const mk = async (name: string, over: Partial<GatewayApp>): Promise<string> => {
      await store.putApp({ ...app, name, ...over });
      const t = generateToken();
      await store.addToken({ app: name, prefix: t.prefix, hash: t.hash, createdAt: app.createdAt });
      return t.token;
    };
    const tModel = await mk("modelled", { models: ["allowed-model"] });
    const tCap = await mk("capped", { dailyTokens: 5 });
    const tRes = await mk("reserved", { reservePercent: 50 });
    const tPool = await mk("pooled", { target: { kind: "pool" }, reservePercent: 50 });
    await store.appendUsage([{ ts: new Date().toISOString(), app: "capped", provider: "claude", identity: "id1", inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, status: "ok", httpStatus: 200, latencyMs: 1, streamed: false }]);
    const g = await boot({ now: () => new Date(), usageFor: async (_p, i) => (i === "id1" ? { status: "live", maxUtilization: 99, capturedAt: new Date().toISOString() } : undefined) });
    await waitFor(async () => (await status(`${base(g)}/readyz`)) === 200);
    const post = (name: string, token: string, b: object) => fetch(`${base(g)}/${name}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(b) });
    expect((await post("modelled", tModel, { model: "other" })).status).toBe(403);
    expect((await post("capped", tCap, { model: "m" })).status).toBe(429);
    expect((await post("reserved", tRes, { model: "m" })).status).toBe(429);
    expect((await post("pooled", tPool, { model: "m" })).status).toBe(429);
    const text = await (await fetch(`${base(g)}/metrics`)).text();
    expect(text).toContain('ais_gateway_rejections_total{app="modelled",reason="model"} 1');
    expect(text).toContain('ais_gateway_rejections_total{app="capped",reason="daily_cap"} 1');
    expect(text).toContain('ais_gateway_rejections_total{app="reserved",reason="reserve"} 1');
    expect(text).toContain('ais_gateway_rejections_total{app="pooled",reason="no_headroom"} 1');
  });
});

describe("error shapes", () => {
  test("pre-auth errors use the app's provider shape when the app is known", async () => {
    await store.putApp(app);
    const deps = { store } as never;
    expect(await styleForPath(deps, "/web/v1/chat")).toBe("anthropic");
    expect(await styleForPath(deps, "/nope/v1/messages")).toBe("anthropic");
    expect(await styleForPath(deps, "/nope/v1/chat/completions")).toBe("openai");
  });

  test("starting-up 503 is OpenAI shaped when the app is unknown", async () => {
    migrateFails = true;
    const g = await boot();
    const res = await fetch(`${base(g)}/web/v1/chat/completions`, { method: "POST" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: { type?: string } }).error?.type).toBe("server_error");
  });
});

describe("alert recovery", () => {
  test("a 200 for the identity clears its alert, so a later failure alerts again", () => {
    const seen: string[] = [];
    const alerter = createAlerter((a) => void seen.push(a.key));
    alerter.raise("refresh-failed", "claude/id1", "x");
    alerter.raise("refresh-failed", "claude/id1", "x");
    const m = recoverOnSuccess(new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 }), alerter);
    m.request({ app: "a", provider: "claude", identity: "id1", status: "upstream_error", httpStatus: 401, latencyMs: 1 });
    alerter.raise("refresh-failed", "claude/id1", "x");
    m.request({ app: "a", provider: "claude", identity: "id1", status: "ok", httpStatus: 200, latencyMs: 1 });
    alerter.raise("refresh-failed", "claude/id1", "x");
    expect(seen).toEqual(["claude/id1", "claude/id1"]);
  });

  test("no-grant and skipped-revoked outcomes alert; a different token read clears", async () => {
    const seen: string[] = [];
    const alerter = createAlerter((a) => void seen.push(a.key));
    const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
    const failed = new Map<string, string>();
    let outcome = "no-grant";
    const refresh = instrumentRefresh((async (_t: string, id: { name: string }) => ({ tool: "codex", identity: id.name, outcome, written: [], writeFailures: [] })) as never, { metrics, alerter, failed });
    const id = { name: "c1", label: "c1", configDir: "/x" } as never;
    await refresh("codex", id, { expectedAccessToken: "old" });
    outcome = "skipped-revoked";
    await refresh("codex", id, { expectedAccessToken: "old" });
    expect(seen).toEqual(["codex/c1"]);
    expect(failed.get("codex/c1")).toBe("old");
    const { watchCredentialReads } = await import("../../src/gateway/serve.ts");
    const creds = watchCredentialReads({ get: async () => ({ identity: "c1", accessToken: "old" }), refreshAfter401: async () => ({ identity: "c1", accessToken: "old" }) } as never, alerter, failed);
    await creds.get("codex", "c1");
    await refresh("codex", id, { expectedAccessToken: "old" });
    expect(seen).toEqual(["codex/c1"]);
    const fresh = watchCredentialReads({ get: async () => ({ identity: "c1", accessToken: "new" }), refreshAfter401: async () => ({ identity: "c1", accessToken: "new" }) } as never, alerter, failed);
    await fresh.get("codex", "c1");
    await refresh("codex", id, { expectedAccessToken: "new" });
    expect(seen).toEqual(["codex/c1", "codex/c1"]);
  });
});

describe("canonical identity names", () => {
  test("an alias pin is recorded under the canonical name and its alert clears on a 2xx", async () => {
    await store.putApp({ ...app, target: { kind: "pin", identity: "alias1" } });
    const t = generateToken();
    await store.addToken({ app: "web", prefix: t.prefix, hash: t.hash, createdAt: app.createdAt });
    const seen: string[] = [];
    const alerter = createAlerter((a) => void seen.push(a.key));
    const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
    const ledger = new LedgerBuffer(store, { max: 100, flushMs: 3_600_000 });
    const gw = createGatewayApp({
      store,
      ledger,
      creds: { get: async () => ({ identity: "id1", accessToken: "t" }), refreshAfter401: async () => ({ identity: "id1", accessToken: "t" }) } as never,
      usageFor: async () => undefined,
      poolMembers: async () => [],
      canonical: async (_p, i) => (i === "alias1" ? "id1" : i),
      fetch: (async () => new Response("{}", { headers: { "content-type": "application/json" } })) as never,
      now: () => new Date(),
      metrics: recoverOnSuccess(metrics, alerter),
    });
    alerter.raise("refresh-failed", "claude/id1", "x");
    const res = await gw.request("http://gw.test/web/v1/messages", { method: "POST", headers: { authorization: `Bearer ${t.token}` }, body: "{}" });
    expect(res.status).toBe(200);
    await res.text();
    await ledger.flush();
    expect(store.written[0]!.identity).toBe("id1");
    expect(metrics.render()).toContain('identity="id1"');
    expect(metrics.render()).not.toContain("alias1");
    alerter.raise("refresh-failed", "claude/id1", "x");
    expect(seen).toEqual(["claude/id1", "claude/id1"]);
    await ledger.close();
  });
});

describe("usage prefill", () => {
  test("pools without an identity list prefill every current member", async () => {
    await store.putApp({ ...app, target: { kind: "pool" } });
    const fetched: string[] = [];
    const g = await boot({ poolMembers: async () => ["m1", "m2"], fetchUsage: async (_p, i) => (fetched.push(i), undefined) });
    await waitFor(async () => (await status(`${base(g)}/readyz`)) === 200);
    await waitFor(() => fetched.includes("m1") && fetched.includes("m2"));
  });
});

describe("canonical names in probes", () => {
  test("the unreadable-credential metric uses the canonical name", async () => {
    await store.putApp({ ...app, target: { kind: "pin", identity: "alias1" } });
    const g = await boot({
      canonical: async (_p, i) => (i === "alias1" ? "id1" : i),
      creds: {
        get: async (_p: string, i: string) => {
          if (i === "alias1") throw new Error("nope");
          return { identity: i, accessToken: "x" };
        },
        refreshAfter401: async () => ({ identity: "x", accessToken: "x" }),
      } as unknown as GatewayHooks["creds"],
    });
    await waitFor(async () => (await (await fetch(`${base(g)}/metrics`)).text()).includes("credential_unreadable_total{"));
    const text = await (await fetch(`${base(g)}/metrics`)).text();
    expect(text).toContain('identity="id1"');
    expect(text).not.toContain('identity="alias1"');
  });
});

describe("canonical resolver", () => {
  test("a failed registry read is cached briefly", async () => {
    const { createCanonicalResolver } = await import("../../src/gateway/serve.ts");
    let loads = 0;
    let t = 0;
    const resolve = createCanonicalResolver(async () => {
      loads += 1;
      throw new SyntaxError("corrupt");
    }, () => t);
    expect(await resolve("claude", "a")).toBe("a");
    expect(await resolve("claude", "a")).toBe("a");
    expect(await resolve("claude", "b")).toBe("b");
    expect(loads).toBe(1);
    t = 61_000;
    await resolve("claude", "a");
    expect(loads).toBe(2);
  });
});

describe("browser relay socket", () => {
  const wsOpen = (url: string): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("ws error"));
    });
  const closed = (ws: WebSocket): Promise<number> => new Promise((r) => (ws.onclose = (e) => r(e.code)));

  test("hello authenticates, a bad token closes 4401, and drain closes with 1012", async () => {
    await store.putBrowserBinding({ name: "work", target: { kind: "identity", identity: "id1" }, profileLabel: "w", state: "active", createdAt: app.createdAt });
    const t = generateToken();
    await store.addBrowserToken("work", t.prefix, t.hash);
    const g = await boot();
    await waitFor(() => g.ready());
    const url = `ws://127.0.0.1:${g.port}/browser/connect`;

    const bad = await wsOpen(url);
    const badClosed = closed(bad);
    bad.send(JSON.stringify({ t: "hello", token: WRONG_TOKEN, version: "1" }));
    expect(await badClosed).toBe(4401);

    const ws = await wsOpen(url);
    const welcome = new Promise<{ t: string }>((r) => (ws.onmessage = (e) => r(JSON.parse(String(e.data)) as { t: string })));
    ws.send(JSON.stringify({ t: "hello", token: t.token, version: "1" }));
    expect((await welcome).t).toBe("welcome");
    await waitFor(async () => (await (await fetch(`${base(g)}/metrics`)).text()).includes("ais_gateway_browsers_connected 1"));

    const drained = closed(ws);
    void g.stop();
    expect(await drained).toBe(1012);
  });
});
