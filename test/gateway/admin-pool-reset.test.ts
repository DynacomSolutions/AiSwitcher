import { expect, test } from "bun:test";
import { createAdminApp } from "../../src/gateway/admin.ts";
import { favouritesToken } from "../../src/gateway/favourites-token.ts";
import { poolLimitsPath, POOL_THRESHOLDS_PATH, type PoolResetReview } from "../../src/gateway/pool-reset-view.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { createApp } from "../../src/server/app.ts";
import { readPoolThresholds } from "../../src/server/gateway-pool-reset.ts";

const ADMIN = "admin-SYNTHETIC_FIXTURE";
const CONSOLE = "console-SYNTHETIC_FIXTURE";
const pool = "sample pool";
const path = poolLimitsPath("codex", pool);
const candidate = {
  identity: "sample-account",
  creditId: "credit-SYNTHETIC_FIXTURE",
  creditExpiresAt: Date.parse("2026-11-30T12:00:00Z"),
  weeklyReset: Date.parse("2026-12-01T12:00:00Z"),
};
const confirmation = { candidate, redeemRequestId: crypto.randomUUID() };
const review: PoolResetReview = {
  tool: "codex", pool, percent: 93, complete: true, observedAt: 1_000,
  members: [candidate.identity], availability: "available", candidate,
};

function fixture(options: {
  gatewayMs?: number;
  consoleMs?: number;
  activationEnabled?: boolean;
  confirmWait?: Promise<void>;
  confirmStarted?: () => void;
  stallFetch?: boolean;
  actors?: Array<string | undefined>;
} = {}) {
  let spendCalls = 0;
  let forwarded = 0;
  let invalidateCalls = 0;
  let loseResponse = false;
  const admin = createAdminApp({
    store: new MemoryGatewayStore(),
    adminToken: ADMIN,
    now: () => new Date("2026-01-01T00:00:00Z"),
    poolReset: {
      thresholds: async () => [{ tool: "codex", pool, observedAt: 1_000, percent: 93, complete: true }],
      review: async (tool, name) => tool === "codex" && name === pool ? review : undefined,
      activationEnabled: options.activationEnabled,
      confirmTimeoutMs: options.gatewayMs,
      confirm: async (name, selection, signal, _deadlineAt, actor) => {
        options.actors?.push(actor);
        expect(name).toBe(pool);
        expect(selection).toEqual(confirmation);
        options.confirmStarted?.();
        await options.confirmWait;
        signal.throwIfAborted();
        spendCalls++;
        return { status: "confirmed" };
      },
    },
  });
  const gateway = {
    confirmTimeoutMs: options.consoleMs,
    adminConfig: async () => ({ url: "https://gateway.example", token: ADMIN }),
    fetch: (async (url, init) => {
      forwarded++;
      if (options.stallFetch) await new Promise(() => {});
      const result = await admin.request(String(url), init);
      if (loseResponse && init?.method === "POST") throw new Error("Synthetic transport error");
      return result;
    }) as typeof fetch,
  };
  const consoleApp = createApp({
    token: CONSOLE,
    port: 47129,
    startedAt: Date.now(),
    gatewayAutoReset: gateway,
    invalidateLimits: () => { invalidateCalls++; },
  });
  return { admin, consoleApp, gateway, state: () => ({ spendCalls, forwarded, invalidateCalls }), lose: () => { loseResponse = true; } };
}

test("gateway requires full admin auth and checks the explicit selection before spending", async () => {
  const { admin, state } = fixture();
  for (const authorization of ["", `Bearer ${favouritesToken(ADMIN)}`]) {
    for (const route of [path, POOL_THRESHOLDS_PATH]) {
      expect((await admin.request(route, { headers: { authorization } })).status).toBe(401);
    }
  }
  const headers = { authorization: `Bearer ${ADMIN}` };
  const reading = await admin.request(path, { headers });
  expect(reading.headers.get("Cache-Control")).toBe("no-store");
  expect(await reading.json()).toEqual(review);
  expect((await admin.request(path, { headers, method: "POST", body: JSON.stringify({ candidate }) })).status).toBe(400);
  expect((await admin.request(poolLimitsPath("claude", pool), { headers, method: "POST", body: JSON.stringify(confirmation) })).status).toBe(404);
  expect(state().spendCalls).toBe(0);
});

test("the rollout gate pauses pool alerts and blocks redemption", async () => {
  const { admin, state } = fixture({ activationEnabled: false });
  const headers = { authorization: `Bearer ${ADMIN}` };
  expect(await (await admin.request(POOL_THRESHOLDS_PATH, { headers })).json()).toEqual({ pools: [] });
  const response = await admin.request(path, { headers });
  expect(await response.json()).toEqual({ ...review, availability: "unavailable", candidate: undefined });
  const post = await admin.request(path, { method: "POST", headers, body: JSON.stringify(confirmation) });
  expect(post.status).toBe(409);
  expect(state().spendCalls).toBe(0);
});

