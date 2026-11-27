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
    canonical: async (_, name) => name === "fixture-alias" ? MEMBER : name,
    identityState: async (provider, name) => {
      if (provider !== "codex") return "missing";
      if (name === MEMBER || name === "fixture-alias" || name === "fixture-detached") return "ok";
      if (name === GROUP) return "pool";
      if (name === "retired") return "retired";
      return "missing";
    },
    autoReset: { store, pools: async () => [{ name: GROUP, members: [MEMBER, "retired", "missing"] }] },
    spendCodexReset: async () => { throw new Error("settings must not spend credits"); },
  });
  const request = (scope = "", token = ADMIN, body?: object) => app.request(BASE + scope, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { method: "PUT", body: JSON.stringify(body) } : {}),
  });
  return { store, app, request };
}

test("Codex auto reset requires full admin and canonical scopes", async () => {
  const { request } = fixture();
  for (const token of ["", favouritesToken(ADMIN), instancesToken(ADMIN)]) {
    expect((await request("", token)).status).toBe(401);
    expect((await request("/pool", token, { name: GROUP, enabled: true })).status).toBe(401);
  }
  expect(await (await request()).json()).toMatchObject({
    pools: [{ name: GROUP, enabled: false }],
    identities: [{ name: MEMBER, enabled: false }],
  });
  const put = (kind: string, name: string, enabled: unknown = true) => request(`/${kind}`, ADMIN, { name, enabled });
  expect((await put("pool", GROUP, "true")).status).toBe(400);
  expect((await put("member", MEMBER)).status).toBe(400);
  expect((await put("pool", "fixture-non-codex-pool")).status).toBe(404);
  for (const name of [GROUP, "fixture-alias", "retired", "missing"]) {
    expect((await put("identity", name)).status).toBe(404);
  }
  expect(await (await put("pool", GROUP)).json()).toEqual({ name: GROUP, enabled: true });
  expect(await (await put("identity", MEMBER)).json()).toEqual({ name: MEMBER, enabled: true });
  expect(await (await put("identity", MEMBER, false)).json()).toEqual({ name: MEMBER, enabled: false });
  expect((await put("identity", "fixture-detached", false)).status).toBe(200);
});

test("Codex auto reset history remains visible without provider reads and excludes claim identifiers", async () => {
  const { store, request } = fixture();
  await store.setEnabled("pool", GROUP, true);
  await store.setEnabled("identity", MEMBER, true);
  expect(await store.claim({
    eventKey: "fixture-event", redeemRequestId: "fixture-redemption",
    pool: GROUP, identity: MEMBER, creditId: "RateLimitResetCredit_SYNTHETIC_FIXTURE", startedAt: STAMP,
    creditExpiresAt: EXPIRY, usageEvidence: [], creditEvidence: { reason: "only_candidate", inventories: [] },
  })).toEqual({ kind: "created" });
  await store.finish("fixture-event", "reset", "RateLimitResetCredit_SYNTHETIC_FIXTURE");
  await store.setEnabled("identity", MEMBER, false);
  const lastClaim = { pool: GROUP, identity: MEMBER, startedAt: STAMP, creditExpiresAt: EXPIRY, status: "reset" };
  expect(await (await request()).json()).toEqual({
    pools: [{ name: GROUP, enabled: true, members: [MEMBER, "retired", "missing"], lastClaim }],
    identities: [{ name: MEMBER, enabled: false, lastClaim }],
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
  expect(await (await consoleApp.request(`/api${BASE}`, { headers })).json()).toMatchObject({ configured: true, identities: [{ name: MEMBER, enabled: false }] });
  const put = (csrf: string, name = MEMBER) => consoleApp.request(`/api${BASE}/identity`, {
    method: "PUT",
    headers: { ...headers, "x-ais-console": csrf, "content-type": "application/json" },
    body: JSON.stringify({ name, enabled: true }),
  });
  expect((await put("")).status).toBe(403);
  expect((await put("1", "unknown")).status).toBe(404);
  expect(await (await put("1")).json()).toEqual({ name: MEMBER, enabled: true });
  expect(await store.enabled("identity", MEMBER)).toBe(true);
  expect(calls).toEqual([
    { method: "GET", path: BASE, authorised: true },
    { method: "PUT", path: `${BASE}/identity`, authorised: true },
    { method: "PUT", path: `${BASE}/identity`, authorised: true },
  ]);
});
