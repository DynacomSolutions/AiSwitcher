import { expect, test } from "bun:test";
import { createAdminApp } from "../../src/gateway/admin.ts";
import { MemoryAutoResetStore } from "../../src/gateway/auto-reset-store.ts";
import {
  AUTO_RESET_PATH, AUTO_RESET_UNSUPPORTED, CODEX_AUTO_RESET_PATH, autoResetProviderPath, type AutoResetLastClaim, type AutoResetView,
} from "../../src/gateway/auto-reset-view.ts";
import { favouritesToken } from "../../src/gateway/favourites-token.ts";
import { instancesToken } from "../../src/gateway/instances-token.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { createApp } from "../../src/server/app.ts";

const ADMIN = "admin_SYNTHETIC_FIXTURE";
const CONSOLE = "console_SYNTHETIC_FIXTURE";
const STAMP = "2026-11-27T10:00:00.000Z";
const EXPIRY = "2026-12-01T10:00:00.000Z";
const CODEX_POOL = "fixture-codex-pool";
const CLAUDE_POOL = "claude-fixture-pool";
const MEMBER = "fixture-account";
const CLAUDE_MEMBER = "fixture-claude-account";

function fixture() {
  const store = new MemoryAutoResetStore();
  const pools = {
    codex: [{ name: CODEX_POOL, members: [MEMBER, "retired", "missing"] }],
    claude: [{ name: CLAUDE_POOL, members: [CLAUDE_MEMBER] }],
  };
  const app = createAdminApp({
    store: new MemoryGatewayStore(),
    adminToken: ADMIN,
    instances: { namespaces: [], log() {} },
    now: () => new Date(STAMP),
    autoReset: { store, pools: async (provider) => pools[provider] },
    spendCodexReset: async () => { throw new Error("settings must not spend credits"); },
    spendReset: async () => { throw new Error("settings must not spend grants"); },
  });
  const request = (path = AUTO_RESET_PATH, token = ADMIN, body?: object) => app.request(path, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { method: "PUT", body: JSON.stringify(body) } : {}),
  });
  return { store, app, request };
}

const claimFor = (provider: "codex" | "claude", pool: string, identity: string, key: string) => ({
  provider, eventKey: `fixture-event-${key}`, redeemRequestId: `fixture-redemption-${key}`,
  pool, identity, creditId: `credit_SYNTHETIC_FIXTURE_${key}`, startedAt: STAMP,
  creditExpiresAt: EXPIRY, usageEvidence: [], creditEvidence: { reason: "only_candidate" as const, inventories: [] },
});

test("the view lists every provider, with a pool setting and a not-supported row for providers without a reset API", async () => {
  const { request } = fixture();
  for (const token of ["", favouritesToken(ADMIN), instancesToken(ADMIN)]) {
    expect((await request(AUTO_RESET_PATH, token)).status).toBe(401);
    expect((await request(`${autoResetProviderPath("claude")}/pool`, token, { name: CLAUDE_POOL, enabled: true })).status).toBe(401);
  }
  const view = await (await request()).json() as AutoResetView;
  expect(view.providers.filter((row) => row.supported).map((row) => row.provider)).toEqual(["codex", "claude"]);
  expect(view.providers).toContainEqual({
    provider: "codex", supported: true, memberClaims: {},
    pools: [{ name: CODEX_POOL, enabled: false, members: [MEMBER, "retired", "missing"] }],
  });
  expect(view.providers).toContainEqual({
    provider: "claude", supported: true, memberClaims: {},
    pools: [{ name: CLAUDE_POOL, enabled: false, members: [CLAUDE_MEMBER] }],
  });
  const unsupported = view.providers.filter((row) => !row.supported);
  expect(unsupported.map((row) => row.provider)).toEqual([...AUTO_RESET_UNSUPPORTED]);
  for (const row of unsupported) expect(row).toMatchObject({ supported: false, reason: expect.stringContaining("no reset") });
  expect(JSON.stringify(view)).not.toContain("identities");
});

test("a pool of every supported provider can be set, and nothing else can", async () => {
  const { request, store } = fixture();
  const put = (provider: string, kind: string, name: string, enabled: unknown = true) =>
    request(`${autoResetProviderPath(provider)}/${kind}`, ADMIN, { name, enabled });
  expect((await put("codex", "pool", CODEX_POOL, "true")).status).toBe(400);
  expect((await put("codex", "member", MEMBER)).status).toBe(400);
  expect((await put("codex", "pool", CLAUDE_POOL)).status).toBe(404);
  expect((await put("claude", "pool", CODEX_POOL)).status).toBe(404);
  expect((await put("nothing", "pool", CODEX_POOL)).status).toBe(404);
  expect(await (await put("codex", "pool", CODEX_POOL)).json()).toEqual({ provider: "codex", name: CODEX_POOL, enabled: true });
  expect(await (await put("claude", "pool", CLAUDE_POOL)).json()).toEqual({ provider: "claude", name: CLAUDE_POOL, enabled: true });
  expect(await store.enabled("codex", CODEX_POOL)).toBe(true);
  expect(await store.enabled("claude", CLAUDE_POOL)).toBe(true);
  expect(await store.enabled("codex", CLAUDE_POOL)).toBe(false);
  expect(await (await put("claude", "pool", CLAUDE_POOL, false)).json()).toEqual({ provider: "claude", name: CLAUDE_POOL, enabled: false });
  expect(await store.enabled("claude", CLAUDE_POOL)).toBe(false);
});

