import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAdminApp } from "../../src/gateway/admin.ts";
import { CachedGatewayStore } from "../../src/gateway/cache-store.ts";
import { AppRevokedError, MemoryGatewayStore } from "../../src/gateway/store.ts";
import { generateToken, verifyToken } from "../../src/gateway/tokens.ts";

const ADMIN = "adm-test-value-0001-0123456789abcdef";
const NOW = new Date("2026-11-02T10:00:00.000Z");
const body = { owner: "o", namespace: "ns", provider: "claude", style: "anthropic", target: { kind: "pin", identity: "id1" } };

let shared: MemoryGatewayStore;
let caches: CachedGatewayStore[];

/** One replica: a cache over the shared store and an admin API whose decisions read the shared store. */
async function replica(opts: { listen: boolean; fresh?: boolean }) {
  const cache = new CachedGatewayStore(shared);
  caches.push(cache);
  await cache.warm();
  if (opts.listen) await cache.startListening();
  const admin = createAdminApp({ store: cache, ...(opts.fresh === false ? {} : { readStore: shared }), adminToken: ADMIN, now: () => NOW });
  const call = (path: string, init: RequestInit = {}) =>
    admin.request(`http://admin.test${path}`, { ...init, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" } });
  return { cache, call, put: (name: string) => call(`/apps/${name}`, { method: "PUT", body: JSON.stringify(body) }), tokens: (name: string, b: object = {}) => call(`/apps/${name}/tokens`, { method: "POST", body: JSON.stringify(b) }) };
}

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(5);
  }
  throw new Error("waitFor timed out");
}

beforeEach(() => {
  shared = new MemoryGatewayStore();
  caches = [];
});
afterEach(() => {
  for (const c of caches) c.stop();
});

describe("a revoked app is final", () => {
  test("PUT on a revoked name is refused and the state stays revoked", async () => {
    const a = await replica({ listen: false });
    expect((await a.put("web")).status).toBe(201);
    const made = (await (await a.tokens("web")).json()) as { token: string };
    expect((await a.call("/apps/web/revoke", { method: "POST" })).status).toBe(200);
    const res = await a.put("web");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('app "web" is revoked; a revoked app stays revoked and its tokens never work again. Register a new name.');
    expect((await shared.getApp("web"))?.state).toBe("revoked");
    expect(await verifyToken(a.cache, "web", made.token, NOW)).toBe(false);
  });

  test("token mint on a revoked app is refused and nothing is added or extended", async () => {
    const a = await replica({ listen: false });
    await a.put("web");
    await a.tokens("web");
    await a.call("/apps/web/revoke", { method: "POST" });
    const before = await shared.tokensFor("web");
    const res = await a.tokens("web", { overlapHours: 24 });
    expect(res.status).toBe(409);
    expect(await shared.tokensFor("web")).toEqual(before);
    for (const t of before) expect(Date.parse(t.expiresAt!)).toBeLessThanOrEqual(Date.now());
  });

  test("revoke stops every token at once, including ones that had a later expiry", async () => {
    const a = await replica({ listen: false });
    await a.put("web");
    const first = (await (await a.tokens("web")).json()) as { token: string };
    const second = (await (await a.tokens("web")).json()) as { token: string };
    await a.call("/apps/web/revoke", { method: "POST" });
    const later = new Date(Date.now() + 1000);
    for (const t of await shared.tokensFor("web")) expect(Date.parse(t.expiresAt!)).toBeLessThanOrEqual(later.getTime());
    for (const t of await a.cache.tokensFor("web")) expect(Date.parse(t.expiresAt!)).toBeLessThanOrEqual(later.getTime());
    expect(await verifyToken(shared, "web", first.token, later)).toBe(false);
    expect(await verifyToken(shared, "web", second.token, later)).toBe(false);
  });

  test("the store refuses putApp and addToken on a revoked app", async () => {
    await shared.putApp({ name: "web", ...body, target: { kind: "pin", identity: "id1" }, provider: "claude", style: "anthropic", state: "active", createdAt: NOW.toISOString() });
    await shared.revokeApp("web");
    await expect(shared.putApp({ name: "web", ...body, provider: "claude", style: "anthropic", target: { kind: "pin", identity: "id1" }, state: "active", createdAt: NOW.toISOString() })).rejects.toBeInstanceOf(AppRevokedError);
    const t = generateToken();
    await expect(shared.addToken({ app: "web", prefix: t.prefix, hash: t.hash, createdAt: NOW.toISOString() })).rejects.toBeInstanceOf(AppRevokedError);
  });
});

