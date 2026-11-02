import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAdminApp } from "../../src/gateway/admin.ts";
import { CachedGatewayStore } from "../../src/gateway/cache-store.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { verifyToken } from "../../src/gateway/tokens.ts";

const ADMIN = "adm-test-value-0001";
let now: Date;
let inner: MemoryGatewayStore;
let store: CachedGatewayStore;
let app: ReturnType<typeof createAdminApp>;

const body = { owner: "o", namespace: "ns", provider: "claude", style: "anthropic", target: { kind: "pin", identity: "id1" } };
const call = (path: string, init: RequestInit & { token?: string | null } = {}) => {
  const { token = ADMIN, ...rest } = init;
  return app.request(`http://admin.test${path}`, {
    ...rest,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...(rest.headers as Record<string, string>) },
  });
};
const put = (name: string, over: object = {}) => call(`/apps/${name}`, { method: "PUT", body: JSON.stringify({ ...body, ...over }) });

beforeEach(async () => {
  now = new Date("2026-11-02T10:00:00.000Z");
  inner = new MemoryGatewayStore();
  store = new CachedGatewayStore(inner);
  await store.warm();
  app = createAdminApp({ store, adminToken: ADMIN, now: () => now });
});
afterEach(() => store.stop());

describe("admin api", () => {
  test("admin rejects missing or wrong token", async () => {
    expect((await call("/apps", { token: null })).status).toBe(401);
    expect((await call("/apps", { token: "wrong" })).status).toBe(401);
    expect((await call("/apps", { token: `${ADMIN}x` })).status).toBe(401);
    expect((await call("/apps", { headers: { authorization: `Basic ${ADMIN}` }, token: null })).status).toBe(401);
    expect((await call("/apps")).status).toBe(200);
  });

  test("put creates an app, get returns it, bad input is 400", async () => {
    expect((await put("web")).status).toBe(201);
    const got = (await (await call("/apps/web")).json()) as any;
    expect(got.name).toBe("web");
    expect(got.state).toBe("active");
    expect((await call("/apps/missing")).status).toBe(404);
    expect((await put("web", { provider: "nope" })).status).toBe(400);
    expect((await put("Bad Name")).status).toBe(400);
    expect((await put("healthz")).status).toBe(400);
    expect((await put("web", { target: { kind: "pin" } })).status).toBe(400);
    expect((await call("/apps/web", { method: "PUT", body: "{" })).status).toBe(400);
  });

  test("create token returns once and list never shows it", async () => {
    await put("web");
    const res = await call("/apps/web/tokens", { method: "POST" });
    expect(res.status).toBe(201);
    const made = (await res.json()) as any;
    expect(made.token).toMatch(/^aisg_/);
    const stored = (await inner.tokensFor("web"))[0]!;
    const secret = made.token.split("_").slice(2).join("_");
    for (const path of ["/apps", "/apps/web"]) {
      const text = await (await call(path)).text();
      expect(text).not.toContain(made.token);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(stored.hash);
      expect(text).not.toContain('"hash"');
    }
    expect(await verifyToken(store, "web", made.token, now)).toBe(true);
  });

  test("rotate keeps old token valid for overlap", async () => {
    await put("web");
    const first = (await (await call("/apps/web/tokens", { method: "POST" })).json()) as any;
    const second = (await (await call("/apps/web/tokens", { method: "POST" })).json()) as any;
    const old = (await inner.tokensFor("web")).find((t) => t.prefix === first.prefix)!;
    expect(Date.parse(old.expiresAt!)).toBe(now.getTime() + 24 * 3600_000);
    const fresh = (await inner.tokensFor("web")).find((t) => t.prefix === second.prefix)!;
    expect(fresh.expiresAt).toBeUndefined();
    expect(await verifyToken(store, "web", first.token, now)).toBe(true);
    expect(await verifyToken(store, "web", second.token, now)).toBe(true);
    const later = new Date(now.getTime() + 24 * 3600_000 + 1);
    expect(await verifyToken(store, "web", first.token, later)).toBe(false);
    expect(await verifyToken(store, "web", second.token, later)).toBe(true);
  });

  test("revoke is immediate", async () => {
    await put("web");
    const made = (await (await call("/apps/web/tokens", { method: "POST" })).json()) as any;
    expect(await verifyToken(store, "web", made.token, now)).toBe(true);
    expect((await call("/apps/web/revoke", { method: "POST" })).status).toBe(200);
    expect(await verifyToken(store, "web", made.token, now)).toBe(false);
    expect((await call("/apps/web/tokens", { method: "POST" })).status).toBe(409);
    expect((await call("/apps/nope/revoke", { method: "POST" })).status).toBe(404);
  });

  test("usage sums tokens per app over the window", async () => {
    await put("web");
    await put("other", { provider: "codex", style: "openai" });
    await inner.appendUsage([
      { ts: new Date(now.getTime() - 3600_000).toISOString(), app: "web", provider: "claude", identity: "id1", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 1, status: "ok", httpStatus: 200, latencyMs: 1, streamed: false },
      { ts: new Date(now.getTime() - 5 * 86400_000).toISOString(), app: "web", provider: "claude", identity: "id1", inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, status: "ok", httpStatus: 200, latencyMs: 1, streamed: false },
    ]);
    const one = (await (await call("/usage?app=web&days=1")).json()) as any;
    expect(one.usage).toEqual([{ app: "web", provider: "claude", days: 1, tokens: 16 }]);
    const wide = (await (await call("/usage?days=7&provider=claude")).json()) as any;
    expect(wide.usage).toEqual([{ app: "web", provider: "claude", days: 7, tokens: 116 }]);
    expect((await call("/usage?days=0")).status).toBe(400);
  });
});
