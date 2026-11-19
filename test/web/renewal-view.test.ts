import { describe, expect, test } from "bun:test";
import { relUntil } from "../../apps/web/src/lib/format.ts";
import { renewalView } from "../../apps/web/src/lib/renewal-view.ts";
import type { RenewalRow } from "../../apps/web/src/types/api.ts";

const NOW = Date.parse("2026-11-19T06:00:00.000Z");
const gw = (over: Partial<NonNullable<RenewalRow["gateway"]>>): RenewalRow => ({
  tool: "claude", identity: "alpha", renewer: "gateway", note: "",
  host: null,
  gateway: { provider: "claude", identity: "alpha", lastRefreshAt: "2026-11-19T04:00:00.000Z", lastRefreshReplica: null, lastError: null, expiresAt: "2026-11-19T12:00:00.000Z", nextRefreshAt: "2026-11-19T08:00:00.000Z", revoked: false, ...over },
});

describe("renewalView", () => {
  test("a healthy gateway login shows last, next and expiry", () => {
    expect(renewalView(gw({}), NOW)).toMatchObject({ renewedBy: "Renewed by the gateway", lastRefresh: "2h ago", nextRefresh: "in 2h", expires: "in 6h", status: { tone: "ok", label: "Renewing" } });
  });
  test("a revoked login says sign-in needed and shows the error code and time", () => {
    const v = renewalView(gw({ revoked: true, lastError: { at: "2026-11-19T03:00:00.000Z", code: "invalid_grant", detail: "revoked" } }), NOW);
    expect(v.status).toEqual({ tone: "destructive", label: "Sign-in needed" });
    expect(v.error).toBe("invalid_grant, 3h ago: revoked");
    expect(v.nextRefresh).toBe("-");
  });
  test("a failed refresh newer than the last success warns", () => {
    expect(renewalView(gw({ lastError: { at: "2026-11-19T05:00:00.000Z", code: "transport", detail: "" } }), NOW).status.tone).toBe("warning");
  });
  test("unavailable gateway state never reads as Never", () => {
    const row: RenewalRow = { tool: "claude", identity: "alpha", renewer: "gateway", gateway: null, gatewayState: "unavailable", host: null, note: "" };
    const v = renewalView(row, NOW);
    expect(v.status.label).toBe("Gateway renewal state unavailable");
    expect(JSON.stringify(v)).not.toContain("Never");
    expect(v.canRefreshHere).toBe(false);
  });
  test("pool and host rows give plain statements", () => {
    const pool: RenewalRow = { tool: "claude", identity: "p", renewer: "pool", gateway: null, host: null, note: "" };
    expect(renewalView(pool, NOW).renewedBy).toBe("No login of its own");
    const host: RenewalRow = { tool: "opencode", identity: "oc", renewer: "host", gateway: null, note: "", host: { lastAttemptAt: null, lastSuccessAt: null, lastError: null, lastDetail: "valid until 2026-12-01T00:00:00.000Z", revoked: false, consecutiveFailures: 0, running: false } };
    const v = renewalView(host, NOW);
    expect(v.lastRefresh).toBe("Not needed yet");
    expect(v.canRefreshHere).toBe(true);
    expect(JSON.stringify(v)).not.toContain("Never");
  });
  test("relUntil", () => {
    expect(relUntil("2026-11-19T06:00:30.000Z", NOW)).toBe("now");
    expect(relUntil("2026-11-21T07:00:00.000Z", NOW)).toBe("in 2d");
  });
});
