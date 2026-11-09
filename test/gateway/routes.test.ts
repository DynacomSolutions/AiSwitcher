import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PoolUsage } from "../../src/identities/pool/adapter.ts";
import { createGatewayApp, type GatewayDeps } from "../../src/gateway/app.ts";
import { LedgerBuffer } from "../../src/gateway/ledger-buffer.ts";
import { noopMetrics, type GatewayMetrics } from "../../src/gateway/metrics.ts";
import { routeFor } from "../../src/gateway/routes.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { generateToken } from "../../src/gateway/tokens.ts";
import type { ApiStyle, GatewayApp, GatewayProvider } from "../../src/gateway/types.ts";

interface Seen {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

const NOW = new Date("2026-11-02T10:00:00.000Z");

let upstream: ReturnType<typeof Bun.serve>;
let seen: Seen[];
let reply: (s: Seen) => Response;
let store: MemoryGatewayStore;
let ledger: LedgerBuffer;
let usage: Record<string, PoolUsage | undefined>;
let requests: Array<{ app: string; provider: string; status: string; httpStatus: number }>;
let deps: GatewayDeps;
let refreshCalls: number;
const tokens: Record<string, string> = {};

const metrics: GatewayMetrics = { ...noopMetrics, request: (e) => void requests.push({ app: e.app, provider: e.provider, status: e.status, httpStatus: e.httpStatus }) };

async function addApp(name: string, provider: GatewayProvider, style: ApiStyle, extra: Partial<GatewayApp> = {}): Promise<void> {
  await store.putApp({ name, owner: "o", namespace: "ns", provider, style, target: { kind: "pool" }, state: "active", createdAt: "2026-11-01T00:00:00.000Z", ...extra });
  const t = generateToken();
  await store.addToken({ app: name, prefix: t.prefix, hash: t.hash, createdAt: NOW.toISOString() });
  tokens[name] = t.token;
}

beforeEach(async () => {
  seen = [];
  refreshCalls = 0;
  requests = [];
  usage = {};
  reply = () => new Response("{}", { headers: { "content-type": "application/json" } });
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const s: Seen = { method: req.method, url: req.url, headers: req.headers, body: await req.text() };
      seen.push(s);
      return reply(s);
    },
  });
  store = new MemoryGatewayStore();
  ledger = new LedgerBuffer(store, { max: 1000, flushMs: 3_600_000 });
  deps = {
    sleep: async () => {},
    store,
    ledger,
    creds: { get: async (_p: string, identity: string) => ({ identity, accessToken: `tok-${identity}`, accountId: "acct" }), refreshAfter401: async () => (refreshCalls++, { identity: "a", accessToken: "x" }) } as unknown as GatewayDeps["creds"],
    usageFor: async (_p, identity) => usage[identity],
    poolMembers: async () => ["a", "b"],
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const headers = new Headers(init?.headers);
      headers.set("x-orig-host", u.host);
      return fetch(`http://127.0.0.1:${upstream.port}${u.pathname}${u.search}`, { ...init, headers });
    }) as typeof fetch,
    now: () => NOW,
    metrics,
    log: () => {},
  };
});

afterEach(async () => {
  await upstream.stop(true);
  await ledger.close();
});

async function call(app: string, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await createGatewayApp(deps).request(`http://gw.test/${app}${path}`, { ...init, headers: { authorization: `Bearer ${tokens[app]}`, ...(init.headers as Record<string, string>) } });
  const bytes = await res.arrayBuffer();
  return new Response(bytes, { status: res.status, headers: res.headers });
}

describe("routeFor", () => {
  test("ordinary chat paths are left to the pass-through", () => {
    expect(routeFor("claude", "anthropic", "POST", "/v1/messages")).toBeUndefined();
    expect(routeFor("codex", "openai", "POST", "/responses")).toBeUndefined();
    expect(routeFor("kimi", "openai", "POST", "/chat/completions")).toBeUndefined();
  });
  test("search and fetch exist for kimi only, as POST", () => {
    expect(routeFor("kimi", "openai", "POST", "/search")).toMatchObject({ kind: "upstream", url: "https://api.kimi.com/coding/v1/search" });
    expect(routeFor("kimi", "anthropic", "POST", "/v1/fetch")).toMatchObject({ url: "https://api.kimi.com/coding/v1/fetch" });
    expect(routeFor("kimi", "openai", "GET", "/search")).toBeUndefined();
    expect(routeFor("zai", "openai", "POST", "/search")).toBeUndefined();
  });
});

