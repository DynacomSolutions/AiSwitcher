import { describe, expect, test } from "bun:test";
import { createApp, type ConsoleAppDeps } from "../../src/server/app.ts";
import { loadBrowserBindings, revokeBrowserBinding } from "../../src/server/browser-bindings.ts";

const base = { token: "t", port: 47129, startedAt: Date.now(), peerAddress: "127.0.0.1", peerPort: 50000, peerUid: () => process.getuid?.() };
const headers = { Host: "127.0.0.1:47129" };
const mutate = { ...headers, "X-AIS-Console": "1" };
const appWith = (extra: Partial<ConsoleAppDeps>) => createApp({ ...base, ...extra });

const NOW = Date.parse("2026-11-08T12:00:00Z");
const admin = { url: "http://admin.example.com", token: "adm-value" };
const body = {
  bindings: [
    { name: "old", target: { kind: "pool", pool: "p1" }, profileLabel: "a@example.com", state: "revoked", createdAt: "2026-11-01T00:00:00Z" },
    { name: "live", target: { kind: "identity", identity: "solo" }, profileLabel: "b@example.com", state: "active", lastSeenAt: "2026-11-08T11:59:30Z" },
    { name: "idle", target: { kind: "pool", pool: "p1" }, profileLabel: "c@example.com", state: "active", lastSeenAt: "2026-11-08T11:50:00Z" },
    { name: "bad", target: { kind: "nope" }, state: "active" },
  ],
};

describe("loadBrowserBindings", () => {
  test("lists with the admin bearer, marks connected, sorts active first, drops malformed", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const f = (async (url: string, init: RequestInit) => (calls.push({ url, auth: new Headers(init.headers).get("authorization") }), Response.json(body))) as unknown as typeof fetch;
    const view = await loadBrowserBindings({ admin, fetch: f, now: () => NOW });
    expect(calls).toEqual([{ url: "http://admin.example.com/browser/bindings", auth: `Bearer ${admin.token}` }]);
    expect(view.configured).toBe(true);
    expect(view.bindings.map((b) => [b.name, b.connected])).toEqual([["idle", false], ["live", true], ["old", false]]);
    expect(JSON.stringify(view)).not.toContain("adm-value");
  });
  test("not configured without admin settings", async () => {
    const saved = { u: process.env.AIS_GATEWAY_ADMIN_URL, t: process.env.AIS_GATEWAY_ADMIN_TOKEN };
    delete process.env.AIS_GATEWAY_ADMIN_URL;
    delete process.env.AIS_GATEWAY_ADMIN_TOKEN;
    try {
      expect(await loadBrowserBindings({ secretsPath: "/nonexistent/secrets" })).toEqual({ configured: false, bindings: [] });
    } finally {
      if (saved.u !== undefined) process.env.AIS_GATEWAY_ADMIN_URL = saved.u;
      if (saved.t !== undefined) process.env.AIS_GATEWAY_ADMIN_TOKEN = saved.t;
    }
  });
  test("reports admin failures as a short error", async () => {
    const down = (async () => { throw new Error("secret detail"); }) as unknown as typeof fetch;
    expect(await loadBrowserBindings({ admin, fetch: down })).toEqual({ configured: true, bindings: [], error: "admin unreachable" });
    const bad = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    expect((await loadBrowserBindings({ admin, fetch: bad })).error).toBe("admin answered 500");
  });
});

describe("revokeBrowserBinding", () => {
  test("DELETEs the encoded name with the bearer", async () => {
    const calls: { url: string; method?: string; auth: string | null }[] = [];
    const f = (async (url: string, init: RequestInit) => (calls.push({ url, method: init.method, auth: new Headers(init.headers).get("authorization") }), Response.json({ ok: true }))) as unknown as typeof fetch;
    expect(await revokeBrowserBinding("a b", { admin, fetch: f })).toEqual({ ok: true });
    expect(calls).toEqual([{ url: "http://admin.example.com/browser/bindings/a%20b", method: "DELETE", auth: `Bearer ${admin.token}` }]);
  });
  test("maps 404 and failures to safe errors", async () => {
    const nf = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    await expect(revokeBrowserBinding("x", { admin, fetch: nf })).rejects.toMatchObject({ status: 404 });
    const down = (async () => { throw new Error("x"); }) as unknown as typeof fetch;
    await expect(revokeBrowserBinding("x", { admin, fetch: down })).rejects.toMatchObject({ status: 502 });
  });
});

describe("console routes", () => {
  test("GET /api/browsers returns the seam view and keeps the guard", async () => {
    const view = { configured: true, bindings: [] };
    const app = appWith({ browserBindings: async () => view });
    const res = await app.request("/api/browsers", { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(view);
    expect((await appWith({ peerAddress: "203.0.113.9", browserBindings: async () => view }).request("/api/browsers", { headers })).status).toBe(401);
  });
  test("not configured is a 200 state, not a 500", async () => {
    const res = await appWith({ browserBindings: async () => ({ configured: false, bindings: [] }) }).request("/api/browsers", { headers });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { configured: boolean }).configured).toBe(false);
  });
  test("revoke passes the decoded name, needs X-AIS-Console and a good Host", async () => {
    const names: string[] = [];
    const app = appWith({ browserRevoke: async (n) => (names.push(n), { ok: true }) });
    expect((await app.request("/api/browsers/work%20mac/revoke", { method: "POST", headers })).status).toBe(403);
    expect((await app.request("/api/browsers/work%20mac/revoke", { method: "POST", headers: { Host: "evil.example.com", "X-AIS-Console": "1" } })).status).toBe(403);
    expect(names).toEqual([]);
    const res = await app.request("/api/browsers/work%20mac/revoke", { method: "POST", headers: mutate });
    expect(res.status).toBe(200);
    expect(names).toEqual(["work mac"]);
  });
  test("revoke without admin config answers 503 with a message", async () => {
    const saved = { u: process.env.AIS_GATEWAY_ADMIN_URL, t: process.env.AIS_GATEWAY_ADMIN_TOKEN };
    delete process.env.AIS_GATEWAY_ADMIN_URL;
    delete process.env.AIS_GATEWAY_ADMIN_TOKEN;
    try {
      const res = await appWith({ browserRevoke: (n) => revokeBrowserBinding(n, { secretsPath: "/nonexistent/secrets" }) }).request("/api/browsers/x/revoke", { method: "POST", headers: mutate });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toContain("not configured");
    } finally {
      if (saved.u !== undefined) process.env.AIS_GATEWAY_ADMIN_URL = saved.u;
      if (saved.t !== undefined) process.env.AIS_GATEWAY_ADMIN_TOKEN = saved.t;
    }
  });
});