test("a provider without a reset API cannot be set and has no toggle", async () => {
  const { request, store } = fixture();
  for (const provider of AUTO_RESET_UNSUPPORTED) {
    const response = await request(`${autoResetProviderPath(provider)}/pool`, ADMIN, { name: "any-pool", enabled: true });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringContaining("not supported") });
    expect(await (await request(autoResetProviderPath(provider))).json()).toMatchObject({ provider, supported: false });
    expect(await store.enabled(provider as never, "any-pool")).toBe(false);
  }
});

test("no identity setting can be set. The old identity path answers 410 and writes nothing", async () => {
  const { request, store } = fixture();
  for (const [provider, name] of [["codex", MEMBER], ["claude", CLAUDE_MEMBER], ["codex", CODEX_POOL]] as const) {
    for (const enabled of [true, false]) {
      const response = await request(`${autoResetProviderPath(provider)}/identity`, ADMIN, { name, enabled });
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ error: expect.stringContaining("pool setting only") });
    }
    expect(await store.enabled(provider, name)).toBe(false);
  }
  // The Codex path that shipped first is the Codex form of the generic path.
  expect(CODEX_AUTO_RESET_PATH).toBe(autoResetProviderPath("codex"));
  expect((await request(`${CODEX_AUTO_RESET_PATH}/identity`, ADMIN, { name: MEMBER, enabled: true })).status).toBe(410);
});

test("the old Codex path still lists and sets its pools", async () => {
  const { request, store } = fixture();
  expect(await (await request(CODEX_AUTO_RESET_PATH)).json()).toMatchObject({
    provider: "codex", supported: true, pools: [{ name: CODEX_POOL, enabled: false }],
  });
  expect((await request(`${CODEX_AUTO_RESET_PATH}/pool`, ADMIN, { name: CODEX_POOL, enabled: true })).status).toBe(200);
  expect(await store.enabled("codex", CODEX_POOL)).toBe(true);
});

test("history stays visible without provider reads. A member shows the last claim of its pool and has no setting", async () => {
  const { store, request } = fixture();
  await store.setEnabled("codex", CODEX_POOL, true);
  await store.setEnabled("claude", CLAUDE_POOL, true);
  const codex = claimFor("codex", CODEX_POOL, MEMBER, "codex");
  expect(await store.claim(codex)).toEqual({ kind: "created" });
  expect(await store.beginSpend(codex.redeemRequestId, MEMBER)).toBe(true);
  const pending = await (await request()).json() as AutoResetView;
  expect(pending.providers.find((row) => row.provider === "codex")).toMatchObject({
    memberClaims: { [MEMBER]: { status: "pending", spendPending: true } },
  });
  await store.recordReportedCredit(codex.redeemRequestId, codex.creditId, "reset");
  await store.finish(codex.eventKey, "reset", codex.creditId);
  const claude = claimFor("claude", CLAUDE_POOL, CLAUDE_MEMBER, "claude");
  expect(await store.claim(claude)).toEqual({ kind: "created" });
  await store.finish(claude.eventKey, "rejected");

  const view = await (await request()).json() as AutoResetView;
  const lastClaim = (pool: string, identity: string, status: AutoResetLastClaim["status"]): AutoResetLastClaim => ({ pool, identity, startedAt: STAMP, creditExpiresAt: EXPIRY, status });
  expect(view.providers.find((row) => row.provider === "codex")).toEqual({
    provider: "codex", supported: true,
    pools: [{ name: CODEX_POOL, enabled: true, members: [MEMBER, "retired", "missing"], lastClaim: lastClaim(CODEX_POOL, MEMBER, "reset") }],
    memberClaims: { [MEMBER]: lastClaim(CODEX_POOL, MEMBER, "reset") },
  });
  expect(view.providers.find((row) => row.provider === "claude")).toEqual({
    provider: "claude", supported: true,
    pools: [{ name: CLAUDE_POOL, enabled: true, members: [CLAUDE_MEMBER], lastClaim: lastClaim(CLAUDE_POOL, CLAUDE_MEMBER, "rejected") }],
    memberClaims: { [CLAUDE_MEMBER]: lastClaim(CLAUDE_POOL, CLAUDE_MEMBER, "rejected") },
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
  const view = await (await consoleApp.request(`/api${AUTO_RESET_PATH}`, { headers })).json() as { configured: boolean; providers: unknown[] };
  expect(view.configured).toBe(true);
  expect(view.providers).toHaveLength(2 + AUTO_RESET_UNSUPPORTED.length);
  const put = (csrf: string, provider: string, kind: string, name: string) => consoleApp.request(`/api/limits/${provider}/auto-reset/${kind}`, {
    method: "PUT",
    headers: { ...headers, "x-ais-console": csrf, "content-type": "application/json" },
    body: JSON.stringify({ name, enabled: true }),
  });
  expect((await put("", "claude", "pool", CLAUDE_POOL)).status).toBe(403);
  expect((await put("1", "claude", "pool", "unknown")).status).toBe(404);
  expect((await put("1", "nothing", "pool", CLAUDE_POOL)).status).toBe(404);
  expect(await (await put("1", "claude", "pool", CLAUDE_POOL)).json()).toEqual({ provider: "claude", name: CLAUDE_POOL, enabled: true });
  expect(await store.enabled("claude", CLAUDE_POOL)).toBe(true);
  // An identity form, or any other scope, is gone. The console answers 410 itself and sends nothing to the gateway.
  for (const kind of ["identity", "member"]) {
    const gone = await put("1", "codex", kind, MEMBER);
    expect(gone.status).toBe(410);
    expect(await store.enabled("codex", MEMBER)).toBe(false);
  }
  expect(calls).toEqual([
    { method: "GET", path: AUTO_RESET_PATH, authorised: true },
    { method: "PUT", path: `${autoResetProviderPath("claude")}/pool`, authorised: true },
    { method: "PUT", path: `${autoResetProviderPath("claude")}/pool`, authorised: true },
  ]);
});
