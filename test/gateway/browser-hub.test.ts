import { describe, expect, test } from "bun:test";
import type { CallRequest } from "../../src/browser/protocol.ts";
import type { BrowserBinding } from "../../src/browser/types.ts";
import { BrowserHub, type HubSocket } from "../../src/gateway/browser/hub.ts";
import { PrometheusMetrics } from "../../src/gateway/metrics.ts";

class FakeWs implements HubSocket {
  sent: Array<Record<string, unknown>> = [];
  sendResult: unknown = undefined;
  closed?: { code?: number; reason?: string };
  send(d: string) {
    this.sent.push(JSON.parse(d) as Record<string, unknown>);
    return this.sendResult;
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
}

const binding = (name: string): BrowserBinding => ({ name, target: { kind: "identity", identity: "id1" }, profileLabel: "p", state: "active", createdAt: "2026-11-04T00:00:00.000Z" });
const req = (id = "c1", tool: CallRequest["tool"] = "navigate"): CallRequest => ({ id, session: { id: "s1", identity: "id1", label: "" }, tool, args: { url: "https://example.test" } });
const tokens: Record<string, BrowserBinding> = { good: binding("work") };
const mk = (over = {}) => new BrowserHub({ authToken: async (t) => tokens[t], ...over });
async function hello(hub: BrowserHub, ws: FakeWs, token = "good", paused = false) {
  hub.open(ws);
  await hub.message(ws, JSON.stringify({ t: "hello", token, version: "1", paused }));
}

describe("BrowserHub", () => {
  test("hello with a good token welcomes and registers the binding", async () => {
    const hub = mk();
    const ws = new FakeWs();
    await hello(hub, ws);
    expect(ws.sent[0]).toMatchObject({ t: "welcome", binding: "work" });
    expect(hub.connected().map((b) => b.name)).toEqual(["work"]);
  });

  test("hello with a revoked or unknown token closes 4401", async () => {
    const hub = mk();
    const ws = new FakeWs();
    await hello(hub, ws, "revoked");
    expect(ws.closed?.code).toBe(4401);
    expect(hub.connected()).toEqual([]);
  });

  test("anything before hello is rejected", async () => {
    const hub = mk();
    const ws = new FakeWs();
    hub.open(ws);
    await hub.message(ws, JSON.stringify({ t: "ping" }));
    expect(ws.closed?.code).toBe(4401);
  });

  test("no hello within the timeout closes the socket", async () => {
    const hub = mk({ helloTimeoutMs: 20 });
    const ws = new FakeWs();
    hub.open(ws);
    await Bun.sleep(60);
    expect(ws.closed?.code).toBe(4408);
  });

  test("a silent socket is dropped", async () => {
    const hub = mk({ silenceTimeoutMs: 20 });
    const ws = new FakeWs();
    await hello(hub, ws);
    await Bun.sleep(60);
    expect(ws.closed?.code).toBe(4408);
    expect(hub.connected()).toEqual([]);
  });

  test("ping is answered with pong", async () => {
    const hub = mk();
    const ws = new FakeWs();
    await hello(hub, ws);
    await hub.message(ws, JSON.stringify({ t: "ping" }));
    expect(ws.sent.at(-1)).toEqual({ t: "pong" });
  });

  test("a call is forwarded and resolved by the result", async () => {
    const hub = mk();
    const ws = new FakeWs();
    await hello(hub, ws);
    const p = hub.call("work", req(), 1000);
    expect(ws.sent.at(-1)).toMatchObject({ t: "call", req: { id: "c1", tool: "navigate" } });
    await hub.message(ws, JSON.stringify({ t: "result", result: { id: "c1", ok: true, content: [{ type: "text", text: "done" }] } }));
    expect(await p).toMatchObject({ ok: true });
  });

  test("a result from another socket is ignored", async () => {
    const hub = mk({});
    const a = new FakeWs();
    await hello(hub, a);
    const p = hub.call("work", req(), 50);
    const b = new FakeWs();
    hub.attach(b, binding("other"));
    await hub.message(b, JSON.stringify({ t: "result", result: { id: "c1", ok: true, content: [] } }));
    expect(await p).toMatchObject({ ok: false, error: "timeout" });
  });

  test("disconnect mid-call gives browser_disconnected within 1 s", async () => {
    const hub = mk();
    const ws = new FakeWs();
    await hello(hub, ws);
    const t0 = Date.now();
    const p = hub.call("work", req(), 30_000);
    hub.detach(ws);
    expect(await p).toMatchObject({ ok: false, error: "browser_disconnected" });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("no result gives timeout and sends abort", async () => {
    const hub = mk();
    const ws = new FakeWs();
    await hello(hub, ws);
    expect(await hub.call("work", req(), 30)).toMatchObject({ ok: false, error: "timeout" });
    expect(ws.sent.at(-1)).toEqual({ t: "abort", id: "c1" });
  });

  test("paused state answers paused_by_user without forwarding", async () => {
    const hub = mk();
    const ws = new FakeWs();
    await hello(hub, ws);
    await hub.message(ws, JSON.stringify({ t: "state", paused: true }));
    const before = ws.sent.length;
    expect(await hub.call("work", req(), 1000)).toMatchObject({ ok: false, error: "paused_by_user" });
    expect(ws.sent.length).toBe(before);
    await hub.message(ws, JSON.stringify({ t: "state", paused: false }));
    const p = hub.call("work", req("c2"), 20);
    expect(ws.sent.length).toBe(before + 1);
    await p;
  });

  test("a new hello for the same binding replaces the old socket with 4409", async () => {
    const hub = mk();
    const a = new FakeWs();
    const b = new FakeWs();
    await hello(hub, a);
    const p = hub.call("work", req(), 30_000);
    await hello(hub, b);
    expect(a.closed?.code).toBe(4409);
    expect(await p).toMatchObject({ error: "browser_disconnected" });
    // the old socket's late close must not unregister the new one
    hub.detach(a);
    expect(hub.connected()).toHaveLength(1);
  });

  test("call to a binding that is not connected is no_browser", async () => {
    expect(await mk().call("work", req(), 100)).toMatchObject({ error: "no_browser" });
  });

  test("closeAll(1012) closes every socket", async () => {
    const hub = mk();
    const a = new FakeWs();
    const b = new FakeWs();
    await hello(hub, a);
    hub.open(b);
    hub.closeAll(1012);
    expect(a.closed?.code).toBe(1012);
    expect(b.closed?.code).toBe(1012);
    expect(hub.connected()).toEqual([]);
  });

  test("a failed send (0 or -1) settles browser_disconnected at once", async () => {
    for (const code of [0, -1]) {
      const hub = mk();
      const ws = new FakeWs();
      await hello(hub, ws);
      ws.sendResult = code;
      expect(await hub.call("work", req(`c${code}`), 60_000)).toMatchObject({ ok: false, error: "browser_disconnected" });
    }
  });

  test("a caller abort settles as timeout, not internal", async () => {
    const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
    const hub = mk({ metrics });
    const ws = new FakeWs();
    await hello(hub, ws);
    const p = hub.call("work", req("a1"), 60_000);
    hub.abort("a1");
    expect(await p).toMatchObject({ ok: false, error: "timeout" });
    const text = metrics.render();
    expect(text).toContain('outcome="timeout"');
    expect(text).not.toContain('outcome="internal"');
  });

  test("metrics count calls by tool and outcome, never content", async () => {
    const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
    const hub = mk({ metrics });
    metrics.browserGauges = { connected: () => hub.connected().length, sessions: () => hub.activeSessions() };
    const ws = new FakeWs();
    await hello(hub, ws);
    const p = hub.call("work", req("c1", "screenshot"), 1000);
    await hub.message(ws, JSON.stringify({ t: "result", result: { id: "c1", ok: true, content: [{ type: "text", text: "SECRET-PAGE-TEXT" }] } }));
    await p;
    await hub.call("work", req("c2", "navigate"), 10);
    metrics.browserPairing();
    const text = metrics.render();
    expect(text).toContain('ais_gateway_browser_calls_total{tool="screenshot",outcome="ok"} 1');
    expect(text).toContain('ais_gateway_browser_calls_total{tool="navigate",outcome="timeout"} 1');
    expect(text).toContain("ais_gateway_browser_call_seconds_count 2");
    expect(text).toContain("ais_gateway_browsers_connected 1");
    expect(text).toContain("ais_gateway_browser_sessions_active 1");
    expect(text).toContain("ais_gateway_browser_pairings_total 1");
    expect(text).not.toContain("SECRET-PAGE-TEXT");
  });

  test("malformed results are ignored; odd error codes become internal and metrics still render", async () => {
    const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
    const hub = mk({ metrics });
    const ws = new FakeWs();
    await hello(hub, ws);
    const p = hub.call("work", req("c1"), 1000);
    await hub.message(ws, JSON.stringify({ t: "result", result: { id: "c1", ok: true, content: [{ type: "text" }] } }));
    await hub.message(ws, JSON.stringify({ t: "result", result: { id: "c1", ok: "yes" } }));
    await hub.message(ws, JSON.stringify({ t: "result", result: { id: "c1", ok: false, error: 123, message: "x".repeat(5000) } }));
    const r = await p;
    expect(r).toMatchObject({ ok: false, error: "internal" });
    expect((r as { message: string }).message.length).toBe(1000);
    const p2 = hub.call("work", req("c2"), 1000);
    await hub.message(ws, JSON.stringify({ t: "result", result: { id: "c2", ok: false, error: "leaked page text", message: "m" } }));
    expect(await p2).toMatchObject({ error: "internal" });
    const text = metrics.render();
    expect(text).toContain('outcome="internal"');
    expect(text).not.toContain("leaked page text");
    metrics.browserCall("not-a-tool", "free text", 0);
    expect(metrics.render()).not.toContain("free text");
  });

  test("tab_hidden passes the sanitiser and is a metrics outcome", async () => {
    const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
    const hub = mk({ metrics });
    const ws = new FakeWs();
    await hello(hub, ws);
    const p = hub.call("work", req("c1", "screenshot"), 1000);
    await hub.message(ws, JSON.stringify({ t: "result", result: { id: "c1", ok: false, error: "tab_hidden", message: "Chrome did not render tab 5" } }));
    expect(await p).toMatchObject({ ok: false, error: "tab_hidden" });
    expect(metrics.render()).toContain('ais_gateway_browser_calls_total{tool="screenshot",outcome="tab_hidden"} 1');
  });

  test("messages during auth are ignored and a second hello cannot double-attach", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hub = new BrowserHub({ authToken: async () => (await gate, binding("work")) });
    const ws = new FakeWs();
    hub.open(ws);
    const h1 = hub.message(ws, JSON.stringify({ t: "hello", token: "a", version: "1", paused: false }));
    await hub.message(ws, JSON.stringify({ t: "hello", token: "b", version: "1", paused: false }));
    await hub.message(ws, JSON.stringify({ t: "ping" }));
    expect(ws.closed).toBeUndefined();
    expect(ws.sent).toEqual([]);
    release();
    await h1;
    expect(ws.sent).toHaveLength(1);
    expect(hub.connected()).toHaveLength(1);
    hub.detach(ws);
    expect(hub.connected()).toEqual([]);
  });

  test("hello timer keeps running while auth hangs", async () => {
    const hub = new BrowserHub({ authToken: () => new Promise(() => {}), helloTimeoutMs: 20 });
    const ws = new FakeWs();
    hub.open(ws);
    void hub.message(ws, JSON.stringify({ t: "hello", token: "a", version: "1", paused: false }));
    await Bun.sleep(60);
    expect(ws.closed?.code).toBe(4408);
  });

  test("hello with paused true starts the connection paused", async () => {
    const hub = mk();
    const ws = new FakeWs();
    await hello(hub, ws, "good", true);
    expect(await hub.call("work", req(), 100)).toMatchObject({ error: "paused_by_user" });
  });

  test("abort sends abort to the extension and settles the call", async () => {
    const hub = mk();
    const ws = new FakeWs();
    await hello(hub, ws);
    const p = hub.call("work", req(), 30_000);
    hub.abort("c1");
    expect(ws.sent.at(-1)).toEqual({ t: "abort", id: "c1" });
    expect(await p).toMatchObject({ ok: false });
  });
});