test("console uses the admin bearer and requires a CSRF header for one POST", async () => {
  const { consoleApp, gateway, state, lose } = fixture();
  const headers = { Host: "localhost:47129", Authorization: `Bearer ${CONSOLE}` };
  expect(await readPoolThresholds(gateway)).toEqual([{ tool: "codex", pool, observedAt: 1_000, percent: 93, complete: true }]);
  const response = await consoleApp.request(`/api${path}`, { headers });
  expect(await response.json()).toEqual(review);
  const post = { method: "POST", body: JSON.stringify(confirmation) };
  expect((await consoleApp.request(`/api${path}`, { headers, ...post })).status).toBe(403);
  expect(state()).toEqual({ spendCalls: 0, forwarded: 2, invalidateCalls: 0 });
  const valid = { ...post, headers: { ...headers, "X-AIS-Console": "1" } };
  const success = await consoleApp.request(`/api${path}`, valid);
  expect(await success.json()).toEqual({ status: "confirmed" });
  expect(state()).toEqual({ spendCalls: 1, forwarded: 3, invalidateCalls: 1 });
  lose();
  expect(await (await consoleApp.request(`/api${path}`, valid)).json()).toEqual({ status: "pending" });
  expect(state()).toEqual({ spendCalls: 2, forwarded: 4, invalidateCalls: 2 });
});

test("console rejects encoded path separators before using the gateway bearer", async () => {
  const { consoleApp, state } = fixture();
  const headers = { Host: "localhost:47129", Authorization: `Bearer ${CONSOLE}` };
  expect((await consoleApp.request("/api/limits/pools/codex/%2Fsample", { headers })).status).toBe(404);
  expect((await consoleApp.request("/api/limits/pools/unknown/sample", { headers })).status).toBe(404);
  expect(state().forwarded).toBe(0);
});

const consolePost = {
  method: "POST",
  headers: { Host: "localhost:47129", Authorization: `Bearer ${CONSOLE}`, "X-AIS-Console": "1" },
  body: JSON.stringify(confirmation),
};

test("cancelling the Console request stops gateway confirmation before spend", async () => {
  const started = Promise.withResolvers<void>();
  const preflight = Promise.withResolvers<void>();
  const caller = new AbortController();
  const { consoleApp, state } = fixture({ confirmWait: preflight.promise, confirmStarted: started.resolve });
  const request = consoleApp.request(`/api${path}`, { ...consolePost, signal: caller.signal });
  await started.promise;
  caller.abort();
  preflight.resolve();
  const response = await request;
  expect(await response.json()).toEqual({ status: "pending" });
  expect(state()).toEqual({ spendCalls: 0, forwarded: 1, invalidateCalls: 1 });
});

test("gateway returns pending even if confirmation preflight ignores the deadline", async () => {
  const preflight = Promise.withResolvers<void>();
  const { consoleApp, state } = fixture({ gatewayMs: 15, consoleMs: 500, confirmWait: preflight.promise });
  const response = await consoleApp.request(`/api${path}`, consolePost);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "pending" });
  preflight.resolve();
  await Bun.sleep(0);
  expect(state()).toEqual({ spendCalls: 0, forwarded: 1, invalidateCalls: 1 });
});

test("console returns pending and invalidates once when the gateway does not respond", async () => {
  const { consoleApp, state } = fixture({ consoleMs: 15, stallFetch: true });
  const response = await consoleApp.request(`/api${path}`, consolePost);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "pending" });
  expect(state()).toEqual({ spendCalls: 0, forwarded: 1, invalidateCalls: 1 });
});

test("the pool route names its actor for the reset log, with the console name when it is sent", async () => {
  const actors: Array<string | undefined> = [];
  const { admin, consoleApp } = fixture({ actors });
  const headers = { authorization: `Bearer ${ADMIN}` };
  const body = JSON.stringify(confirmation);
  expect((await admin.request(path, { method: "POST", headers, body })).status).toBe(200);
  expect((await admin.request(path, { method: "POST", headers: { ...headers, "x-ais-actor": "console" }, body })).status).toBe(200);
  expect((await admin.request(path, { method: "POST", headers: { ...headers, "x-ais-actor": "bad actor; drop" }, body })).status).toBe(200);
  const viaConsole = await consoleApp.request(`/api${path}`, {
    method: "POST", body, headers: { Host: "localhost:47129", Authorization: `Bearer ${CONSOLE}`, "X-AIS-Console": "1" },
  });
  expect(viaConsole.status).toBe(200);
  expect(actors).toEqual(["pool-route", "pool-route:console", "pool-route", "pool-route:console"]);
});
