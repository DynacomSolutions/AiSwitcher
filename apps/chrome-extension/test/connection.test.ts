import { describe, expect, test } from "bun:test";
import type { CallRequest, CallResult } from "../../../src/browser/protocol.ts";
import { Connection } from "../src/background/connection.ts";
import type { ConnectionStatus, Scheduler, SocketLike } from "../src/background/connection.ts";

class FakeSocket implements SocketLike {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.closed = true; }
  serve(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

function setup(paused = false) {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean; interval: boolean }> = [];
  const scheduler: Scheduler = {
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false, interval: false }; timers.push(t); return t; },
    clearTimeout: h => { (h as { cleared: boolean }).cleared = true; },
    setInterval: (fn, ms) => { const t = { fn, ms, cleared: false, interval: true }; timers.push(t); return t; },
    clearInterval: h => { (h as { cleared: boolean }).cleared = true; },
  };
  const calls: CallRequest[] = [];
  const statuses: ConnectionStatus[] = [];
  let signedOut = 0;
  const conn = new Connection({
    createSocket: url => { const s = new FakeSocket(url); sockets.push(s); return s; },
    version: "1",
    isPaused: () => paused,
    onCall: async (req): Promise<CallResult> => { calls.push(req); return { id: req.id, ok: true, content: [] }; },
    onAbort: () => {},
    onStatus: s => statuses.push(s),
    onSignedOut: () => { signedOut++; },
    scheduler,
  });
  const req = (id: string) => ({ t: "call", req: { id, session: { id: "s", identity: "i", label: "l" }, tool: "wait", args: { seconds: 0 } } });
  return { conn, sockets, timers, calls, statuses, req, signedOut: () => signedOut };
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe("connection", () => {
  test("hello carries token, version and pause state; refuses insecure URLs", () => {
    const t = setup(true);
    expect(() => t.conn.start("ws://gw.example.test", "tok")).toThrow();
    t.conn.start("wss://gw.example.test", "tok");
    expect(t.sockets[0]!.url).toBe("wss://gw.example.test/browser/connect");
    t.sockets[0]!.onopen!();
    expect(t.sockets[0]!.sent[0]).toEqual({ t: "hello", token: "tok", version: "1", paused: true });
  });

  test("call before welcome is ignored; after welcome it runs and replies", async () => {
    const t = setup();
    t.conn.start("wss://gw.example.test", "tok");
    const s = t.sockets[0]!;
    s.onopen!();
    s.serve(t.req("early"));
    await flush();
    expect(t.calls).toHaveLength(0);
    s.serve({ t: "welcome", binding: "b", target: { kind: "identity", identity: "i" } });
    s.serve(t.req("ok"));
    await flush();
    expect(t.calls.map(c => c.id)).toEqual(["ok"]);
    expect(s.sent.at(-1)).toEqual({ t: "result", result: { id: "ok", ok: true, content: [] } });
  });

  test("pings every 20 s after welcome", () => {
    const t = setup();
    t.conn.start("wss://gw.example.test", "tok");
    t.sockets[0]!.onopen!();
    t.sockets[0]!.serve({ t: "welcome", binding: "b", target: { kind: "identity", identity: "i" } });
    const ping = t.timers.find(x => x.interval)!;
    expect(ping.ms).toBe(20_000);
    ping.fn();
    expect(t.sockets[0]!.sent.at(-1)).toEqual({ t: "ping" });
  });

  test("1012 reconnects with doubling backoff capped at 30 s", () => {
    const t = setup();
    t.conn.start("wss://gw.example.test", "tok");
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      t.sockets.at(-1)!.onclose!({ code: 1012 });
      const timer = t.timers.filter(x => !x.interval).at(-1)!;
      delays.push(timer.ms);
      timer.fn();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  test("4401 signs out and does not reconnect; 4409 shows replaced and does not reconnect", () => {
    const a = setup();
    a.conn.start("wss://gw.example.test", "tok");
    a.sockets[0]!.onclose!({ code: 4401 });
    expect(a.signedOut()).toBe(1);
    expect(a.conn.status).toBe("signed_out");
    expect(a.timers.filter(x => !x.interval)).toHaveLength(0);

    const b = setup();
    b.conn.start("wss://gw.example.test", "tok");
    b.sockets[0]!.onclose!({ code: 4409 });
    expect(b.conn.status).toBe("replaced");
    expect(b.timers.filter(x => !x.interval)).toHaveLength(0);
    expect(b.signedOut()).toBe(0);
  });
});
