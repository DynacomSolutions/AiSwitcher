import { describe, expect, test } from "bun:test";
import { createGatewayApp, type GatewayDeps } from "../../src/gateway/app.ts";
import { LedgerBuffer } from "../../src/gateway/ledger-buffer.ts";
import { PrometheusMetrics } from "../../src/gateway/metrics.ts";
import { DEFAULT_RUNAWAY, RunawayTracker, runawayFromEnv, type RunawayObservation } from "../../src/gateway/runaway.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { generateToken } from "../../src/gateway/tokens.ts";
import type { GatewayApp } from "../../src/gateway/types.ts";

const SESSION = "11111111-2222-3333-4444-555555555555";
const obs = (over: Partial<RunawayObservation> = {}): RunawayObservation => ({ sessionKey: SESSION, provider: "claude", app: "web", identity: "id1", tokens: 10, toolErrors: undefined, served: true, ...over });

function clocked(cfg: ConstructorParameters<typeof RunawayTracker>[0]) {
  const clock = { ms: Date.UTC(2026, 10, 28, 10, 0, 0) };
  return { clock, t: new RunawayTracker(cfg, () => clock.ms) };
}
const line = (t: RunawayTracker, name: string): string => t.render().find((l) => l.startsWith(name)) ?? "";

describe("runaway tracker", () => {
  test("a synthetic request loop raises the gauge and the counter once", () => {
    const { clock, t } = clocked({ requests: 5, tokens: 0, toolErrorStreak: 0 });
    const events = [];
    for (let i = 0; i < 8; i++) {
      clock.ms += 1_000;
      const e = t.observe(obs());
      if (e) events.push(e);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionKey: SESSION, provider: "claude", identity: "id1", reasons: ["requests"], requests: 5 });
    expect(line(t, "ais_gateway_runaway_sessions")).toBe("ais_gateway_runaway_sessions 1");
    expect(line(t, "ais_gateway_runaway_events_total")).toBe('ais_gateway_runaway_events_total{provider="claude"} 1');
  });

  test("a token burst fires on the token limit only", () => {
    const { t } = clocked({ requests: 0, tokens: 1_000, toolErrorStreak: 0 });
    expect(t.observe(obs({ tokens: 600 }))).toBeUndefined();
    const e = t.observe(obs({ tokens: 600 }));
    expect(e?.reasons).toEqual(["tokens"]);
    expect(e?.tokens).toBe(1_200);
  });

  test("a run of tool errors fires, and a clean request resets the streak", () => {
    const { t } = clocked({ requests: 0, tokens: 0, toolErrorStreak: 3 });
    expect(t.observe(obs({ toolErrors: 1 }))).toBeUndefined();
    expect(t.observe(obs({ toolErrors: 2 }))).toBeUndefined();
    expect(t.observe(obs({ toolErrors: 0 }))).toBeUndefined();
    expect(t.observe(obs({ toolErrors: 1 }))).toBeUndefined();
    expect(t.observe(obs({ toolErrors: 1 }))).toBeUndefined();
    expect(t.observe(obs({ toolErrors: 1 }))?.reasons).toEqual(["tool_errors"]);
    // A request that cannot tell, or a failed one, leaves the streak alone.
    expect(t.observe(obs({ toolErrors: undefined }))).toBeUndefined();
    expect(t.runawaySessions()).toBe(1);
    t.observe(obs({ toolErrors: 0 }));
    expect(t.runawaySessions()).toBe(0);
  });

  test("normal traffic spread over the window stays quiet, and the gauge clears when the window passes", () => {
    const { clock, t } = clocked({ requests: 10, tokens: 0, toolErrorStreak: 0 });
    for (let i = 0; i < 40; i++) {
      clock.ms += 120_000; // one request every two minutes: five in a ten minute window
      expect(t.observe(obs())).toBeUndefined();
    }
    expect(t.runawaySessions()).toBe(0);
    for (let i = 0; i < 10; i++) t.observe(obs());
    expect(t.runawaySessions()).toBe(1);
    clock.ms += DEFAULT_RUNAWAY.windowMs + 1_000;
    expect(t.runawaySessions()).toBe(0);
    // Back under the limit and over it again counts as a second event.
    for (let i = 0; i < 10; i++) t.observe(obs());
    expect(line(t, "ais_gateway_runaway_events_total")).toBe('ais_gateway_runaway_events_total{provider="claude"} 2');
  });

  test("memory is bounded: the oldest session is evicted and idle sessions expire", () => {
    const { clock, t } = clocked({ maxSessions: 3, requests: 0, tokens: 0, toolErrorStreak: 0 });
    for (let i = 0; i < 5; i++) t.observe(obs({ sessionKey: `session-key-${i}` }));
    expect(t.size).toBe(3);
    expect(line(t, "ais_gateway_runaway_evicted_total")).toBe("ais_gateway_runaway_evicted_total 2");
    clock.ms += DEFAULT_RUNAWAY.windowMs + 1_000;
    t.observe(obs({ sessionKey: "session-key-new" }));
    expect(t.size).toBe(1);
  });

  test("sessions are kept apart by key and provider; a request with no key is ignored", () => {
    const { t } = clocked({ requests: 3, tokens: 0, toolErrorStreak: 0 });
    for (let i = 0; i < 2; i++) {
      t.observe(obs({ sessionKey: "session-key-a" }));
      t.observe(obs({ sessionKey: "session-key-b" }));
      t.observe(obs({ sessionKey: "session-key-a", provider: "codex" }));
      t.observe(obs({ sessionKey: undefined }));
    }
    expect(t.runawaySessions()).toBe(0);
    expect(t.size).toBe(3);
  });

  test("series carry no session, app or identity label", () => {
    const { t } = clocked({ requests: 1, tokens: 0, toolErrorStreak: 0 });
    t.observe(obs());
    const text = t.render(["claude", "codex"]).join("\n");
    expect(text).not.toContain(SESSION);
    expect(text).not.toContain("web");
    expect(text).not.toContain("id1");
    expect(text).toContain('ais_gateway_runaway_events_total{provider="codex"} 0');
  });

  test("a disabled tracker does nothing", () => {
    const { t } = clocked({ enabled: false, requests: 1 });
    expect(t.observe(obs())).toBeUndefined();
    expect(t.size).toBe(0);
  });

  test("environment limits: defaults, overrides, zero turns a check off, bad values fall back", () => {
    expect(runawayFromEnv({})).toEqual(DEFAULT_RUNAWAY);
    expect(runawayFromEnv({ AIS_GATEWAY_RUNAWAY_REQUESTS: "50", AIS_GATEWAY_RUNAWAY_TOKENS: "0", AIS_GATEWAY_RUNAWAY_WINDOW_S: "60", AIS_GATEWAY_RUNAWAY_TOOL_ERROR_STREAK: "x" })).toMatchObject({
      requests: 50,
      tokens: 0,
      windowMs: 60_000,
      toolErrorStreak: DEFAULT_RUNAWAY.toolErrorStreak,
    });
    expect(runawayFromEnv({ AIS_GATEWAY_RUNAWAY: "off" }).enabled).toBe(false);
    expect(runawayFromEnv({ AIS_GATEWAY_RUNAWAY_WINDOW_S: "0", AIS_GATEWAY_RUNAWAY_MAX_SESSIONS: "0" })).toMatchObject({ windowMs: DEFAULT_RUNAWAY.windowMs, maxSessions: DEFAULT_RUNAWAY.maxSessions });
  });
});