describe("model lists", () => {
  const cases: Array<[GatewayProvider, ApiStyle, string, string, string]> = [
    ["claude", "anthropic", "/v1/models", "/v1/models", "api.anthropic.com"],
    ["claude", "anthropic", "/models", "/v1/models", "api.anthropic.com"],
    ["codex", "openai", "/v1/models", "/backend-api/codex/models", "chatgpt.com"],
    ["codex", "openai", "/models", "/backend-api/codex/models", "chatgpt.com"],
    ["kimi", "openai", "/v1/models", "/coding/v1/models", "api.kimi.com"],
    ["kimi", "anthropic", "/v1/models", "/coding/v1/models", "api.kimi.com"],
    ["zai", "openai", "/v1/models", "/api/coding/paas/v4/models", "api.z.ai"],
    ["zai", "anthropic", "/v1/models", "/api/anthropic/v1/models", "api.z.ai"],
    ["grok", "openai", "/v1/models", "/v1/models", "cli-chat-proxy.grok.com"],
    ["opencode", "openai", "/models", "/zen/go/v1/models", "opencode.ai"],
  ];
  for (const [provider, style, path, want, host] of cases) {
    test(`${provider} (${style}) ${path} goes to ${host}${want} with the gateway's own login`, async () => {
      await addApp("app", provider, style, { models: ["only-this-model"] }); // the allowlist must not block a list call
      const res = await call("app", path, { method: "GET" });
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(new URL(seen[0]!.url).pathname).toBe(want);
      expect(seen[0]!.headers.get("x-orig-host")).toBe(host);
      expect(seen[0]!.headers.get("authorization") ?? seen[0]!.headers.get("x-api-key")).toContain("tok-");
      expect(requests.at(-1)).toMatchObject({ app: "app", provider, httpStatus: 200 });
    });
  }

  test("a single model id and the query string are forwarded", async () => {
    await addApp("app", "claude", "anthropic");
    await call("app", "/v1/models/claude-x?limit=5", { method: "GET" });
    expect(seen[0]!.url).toContain("/v1/models/claude-x?limit=5");
  });

  test("ali has no upstream list: the gateway lists the models AIS knows, with no upstream call", async () => {
    await addApp("ali-app", "ali", "anthropic");
    const res = await call("ali-app", "/v1/models", { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; type: string }>; has_more: boolean };
    expect(body.data.map((m) => m.id)).toContain("qwen3.8-max");
    expect(body.data.every((m) => m.type === "model")).toBe(true);
    expect(seen).toHaveLength(0);
    expect(requests.at(-1)).toMatchObject({ provider: "ali", status: "ok", httpStatus: 200 });
  });

  test("a bad token still gets 401 on a list route", async () => {
    await addApp("app", "kimi", "openai");
    const res = await createGatewayApp(deps).request("http://gw.test/app/v1/models", { headers: { authorization: ["Bearer", "wrong"].join(" ") } });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });
});

describe("kimi search and fetch", () => {
  test("search is posted to the coding service with the login, body untouched, and ignores the model allowlist", async () => {
    await addApp("k", "kimi", "openai", { models: ["kimi-for-coding"] });
    reply = () => new Response(JSON.stringify({ search_results: [] }), { headers: { "content-type": "application/json" } });
    const res = await call("k", "/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text_query: "bun test", limit: 3 }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ search_results: [] });
    expect(seen[0]!.method).toBe("POST");
    expect(new URL(seen[0]!.url).pathname).toBe("/coding/v1/search");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer tok-a");
    expect(JSON.parse(seen[0]!.body)).toEqual({ text_query: "bun test", limit: 3 });
  });

  test("fetch keeps the client's accept header", async () => {
    await addApp("k", "kimi", "anthropic");
    reply = () => new Response("# page", { headers: { "content-type": "text/markdown" } });
    const res = await call("k", "/v1/fetch", { method: "POST", headers: { accept: "text/markdown", "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com" }) });
    expect(await res.text()).toBe("# page");
    expect(new URL(seen[0]!.url).pathname).toBe("/coding/v1/fetch");
    expect(seen[0]!.headers.get("accept")).toBe("text/markdown");
  });

  test("the daily token cap still applies", async () => {
    await addApp("k", "kimi", "openai", { dailyTokens: 0 });
    const res = await call("k", "/search", { method: "POST", body: "{}" });
    expect(res.status).toBe(429);
    expect(seen).toHaveLength(0);
  });
});

