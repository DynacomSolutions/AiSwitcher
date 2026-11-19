import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/server/app.ts";
import type { RefreshStatusDto } from "../../src/server/auth-refresh.ts";
import { buildRenewalRows, loadGatewayRenewal, type GatewayRenewalView } from "../../src/server/gateway-renewal.ts";

const ADMIN = { url: "http://admin.example.test", token: "admin-token-SYNTHETIC_FIXTURE" };

const LOGINS = [
  {
    provider: "claude", identity: "alpha", renewedBy: "gateway",
    lastRefreshAt: "2026-11-19T04:00:00.000Z", lastRefreshReplica: "gw-0", lastError: null,
    expiresAt: "2026-11-19T12:00:00.000Z", nextRefreshAt: "2026-11-19T08:00:00.000Z", revoked: false,
  },
  {
    provider: "claude", identity: "beta", renewedBy: "gateway",
    lastRefreshAt: null, lastRefreshReplica: null,
    lastError: { at: "2026-11-19T03:00:00.000Z", code: "invalid_grant", detail: "refresh token revoked" },
    expiresAt: null, nextRefreshAt: null, revoked: true,
  },
  { provider: "claude", identity: "other", renewedBy: "host" },
  { identity: "no-provider" },
];

function fakeFetch(handler: (path: string) => Response | Promise<Response>) {
  const calls: { path: string; auth: string | null }[] = [];
  const doFetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, auth: new Headers(init?.headers).get("authorization") });
    return handler(url.pathname);
  }) as unknown as typeof fetch;
  return { calls, doFetch };
}

const host = (over: Partial<RefreshStatusDto>): RefreshStatusDto => ({
  tool: "claude", identity: "alpha", lastAttemptAt: "2026-11-05T00:00:00.000Z", lastSuccessAt: "2026-11-05T00:00:00.000Z",
  lastError: null, lastDetail: "login is owned by the cluster gateway - not refreshed here", revoked: false, consecutiveFailures: 0, running: false, ...over,
});

describe("loadGatewayRenewal", () => {
  test("reads the admin route with the admin token and keeps only gateway-renewed, well-formed logins", async () => {
    const { doFetch, calls } = fakeFetch(() => Response.json({ logins: LOGINS }));
    const view = await loadGatewayRenewal({ admin: ADMIN, fetch: doFetch });
    expect(view.state).toBe("ok");
    expect(view.logins.map((l) => `${l.provider}/${l.identity}`)).toEqual(["claude/alpha", "claude/beta"]);
    expect(view.logins[1]).toMatchObject({ revoked: true, lastError: { code: "invalid_grant" } });
    expect(calls).toEqual([{ path: "/logins/renewal", auth: `Bearer ${ADMIN.token}` }]);
  });

  test("404, unreachable and bad JSON are unavailable, never thrown", async () => {
    const missing = await loadGatewayRenewal({ admin: ADMIN, fetch: fakeFetch(() => Response.json({ error: "not found" }, { status: 404 })).doFetch });
    expect(missing).toMatchObject({ state: "unavailable", logins: [] });
    const down = await loadGatewayRenewal({ admin: ADMIN, fetch: (async () => { throw new Error("connect refused"); }) as unknown as typeof fetch });
    expect(down).toMatchObject({ state: "unavailable", error: "gateway admin unreachable" });
    const odd = await loadGatewayRenewal({ admin: ADMIN, fetch: fakeFetch(() => Response.json({ nope: 1 })).doFetch });
    expect(odd.state).toBe("unavailable");
  });

  test("without admin settings the state is unconfigured and no call is made", async () => {
    const { doFetch, calls } = fakeFetch(() => Response.json({ logins: [] }));
    const view = await loadGatewayRenewal({ secretsPath: "/nonexistent/secrets", fetch: doFetch });
    if (!process.env.AIS_GATEWAY_ADMIN_URL) expect(view.state).toBe("unconfigured");
    if (view.state === "unconfigured") expect(calls).toHaveLength(0);
  });
});

describe("buildRenewalRows", () => {
  const ok: GatewayRenewalView = { state: "ok", logins: [
    { provider: "claude", identity: "alpha", lastRefreshAt: "2026-11-19T04:00:00.000Z", lastRefreshReplica: "gw-0", lastError: null, expiresAt: null, nextRefreshAt: null, revoked: false },
  ] };

  test("a gateway-owned login drops the frozen host stamp and shows the gateway state", () => {
    const rows = buildRenewalRows([host({})], ok);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ renewer: "gateway", host: null, gateway: { lastRefreshAt: "2026-11-19T04:00:00.000Z" } });
  });

  test("when the gateway state is unavailable the row says so instead of Never", () => {
    const rows = buildRenewalRows([host({ lastSuccessAt: null })], { state: "unavailable", logins: [], error: "x" });
    expect(rows[0]).toMatchObject({ renewer: "gateway", gateway: null, gatewayState: "unavailable", host: null });
  });

  test("pools hold no login; other logins stay with the host", () => {
    const rows = buildRenewalRows(
      [host({ identity: "pool1", lastSuccessAt: null, lastDetail: "no refreshable OAuth grant" }), host({ tool: "opencode", identity: "oc", lastSuccessAt: null, lastDetail: "valid until later" })],
      ok,
      new Set(["claude/pool1"]),
    );
    expect(rows.find((r) => r.identity === "pool1")).toMatchObject({ renewer: "pool", host: null });
    expect(rows.find((r) => r.identity === "oc")).toMatchObject({ renewer: "host", host: { lastDetail: "valid until later" } });
    expect(rows.find((r) => r.identity === "alpha")).toMatchObject({ renewer: "gateway" });
  });
});

describe("GET /api/auth/refresh", () => {
  test("returns the merged rows next to the host results", async () => {
    const app = createApp({
      token: "t", port: 47129, startedAt: Date.now(), peerAddress: "127.0.0.1", peerPort: 50000, peerUid: () => process.getuid?.(),
      gatewayRenewal: async () => ({ state: "ok", logins: [{ provider: "claude", identity: "alpha", lastRefreshAt: "2026-11-19T04:00:00.000Z", lastRefreshReplica: null, lastError: null, expiresAt: null, nextRefreshAt: null, revoked: false }] }),
      poolKeys: async () => new Set(["claude/pool1"]),
    });
    const res = await app.request("/api/auth/refresh", { headers: { Host: "127.0.0.1:47129" } });
    const body = (await res.json()) as { results: unknown[]; rows: { identity: string; renewer: string }[]; gateway: { state: string } };
    expect(res.status).toBe(200);
    expect(body.gateway.state).toBe("ok");
    expect(body.rows).toEqual([expect.objectContaining({ identity: "alpha", renewer: "gateway" })]);
  });
});
