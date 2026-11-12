import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type ConsoleAppDeps } from "../../src/server/app.ts";
import { loadGatewayApps, parseGatewayAppPatch, rotateGatewayApp, revokeGatewayApp, updateGatewayApp } from "../../src/server/gateway-apps.ts";
import { HttpError } from "../../src/server/types.ts";

const ADMIN = { url: "http://admin.example.test", token: "admin-token-SYNTHETIC_FIXTURE" };

const APPS = [
  {
    name: "billing",
    owner: "alice",
    namespace: "shop",
    provider: "claude",
    style: "anthropic",
    target: { kind: "pool", identities: ["m1", "m2"] },
    state: "active",
    createdAt: "2026-11-01T00:00:00.000Z",
    dailyTokens: 5000,
    tokens: [
      { prefix: "gw_old0", createdAt: "2026-11-01T00:00:00.000Z", expiresAt: "2026-11-02T00:00:00.000Z" },
      { prefix: "gw_new1", createdAt: "2026-11-05T00:00:00.000Z" },
    ],
  },
  { name: "reports", owner: "bob", namespace: "ops", provider: "codex", style: "openai", target: { kind: "pin", identity: "m3" }, state: "active", reservePercent: 40, models: ["gpt-x"], tokens: [] },
  { name: "gone", owner: "bob", namespace: "ops", provider: "kimi", style: "openai", target: { kind: "pool" }, state: "revoked", tokens: [] },
];

interface Call {
  method: string;
  path: string;
  body?: unknown;
  auth: string | null;
}

function fakeAdmin(handlers: Record<string, (body: unknown) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const doFetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname + url.search, body, auth: new Headers(init?.headers).get("authorization") });
    const h = handlers[`${method} ${url.pathname + url.search}`] ?? handlers[`${method} ${url.pathname}`];
    return h ? h(body) : Response.json({ error: "no such app" }, { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, doFetch };
}

const usage = (days: number, tokens: Record<string, number>) => Response.json({ usage: Object.entries(tokens).map(([app, t]) => ({ app, provider: "claude", days, tokens: t })) });

