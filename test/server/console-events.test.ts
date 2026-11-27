import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../../src/server/app.ts";
import { ConsoleEvents } from "../../src/server/console-events.ts";
import { HttpError } from "../../src/server/types.ts";
import * as workers from "../../src/server/workers.ts";

const headers = { Host: "localhost", Authorization: "Bearer SYNTHETIC_FIXTURE_console_token" };
const credentials = { token: "SYNTHETIC_FIXTURE_console_token", port: 47129, startedAt: 0, requireBearerToken: true };
const decoder = new TextDecoder();
const changeFrame = (...topics: string[]) => `event: change\ndata: ${JSON.stringify(topics)}\n\n`;

async function readFrame(reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">): Promise<string> {
  const result = await reader.read();
  if (result.done) throw new Error("Console stream closed");
  return decoder.decode(result.value);
}

test("Console event stream uses the existing Host and bearer guards", async () => {
  const app = createApp(credentials);
  expect((await app.request("/api/events", { headers: { Host: "localhost" } })).status).toBe(401);
  expect((await app.request("/api/events", { headers: { ...headers, Host: "example.invalid" } })).status).toBe(403);
});

test("the observer shares reads, ignores transport timestamps and sends changed topics to every stream", async () => {
  let now = 1_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const monotonic = spyOn(performance, "now").mockImplementation(() => now);
  let usedPercent = 95;
  let usage = { pending: true, results: [] as number[] };
  let claim = "pending";
  let calls = 0;
  const limits = async () => ({ results: [{ windows: [{ usedPercent }], credits: usedPercent === 95 ? 2 : 1 }], fetchedAt: new Date(++calls).toISOString(), cached: calls > 1 });
  const unchanged = { load: () => ({}), intervalMs: 1_000 };
  const stop = new AbortController();
  const events = new ConsoleEvents({
    limits: { load: limits, intervalMs: 1_000 },
    usage: { load: () => ({ ...usage, generatedAt: new Date(now).toISOString() }), intervalMs: 60_000, pendingIntervalMs: 1_000 },
    "pools-usage": unchanged,
    "gateway-usage": unchanged,
    "usage-projects": unchanged,
    "auto-reset": { load: () => ({ lastClaim: { status: claim } }), intervalMs: 1_000 },
  }, stop.signal);
  const app = new Hono().get("/events", (c) => events.stream(c));
  const response = await app.request("/events");
  const a = response.body!.getReader();
  const b = (await app.request("/events")).body!.getReader();
  try {
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(await readFrame(a)).toBe("event: ready\ndata: {}\n\n");
    expect(await readFrame(b)).toBe("event: ready\ndata: {}\n\n");
    await Promise.all([events.read("limits"), events.read("limits")]);
    expect(calls).toBe(1);

    // An unchanged pass sends only a heartbeat, even though envelope timestamps and the cache flag move.
    now += 15_001;
    expect(await readFrame(a)).toBe("event: heartbeat\ndata: {}\n\n");
    expect(await readFrame(b)).toBe("event: heartbeat\ndata: {}\n\n");
    await events.read("limits");
    expect(calls).toBe(2);

    usedPercent = 20;
    usage = { pending: false, results: [4] };
    claim = "reset";
    now += 2_000;
    for (const reader of [a, b]) {
      const topics = new Set<string>();
      while (topics.size < 3) {
        const frame = await readFrame(reader);
        const data = /^event: change\ndata: (.+)/.exec(frame)?.[1];
        if (data) for (const topic of JSON.parse(data) as string[]) topics.add(topic);
      }
      expect(topics).toEqual(new Set(["limits", "usage", "auto-reset"]));
    }
    expect(calls).toBe(3);
    // Ending the lifetime closes both live response bodies so daemon drain can finish.
    stop.abort();
    expect(await a.read()).toEqual({ done: true, value: undefined });
    expect(await b.read()).toEqual({ done: true, value: undefined });
  } finally {
    stop.abort();
    await Promise.all([a.cancel(), b.cancel()]);
    clock.mockRestore();
    monotonic.mockRestore();
  }
}, 8_000);

