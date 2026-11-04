import { beforeEach, describe, expect, test } from "bun:test";
import { createAdminApp } from "../../src/gateway/admin.ts";
import { createGatewayApp } from "../../src/gateway/app.ts";
import { authAgentToken, authBrowserToken } from "../../src/gateway/browser/auth.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";

const ADMIN = "adm-test-value-0001-0123456789abcdef";
let nowMs: number;
let store: MemoryGatewayStore;
let proxy: ReturnType<typeof createGatewayApp>;
let admin: ReturnType<typeof createAdminApp>;

const now = () => new Date(nowMs);
const pools = async (pool: string) => (pool === "main" ? ["a", "b"] : undefined);

const post = (path: string, body: unknown, ip = "client-a") =>
  proxy.request(`http://gw.test${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });
const adm = (path: string, init: RequestInit = {}) =>
  admin.request(`http://admin.test${path}`, { ...init, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" } });
const approve = (code: string, body: unknown) => adm(`/browser/pairings/${code}/approve`, { method: "POST", body: JSON.stringify(body) });

async function startPair(label = "Work") {
  const res = await post("/browser/pair", { profileLabel: label });
  expect(res.status).toBe(200);
  return (await res.json()) as { code: string; pollSecret: string; expiresAt: string };
}

beforeEach(() => {
  nowMs = Date.parse("2026-11-04T10:00:00.000Z");
  store = new MemoryGatewayStore();
  const common = { store, now, browserPoolMembers: pools, browserIdentityExists: async (n: string) => n === "id1" };
  proxy = createGatewayApp({ ...common } as never);
  admin = createAdminApp({ ...common, adminToken: ADMIN });
});

describe("browser pairing", () => {
  test("full flow: pair, poll pending, approve, poll delivers token once", async () => {
    const p = await startPair();
    expect(p.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    expect(Date.parse(p.expiresAt) - nowMs).toBe(10 * 60_000);
    const pending = await post("/browser/pair/poll", { code: p.code, pollSecret: p.pollSecret });
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ pending: true });

    const ok = await approve(p.code, { target: { kind: "pool", pool: "main" } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { binding: { name: string } }).binding.name).toBe("work");

    const done = await post("/browser/pair/poll", { code: p.code, pollSecret: p.pollSecret });
    expect(done.status).toBe(200);
    const body = (await done.json()) as { binding: string; token: string; target: unknown };
    expect(body.binding).toBe("work");
    expect(body.target).toEqual({ kind: "pool", pool: "main" });
    expect((await authBrowserToken(store, body.token))?.name).toBe("work");

    expect((await post("/browser/pair/poll", { code: p.code, pollSecret: p.pollSecret })).status).toBe(404);
  });

  test("wrong poll secret looks like an unknown pairing", async () => {
    const p = await startPair();
    expect((await post("/browser/pair/poll", { code: p.code, pollSecret: "nope" })).status).toBe(404);
  });

  test("expired pairing polls 410 and cannot be approved", async () => {
    const p = await startPair();
    const q = await startPair();
    nowMs += 10 * 60_000 + 1;
    expect((await approve(q.code, { target: { kind: "pool", pool: "main" } })).status).toBe(410);
    expect((await post("/browser/pair/poll", { code: p.code, pollSecret: p.pollSecret })).status).toBe(410);
  });

  test("11th pair from one IP in a minute is 429; other IPs and later minutes are fine", async () => {
    for (let i = 0; i < 10; i++) expect((await post("/browser/pair", { profileLabel: "x" })).status).toBe(200);
    expect((await post("/browser/pair", { profileLabel: "x" })).status).toBe(429);
    expect((await post("/browser/pair", { profileLabel: "x" }, "client-b")).status).toBe(200);
    nowMs += 61_000;
    expect((await post("/browser/pair", { profileLabel: "x" })).status).toBe(200);
  });

  test("rate limit falls back to the remote address", async () => {
    const send = () => proxy.request("http://gw.test/browser/pair", { method: "POST", body: JSON.stringify({ profileLabel: "x" }) }, { ip: "client-c" });
    for (let i = 0; i < 10; i++) expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
  });

  test("approve refuses unknown pool, unknown identity, bad name, duplicate name", async () => {
    const p = await startPair();
    expect((await approve(p.code, { target: { kind: "pool", pool: "ghost" } })).status).toBe(400);
    expect((await approve(p.code, { target: { kind: "identity", identity: "ghost" } })).status).toBe(400);
    expect((await approve(p.code, { target: { kind: "identity", identity: "id1" }, name: "Bad Name" })).status).toBe(400);
    expect((await approve(p.code, { target: { kind: "identity", identity: "id1" }, name: "mine" })).status).toBe(200);
    const q = await startPair();
    expect((await approve(q.code, { target: { kind: "identity", identity: "id1" }, name: "mine" })).status).toBe(409);
    expect((await approve("NOPE", { target: { kind: "identity", identity: "id1" } })).status).toBe(404);
  });

  test("admin routes need the admin token", async () => {
    const res = await admin.request("http://admin.test/browser/bindings");
    expect(res.status).toBe(401);
  });

  test("an app named browser is refused", async () => {
    const res = await adm("/apps/browser", {
      method: "PUT",
      body: JSON.stringify({ owner: "o", namespace: "ns", provider: "claude", style: "anthropic", target: { kind: "pool" } }),
    });
    expect(res.status).toBe(400);
  });

  test("revoked binding token fails authBrowserToken; list shows state", async () => {
    const p = await startPair();
    await approve(p.code, { target: { kind: "identity", identity: "id1" }, name: "laptop" });
    const { token } = (await (await post("/browser/pair/poll", { code: p.code, pollSecret: p.pollSecret })).json()) as { token: string };
    expect(await authBrowserToken(store, token)).toBeDefined();
    expect(await authBrowserToken(store, `${token}x`)).toBeUndefined();
    expect(await authBrowserToken(store, "garbage")).toBeUndefined();
    expect((await adm("/browser/bindings/laptop", { method: "DELETE" })).status).toBe(200);
    expect(await authBrowserToken(store, token)).toBeUndefined();
    const list = (await (await adm("/browser/bindings")).json()) as { bindings: Array<{ name: string; state: string }> };
    expect(list.bindings).toEqual([expect.objectContaining({ name: "laptop", state: "revoked" })]);
    expect((await adm("/browser/bindings/ghost", { method: "DELETE" })).status).toBe(404);
  });

  test("agent token rotation invalidates the old one; delete revokes", async () => {
    const mint = async () => ((await (await adm("/browser/agents/id1/tokens", { method: "POST" })).json()) as { token: string }).token;
    const first = await mint();
    expect(await authAgentToken(store, first)).toEqual({ identity: "id1" });
    const second = await mint();
    expect(await authAgentToken(store, first)).toBeUndefined();
    expect(await authAgentToken(store, second)).toEqual({ identity: "id1" });
    expect((await adm("/browser/agents/id1/tokens", { method: "DELETE" })).status).toBe(200);
    expect(await authAgentToken(store, second)).toBeUndefined();
    expect((await adm("/browser/agents/ghost/tokens", { method: "POST" })).status).toBe(404);
  });
});