describe("loadGatewayApps", () => {
  test("lists every app with effective reserve, newest token first and 1/7-day usage", async () => {
    const { doFetch, calls } = fakeAdmin({
      "GET /apps": () => Response.json({ apps: APPS }),
      "GET /usage?days=1": () => usage(1, { billing: 10 }),
      "GET /usage?days=7": () => usage(7, { billing: 70, reports: 7 }),
    });
    const view = await loadGatewayApps({ admin: ADMIN, fetch: doFetch });
    expect(view.configured).toBe(true);
    expect(view.defaultReservePercent).toBe(100);
    expect(view.apps.map((a) => a.name)).toEqual(["billing", "reports", "gone"]);
    const [billing, reports] = view.apps;
    expect(billing).toMatchObject({ effectiveReservePercent: 100, dailyTokens: 5000, usage1d: 10, usage7d: 70, target: { kind: "pool", identities: ["m1", "m2"] } });
    expect(billing!.reservePercent).toBeUndefined();
    expect(billing!.tokens.map((t) => t.prefix)).toEqual(["gw_new1", "gw_old0"]);
    expect(reports).toMatchObject({ reservePercent: 40, effectiveReservePercent: 40, models: ["gpt-x"], usage1d: 0, usage7d: 7 });
    expect(calls.every((c) => c.auth === `Bearer ${ADMIN.token}`)).toBe(true);
  });

  test("usage failure keeps the apps; list failure and no config are honest", async () => {
    const { doFetch } = fakeAdmin({ "GET /apps": () => Response.json({ apps: APPS }), "GET /usage": () => Response.json({ error: "x" }, { status: 503 }) });
    const view = await loadGatewayApps({ admin: ADMIN, fetch: doFetch });
    expect(view.apps).toHaveLength(3);
    expect(view.apps[0]!.usage7d).toBeNull();
    expect(view.usageError).toBeTruthy();
    const down = (async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch;
    const failed = await loadGatewayApps({ admin: ADMIN, fetch: down });
    expect(failed).toMatchObject({ configured: true, apps: [], error: "gateway admin unreachable" });
    const dir = mkdtempSync(join(tmpdir(), "ais-gw-"));
    const prev = { url: process.env.AIS_GATEWAY_ADMIN_URL, token: process.env.AIS_GATEWAY_ADMIN_TOKEN };
    delete process.env.AIS_GATEWAY_ADMIN_URL;
    delete process.env.AIS_GATEWAY_ADMIN_TOKEN;
    try {
      expect((await loadGatewayApps({ secretsPath: join(dir, "none") })).configured).toBe(false);
    } finally {
      if (prev.url !== undefined) process.env.AIS_GATEWAY_ADMIN_URL = prev.url;
      if (prev.token !== undefined) process.env.AIS_GATEWAY_ADMIN_TOKEN = prev.token;
    }
  });
});

describe("updateGatewayApp", () => {
  test("merges the patch over the current app; null and empty lists clear", async () => {
    const { doFetch, calls } = fakeAdmin({
      "GET /apps/reports": () => Response.json(APPS[1]),
      "PUT /apps/reports": (body) => Response.json({ ...(body as object), name: "reports", state: "active", tokens: [] }),
    });
    const app = await updateGatewayApp("reports", { reservePercent: null, models: [], dailyTokens: 900 }, { admin: ADMIN, fetch: doFetch });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({ owner: "bob", namespace: "ops", provider: "codex", style: "openai", target: { kind: "pin", identity: "m3" }, dailyTokens: 900 });
    expect(app).toMatchObject({ name: "reports", effectiveReservePercent: 100, dailyTokens: 900 });
  });

  test("an admin refusal keeps its reason; a missing app is 404", async () => {
    const { doFetch } = fakeAdmin({
      "GET /apps/reports": () => Response.json(APPS[1]),
      "PUT /apps/reports": () => Response.json({ error: "reservePercent must be between 1 and 100" }, { status: 400 }),
    });
    const err = await updateGatewayApp("reports", { reservePercent: 5 }, { admin: ADMIN, fetch: doFetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).message).toBe("reservePercent must be between 1 and 100");
    const missing = await updateGatewayApp("nope", {}, { admin: ADMIN, fetch: doFetch }).catch((e: unknown) => e);
    expect((missing as HttpError).status).toBe(404);
  });

  test("parseGatewayAppPatch validates each field", () => {
    expect(parseGatewayAppPatch({ reservePercent: 50, models: [" a ", "a", "b"], dailyTokens: null })).toEqual({ reservePercent: 50, models: ["a", "b"], dailyTokens: null });
    for (const bad of [null, [], { reservePercent: 0 }, { reservePercent: 101 }, { dailyTokens: -1 }, { dailyTokens: 1.5 }, { models: "a" }, { models: [""] }]) {
      expect(() => parseGatewayAppPatch(bad)).toThrow(HttpError);
    }
  });
});

describe("rotateGatewayApp", () => {
  const NEW = "gw_rot9.secret-SYNTHETIC_FIXTURE";
  const admin = () =>
    fakeAdmin({
      "GET /apps/billing": () => Response.json(APPS[0]),
      "POST /apps/billing/tokens": () => Response.json({ app: "billing", token: NEW, prefix: "gw_rot9", previousTokensExpireAt: "2026-11-13T00:00:00.000Z" }, { status: 201 }),
    });

  test("runs the CLI rotate path: kube Secret and secrets file, token returned once and kept out of messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ais-gw-"));
    const secretsPath = join(dir, "secrets");
    writeFileSync(secretsPath, "AIS_GATEWAY_PROXY_URL=http://proxy.example.test/gw\n", { mode: 0o600 });
    const kube: { args: string[]; stdin: string }[] = [];
    const { doFetch } = admin();
    const r = await rotateGatewayApp("billing", {
      admin: ADMIN,
      fetch: doFetch,
      secretsPath,
      codexHomesPath: join(dir, "codex-homes.json"),
      kubectl: async (args, stdin) => (kube.push({ args, stdin }), { code: 0, stderr: "" }),
      now: () => Date.parse("2026-11-12T00:00:00Z"),
    });
    expect(r).toMatchObject({ app: "billing", token: NEW, url: "http://proxy.example.test/gw/billing", previousTokensExpireAt: "2026-11-13T00:00:00.000Z" });
    expect(r.deliveryError).toBeUndefined();
    expect(r.messages.join("\n")).not.toContain(NEW);
    expect(r.messages.some((m) => m.includes("ais-gateway-billing written in shop"))).toBe(true);
    expect(kube).toHaveLength(1);
    expect(kube[0]!.args.join(" ")).not.toContain(NEW);
    expect(kube[0]!.stdin).toContain("ais-gateway-billing");
    expect(readFileSync(secretsPath, "utf8")).toContain(`AIS_GATEWAY_APP_BILLING_TOKEN=${NEW}`);
  });

  test("a kubectl failure still hands the minted token over, with the reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ais-gw-"));
    const secretsPath = join(dir, "secrets");
    writeFileSync(secretsPath, "AIS_GATEWAY_PROXY_URL=http://proxy.example.test\n", { mode: 0o600 });
    const { doFetch } = admin();
    const r = await rotateGatewayApp("billing", {
      admin: ADMIN,
      fetch: doFetch,
      secretsPath,
      codexHomesPath: join(dir, "codex-homes.json"),
      kubectl: async () => ({ code: 1, stderr: "forbidden" }),
    });
    expect(r.token).toBe(NEW);
    expect(r.deliveryError).toContain("forbidden");
    expect(r.deliveryError).not.toContain(NEW);
  });

  test("revoke posts to the admin API", async () => {
    const { doFetch, calls } = fakeAdmin({ "POST /apps/billing/revoke": () => Response.json({ app: "billing", state: "revoked" }) });
    expect(await revokeGatewayApp("billing", { admin: ADMIN, fetch: doFetch })).toEqual({ app: "billing", state: "revoked" });
    expect(calls[0]!.method).toBe("POST");
    await expect(revokeGatewayApp("../x", { admin: ADMIN, fetch: doFetch })).rejects.toThrow("invalid app name");
  });
});