describe("speech to text", () => {
  test("a multipart upload reaches the ChatGPT transcribe endpoint byte for byte, with the account login", async () => {
    await addApp("c", "codex", "openai", { models: ["gpt-5"] });
    reply = () => new Response(JSON.stringify({ text: "hello" }), { headers: { "content-type": "application/json" } });
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([1, 2, 3, 250])], { type: "audio/wav" }), "a.wav");
    form.append("model", "gpt-4o-mini-transcribe");
    const res = await call("c", "/v1/audio/transcriptions", { method: "POST", body: form });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "hello" });
    expect(new URL(seen[0]!.url).pathname).toBe("/backend-api/transcribe");
    expect(seen[0]!.headers.get("x-orig-host")).toBe("chatgpt.com");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer tok-a");
    expect(seen[0]!.headers.get("chatgpt-account-id")).toBe("acct");
    expect(seen[0]!.headers.get("content-type")).toContain("multipart/form-data");
    expect(seen[0]!.body).toContain("gpt-4o-mini-transcribe");
  });

  test("only POST, and only codex apps", async () => {
    await addApp("z", "zai", "openai");
    await call("z", "/v1/audio/transcriptions", { method: "POST", body: "x" });
    expect(new URL(seen[0]!.url).pathname).toBe("/api/coding/paas/v4/v1/audio/transcriptions"); // plain pass-through, not rewritten
  });
});

