import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createGatewayApp, type GatewayDeps } from "../../src/gateway/app.ts";
import { LedgerBuffer } from "../../src/gateway/ledger-buffer.ts";
import { noopMetrics } from "../../src/gateway/metrics.ts";
import { createResetLogger, MemoryResetLog, type ResetLogger } from "../../src/gateway/reset-log.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { generateToken } from "../../src/gateway/tokens.ts";
import type { ApiStyle, GatewayApp, GatewayProvider } from "../../src/gateway/types.ts";

// Resets that an app sends through the account routes of the proxy write one reset log row each (account.ts).

interface Seen {
  method: string;
  url: string;
  body: string;
}

const NOW = new Date("2026-11-02T10:00:00.000Z");

let upstream: ReturnType<typeof Bun.serve>;
let seen: Seen[];
let reply: (s: Seen) => Response;
let store: MemoryGatewayStore;
let ledger: LedgerBuffer;
let deps: GatewayDeps;
let logStore: MemoryResetLog;
let logger: ResetLogger;
const tokens: Record<string, string> = {};

async function addApp(name: string, provider: GatewayProvider, style: ApiStyle, extra: Partial<GatewayApp> = {}): Promise<void> {
  await store.putApp({ name, owner: "o", namespace: "ns", provider, style, target: { kind: "pin", identity: "a" }, state: "active", createdAt: "2026-11-01T00:00:00.000Z", ...extra });
  const t = generateToken();
  await store.addToken({ app: name, prefix: t.prefix, hash: t.hash, createdAt: NOW.toISOString() });
  tokens[name] = t.token;
}

async function call(app: string, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await createGatewayApp(deps).request(`http://gw.test/${app}${path}`, { ...init, headers: { authorization: `Bearer ${tokens[app]}`, ...(init.headers as Record<string, string>) } });
  const bytes = await res.arrayBuffer();
  return new Response(bytes, { status: res.status, headers: res.headers });
}

beforeEach(() => {
  seen = [];
  reply = () => new Response("{}", { headers: { "content-type": "application/json" } });
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const s: Seen = { method: req.method, url: req.url, body: await req.text() };
      seen.push(s);
      return reply(s);
    },
  });
  store = new MemoryGatewayStore();
  ledger = new LedgerBuffer(store, { max: 1000, flushMs: 3_600_000 });
  logStore = new MemoryResetLog();
  logger = createResetLogger({
    store: logStore, now: () => NOW.getTime(), log: () => {}, retryBackoffMs: [0, 0],
    usageFor: async () => ({ status: "live", capturedAt: NOW.toISOString(), windows: [{ label: "seven-day", utilization: 100 }] }),
  });
  deps = {
    sleep: async () => {},
    store,
    ledger,
    resetLog: logger,
    creds: { get: async (_p: string, identity: string) => ({ identity, accessToken: `tok-${identity}`, accountId: "acct" }), refreshAfter401: async () => ({ identity: "a", accessToken: "x" }) } as unknown as GatewayDeps["creds"],
    usageFor: async () => undefined,
    poolMembers: async () => ["a", "b"],
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return fetch(`http://127.0.0.1:${upstream.port}${u.pathname}${u.search}`, init);
    }) as typeof fetch,
    now: () => NOW,
    metrics: noopMetrics,
    log: () => {},
  };
});

afterEach(async () => {
  await upstream.stop(true);
  await ledger.close();
});

const isProfile = (s: Seen): boolean => new URL(s.url).pathname === "/api/oauth/profile";
const claudeBody = (id: string): string => JSON.stringify({ program: "cedar_ember", grant_id: id, request_id: "req-1" });
const codexBody = (): string => JSON.stringify({ redeem_request_id: crypto.randomUUID() });
const CONSUME = "/wham/rate-limit-reset-credits/consume";

