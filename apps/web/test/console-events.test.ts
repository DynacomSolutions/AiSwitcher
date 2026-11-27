import { expect, test } from "bun:test";
import { listenToConsoleEvents } from "../src/lib/console-events.ts";

const encoder = new TextEncoder();
const READY = "event: ready\ndata: {}\n\n";
const HEARTBEAT = "event: heartbeat\ndata: {}\n\n";

function fakeFetch(fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(fn, { preconnect: fetch.preconnect });
}

function eventStream(chunks: Uint8Array[], signal?: AbortSignal | null): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (!signal) controller.close();
      else signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

test("the stream sends the current bearer and parses split lines and UTF-8 without replaying the first load", async () => {
  const windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window");
  let token = "SYNTHETIC_FIXTURE_first_token";
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: { getItem: () => token } },
  });
  const stop = new AbortController();
  const requests: Array<{ url: unknown; auth: string | null; accept: string | null }> = [];
  const ready: boolean[] = [];
  const changes: string[][] = [];
  let disconnects = 0;
  try {
    await listenToConsoleEvents({
      onReady: (reconnected) => ready.push(reconnected),
      onDisconnect() {
        disconnects += 1;
        token = "SYNTHETIC_FIXTURE_second_token";
      },
      onChange(topics) {
        changes.push(topics);
        if (changes.length === 2) stop.abort();
      },
    }, stop.signal, {
      retryMs: 1,
      fetch: fakeFetch(async (url, init) => {
        const headers = new Headers(init?.headers);
        requests.push({ url, auth: headers.get("Authorization"), accept: headers.get("Accept") });
        expect(init).toMatchObject({ redirect: "error", cache: "no-store" });
        if (requests.length === 1) {
          const wire = encoder.encode('event: ready\r\ndata: {}\r\n\r\n' + READY
            + ': ignored comment\r\r' + 'event: change\rdata: ["usage",\rdata: "test-é"]\r\r'
            + 'event: change\ndata: ["incomplete"]');
          return eventStream(Array.from(wire, (byte) => Uint8Array.of(byte)));
        }
        return eventStream([encoder.encode(READY + 'event: change\ndata: ["limits"]\n\n')], init?.signal);
      }),
    });
  } finally {
    stop.abort();
    if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore);
    else Reflect.deleteProperty(globalThis, "window");
  }
  expect(requests).toEqual([
    { url: "/api/events", auth: "Bearer SYNTHETIC_FIXTURE_first_token", accept: "text/event-stream" },
    { url: "/api/events", auth: "Bearer SYNTHETIC_FIXTURE_second_token", accept: "text/event-stream" },
  ]);
  expect(ready).toEqual([false, true]);
  expect(changes).toEqual([["usage", "test-é"], ["limits"]]);
  expect(disconnects).toBe(1);
});

test("HTTP errors and short connections back off to a cap, then a heartbeat resets the delay", async () => {
  const stop = new AbortController();
  const delays: number[] = [];
  const ready: boolean[] = [];
  let attempts = 0;
  await listenToConsoleEvents({
    onReady: (reconnected) => ready.push(reconnected),
    onDisconnect: () => {},
    onChange: () => {},
  }, stop.signal, {
    wait: async (ms) => {
      delays.push(ms);
      if (delays.length === 6) stop.abort();
    },
    fetch: fakeFetch(async () => {
      attempts += 1;
      if (attempts === 1) return new Response("", { status: 401 });
      if (attempts === 2) return Response.json({ htmlFallback: true });
      if (attempts === 6) return eventStream([encoder.encode(READY + HEARTBEAT)]);
      return eventStream([encoder.encode(READY)]);
    }),
    retryMs: 500,
    maxRetryMs: 2_000,
  });
  expect(delays).toEqual([500, 1_000, 2_000, 2_000, 2_000, 500]);
  expect(ready).toEqual([true, true, true, true]);
  expect(attempts).toBe(6);
});

test("a silent live stream expires and an outer abort stops the new connection", async () => {
  const stop = new AbortController();
  const signals: AbortSignal[] = [];
  const ready: boolean[] = [];
  let disconnects = 0;
  await listenToConsoleEvents({
    onReady(reconnected) {
      ready.push(reconnected);
      if (reconnected) stop.abort();
    },
    onDisconnect: () => { disconnects += 1; },
    onChange: () => {},
  }, stop.signal, {
    retryMs: 1,
    heartbeatTimeoutMs: 25,
    fetch: fakeFetch(async (_url, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Missing stream signal");
      signals.push(signal);
      return eventStream([encoder.encode(READY)], signal);
    }),
  });
  expect(ready).toEqual([false, true]);
  expect(disconnects).toBe(1);
  expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
});

test("an oversized incomplete frame closes its body before the backoff", async () => {
  const stop = new AbortController();
  let cancelled = false;
  await listenToConsoleEvents({
    onReady: () => { throw new Error("Incomplete frame must never be applied"); },
    onDisconnect: () => stop.abort(),
    onChange: () => {},
  }, stop.signal, {
    fetch: fakeFetch(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode("data: " + "x".repeat(8_193))); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } })),
  });
  expect(cancelled).toBe(true);
});

test("a planned rollover reconnects at once without a loss signal, then treats a failed reconnect as a loss", async () => {
  const stop = new AbortController();
  const states: Array<boolean | "lost"> = [];
  const waits: number[] = [];
  let attempts = 0;
  await listenToConsoleEvents({
    onReady(reconnected) {
      states.push(reconnected);
      if (states.length === 3) stop.abort();
    },
    onDisconnect: () => states.push("lost"),
    onChange: () => {},
  }, stop.signal, {
    wait: async (ms) => { waits.push(ms); },
    fetch: fakeFetch(async (_url, init) => {
      attempts += 1;
      if (attempts === 1) {
        // The client must release the original connection even before the peer closes its body.
        return eventStream([encoder.encode(READY + 'event: rollover\ndata: {}\n\n')], init?.signal);
      }
      if (attempts === 2) return new Response(null, { status: 503 });
      return eventStream([encoder.encode(READY)], init?.signal);
    }),
  });
  expect(attempts).toBe(3);
  expect(states).toEqual([false, "lost", true]);
  expect(waits).toEqual([500]);
});
