import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAdminApp } from "../../src/gateway/admin.ts";
import { favouritesToken } from "../../src/gateway/favourites-token.ts";
import { instancesToken } from "../../src/gateway/instances-token.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { verifyToken } from "../../src/gateway/tokens.ts";

const ADMIN = "adm-test-value-0001-0123456789abcdef";
let now: Date;
let store: MemoryGatewayStore;
let app: ReturnType<typeof createAdminApp>;
let logs: string[];

const base = { owner: "o", namespace: "dev", provider: "claude", style: "anthropic", target: { kind: "pool" } };
const call = (path: string, token: string | null, init: RequestInit = {}) =>
  app.request(`http://admin.test${path}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" } });
const put = (name: string, over: object = {}) => call(`/apps/${name}`, ADMIN, { method: "PUT", body: JSON.stringify({ ...base, ...over }) });
const scope = () => instancesToken(ADMIN);
const mint = (name: string, token: string | null = scope()) => call(`/apps/${name}/instance-token`, token, { method: "POST" });

beforeEach(async () => {
  now = new Date("2026-11-02T10:00:00.000Z");
  store = new MemoryGatewayStore();
  logs = [];
  app = createAdminApp({ store, adminToken: ADMIN, now: () => now, instances: { namespaces: ["dev"], log: (l) => logs.push(l) } });
  await put("agents-a");
});
afterEach(() => undefined);

describe("t3-instances scope", () => {
  test("lists apps with names, provider, mode, target and namespace only", async () => {
    await put("agents-b", { provider: "codex", style: "openai", namespace: "prod" });
    await call("/apps/agents-a/tokens", ADMIN, { method: "POST" });
    const res = await call("/apps", scope());
    expect(res.status).toBe(200);
    const list = ((await res.json()) as { apps: Record<string, unknown>[] }).apps;
    expect(list.map((a) => a.name).sort()).toEqual(["agents-a", "agents-b"]);
    for (const a of list) expect(Object.keys(a).sort()).toEqual(["name", "namespace", "provider", "state", "style", "target"]);
    expect(JSON.stringify(list)).not.toMatch(/aisg_|hash|prefix/);
  });

  test("refuses the favourites token, an app token, a wrong token and no token", async () => {
    const appToken = ((await (await call("/apps/agents-a/tokens", ADMIN, { method: "POST" })).json()) as any).token as string;
    for (const t of [favouritesToken(ADMIN), appToken, "wrong", null]) {
      expect((await call("/apps", t)).status).toBe(401);
      expect((await mint("agents-a", t)).status).toBe(401);
    }
  });

  test("the scope opens only the app list and the instance token route", async () => {
    expect((await call("/favourites", scope())).status).toBe(401);
    expect((await call("/apps/agents-a/tokens", scope(), { method: "POST" })).status).toBe(401);
    expect((await call("/apps/agents-a", scope())).status).toBe(401);
    expect((await call("/apps/agents-a", scope(), { method: "PUT", body: JSON.stringify(base) })).status).toBe(401);
    expect((await call("/apps/agents-a/revoke", scope(), { method: "POST" })).status).toBe(401);
    expect((await call("/usage", scope())).status).toBe(401);
    expect((await call("/apps", scope(), { method: "DELETE" })).status).toBe(401);
  });

  test("the scope is off when the gateway has no instances settings", async () => {
    app = createAdminApp({ store, adminToken: ADMIN, now: () => now });
    expect((await call("/apps", scope())).status).toBe(401);
  });

  test("returns a working app token, the same one each time, without touching other tokens", async () => {
    const own = ((await (await call("/apps/agents-a/tokens", ADMIN, { method: "POST" })).json()) as any).token as string;
    const first = (await (await mint("agents-a")).json()) as { token: string };
    const second = (await (await mint("agents-a")).json()) as { token: string };
    expect(first.token).toMatch(/^aisg_/);
    expect(second.token).toBe(first.token);
    expect(first.token).not.toBe(own);
    const records = await store.tokensFor("agents-a");
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.expiresAt === undefined)).toBe(true);
    expect(await verifyToken(store, "agents-a", first.token, now)).toBe(true);
    expect(await verifyToken(store, "agents-a", own, now)).toBe(true);
  });

  test("a rotated app gets a new token, and the old one is not handed out again", async () => {
    const first = (await (await mint("agents-a")).json()) as { token: string };
    await call("/apps/agents-a/tokens", ADMIN, { method: "POST" });
    const next = (await (await mint("agents-a")).json()) as { token: string };
    expect(next.token).not.toBe(first.token);
    expect(await verifyToken(store, "agents-a", next.token, now)).toBe(true);
  });

  test("refuses a namespace the scope does not allow", async () => {
    await put("agents-p", { namespace: "prod" });
    expect((await mint("agents-p")).status).toBe(403);
    expect(await store.tokensFor("agents-p")).toHaveLength(0);
  });

  test("a revoked or unknown app answers 404 and mints nothing", async () => {
    await call("/apps/agents-a/revoke", ADMIN, { method: "POST" });
    expect((await mint("agents-a")).status).toBe(404);
    expect((await mint("nope")).status).toBe(404);
    expect(((await (await call("/apps", scope())).json()) as any).apps.map((a: any) => a.name)).not.toContain("agents-a");
  });

  test("logs every token read, never the token", async () => {
    const t = ((await (await mint("agents-a")).json()) as any).token as string;
    await mint("agents-a");
    await mint("nope");
    expect(logs).toHaveLength(3);
    expect(logs.join("\n")).not.toContain(t);
    expect(JSON.parse(logs[0]!)).toMatchObject({ event: "instance-token", app: "agents-a", outcome: "minted" });
    expect(JSON.parse(logs[1]!)).toMatchObject({ app: "agents-a", outcome: "served" });
    expect(JSON.parse(logs[2]!)).toMatchObject({ app: "nope", outcome: "refused" });
  });
});
