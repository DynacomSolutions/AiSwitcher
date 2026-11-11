import { describe, expect, test } from "bun:test";
import { createApp, type ConsoleAppDeps } from "../../src/server/app.ts";

const base = { token: "t", port: 47129, startedAt: Date.now(), peerAddress: "127.0.0.1", peerPort: 50000, peerUid: () => process.getuid?.() };
const headers = { Host: "127.0.0.1:47129" };
const appWith = (extra: Partial<ConsoleAppDeps>) => createApp({ ...base, ...extra });

describe("GET /api/gateway/usage", () => {
  test("returns the view and passes days through", async () => {
    let days = 0;
    const view = { configured: true, rows: [{ app: "e2e-claude", provider: "claude", days: 3, tokens: 42 }] };
    const res = await appWith({ gatewayUsage: async (d) => ((days = d), view) }).request("/api/gateway/usage?days=3", { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(view);
    expect(days).toBe(3);
  });
  test("defaults to 7 days and keeps the console guard", async () => {
    let days = 0;
    const app = appWith({ gatewayUsage: async (d) => ((days = d), { configured: false, rows: [] }) });
    expect((await app.request("/api/gateway/usage", { headers })).status).toBe(200);
    expect(days).toBe(7);
    expect((await appWith({ peerAddress: "203.0.113.9" }).request("/api/gateway/usage", { headers })).status).toBe(401);
  });
});

describe("GET /api/pools/usage", () => {
  test("returns the seam answer and keeps the console guard", async () => {
    const body = { todayKey: "2026-11-06", weekStartKey: "2026-10-31", pools: [], gateway: { today: { configured: false, rows: [] }, week: { configured: false, rows: [] } } };
    const app = appWith({ poolsUsage: async () => body });
    const res = await app.request("/api/pools/usage", { headers });
    expect(await res.json()).toEqual(body);
    expect((await appWith({ peerAddress: "203.0.113.9" }).request("/api/pools/usage", { headers })).status).toBe(401);
  });
});

describe("poolsUsage", () => {
  test("asks the ledger from local midnight and from six days earlier", async () => {
    const { poolsUsage } = await import("../../src/server/pools-usage.ts");
    const since: Date[] = [];
    const out = await poolsUsage({
      now: () => new Date(2026, 10, 6, 15, 30),
      pools: async () => [{ tool: "claude", name: "p", members: [{ name: "m", allowed: true }] }],
      gateway: async (d) => (since.push(d), { configured: true, rows: [], ...(since.length === 2 ? { error: "admin unreachable" } : {}) }),
    });
    expect(out.todayKey).toBe("2026-11-06");
    expect(out.weekStartKey).toBe("2026-10-31");
    expect(since.map((d) => d.getTime()).sort()).toEqual([new Date(2026, 9, 31).getTime(), new Date(2026, 10, 6).getTime()]);
    expect(out.gateway.week.error).toBe("admin unreachable");
  });
});

describe("GET /api/usage/projects", () => {
  test("serves the collector's rows without scanning and keeps the console guard", async () => {
    const body = {
      generatedAt: "2026-11-12T03:00:00.000Z",
      rows: [{
        path: "/work/acme/widget", repo: "acme/widget", org: "acme", host: "example.com", source: "git" as const,
        workspace: "/work/acme/widget", provider: "anthropic", identity: "alice", tool: "claude", date: "2026-11-11",
        cost: 1, input: 2, output: 3, cacheRead: 4, cacheWrite: 5, messages: 6, lastMs: 7,
      }],
    };
    const app = appWith({ usageProjects: () => body });
    const res = await app.request("/api/usage/projects", { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(body);
    expect((await appWith({ usageProjects: () => undefined }).request("/api/usage/projects", { headers })).json()).resolves.toEqual({ pending: true, rows: [] });
    expect((await appWith({ peerAddress: "203.0.113.9" }).request("/api/usage/projects", { headers })).status).toBe(401);
  });
});