describe("served from pool state", () => {
  test("claude usage shows the least-used member's windows and never calls the provider", async () => {
    await addApp("cl", "claude", "anthropic");
    usage.a = { status: "live", maxUtilization: 90, capturedAt: "", windows: [{ label: "five-hour", utilization: 90, resetsAt: "2026-11-02T12:00:00.000Z" }, { label: "seven-day", utilization: 40 }] };
    usage.b = { status: "live", maxUtilization: 30, capturedAt: "", windows: [{ label: "five-hour", utilization: 30, resetsAt: "2026-11-02T13:00:00.000Z" }, { label: "seven-day", utilization: 10, resetsAt: "2026-11-05T00:00:00.000Z" }] };
    const res = await call("cl", "/api/oauth/usage", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ five_hour: { utilization: 30, resets_at: "2026-11-02T13:00:00.000Z" }, seven_day: { utilization: 10, resets_at: "2026-11-05T00:00:00.000Z" } });
    expect(seen).toHaveLength(0);
    expect(requests.at(-1)).toMatchObject({ provider: "claude", status: "ok", httpStatus: 200 });
  });

  test("claude usage with no figures answers null windows", async () => {
    await addApp("cl", "claude", "anthropic");
    expect(await (await call("cl", "/api/oauth/usage", { method: "GET" })).json()).toMatchObject({ five_hour: null, seven_day: null });
  });

  test("claude profile names only the app, with no account detail and no token", async () => {
    await addApp("cl", "claude", "anthropic");
    const res = await call("cl", "/api/oauth/profile", { method: "GET" });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ account: { display_name: "cl", email: null } });
    expect(text).not.toContain("tok-");
    expect(seen).toHaveLength(0);
  });

  test("these claude routes are not served for another provider", async () => {
    await addApp("k", "kimi", "openai");
    await call("k", "/api/oauth/usage", { method: "GET" });
    expect(seen).toHaveLength(1); // plain pass-through
  });

  for (const path of ["/api/codex/rate-limit-reset-credits", "/wham/rate-limit-reset-credits", "/rate-limit-reset-credits"]) {
    test(`codex ${path} returns only the summed count`, async () => {
      await addApp("c", "codex", "openai");
      reply = (s) => new Response(JSON.stringify({ available_count: s.headers.get("authorization") === "Bearer tok-a" ? 2 : 1, account_id: "leak", email: "leak@example.com" }));
      const res = await call("c", path, { method: "GET" });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ available_count: 3 });
      expect(text).not.toContain("leak");
      expect(seen.map((s) => new URL(s.url).pathname)).toEqual(["/backend-api/wham/rate-limit-reset-credits", "/backend-api/wham/rate-limit-reset-credits"]);
    });
  }

  test("codex reset credits read from the usage summary shape too, and unreadable members are skipped", async () => {
    await addApp("c", "codex", "openai");
    let n = 0;
    reply = () => (++n === 1 ? new Response("nope", { status: 500 }) : new Response(JSON.stringify({ rate_limit_reset_credits: { available_count: 4 } })));
    expect(await (await call("c", "/wham/rate-limit-reset-credits", { method: "GET" })).json()).toEqual({ available_count: 4 });
  });

  test("codex reset credits: 502 when no member can be read", async () => {
    await addApp("c", "codex", "openai");
    reply = () => new Response("nope", { status: 500 });
    expect((await call("c", "/api/codex/rate-limit-reset-credits", { method: "GET" })).status).toBe(502);
  });

  test("spending a reset credit through the gateway is refused with no upstream call", async () => {
    await addApp("c", "codex", "openai");
    const res = await call("c", "/api/codex/rate-limit-reset-credits/consume", { method: "POST", body: "{}" });
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

describe("claude account paths", () => {
  const blocked = ["/api/oauth/account", "/API/oauth/account", "/api/oauth//account", "/api//oauth/account", "//api/oauth/account", "/%61pi/oauth/account", "/%2561pi/oauth/account", "/api/oauth/account;x=1", "/api/oauth/userinfo", "/api/oauth/organizations/x", "/api/oauth/claude_cli/roles", "/api/claude_cli_profile", "/api/organizations", "/api/bootstrap"];
  for (const path of blocked) {
    test(`${path} never reaches the provider`, async () => {
      await addApp("cl", "claude", "anthropic");
      const res = await call("cl", path, { method: "GET" });
      expect(res.status).toBe(403);
      expect(seen).toHaveLength(0);
    });
  }
  for (const path of ["/api/oauth//profile", "/api//oauth/profile", "//api/oauth/profile", "/API/oauth/PROFILE", "/%61pi/oauth/profile"]) {
    test(`${path} is the served profile, never the provider's`, async () => {
      await addApp("cl", "claude", "anthropic");
      const res = await call("cl", path, { method: "GET" });
      expect(seen).toHaveLength(0);
      expect(res.status === 200 || res.status === 403).toBe(true);
      expect(await res.text()).not.toContain("tok-");
    });
  }
  test("other /api paths Claude Code uses still pass through", async () => {
    await addApp("cl", "claude", "anthropic");
    for (const path of ["/api/hello", "/api/oauth/claude_cli/create_api_key", "/api/claude_code/settings", "/api/event_logging/batch"]) {
      seen.length = 0;
      expect((await call("cl", path, { method: "GET" })).status).toBe(200);
      expect(seen).toHaveLength(1);
    }
  });
  test("repeated slashes are collapsed before they are sent on", async () => {
    await addApp("cl", "claude", "anthropic");
    await call("cl", "/v1//messages", { method: "POST", body: "{}" });
    expect(new URL(seen[0]!.url).pathname).toBe("/v1/messages");
  });
  test("the served paths still work, and /v1 paths are unaffected", async () => {
    await addApp("cl", "claude", "anthropic");
    expect((await call("cl", "/api/oauth/profile", { method: "GET" })).status).toBe(200);
    expect((await call("cl", "/api/oauth/usage/", { method: "GET" })).status).toBe(200);
    expect(seen).toHaveLength(0);
  });
});

describe("side routes do not disturb logins or the pool", () => {
  for (const status of [401, 402, 403, 429]) {
    test(`transcribe answering ${status} is passed through with no refresh and no hold`, async () => {
      await addApp("c", "codex", "openai");
      reply = (s) => (new URL(s.url).pathname.endsWith("/transcribe") ? new Response('{"detail":"nope"}', { status, headers: { "content-type": "application/json", "retry-after": "30" } }) : new Response("{}"));
      const res = await call("c", "/v1/audio/transcriptions", { method: "POST", body: "x" });
      expect(res.status).toBe(status);
      expect(refreshCalls).toBe(0);
      expect(seen).toHaveLength(1); // no failover to another member
      // a chat call straight after still goes out on the first member
      seen.length = 0;
      const chat = await call("c", "/responses", { method: "POST", body: "{}" });
      expect(chat.status).toBe(200);
      expect(seen).toHaveLength(1);
    });
  }
  test("kimi search 403 with a quota-looking body does not mark the member exhausted", async () => {
    await addApp("k", "kimi", "openai");
    reply = (s) => (s.url.includes("/search") ? new Response('{"error":{"type":"insufficient_quota"}}', { status: 403 }) : new Response("{}"));
    expect((await call("k", "/search", { method: "POST", body: "{}" })).status).toBe(403);
    expect(seen).toHaveLength(1);
    await call("k", "/chat/completions", { method: "POST", body: "{}" });
    expect(new URL(seen[1]!.url).pathname).toBe("/coding/v1/chat/completions");
    expect(seen[1]!.headers.get("authorization")).toBe("Bearer tok-a");
  });
  test("chat 401 still refreshes", async () => {
    await addApp("c", "codex", "openai", { target: { kind: "pin", identity: "a" } });
    let n = 0;
    reply = () => (++n === 1 ? new Response("{}", { status: 401 }) : new Response("{}"));
    await call("c", "/responses", { method: "POST", body: "{}" });
    expect(refreshCalls).toBe(1);
  });
});

describe("daily limits", () => {
  test("side calls are counted as requests, not tokens, and stop at the side limit", async () => {
    await addApp("k", "kimi", "openai", { dailyTokens: 10 });
    deps.sideDailyLimit = 3;
    const app = createGatewayApp(deps);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await app.request("http://gw.test/k/search", { method: "POST", body: "{}", headers: { authorization: `Bearer ${tokens.k}` } })).status);
    await ledger.flush();
    expect(codes).toEqual([200, 200, 200, 429]);
    expect(seen).toHaveLength(3);
    expect(await store.usageSince("k", new Date(0))).toBe(0); // no invented token rows
  });
  test("served routes count against the same limit, and the count restarts the next day", async () => {
    await addApp("cl", "claude", "anthropic");
    deps.sideDailyLimit = 2;
    let t = NOW.getTime();
    deps.now = () => new Date(t);
    const app = createGatewayApp(deps);
    const get = async () => (await app.request("http://gw.test/cl/api/oauth/usage", { headers: { authorization: `Bearer ${tokens["cl"]}` } })).status;
    expect([await get(), await get(), await get()]).toEqual([200, 200, 429]);
    t += 24 * 3_600_000;
    expect(await get()).toBe(200);
  });
  test("two gateway instances sharing one store share the count", async () => {
    await addApp("k", "kimi", "openai");
    deps.sideDailyLimit = 3;
    const a = createGatewayApp(deps);
    const b = createGatewayApp(deps); // another replica, same database
    const hit = async (g: ReturnType<typeof createGatewayApp>) => (await g.request("http://gw.test/k/search", { method: "POST", body: "{}", headers: { authorization: `Bearer ${tokens.k}` } })).status;
    expect([await hit(a), await hit(b), await hit(a), await hit(b)]).toEqual([200, 200, 200, 429]);
  });

  test("when the store cannot count, the replica's own memory limits, the failure is counted and reported, and requests go on", async () => {
    await addApp("k", "kimi", "openai");
    deps.sideDailyLimit = 2;
    store.bumpSideCount = async () => {
      throw new Error("db down");
    };
    const health: boolean[] = [];
    const failures: string[] = [];
    deps.sideCountHealth = (ok) => void health.push(ok);
    deps.metrics = { ...noopMetrics, failOpen: (_a, r) => void failures.push(r) };
    const app = createGatewayApp(deps);
    const hit = async () => (await app.request("http://gw.test/k/search", { method: "POST", body: "{}", headers: { authorization: `Bearer ${tokens.k}` } })).status;
    expect([await hit(), await hit(), await hit()]).toEqual([200, 200, 429]);
    expect(health.every((h) => h === false)).toBe(true);
    expect(failures).toContain("side_count_failed");
  });

  test("chat calls are not counted against the side limit", async () => {
    await addApp("cl", "claude", "anthropic");
    deps.sideDailyLimit = 1;
    for (let i = 0; i < 3; i++) expect((await call("cl", "/v1/messages", { method: "POST", body: "{}" })).status).toBe(200);
  });
  test("a chat call that reports tokens is counted by those tokens, not the fixed cost", async () => {
    await addApp("cl", "claude", "anthropic", { dailyTokens: 100000 });
    reply = () => new Response(JSON.stringify({ type: "message", model: "m", usage: { input_tokens: 5, output_tokens: 7 } }), { headers: { "content-type": "application/json" } });
    await call("cl", "/v1/messages", { method: "POST", body: "{}" });
    await ledger.flush();
    expect(await store.usageSince("cl", new Date(0))).toBe(12);
  });
  test("codex reset credits are cached for a minute per app", async () => {
    await addApp("c", "codex", "openai");
    reply = () => new Response(JSON.stringify({ available_count: 1 }));
    let t = NOW.getTime();
    deps.now = () => new Date(t);
    const app = createGatewayApp(deps);
    const get = async () => (await app.request("http://gw.test/c/wham/rate-limit-reset-credits", { headers: { authorization: `Bearer ${tokens.c}` } })).text();
    await get();
    const before = seen.length;
    expect(before).toBe(2); // one read per member
    await get();
    expect(seen.length).toBe(before);
    t += 61_000;
    await get();
    expect(seen.length).toBe(before + 2);
  });
});