describe("/api/gateway/apps routes", () => {
  const base = { token: "t", port: 47129, startedAt: Date.now(), peerAddress: "127.0.0.1", peerPort: 50000, peerUid: () => process.getuid?.() };
  const headers = { Host: "127.0.0.1:47129" };
  const mutating = { ...headers, "X-AIS-Console": "1", "content-type": "application/json" };
  const appWith = (extra: Partial<ConsoleAppDeps>) => createApp({ ...base, ...extra });

  test("list, update, rotate and revoke reach their seams; mutations need the console header", async () => {
    const seen: string[] = [];
    const app = appWith({
      gatewayApps: {
        list: async () => ({ configured: true, apps: [], defaultReservePercent: 100 }),
        update: async (name, patch) => (seen.push(`update ${name} ${JSON.stringify(patch)}`), { name } as never),
        rotate: async (name) => (seen.push(`rotate ${name}`), { app: name, token: "tok-SYNTHETIC_FIXTURE", url: "u", previousTokensExpireAt: "", messages: [] }),
        revoke: async (name) => (seen.push(`revoke ${name}`), { app: name, state: "revoked" as const }),
      },
    });
    expect(await (await app.request("/api/gateway/apps", { headers })).json()).toEqual({ configured: true, apps: [], defaultReservePercent: 100 });
    expect((await app.request("/api/gateway/apps/billing", { method: "PUT", headers: mutating, body: JSON.stringify({ reservePercent: 50 }) })).status).toBe(200);
    expect((await app.request("/api/gateway/apps/billing", { method: "PUT", headers: mutating, body: JSON.stringify({ reservePercent: 500 }) })).status).toBe(400);
    expect((await app.request("/api/gateway/apps/billing/rotate", { method: "POST", headers: mutating })).status).toBe(200);
    expect((await app.request("/api/gateway/apps/billing/revoke", { method: "POST", headers: mutating })).status).toBe(200);
    expect((await app.request("/api/gateway/apps/billing/revoke", { method: "POST", headers })).status).toBe(403);
    expect(seen).toEqual(['update billing {"reservePercent":50}', "rotate billing", "revoke billing"]);
    expect((await appWith({ peerAddress: "203.0.113.9" }).request("/api/gateway/apps", { headers })).status).toBe(401);
  });
});