test("manual reset results and rule writes immediately invalidate their shared JSON reads", async () => {
  let pendingCredits = 2;
  let reads = 0;
  let spends = 0;
  let invalidations = 0;
  let enabled = false;
  const stop = new AbortController();
  const scan = spyOn(workers, "runScanIsolated").mockImplementation(async <T>() => {
    reads += 1;
    return { ok: true, payload: { pendingCredits, fetchedAt: new Date().toISOString() } as T };
  });
  const settingsFetch = Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") {
      enabled = (JSON.parse(String(init.body)) as { enabled: boolean }).enabled;
      return Response.json({ name: "fixture", enabled });
    }
    return Response.json({ pools: [], identities: [{ name: "fixture", enabled }] });
  }, { preconnect: fetch.preconnect });
  const app = createApp({
    ...credentials,
    consoleEventSignal: stop.signal,
    gatewayLimits: async () => ({ configured: false, rows: [] }),
    gatewayModelUsage: async () => ({ configured: true, rows: [] }),
    gatewayUsageHistory: async () => ({ configured: false, rows: [] }),
    gatewayUsage: async () => ({ configured: false, rows: [] }),
    usageProjects: () => undefined,
    poolsUsage: async () => ({ todayKey: "", weekStartKey: "", pools: [], gateway: {
      today: { configured: false, rows: [] }, week: { configured: false, rows: [] },
    } }),
    gatewayAutoReset: {
      adminConfig: async () => ({ url: "https://example.invalid", token: "SYNTHETIC_FIXTURE_admin_token" }),
      fetch: settingsFetch,
    },
    invalidateLimits: () => { invalidations += 1; },
    codexUseReset: async (identity) => {
      spends += 1;
      pendingCredits -= 1;
      if (spends === 2) throw new HttpError(502, "ambiguous reset");
      return { identity, result: "reset", windowsReset: 1 };
    },
  });
  const stream = await app.request("/api/events", { headers });
  const reader = stream.body!.getReader();
  const mutationHeaders = { ...headers, "X-AIS-Console": "1", "content-type": "application/json" };
  const settings = "/api/limits/codex/auto-reset";
  const reset = "/api/limits/codex/fixture/resets/use";
  const consume = () => app.request(reset, {
    method: "POST", headers: mutationHeaders, body: JSON.stringify({ redeemRequestId: crypto.randomUUID() }),
  });
  const get = async (path: string) => (await app.request(path, { headers })).json();
  try {
    expect(await readFrame(reader)).toBe("event: ready\ndata: {}\n\n");
    expect(await get("/api/limits?maxAge=45")).toMatchObject({ pendingCredits: 2 });
    expect(reads).toBe(1);
    expect(await get(settings)).toMatchObject({ identities: [{ enabled: false }] });
    const rule = await app.request(`${settings}/identity`, {
      method: "PUT", headers: mutationHeaders, body: JSON.stringify({ name: "fixture", enabled: true }),
    });
    expect(rule.status).toBe(200);
    expect(await readFrame(reader)).toBe(changeFrame("auto-reset"));
    expect(await get(settings)).toMatchObject({ identities: [{ enabled: true }] });

    expect((await consume()).status).toBe(200);
    expect(await readFrame(reader)).toBe(changeFrame("limits", "pools-usage"));
    expect(await get("/api/limits")).toMatchObject({ pendingCredits: 1 });
    expect((await consume()).status).toBe(502);
    expect(await readFrame(reader)).toBe(changeFrame("limits", "pools-usage"));
    expect(await get("/api/limits")).toMatchObject({ pendingCredits: 0 });
    expect({ spends, invalidations, reads }).toEqual({ spends: 2, invalidations: 2, reads: 3 });
  } finally {
    stop.abort();
    await reader.cancel();
    scan.mockRestore();
  }
}, 5_000);

test("rollover closes the response body and the next connection reuses reads that are still fresh", async () => {
  const clock = spyOn(performance, "now");
  let time = 0;
  clock.mockImplementation(() => time);
  let calls = 0;
  const source = { load: () => { calls += 1; return {}; }, intervalMs: 45_000 };
  const events = new ConsoleEvents({
    limits: source,
    usage: source,
    "pools-usage": source,
    "gateway-usage": source,
    "usage-projects": source,
    "auto-reset": source,
  });
  const app = new Hono().get("/events", (c) => events.stream(c));
  const initial = (await app.request("/events")).body!.getReader();
  try {
    expect(await readFrame(initial)).toBe("event: ready\ndata: {}\n\n");
    const firstPass = await events.read("limits");
    expect(firstPass).toMatchObject({});
    expect(calls).toBe(6);
    time += 25_000;
    expect(await readFrame(initial)).toBe("event: rollover\ndata: {}\n\n");
    expect((await initial.read()).done).toBe(true);

    const next = (await app.request("/events")).body!.getReader();
    try {
      expect(await readFrame(next)).toBe("event: ready\ndata: {}\n\n");
      expect(await events.read("limits")).toMatchObject({ cached: true });
      expect(calls).toBe(6);
    } finally {
      await next.cancel();
    }
  } finally {
    await initial.cancel();
    clock.mockRestore();
  }
}, 5_000);

test("a mutation during a read shares one replacement and no caller receives the old result", async () => {
  const previous = Promise.withResolvers<{ version: number }>();
  let calls = 0;
  const unchanged = { load: () => ({}), intervalMs: 45_000 };
  const events = new ConsoleEvents({
    limits: { load: () => ++calls === 1 ? previous.promise : { version: 2 }, intervalMs: 45_000 },
    usage: unchanged,
    "pools-usage": unchanged,
    "gateway-usage": unchanged,
    "usage-projects": unchanged,
    "auto-reset": unchanged,
  });
  const before = events.read("limits");
  await Promise.resolve();
  expect(calls).toBe(1);
  events.invalidate("limits");
  const a = events.read("limits");
  const b = events.read("limits");
  await Promise.resolve();
  expect(calls).toBe(1);
  previous.resolve({ version: 1 });
  const snapshots = await Promise.all([before, a, b]);
  expect(snapshots).toMatchObject([{ version: 2 }, { version: 2 }, { version: 2 }]);
  expect(calls).toBe(2);
});