describe("two replicas over one store", () => {
  test("a revoke through replica A reaches replica B at once through the change notice", async () => {
    const a = await replica({ listen: true });
    const b = await replica({ listen: true });
    await a.put("web");
    const made = (await (await a.tokens("web")).json()) as { token: string };
    await waitFor(async () => (await b.cache.getApp("web")) !== undefined);
    expect(await verifyToken(b.cache, "web", made.token, NOW)).toBe(true);
    await a.call("/apps/web/revoke", { method: "POST" });
    await waitFor(async () => !(await verifyToken(b.cache, "web", made.token, NOW)));
    expect((await b.cache.getApp("web"))?.state).toBe("revoked");
  });

  test("a stale replica cannot revive a revoked app", async () => {
    const a = await replica({ listen: false });
    const b = await replica({ listen: false });
    await a.put("web");
    const made = (await (await a.tokens("web")).json()) as { token: string };
    await b.cache.warm();
    await a.call("/apps/web/revoke", { method: "POST" });
    // B never saw the revoke: its cache still says active.
    expect((await b.cache.getApp("web"))?.state).toBe("active");
    const res = await b.put("web");
    expect(res.status).toBe(409);
    expect((await shared.getApp("web"))?.state).toBe("revoked");
    expect((await b.tokens("web")).status).toBe(409);
    expect(await verifyToken(shared, "web", made.token, NOW)).toBe(false);
  });

  test("even with decisions read from a stale cache, the store guard refuses and the cache learns the revoke", async () => {
    const a = await replica({ listen: false });
    const b = await replica({ listen: false, fresh: false });
    await a.put("web");
    await a.tokens("web");
    await b.cache.warm();
    await a.call("/apps/web/revoke", { method: "POST" });
    expect((await b.put("web")).status).toBe(409);
    expect((await shared.getApp("web"))?.state).toBe("revoked");
    expect((await b.cache.getApp("web"))?.state).toBe("revoked");
    expect((await b.tokens("web")).status).toBe(409);
    for (const t of await shared.tokensFor("web")) expect(Date.parse(t.expiresAt!)).toBeLessThanOrEqual(Date.now());
  });
});

describe("the cache never brings a revoked app back", () => {
  const app = { name: "web", owner: "o", namespace: "ns", provider: "claude" as const, style: "anthropic" as const, target: { kind: "pin" as const, identity: "id1" }, state: "active" as const, createdAt: NOW.toISOString() };

  test("a warm() whose reads finish after a refreshApp(revoke) does not bring back active", async () => {
    await shared.putApp(app);
    const t = generateToken();
    await shared.addToken({ app: "web", prefix: t.prefix, hash: t.hash, createdAt: NOW.toISOString() });
    // A store whose listApps and tokensFor answer with the state at call time, but only after a gate opens.
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let slow = false;
    const wrapper = new Proxy(shared, {
      get(target, prop, receiver) {
        if (slow && (prop === "listApps" || prop === "tokensFor")) {
          return async (...args: unknown[]) => {
            const snapshot = await (target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[prop as string]!(...args);
            await gate;
            return snapshot;
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as MemoryGatewayStore;
    const cache = new CachedGatewayStore(wrapper);
    caches.push(cache);
    await cache.warm();
    slow = true;
    const warming = cache.warm(); // reads "active", then waits on the gate
    await Bun.sleep(5);
    slow = false;
    await shared.revokeApp("web");
    await cache.refreshApp("web");
    expect((await cache.getApp("web"))?.state).toBe("revoked");
    open();
    await warming;
    expect((await cache.getApp("web"))?.state).toBe("revoked");
    expect(await verifyToken(cache, "web", t.token, NOW)).toBe(false);
  });

  test("a snapshot that says active never un-revokes a cached revoked app", async () => {
    const stale = new MemoryGatewayStore();
    await stale.putApp(app);
    const t = generateToken();
    await stale.addToken({ app: "web", prefix: t.prefix, hash: t.hash, createdAt: NOW.toISOString() });
    const cache = new CachedGatewayStore(stale);
    caches.push(cache);
    await cache.warm();
    await cache.revokeApp("web");
    const revokedExpiry = (await cache.tokensFor("web"))[0]!.expiresAt!;
    // Make the underlying store look as if it never saw the revoke (an old snapshot).
    const old = new MemoryGatewayStore();
    await old.putApp(app);
    await old.addToken({ app: "web", prefix: t.prefix, hash: t.hash, createdAt: NOW.toISOString() });
    (cache as unknown as { inner: MemoryGatewayStore }).inner = old;
    await cache.warm();
    expect((await cache.getApp("web"))?.state).toBe("revoked");
    expect((await cache.tokensFor("web"))[0]!.expiresAt).toBe(revokedExpiry);
    await cache.refreshApp("web");
    expect((await cache.getApp("web"))?.state).toBe("revoked");
    expect((await cache.tokensFor("web"))[0]!.expiresAt).toBe(revokedExpiry);
    await expect(cache.putApp(app)).rejects.toBeInstanceOf(AppRevokedError);
    expect(await verifyToken(cache, "web", t.token, new Date(Date.now() + 1000))).toBe(false);
  });
});