describe("a Claude reset through the proxy", () => {
  test("writes a manual row for the app, and the app gets the provider answer unchanged", async () => {
    await addApp("cl", "claude", "anthropic");
    reply = (s) => (isProfile(s) ? Response.json({ organization: { uuid: "org-of-a" } }) : Response.json({ result: "reset", grant_id: "grant-a", cleared: ["seven_day"] }));
    const res = await call("cl", "/api/organizations/org-stale/reset_rate_limits", { method: "POST", body: claudeBody("grant-a"), headers: { "content-type": "application/json" } });
    expect(await res.json()).toEqual({ result: "reset", grant_id: "grant-a", cleared: ["seven_day"] });
    await logger.drain();
    const rows = (await logStore.list({})).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "claude", trigger: "manual", actor: "app:cl", identity: "a", grantId: "grant-a", outcome: "reset" });
    expect(rows[0]?.before.map((w) => [w.key, w.percent])).toEqual([["weekly", 100]]);
  });

  test("is a rejected row when the provider refuses it, and the refusal reaches the app", async () => {
    await addApp("cl", "claude", "anthropic");
    reply = (s) => (isProfile(s) ? Response.json({ organization: { uuid: "org-of-a" } }) : Response.json({ error: "no" }, { status: 403 }));
    const res = await call("cl", "/api/organizations/org-of-a/reset_rate_limits", { method: "POST", body: claudeBody("grant-a") });
    expect(res.status).toBe(403);
    await logger.drain();
    expect((await logStore.list({})).rows.map((row) => row.outcome)).toEqual(["rejected"]);
  });

  test("is an error row when the provider fails it, because the outcome is not known", async () => {
    await addApp("cl", "claude", "anthropic");
    reply = (s) => (isProfile(s) ? Response.json({ organization: { uuid: "org-of-a" } }) : new Response("{}", { status: 500 }));
    expect((await call("cl", "/api/organizations/org-of-a/reset_rate_limits", { method: "POST", body: claudeBody("grant-a") })).status).toBe(500);
    await logger.drain();
    expect((await logStore.list({})).rows.map((row) => row.outcome)).toEqual(["error"]);
  });

  test("with no organisation sends nothing and writes a rejected row", async () => {
    await addApp("cl", "claude", "anthropic");
    reply = (s) => (isProfile(s) ? Response.json({}) : Response.json({ result: "reset" }));
    const res = await call("cl", "/api/organizations/org-of-a/reset_rate_limits", { method: "POST", body: claudeBody("grant-a") });
    expect(res.status).toBe(502);
    await logger.drain();
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(0);
    expect((await logStore.list({})).rows.map((row) => row.outcome)).toEqual(["rejected"]);
  });

  test("is the only Claude call that logs: a usage read writes no row", async () => {
    await addApp("cl", "claude", "anthropic");
    reply = () => Response.json({ organization: { uuid: "org-of-a" } });
    await call("cl", "/api/organizations/org-of-a/usage", { method: "GET" });
    await logger.drain();
    expect((await logStore.list({})).rows).toEqual([]);
  });

  test("never changes the answer when the log cannot write", async () => {
    await addApp("cl", "claude", "anthropic");
    reply = (s) => (isProfile(s) ? Response.json({ organization: { uuid: "org-of-a" } }) : Response.json({ result: "reset" }));
    logStore.failInserts = true;
    const res = await call("cl", "/api/organizations/org-of-a/reset_rate_limits", { method: "POST", body: claudeBody("grant-a") });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "reset" });
    await logger.drain();
    expect((await logStore.list({})).rows).toEqual([]);
  });
});

describe("a Codex consume through the proxy", () => {
  test("writes a manual row for the app, with the member and the credit", async () => {
    await addApp("c", "codex", "openai");
    reply = (s) => (s.method === "GET" ? Response.json({ available_count: 1 }) : Response.json({ code: "reset", windows_reset: 2, credit: { id: "credit-SYNTHETIC_FIXTURE-one" } }));
    const res = await call("c", CONSUME, { method: "POST", body: codexBody() });
    expect(await res.json()).toEqual({ code: "reset", windows_reset: 2, credit: { id: "credit-SYNTHETIC_FIXTURE-one" } });
    await logger.drain();
    const rows = (await logStore.list({})).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "codex", trigger: "manual", actor: "app:c", identity: "a", grantId: "credit-SYNTHETIC_FIXTURE-one", outcome: "reset" });
  });

  test.each([
    ["no_credit", "no_credit"], ["already_redeemed", "already_redeemed"], ["nothing_to_reset", "rejected"],
  ])("answer %s is the outcome %s", async (code, outcome) => {
    await addApp("c", "codex", "openai");
    reply = (s) => (s.method === "GET" ? Response.json({ available_count: 1 }) : Response.json({ code, windows_reset: 0 }));
    await call("c", CONSUME, { method: "POST", body: codexBody() });
    await logger.drain();
    expect((await logStore.list({})).rows.map((row) => row.outcome)).toEqual([outcome] as never);
  });

  test("refused by the provider is rejected, and a fence that stops the guard writes no second row", async () => {
    await addApp("c", "codex", "openai");
    reply = (s) => (s.method === "GET" ? Response.json({ available_count: 1 }) : new Response("{}", { status: 429 }));
    expect((await call("c", CONSUME, { method: "POST", body: codexBody() })).status).toBe(429);
    await logger.drain();
    expect((await logStore.list({})).rows.map((row) => row.outcome)).toEqual(["rejected"]);

    const { CodexResetFenced } = await import("../../src/gateway/account.ts");
    deps = { ...deps, withCodexRedemption: async () => { throw new CodexResetFenced(); } };
    expect((await call("c", CONSUME, { method: "POST", body: codexBody() })).status).toBe(409);
    // The guard threw before the member was chosen, so there is no second row.
    await logger.drain();
    expect((await logStore.list({})).rows).toHaveLength(1);
  });

  test("never changes the answer when the log cannot write", async () => {
    await addApp("c", "codex", "openai");
    reply = (s) => (s.method === "GET" ? Response.json({ available_count: 1 }) : Response.json({ code: "reset", windows_reset: 1 }));
    logStore.failInserts = true;
    const res = await call("c", CONSUME, { method: "POST", body: codexBody() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: "reset", windows_reset: 1 });
    await logger.drain();
    expect((await logStore.list({})).rows).toEqual([]);
  });
});
