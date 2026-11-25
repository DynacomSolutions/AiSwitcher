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
  await put("agents-claude");
});
afterEach(() => undefined);

describe("t3-instances scope", () => {
  test("lists apps with names, provider, mode, target and namespace only", async () => {
    await put("agents-codex", { provider: "codex", style: "openai", namespace: "prod" });
    await put("agents-grok", { provider: "grok", style: "openai" });
    await call("/apps/agents-claude/tokens", ADMIN, { method: "POST" });
    const res = await call("/apps", scope());
    expect(res.status).toBe(200);
    const list = ((await res.json()) as { apps: Record<string, unknown>[] }).apps;
    expect(list.map((a) => a.name).sort()).toEqual(["agents-claude", "agents-grok"]); // prod is outside the scope
    for (const a of list) expect(Object.keys(a).sort()).toEqual(["name", "namespace", "provider", "state", "style", "target"]);
    expect(JSON.stringify(list)).not.toMatch(/aisg_|hash|prefix/);
  });

  test("refuses the favourites token, an app token, a wrong token and no token", async () => {
    const appToken = ((await (await call("/apps/agents-claude/tokens", ADMIN, { method: "POST" })).json()) as any).token as string;
    for (const t of [favouritesToken(ADMIN), appToken, "wrong", null]) {
      expect((await call("/apps", t)).status).toBe(401);
      expect((await mint("agents-claude", t)).status).toBe(401);
    }
  });

  test("the scope opens only the app list and the instance token route", async () => {
    expect((await call("/favourites", scope())).status).toBe(401);
    expect((await call("/apps/agents-claude/tokens", scope(), { method: "POST" })).status).toBe(401);
    expect((await call("/apps/agents-claude", scope())).status).toBe(401);
    expect((await call("/apps/agents-claude", scope(), { method: "PUT", body: JSON.stringify(base) })).status).toBe(401);
    expect((await call("/apps/agents-claude/revoke", scope(), { method: "POST" })).status).toBe(401);
    expect((await call("/usage", scope())).status).toBe(401);
    expect((await call("/apps", scope(), { method: "DELETE" })).status).toBe(401);
  });

  test("the scope is off when the gateway has no instances settings", async () => {
    app = createAdminApp({ store, adminToken: ADMIN, now: () => now });
    expect((await call("/apps", scope())).status).toBe(401);
  });

  test("returns a working app token, the same one each time, without touching other tokens", async () => {
    const own = ((await (await call("/apps/agents-claude/tokens", ADMIN, { method: "POST" })).json()) as any).token as string;
    const first = (await (await mint("agents-claude")).json()) as { token: string };
    const second = (await (await mint("agents-claude")).json()) as { token: string };
    expect(first.token).toMatch(/^aisg_/);
    expect(second.token).toBe(first.token);
    expect(first.token).not.toBe(own);
    const records = await store.tokensFor("agents-claude");
    expect(records).toHaveLength(2);
    const mine = records.filter((r) => r.expiresAt !== undefined);
    expect(mine).toHaveLength(1); // the scope token expires; the app's own token does not
    expect(Date.parse(mine[0]!.expiresAt!) - now.getTime()).toBeLessThanOrEqual(8 * 24 * 3600 * 1000);
    expect(Date.parse(mine[0]!.expiresAt!) - now.getTime()).toBeGreaterThan(24 * 3600 * 1000);
    expect(await verifyToken(store, "agents-claude", first.token, now)).toBe(true);
    expect(await verifyToken(store, "agents-claude", own, now)).toBe(true);
  });

  test("rotating the app ends the minted token at the overlap and the next mint is a new token", async () => {
    const first = (await (await mint("agents-claude")).json()) as { token: string };
    const rot = (await (await call("/apps/agents-claude/tokens", ADMIN, { method: "POST", body: JSON.stringify({ overlapHours: 1 }) })).json()) as { previousTokensExpireAt: string };
    const next = (await (await mint("agents-claude")).json()) as { token: string };
    expect(next.token).not.toBe(first.token);
    expect(await verifyToken(store, "agents-claude", first.token, now)).toBe(true); // overlap
    expect(await verifyToken(store, "agents-claude", next.token, now)).toBe(true);
    now = new Date(Date.parse(rot.previousTokensExpireAt) + 1000);
    expect(await verifyToken(store, "agents-claude", first.token, now)).toBe(false);
    expect(await verifyToken(store, "agents-claude", next.token, now)).toBe(true);
  });

  test("a mint removes expired minted records of the app and keeps live and own tokens", async () => {
    const WEEK = 7 * 24 * 3600 * 1000;
    now = new Date(Math.floor(now.getTime() / WEEK) * WEEK + 3600 * 1000);
    await call("/apps/agents-claude/tokens", ADMIN, { method: "POST" });
    await mint("agents-claude");
    now = new Date(now.getTime() + 20 * 24 * 3600 * 1000);
    await mint("agents-claude");
    const records = await store.tokensFor("agents-claude");
    expect(records.length).toBe(2); // the app's own token and the live minted one
    expect(records.filter((r) => r.expiresAt === undefined).length).toBe(1);
  });

  test("a minted token is re-minted in the next window and the old one works until its overlap ends", async () => {
    const WEEK = 7 * 24 * 3600 * 1000;
    now = new Date(Math.floor(now.getTime() / WEEK) * WEEK + 3600 * 1000); // one hour into a window
    const first = (await (await mint("agents-claude")).json()) as { token: string };
    now = new Date(now.getTime() + 4 * 24 * 3600 * 1000);
    expect(((await (await mint("agents-claude")).json()) as any).token).toBe(first.token);
    now = new Date(now.getTime() + 3 * 24 * 3600 * 1000);
    const next = (await (await mint("agents-claude")).json()) as { token: string };
    expect(next.token).not.toBe(first.token);
    expect(await verifyToken(store, "agents-claude", first.token, now)).toBe(true);
    expect(await verifyToken(store, "agents-claude", next.token, now)).toBe(true);
    now = new Date(now.getTime() + 2 * 24 * 3600 * 1000);
    expect(await verifyToken(store, "agents-claude", first.token, now)).toBe(false);
  });

  test("refuses an app that no T3 instance uses, with 403 and no token", async () => {
    await put("my-service");
    expect((await mint("my-service")).status).toBe(403);
    expect(await store.tokensFor("my-service")).toHaveLength(0);
    await put("agents-claude-x", { provider: "kimi" });
    expect((await mint("agents-claude-x")).status).toBe(403);
  });

  test("refuses a namespace the scope does not allow", async () => {
    await put("agents-codex", { provider: "codex", style: "openai", namespace: "prod" });
    expect((await mint("agents-codex")).status).toBe(403);
    expect(await store.tokensFor("agents-codex")).toHaveLength(0);
  });

  test("a revoked or unknown app answers 404 and mints nothing", async () => {
    await call("/apps/agents-claude/revoke", ADMIN, { method: "POST" });
    expect((await mint("agents-claude")).status).toBe(404);
    expect((await mint("nope")).status).toBe(404);
    expect(((await (await call("/apps", scope())).json()) as any).apps.map((a: any) => a.name)).not.toContain("agents-claude");
  });

  test("logs every token read, never the token", async () => {
    const t = ((await (await mint("agents-claude")).json()) as any).token as string;
    await mint("agents-claude");
    await mint("nope");
    expect(logs).toHaveLength(3);
    expect(logs.join("\n")).not.toContain(t);
    expect(JSON.parse(logs[0]!)).toMatchObject({ event: "instance-token", app: "agents-claude", outcome: "minted" });
    expect(logs[0]!.match(/"at"/g)).toHaveLength(1);
    expect(JSON.parse(logs[1]!)).toMatchObject({ app: "agents-claude", outcome: "served" });
    expect(JSON.parse(logs[2]!)).toMatchObject({ app: "nope", outcome: "refused" });
  });
});