describe("Cloudflare headers", () => {
  test("no cf-* header, cdn-loop or Access credential reaches a provider; ordinary headers do", async () => {
    await addApp("cl", "claude", "anthropic");
    await call("cl", "/v1/messages", {
      method: "POST",
      body: "{}",
      headers: {
        "cf-access-jwt-assertion": "jwt-value",
        "cf-access-client-id": "id-value",
        "cf-access-client-secret": ["client", "value"].join("-"),
        "cf-connecting-ip": "client-a",
        "cf-ray": "abc",
        "cdn-loop": "cloudflare",
        "anthropic-version": "2023-06-01",
      },
    });
    const names = [...seen[0]!.headers.keys()];
    expect(names.filter((n) => n.startsWith("cf-") || n === "cdn-loop")).toEqual([]);
    expect(seen[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
  });
  test("client and pod addresses and proxy metadata are stripped too", async () => {
    await addApp("cl", "claude", "anthropic");
    const meta = { "x-forwarded-for": "client-a, pod-a", "x-forwarded-proto": "https", "x-forwarded-host": "gw.public.example", "x-real-ip": "client-a", "x-request-id": "r-1", "x-envoy-external-address": "pod-a", "x-envoy-attempt-count": "1", "cf-worker": "w", forwarded: "for=client-a", "true-client-ip": "client-a" };
    await call("cl", "/v1/messages", { method: "POST", body: "{}", headers: { ...meta, "anthropic-version": "2023-06-01" } });
    for (const name of Object.keys(meta)) expect(seen[0]!.headers.get(name)).toBeNull();
    expect(seen[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
  });
  test("side routes strip them too", async () => {
    await addApp("k", "kimi", "openai");
    await call("k", "/search", { method: "POST", body: "{}", headers: { "cf-access-jwt-assertion": "jwt-value" } });
    expect(seen[0]!.headers.get("cf-access-jwt-assertion")).toBeNull();
  });
});
