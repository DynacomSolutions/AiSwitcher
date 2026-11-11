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
const WRONG_APP_TOKEN = ["aisg", "abcdefgh", "SYNTHETIC_FIXTURE-wrong"].join("_");

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

  test("these claude routes are not special for another provider", async () => {
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

  for (const path of ["/backend-api/wham/rate-limit-reset-credits", "/backend-api/api/codex/rate-limit-reset-credits"]) {
    test(`codex reset credits are served under the ChatGPT ${path}`, async () => {
      await addApp("c", "codex", "openai");
      reply = () => new Response(JSON.stringify({ available_count: 1 }));
      expect(await (await call("c", path, { method: "GET" })).json()).toEqual({ available_count: 2 });
    });
  }

  const codexUsageA = (): PoolUsage => ({ status: "live", maxUtilization: 60, capturedAt: "", windows: [{ label: "session", utilization: 60, resetsAt: "2026-11-02T11:00:00.000Z" }, { label: "week", utilization: 20, resetsAt: "2026-11-07T10:00:00.000Z" }] });
  const codexUsageB = (): PoolUsage => ({ status: "live", maxUtilization: 30, capturedAt: "", windows: [{ label: "session", utilization: 12.6, resetsAt: "2026-11-02T12:00:00.000Z" }, { label: "week", utilization: 30, resetsAt: "2026-11-08T10:00:00.000Z" }] });
  const nowSec = NOW.getTime() / 1000;

  for (const path of ["/wham/usage", "/api/codex/usage", "/backend-api/wham/usage", "/backend-api/api/codex/usage", "/backend-api//wham/usage/"]) {
    test(`codex ${path} shows the least-used member's windows in the ChatGPT shape, with no upstream call`, async () => {
      await addApp("c", "codex", "openai");
      usage.a = codexUsageA();
      usage.b = codexUsageB();
      const res = await call("c", path, { method: "GET" });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({
        plan_type: "pro",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { used_percent: 13, limit_window_seconds: 18_000, reset_after_seconds: 7_200, reset_at: nowSec + 7_200 },
          secondary_window: { used_percent: 30, limit_window_seconds: 604_800, reset_after_seconds: 6 * 86_400, reset_at: nowSec + 6 * 86_400 },
        },
      });
      expect(text).not.toContain("tok-");
      expect(seen).toHaveLength(0);
      expect(requests.at(-1)).toMatchObject({ provider: "codex", status: "ok", httpStatus: 200 });
    });
  }

  test("codex usage of a pool shows a full window as limit_reached", async () => {
    await addApp("c", "codex", "openai");
    usage.a = { ...codexUsageA(), windows: [{ label: "session", utilization: 100 }, { label: "week", utilization: 20, resetsAt: "2026-11-07T10:00:00.000Z" }] };
    const body = (await (await call("c", "/backend-api/wham/usage", { method: "GET" })).json()) as { rate_limit: Record<string, unknown> };
    expect(body.rate_limit).toMatchObject({ allowed: false, limit_reached: true, primary_window: { used_percent: 100, reset_at: nowSec + 18_000 }, secondary_window: { used_percent: 20 } });
  });

  test("codex usage keeps each window's own length: a monthly-only account is one 30-day primary window", async () => {
    await addApp("c", "codex", "openai");
    usage.a = { status: "live", maxUtilization: 99, capturedAt: "", windows: [{ label: "month", utilization: 99, resetsAt: "2026-11-20T10:00:00.000Z" }] };
    const body = (await (await call("c", "/backend-api/wham/usage", { method: "GET" })).json()) as { rate_limit: Record<string, unknown> };
    expect(body.rate_limit).toEqual({ allowed: true, limit_reached: false, primary_window: { used_percent: 99, limit_window_seconds: 30 * 86_400, reset_after_seconds: 18 * 86_400, reset_at: nowSec + 18 * 86_400 }, secondary_window: null });
  });

  test("codex usage orders windows by length whatever their order, and reads ~Nh/~Nd labels", async () => {
    await addApp("c", "codex", "openai");
    usage.a = { status: "live", maxUtilization: 40, capturedAt: "", windows: [{ label: "~3d", utilization: 40 }, { label: "~2h", utilization: 10 }, { label: "mystery", utilization: 90 }] };
    const body = (await (await call("c", "/backend-api/wham/usage", { method: "GET" })).json()) as { rate_limit: { primary_window: Record<string, number>; secondary_window: Record<string, number> } };
    expect(body.rate_limit.primary_window).toMatchObject({ used_percent: 10, limit_window_seconds: 7_200 });
    expect(body.rate_limit.secondary_window).toMatchObject({ used_percent: 40, limit_window_seconds: 3 * 86_400 });
  });

  test("codex usage with no figures is 502, not an invented 0%", async () => {
    await addApp("c", "codex", "openai");
    expect((await call("c", "/backend-api/wham/usage", { method: "GET" })).status).toBe(502);
    expect(seen).toHaveLength(0);
  });

  test("the bare /backend-api prefix names nothing: 404, never reaches the provider", async () => {
    await addApp("c", "codex", "openai");
    expect((await call("c", "/backend-api", { method: "GET" })).status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  const modelBody = (model: string): string => JSON.stringify({ model, input: "x" });
  for (const [method, path, want] of [
    ["POST", "/backend-api/codex/responses", "/backend-api/codex/responses"],
    ["POST", "/backend-api/%63odex/responses", "/backend-api/%63odex/responses"],
    ["POST", "/backend-api/codex;x/responses", "/backend-api/codex;x/responses"],
    ["POST", "/backend-api/%2563odex/responses", "/backend-api/%2563odex/responses"],
    ["POST", "/%62ackend-api/CODEX/responses", "/backend-api/CODEX/responses"],
    ["POST", "/backend-api/conversation", "/backend-api/conversation"],
    ["POST", "/backend-api/f/conversation", "/backend-api/f/conversation"],
    ["POST", "/backend-api/wham/tasks", "/backend-api/wham/tasks"],
    ["POST", "/wham/tasks/abc/retry", "/backend-api/wham/tasks/abc/retry"],
  ] as const) {
    test(`codex ${method} ${path} runs a model: the model path (allowlist, ledger), never an account forward`, async () => {
      await addApp("c", "codex", "openai", { models: ["only-this-model"] });
      const refused = await call("c", path, { method, body: modelBody("other-model") });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(seen).toHaveLength(0);
      const ok = await call("c", path, { method, body: modelBody("only-this-model") });
      expect(ok.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(new URL(seen[0]!.url).pathname.toLowerCase()).toBe(want.toLowerCase());
      expect(requests.filter((r) => r.status === "ok")).toHaveLength(1); // a ledger/metrics row, as for chat
    });
  }
  test("codex cloud task listings are account reads: forwarded, no model path", async () => {
    await addApp("c", "codex", "openai", { target: { kind: "pin", identity: "a" } });
    await call("c", "/backend-api/wham/tasks/list", { method: "GET" });
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!.url).pathname).toBe("/backend-api/wham/tasks/list");
  });
  test("a codex model call that hits the daily token cap is refused like chat", async () => {
    await addApp("c", "codex", "openai", { dailyTokens: 1 });
    await store.appendUsage([{ ts: NOW.toISOString(), app: "c", provider: "codex", identity: "a", inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, status: "ok", httpStatus: 200, latencyMs: 1, streamed: false }]);
    expect((await call("c", "/backend-api/conversation", { method: "POST", body: modelBody("m") })).status).toBe(429);
    expect(seen).toHaveLength(0);
  });

  test("a codex account path is forwarded as the client wrote it (case kept), classified in normal form", async () => {
    await addApp("c", "codex", "openai", { target: { kind: "pin", identity: "a" } });
    await call("c", "/BACKEND-api/files/file-AbC123", { method: "GET" });
    expect(new URL(seen[0]!.url).pathname).toBe("/backend-api/files/file-AbC123");
  });
  for (const path of ["/backend-api/api_keys", "/backend-api/oauth/token", "/backend-api/accounts/x/API_KEYS"]) {
    test(`codex ${path} mints a credential: 403, nothing sent`, async () => {
      await addApp("c", "codex", "openai", { target: { kind: "pin", identity: "a" } });
      expect((await call("c", path, { method: "POST", body: "{}" })).status).toBe(403);
      expect(seen).toHaveLength(0);
    });
  }

  test("codex usage paths are not served for another provider", async () => {
    await addApp("k", "kimi", "openai");
    await call("k", "/backend-api/wham/usage", { method: "GET" });
    expect(seen).toHaveLength(1); // plain pass-through
  });
});

describe("claude account paths", () => {
  const forwarded = ["/api/oauth/account", "/API/oauth/account", "/api/oauth//account", "/api//oauth/account", "//api/oauth/account", "/%61pi/oauth/account", "/api/oauth/account;x=1", "/api/oauth/userinfo", "/api/oauth/claude_cli/roles", "/api/claude_cli_profile", "/api/organizations", "/api/bootstrap", "/api/oauth/profile", "/api/oauth//profile", "//api/oauth/profile"];
  for (const path of forwarded) {
    test(`${path} is forwarded with the member's login, never the app token`, async () => {
      await addApp("cl", "claude", "anthropic", { target: { kind: "pin", identity: "a" } });
      const res = await call("cl", path, { method: "GET" });
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.headers.get("authorization")).toBe("Bearer tok-a");
      expect(seen[0]!.headers.get("authorization")).not.toContain("aisg_");
      expect(await res.text()).not.toContain("tok-");
    });
  }
  test("a pool app's profile is the one of the member the pool uses now, unchanged", async () => {
    await addApp("cl", "claude", "anthropic");
    usage.a = { status: "live", maxUtilization: 80, capturedAt: "" };
    usage.b = { status: "live", maxUtilization: 10, capturedAt: "" };
    reply = () => Response.json({ account: { uuid: "acct-b", email: "b@example.com" }, organization: { uuid: "org-b" } });
    const res = await call("cl", "/api/oauth/profile", { method: "GET" });
    expect(await res.json()).toEqual({ account: { uuid: "acct-b", email: "b@example.com" }, organization: { uuid: "org-b" } });
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer tok-b");
  });
  test("a pinned app's usage with cedar_ember is the member's own body", async () => {
    await addApp("cl", "claude", "anthropic", { target: { kind: "pin", identity: "a" } });
    const body = { five_hour: { utilization: 3 }, cedar_ember: { eligible: true, grants: [{ id: "grant-a", resets_left: 2, paused: false, usable_now: true }], next_grant_id: "grant-a" } };
    reply = () => Response.json(body);
    const res = await call("cl", "/api/oauth/usage?cedar_ember=1&skip_spend=1", { method: "GET", headers: { "anthropic-beta": "oauth-2025-04-20" } });
    expect(await res.json()).toEqual(body);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain("/api/oauth/usage?cedar_ember=1&skip_spend=1");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer tok-a");
    expect(requests.at(-1)).toMatchObject({ provider: "claude", status: "ok", httpStatus: 200 });
  });
  test("a pool app's usage with cedar_ember keeps the served windows and merges the chosen member's grants", async () => {
    await addApp("cl", "claude", "anthropic");
    usage.a = { status: "live", maxUtilization: 90, capturedAt: "", windows: [{ label: "five-hour", utilization: 90 }] };
    usage.b = { status: "live", maxUtilization: 30, capturedAt: "", windows: [{ label: "five-hour", utilization: 30 }] };
    reply = (s) => Response.json({ five_hour: { utilization: 99 }, cedar_ember: { eligible: true, grants: [{ id: `grant-${s.headers.get("authorization")}` }] } });
    const res = (await (await call("cl", "/api/oauth/usage?cedar_ember=1", { method: "GET" })).json()) as { five_hour: { utilization: number }; cedar_ember: { grants: Array<{ id: string }> } };
    expect(res.five_hour.utilization).toBe(30); // the served window, not the member's raw one
    expect(res.cedar_ember.grants[0]!.id).toBe("grant-Bearer tok-b");
    expect(seen).toHaveLength(1);
  });
  test("a pinned redeem goes out with the member's login and the member's organisation (a stale local uuid is replaced)", async () => {
    await addApp("cl", "claude", "anthropic", { target: { kind: "pin", identity: "a" } });
    reply = (s) => (new URL(s.url).pathname === "/api/oauth/profile" ? Response.json({ organization: { uuid: "org-of-a" } }) : Response.json({ result: "reset" }));
    const payload = '{"program":"cedar_ember","grant_id":"grant-a","request_id":"req-1"}';
    const res = await call("cl", "/api/organizations/org-stale/reset_rate_limits", { method: "POST", body: payload, headers: { "content-type": "application/json" } });
    expect(await res.json()).toEqual({ result: "reset" });
    const post = seen.find((x) => x.method === "POST")!;
    expect(new URL(post.url).pathname).toBe("/api/organizations/org-of-a/reset_rate_limits");
    expect(post.body).toBe(payload);
    expect(post.headers.get("authorization")).toBe("Bearer tok-a");
  });
  test("a matching organisation is left as it is", async () => {
    await addApp("cl", "claude", "anthropic", { target: { kind: "pin", identity: "a" } });
    reply = (s) => (new URL(s.url).pathname === "/api/oauth/profile" ? Response.json({ organization: { uuid: "org-of-a" } }) : Response.json({ result: "reset" }));
    await call("cl", "/api/organizations/org-of-a/reset_rate_limits", { method: "POST", body: '{"grant_id":"g"}' });
    expect(new URL(seen.find((x) => x.method === "POST")!.url).pathname).toBe("/api/organizations/org-of-a/reset_rate_limits");
  });
  test("a pool redeem goes to the member that owns the grant, even when another is less used", async () => {
    await addApp("cl", "claude", "anthropic");
    usage.a = { status: "live", maxUtilization: 5, capturedAt: "" }; // the pool would prefer a
    usage.b = { status: "live", maxUtilization: 95, capturedAt: "" };
    reply = (s) => {
      const who = s.headers.get("authorization");
      const path = new URL(s.url).pathname;
      if (path === "/api/oauth/usage") return Response.json({ cedar_ember: { grants: who === "Bearer tok-b" ? [{ id: "grant-of-b" }] : [{ id: "grant-of-a" }] } });
      if (path === "/api/oauth/profile") return Response.json({ organization: { uuid: who === "Bearer tok-b" ? "org-of-b" : "org-of-a" } });
      return Response.json({ result: "reset" });
    };
    await call("cl", "/api/organizations/org-of-a/reset_rate_limits", { method: "POST", body: '{"program":"cedar_ember","grant_id":"grant-of-b","request_id":"r"}' });
    const post = seen.find((x) => x.method === "POST")!;
    expect(post.headers.get("authorization")).toBe("Bearer tok-b");
    expect(new URL(post.url).pathname).toBe("/api/organizations/org-of-b/reset_rate_limits");
  });
  for (const status of [401, 429]) {
    test(`a ${status} on a telemetry call through the app route leaves the pool alone: the next chat uses the same member`, async () => {
      await addApp("cl", "claude", "anthropic");
      usage.a = { status: "live", maxUtilization: 10, capturedAt: "" };
      usage.b = { status: "live", maxUtilization: 50, capturedAt: "" };
      reply = (s) => (new URL(s.url).pathname === "/api/event_logging/batch" ? new Response("{}", { status, headers: { "retry-after": "60" } }) : Response.json({ id: "m", usage: { input_tokens: 1, output_tokens: 1 } }));
      const res = await call("cl", "/api/event_logging/batch", { method: "POST", body: "{}" });
      expect(res.status).toBe(status);
      expect(seen.every((x) => x.headers.get("authorization") !== "Bearer tok-b")).toBe(true); // no failover to another member
      if (status === 429) expect(seen).toHaveLength(1);
      seen.length = 0;
      expect((await call("cl", "/v1/messages", { method: "POST", body: '{"model":"m","messages":[]}', headers: { "content-type": "application/json" } })).status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.headers.get("authorization")).toBe("Bearer tok-a");
    });
  }
  test("the account relay keeps only content headers: no set-cookie, no upstream auth challenge, no hop-by-hop", async () => {
    await addApp("cl", "claude", "anthropic", { target: { kind: "pin", identity: "a" } });
    reply = () => new Response("{}", { headers: { "content-type": "application/json", "set-cookie": "sid=1", "www-authenticate": "Bearer realm=x", "x-api-key": "k", authorization: "Bearer leak", connection: "keep-alive", "keep-alive": "timeout=5", "retry-after": "3" } });
    const res = await call("cl", "/api/oauth/profile", { method: "GET" });
    for (const h of ["set-cookie", "www-authenticate", "x-api-key", "authorization", "keep-alive"]) expect(res.headers.get(h)).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/json");
  });
  test("an account route respects the pool's identity narrowing: owner probe and least-used pick stay inside the set", async () => {
    await addApp("cl", "claude", "anthropic", { target: { kind: "pool", identities: ["b"] } });
    usage.a = { status: "live", maxUtilization: 1, capturedAt: "" };
    usage.b = { status: "live", maxUtilization: 90, capturedAt: "" };
    reply = (s) => {
      const path = new URL(s.url).pathname;
      if (path === "/api/oauth/usage") return Response.json({ cedar_ember: { grants: [{ id: "grant-of-a" }] } }); // everyone "owns" it; only b may be asked
      if (path === "/api/oauth/profile") return Response.json({ organization: { uuid: "org-of-b" } });
      return Response.json({ result: "reset" });
    };
    await call("cl", "/api/organizations/org-x/reset_rate_limits", { method: "POST", body: '{"grant_id":"grant-of-a"}' });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((x) => x.headers.get("authorization") === "Bearer tok-b")).toBe(true);
    await call("cl", "/api/oauth/profile", { method: "GET" });
    expect(seen.every((x) => x.headers.get("authorization") === "Bearer tok-b")).toBe(true);
  });
  test("an org that cannot be read is fail-closed: 502 and the client's org is never sent", async () => {
    await addApp("cl", "claude", "anthropic", { target: { kind: "pin", identity: "a" } });
    reply = () => Response.json({});
    const res = await call("cl", "/api/organizations/org-stale/reset_rate_limits", { method: "POST", body: '{"grant_id":"g"}' });
    expect(res.status).toBe(502);
    expect(seen.some((x) => x.method === "POST")).toBe(false);
    expect(seen.every((x) => !x.url.includes("org-stale"))).toBe(true);
  });
  for (const path of ["/api/organizations/org-stale/reset_rate_limits", "/api/%6frganizations/org-stale/reset_rate_limits", "/api/organizations;x=1/org-stale/reset_rate_limits", "/API/Organizations/org-stale/reset_rate_limits", "/api/organizations/org-stale", "/api/oauth/organizations/org-stale/x", "/api/%256frganizations/org-stale/x"]) {
    test(`${path}: the organisation sent upstream is the member's`, async () => {
      await addApp("cl", "claude", "anthropic", { target: { kind: "pin", identity: "a" } });
      reply = (s) => (new URL(s.url).pathname === "/api/oauth/profile" ? Response.json({ organization: { uuid: "org-of-a" } }) : Response.json({ ok: true }));
      const res = await call("cl", path, { method: "POST", body: '{"grant_id":"g"}' });
      expect(res.status).toBe(200);
      const post = seen.find((x) => x.method === "POST")!;
      expect(post.url).toContain("org-of-a");
      expect(post.url).not.toContain("org-stale");
    });
  }
  for (const [method, path] of [
    ["POST", "/api/oauth/claude_cli/create_api_key"],
    ["POST", "/api/oauth/claude_cli/create%5Fapi%5Fkey"],
    ["POST", "/api/organizations/o/api_keys"],
    ["GET", "/api/organizations/o/API_KEYS/x"],
    ["POST", "/api/oauth/token"],
  ] as const) {
    test(`claude ${method} ${path} mints a credential: 403, nothing sent`, async () => {
      await addApp("cl", "claude", "anthropic", { target: { kind: "pin", identity: "a" } });
      expect((await call("cl", path, { method, body: "{}" })).status).toBe(403);
      expect(seen).toHaveLength(0);
    });
  }
  test("account bodies are bounded: declared and undeclared (streamed) bodies over the limit are 413 and not forwarded", async () => {
    await addApp("cl", "claude", "anthropic", { target: { kind: "pin", identity: "a" } });
    expect((await call("cl", "/api/event_logging/batch", { method: "POST", body: "x".repeat(2 * 1024 * 1024) })).status).toBe(413);
    const chunk = new Uint8Array(256 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (sent++ < 8) c.enqueue(chunk); else c.close(); } });
    const res = await call("cl", "/api/event_logging/batch", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });
  for (const path of ["/v1/sessions", "/v1/messages/batches", "/v1/complete", "/v1/whatever"]) {
    test(`claude POST ${path} is model traffic: allowlist, ledger row, pool failover on 429`, async () => {
      await addApp("cl", "claude", "anthropic", { models: ["only-this-model"] });
      const refused = await call("cl", path, { method: "POST", body: '{"model":"other-model"}' });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(seen).toHaveLength(0);
      usage.a = { status: "live", maxUtilization: 10, capturedAt: "" };
      usage.b = { status: "live", maxUtilization: 50, capturedAt: "" };
      reply = (s) => (s.headers.get("authorization") === "Bearer tok-a" ? new Response("{}", { status: 429, headers: { "retry-after": "5" } }) : Response.json({ ok: true }));
      const ok = await call("cl", path, { method: "POST", body: '{"model":"only-this-model"}' });
      expect(ok.status).toBe(200);
      expect(seen.map((x) => x.headers.get("authorization"))).toEqual(["Bearer tok-a", "Bearer tok-b"]);
      expect(requests.length).toBeGreaterThan(0);
    });
  }
  test("telemetry, hello and settings calls are not counted against the daily side limit; the rest still is", async () => {
    await addApp("cl", "claude", "anthropic", { target: { kind: "pin", identity: "a" } });
    deps.sideDailyLimit = 2;
    for (let i = 0; i < 5; i++) {
      expect((await call("cl", "/api/event_logging/batch", { method: "POST", body: "{}" })).status).toBe(200);
      expect((await call("cl", "/api/hello", { method: "GET" })).status).toBe(200);
      expect((await call("cl", "/api/claude_code/settings", { method: "GET" })).status).toBe(200);
    }
    expect((await call("cl", "/api/oauth/profile", { method: "GET" })).status).toBe(200);
    expect((await call("cl", "/api/oauth/profile", { method: "GET" })).status).toBe(200);
    expect((await call("cl", "/api/oauth/profile", { method: "GET" })).status).toBe(429);
  });
  test("an account call is counted as a side call (no token rows) and not refused at the reserve", async () => {
    await addApp("cl", "claude", "anthropic", { target: { kind: "pin", identity: "a" } });
    usage.a = { status: "live", maxUtilization: 100, capturedAt: "" };
    expect((await call("cl", "/api/oauth/usage?cedar_ember=1", { method: "GET" })).status).toBe(200);
    expect(requests.at(-1)).toMatchObject({ provider: "claude", status: "ok", httpStatus: 200 });
    expect(await store.usageSince("cl", new Date(0))).toBe(0);
  });
  test("a call with a bad app token is refused and nothing is sent upstream", async () => {
    await addApp("cl", "claude", "anthropic", { target: { kind: "pin", identity: "a" } });
    const res = await createGatewayApp(deps).request("http://gw.test/cl/api/oauth/usage?cedar_ember=1", { headers: { authorization: `Bearer ${WRONG_APP_TOKEN}` } });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });
  test("other /api paths Claude Code uses still pass through", async () => {
    await addApp("cl", "claude", "anthropic");
    for (const path of ["/api/hello", "/api/claude_code/settings", "/api/event_logging/batch"]) {
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
  test("plain pool usage is still served from pool state, trailing slash included", async () => {
    await addApp("cl", "claude", "anthropic");
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

  test("a slow database is cancelled on timeout and never has more than four calls in flight", async () => {
    await addApp("k", "kimi", "openai");
    deps.sideCountTimeoutMs = 150;
    let calls = 0;
    const signals: AbortSignal[] = [];
    store.bumpSideCount = (_a, _d, signal) => {
      calls += 1;
      if (signal) signals.push(signal);
      return new Promise<number>(() => {});
    };
    const app = createGatewayApp(deps);
    const hit = async () => (await app.request("http://gw.test/k/search", { method: "POST", body: "{}", headers: { authorization: `Bearer ${tokens.k}` } })).status;
    const codes = await Promise.all(Array.from({ length: 8 }, hit));
    expect(codes.every((c) => c === 200)).toBe(true);
    expect(calls).toBe(4);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  test("a healthy but slow database: a burst queues for slots, the shared limit holds, and nothing is reported as a failure", async () => {
    await addApp("k", "kimi", "openai");
    deps.sideDailyLimit = 5;
    let n = 0;
    store.bumpSideCount = async () => {
      await Bun.sleep(30);
      return ++n;
    };
    const health: boolean[] = [];
    let failOpens = 0;
    deps.sideCountHealth = (ok) => void health.push(ok);
    deps.metrics = { ...noopMetrics, failOpen: () => void (failOpens += 1) };
    const app = createGatewayApp(deps);
    const hit = async () => (await app.request("http://gw.test/k/search", { method: "POST", body: "{}", headers: { authorization: `Bearer ${tokens.k}` } })).status;
    const codes = await Promise.all(Array.from({ length: 20 }, hit));
    expect(codes.filter((c) => c === 200)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(15);
    expect(health.filter((h) => !h)).toHaveLength(0);
    expect(failOpens).toBe(0);
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

describe("account API of the other providers", () => {
  test("codex: a pinned app's usage and reset credits are the provider's real answers", async () => {
    await addApp("c", "codex", "openai", { target: { kind: "pin", identity: "a" } });
    reply = () => Response.json({ plan_type: "plus", available_count: 3 });
    expect(await (await call("c", "/wham/usage", { method: "GET" })).json()).toEqual({ plan_type: "plus", available_count: 3 });
    expect(await (await call("c", "/backend-api/wham/rate-limit-reset-credits", { method: "GET" })).json()).toEqual({ plan_type: "plus", available_count: 3 });
    expect(seen.map((x) => new URL(x.url).pathname)).toEqual(["/backend-api/wham/usage", "/backend-api/wham/rate-limit-reset-credits"]);
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer tok-a");
    expect(seen[0]!.headers.get("chatgpt-account-id")).toBe("acct");
  });
  test("codex: spending a credit goes to the member that has one, with its login", async () => {
    await addApp("c", "codex", "openai");
    usage.a = { status: "live", maxUtilization: 5, capturedAt: "" };
    reply = (s) => (s.method === "GET" ? Response.json({ available_count: s.headers.get("authorization") === "Bearer tok-b" ? 1 : 0 }) : Response.json({ ok: true }));
    for (const path of ["/api/codex/rate-limit-reset-credits/consume", "/backend-api/wham/rate-limit-reset-credits/consume"]) {
      seen.length = 0;
      const res = await call("c", path, { method: "POST", body: "{}" });
      expect(res.status).toBe(200);
      const post = seen.find((x) => x.method === "POST")!;
      expect(new URL(post.url).pathname).toBe("/backend-api/wham/rate-limit-reset-credits/consume");
      expect(post.headers.get("authorization")).toBe("Bearer tok-b");
    }
  });
  test("codex: a pinned consume goes to that identity", async () => {
    await addApp("c", "codex", "openai", { target: { kind: "pin", identity: "a" } });
    await call("c", "/wham/rate-limit-reset-credits/consume", { method: "POST", body: "{}" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer tok-a");
  });
  for (const [method, path, want] of [
    ["GET", "/backend-api/plugins/featured", "/backend-api/plugins/featured"],
    ["GET", "/backend-api/ps/plugins/installed", "/backend-api/ps/plugins/installed"],
    ["GET", "//backend-api/accounts/settings", "/backend-api/accounts/settings"],
    ["GET", "/BACKEND-API/accounts/settings", "/backend-api/accounts/settings"],
    ["POST", "/backend-api/wham/tasks", "/backend-api/wham/tasks"],
    ["GET", "/wham/tasks/list", "/backend-api/wham/tasks/list"],
  ] as const) {
    test(`codex ${method} ${path} is forwarded to ChatGPT with the member's login`, async () => {
      await addApp("c", "codex", "openai", { target: { kind: "pin", identity: "a" } });
      const res = await call("c", path, { method, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.headers.get("x-orig-host")).toBe("chatgpt.com");
      expect(new URL(seen[0]!.url).pathname).toBe(want);
      expect(seen[0]!.headers.get("authorization")).toBe("Bearer tok-a");
      expect(seen[0]!.headers.get("chatgpt-account-id")).toBe("acct");
    });
  }
  for (const [label, opts] of [["pool", undefined], ["pinned", { target: { kind: "pin", identity: "a" } }]] as const) {
    test(`codex ${label}: accounts/check is served from the app, no upstream call`, async () => {
      await addApp("c", "codex", "openai", opts as never);
      for (const path of ["/backend-api/wham/accounts/check", "/wham/accounts/check", "//BACKEND-API/wham/accounts/check", "/backend-api/accounts/check/v4-2023-04-27"]) {
        seen.length = 0;
        const res = await call("c", path);
        expect(res.status).toBe(200);
        expect(seen).toHaveLength(0);
        const body = (await res.json()) as { default_account_id: string; accounts: Array<{ id: string; workspace_backend_origin: string }> };
        expect(body.default_account_id).toBe("ais-c");
        expect(body.accounts[0]!.id).toBe("ais-c");
        expect(body.accounts[0]!.workspace_backend_origin).toBe("NO_CONSTRAINT");
      }
    });
  }
  const others: Array<[GatewayProvider, ApiStyle, string, string, string]> = [
    ["kimi", "anthropic", "/usages", "api.kimi.com", "/coding/v1/usages"],
    ["kimi", "openai", "/v1/usages", "api.kimi.com", "/coding/v1/usages"],
    ["zai", "anthropic", "/api/monitor/usage/quota/limit", "api.z.ai", "/api/monitor/usage/quota/limit"],
    ["opencode", "openai", "/usage", "opencode.ai", "/zen/go/v1/usage"],
  ];
  for (const [provider, style, path, host, want] of others) {
    test(`${provider} ${path} is forwarded to ${host}${want} with the member's login, never the app token`, async () => {
      await addApp("app", provider, style, { target: { kind: "pin", identity: "a" }, models: ["only-this-model"] });
      const res = await call("app", path, { method: "GET" });
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.headers.get("x-orig-host")).toBe(host);
      expect(new URL(seen[0]!.url).pathname).toBe(want);
      expect(seen[0]!.headers.get("authorization") ?? seen[0]!.headers.get("x-api-key")).not.toContain("aisg_");
    });
  }
  test("an unknown app token reaches no provider on any of these paths", async () => {
    await addApp("c", "codex", "openai", { target: { kind: "pin", identity: "a" } });
    for (const path of ["/backend-api/plugins/featured", "/wham/usage"]) {
      const res = await createGatewayApp(deps).request(`http://gw.test/c${path}`, { headers: { authorization: `Bearer ${WRONG_APP_TOKEN}` } });
      expect(res.status).toBe(401);
    }
    expect(seen).toHaveLength(0);
  });
});
