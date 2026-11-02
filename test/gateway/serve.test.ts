import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAlerter } from "../../src/gateway/alerts.ts";
import { instrumentRefresh, startGateway, type GatewayHooks } from "../../src/gateway/serve.ts";
import { PrometheusMetrics } from "../../src/gateway/metrics.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { LedgerBuffer } from "../../src/gateway/ledger-buffer.ts";
import { generateToken } from "../../src/gateway/tokens.ts";
import type { GatewayApp, UsageRow } from "../../src/gateway/types.ts";

const ADMIN = "adm-test-value-0001";
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

  test("unreadable credential keeps the gateway unready", async () => {
    await seed();
    credFails = true;
    const g = await boot();
    await Bun.sleep(80);
    expect(await status(`${base(g)}/readyz`)).toBe(503);
    credFails = false;
    await waitFor(async () => (await status(`${base(g)}/readyz`)) === 200);
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
