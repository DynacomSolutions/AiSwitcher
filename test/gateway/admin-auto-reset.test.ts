import { expect, test } from "bun:test";
import { createAdminApp } from "../../src/gateway/admin.ts";
import { MemoryAutoResetStore } from "../../src/gateway/auto-reset-store.ts";
import { CODEX_AUTO_RESET_PATH as BASE } from "../../src/gateway/auto-reset-view.ts";
import { favouritesToken } from "../../src/gateway/favourites-token.ts";
import { instancesToken } from "../../src/gateway/instances-token.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { createApp } from "../../src/server/app.ts";

const ADMIN = "admin_SYNTHETIC_FIXTURE";
const CONSOLE = "console_SYNTHETIC_FIXTURE";
const STAMP = "2026-11-27T10:00:00.000Z";
const EXPIRY = "2026-12-01T10:00:00.000Z";
const GROUP = "fixture-pool";
const MEMBER = "fixture-account";

function fixture() {
  const store = new MemoryAutoResetStore();
  const app = createAdminApp({
    store: new MemoryGatewayStore(),
    adminToken: ADMIN,
    instances: { namespaces: [], log() {} },
    now: () => new Date(STAMP),
    autoReset: { store, pools: async () => [{ name: GROUP, members: [MEMBER] }] },
    spendCodexReset: async () => { throw new Error("settings must not spend credits"); },
  });
  const request = (scope = "", token = ADMIN, body?: object) => app.request(BASE + scope, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { method: "PUT", body: JSON.stringify(body) } : {}),
  });
  return { store, app, request };
}

test("Codex auto reset requires full admin and accepts only pool settings", async () => {
  const { request } = fixture();
  for (const token of ["", favouritesToken(ADMIN), instancesToken(ADMIN)]) {
    expect((await request("", token)).status).toBe(401);
    expect((await request("/pool", token, { name: GROUP, enabled: true })).status).toBe(401);
  }
  expect(await (await request()).json()).toEqual({
    pools: [{ name: GROUP, enabled: false, members: [MEMBER] }],
  });
  const put = (kind: string, name: string, enabled: unknown = true) => request(`/${kind}`, ADMIN, { name, enabled });
  expect((await put("pool", GROUP, "true")).status).toBe(400);
  expect((await put("pool", "fixture-unknown-pool")).status).toBe(404);
  expect((await put("identity", MEMBER)).status).toBe(404);
  expect(await (await put("pool", GROUP)).json()).toEqual({ name: GROUP, enabled: true });
  expect(await (await put("pool", GROUP, false)).json()).toEqual({ name: GROUP, enabled: false });
});

test("Codex auto reset history remains visible without provider reads and excludes claim identifiers", async () => {
  const { store, request } = fixture();
  await store.setEnabled(GROUP, true);
  expect(await store.claim({
    eventKey: "fixture-event", redeemRequestId: "fixture-redemption",
    pool: GROUP, identity: MEMBER, creditId: "RateLimitResetCredit_SYNTHETIC_FIXTURE", startedAt: STAMP,
    creditExpiresAt: EXPIRY, usageEvidence: [], creditEvidence: { reason: "only_candidate", inventories: [] },
  })).toEqual({ kind: "created" });
  expect(await store.beginSpend("fixture-redemption", MEMBER)).toBe(true);
  const pending = await (await request()).json();
  expect(pending).toMatchObject({ pools: [{ name: GROUP, lastClaim: { identity: MEMBER, status: "pending", spendPending: true } }] });
  await store.recordReportedCredit("fixture-redemption", "RateLimitResetCredit_SYNTHETIC_FIXTURE", "reset");
  await store.finish("fixture-event", "reset", "RateLimitResetCredit_SYNTHETIC_FIXTURE");
  await store.setEnabled(GROUP, false);
  const lastClaim = { pool: GROUP, identity: MEMBER, startedAt: STAMP, creditExpiresAt: EXPIRY, status: "reset" };
  expect(await (await request()).json()).toEqual({
    pools: [{ name: GROUP, enabled: false, members: [MEMBER], lastClaim }],
  });
});

test("console forwards settings through its admin connection and guards mutations", async () => {
  const { app, store } = fixture();
  const calls: Array<{ path: string; method: string; authorised: boolean }> = [];
  const consoleApp = createApp({
    port: 47129, startedAt: Date.now(), token: CONSOLE,
    gatewayAutoReset: {
      adminConfig: async () => ({ url: "http://admin.test", token: ADMIN }),
      fetch: (async (url: string, init: RequestInit) => {
        const { pathname } = new URL(url);
        calls.push({ path: pathname, method: init.method!, authorised: new Headers(init.headers).get("authorization") === `Bearer ${ADMIN}` });
        return app.request(pathname, init);
      }) as typeof fetch,
    },
  });
  const headers = { Host: "localhost", authorization: `Bearer ${CONSOLE}` };
  expect(await (await consoleApp.request(`/api${BASE}`, { headers })).json()).toEqual({
    configured: true, pools: [{ name: GROUP, enabled: false, members: [MEMBER] }],
  });
  const put = (csrf: string, name = GROUP, scope = "pool") => consoleApp.request(`/api${BASE}/${scope}`, {
    method: "PUT",
    headers: { ...headers, "x-ais-console": csrf, "content-type": "application/json" },
    body: JSON.stringify({ name, enabled: true }),
  });
  expect((await put("")).status).toBe(403);
  expect((await put("1", MEMBER, "identity")).status).toBe(404);
  expect((await put("1", "unknown")).status).toBe(404);
  expect(await (await put("1")).json()).toEqual({ name: GROUP, enabled: true });
  expect(await store.enabled(GROUP)).toBe(true);
  expect(calls).toEqual([
    { method: "GET", path: BASE, authorised: true },
    { method: "PUT", path: `${BASE}/pool`, authorised: true },
    { method: "PUT", path: `${BASE}/pool`, authorised: true },
  ]);
});