describe("runaway through the proxy", () => {
  test("a loop of requests from one session fires the gauge, the counter and one log line, and no request is refused", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(JSON.stringify({ type: "message", model: "claude-sonnet-4-5", usage: { input_tokens: 12, output_tokens: 34 } }), { headers: { "content-type": "application/json" } }),
    });
    try {
      const store = new MemoryGatewayStore();
      const ledger = new LedgerBuffer(store, { max: 1000, flushMs: 3_600_000 });
      const metrics = new PrometheusMetrics({ ledgerDepth: () => ledger.depth, ledgerDropped: () => ledger.dropped });
      const runaway = new RunawayTracker({ requests: 5, tokens: 0, toolErrorStreak: 0 });
      metrics.sections.push(() => runaway.render(["claude"]));
      const logs: string[] = [];
      const now = new Date("2026-11-28T10:00:00.000Z");
      const app: GatewayApp = { name: "loop", owner: "o", namespace: "ns", provider: "claude", style: "anthropic", target: { kind: "pin", identity: "id1" }, state: "active", createdAt: now.toISOString() };
      await store.putApp(app);
      const tok = generateToken();
      await store.addToken({ app: app.name, prefix: tok.prefix, hash: tok.hash, createdAt: now.toISOString() });
      const deps: GatewayDeps = {
        store,
        ledger,
        runaway,
        metrics,
        creds: { get: async (_p: string, identity: string) => ({ identity, accessToken: `t-${identity}` }), refreshAfter401: async () => ({ identity: "id1", accessToken: "x" }) } as unknown as GatewayDeps["creds"],
        usageFor: async () => undefined,
        poolMembers: async () => ["id1"],
        fetch: ((input: string | URL | Request, init?: RequestInit) => {
          const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
          return fetch(`http://127.0.0.1:${upstream.port}${u.pathname}${u.search}`, init);
        }) as typeof fetch,
        now: () => now,
        log: (l) => logs.push(l),
      };
      const gw = createGatewayApp(deps);
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) {
        const res = await gw.request("http://gw.test/loop/v1/messages", {
          method: "POST",
          headers: { authorization: `Bearer ${tok.token}`, "x-claude-code-session-id": SESSION, "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1, messages: [{ role: "user", content: "CANARY_PROMPT_TEXT" }] }),
        });
        await res.arrayBuffer();
        statuses.push(res.status);
      }
      expect(statuses.every((s) => s === 200)).toBe(true);
      const text = metrics.render();
      expect(text).toContain("ais_gateway_runaway_sessions 1");
      expect(text).toContain('ais_gateway_runaway_events_total{provider="claude"} 1');
      expect(text).not.toContain(SESSION);
      const runLines = logs.filter((l) => l.includes('"event":"runaway_session"'));
      expect(runLines).toHaveLength(1);
      const parsed = JSON.parse(runLines[0]!);
      expect(parsed).toMatchObject({ session: SESSION, identity: "id1", provider: "claude", reasons: ["requests"] });
      expect(runLines[0]).not.toContain("CANARY_PROMPT_TEXT");
      await ledger.close();
    } finally {
      await upstream.stop(true);
    }
  });
});
