import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAdminApp } from "../../src/gateway/admin.ts";
import { CachedGatewayStore } from "../../src/gateway/cache-store.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";

const ADMIN = "adm-test-value-0001-0123456789abcdef";
let now: Date;
let inner: MemoryGatewayStore;
let store: CachedGatewayStore;
let app: ReturnType<typeof createAdminApp>;

const call = (path: string, token: string | null = ADMIN) =>
  app.request(`http://admin.test${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

beforeEach(async () => {
  now = new Date("2026-11-02T10:00:00.000Z");
  inner = new MemoryGatewayStore();
  store = new CachedGatewayStore(inner);
  await store.warm();
  app = createAdminApp({ store, adminToken: ADMIN, now: () => now });
});
afterEach(() => store.stop());

describe("admin GET /usage/models", () => {
  const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const base = { app: "web", provider: "claude" as const, cacheReadTokens: 0, cacheWriteTokens: 0, status: "ok", httpStatus: 200, latencyMs: 1, streamed: false };
  const seed = () =>
    inner.appendUsage([
      { ...base, ts: at(3600_000), identity: "m1", model: "sonnet", inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, estCostUsd: 0.5 },
      { ...base, ts: at(2 * 3600_000), identity: "m1", model: "sonnet", inputTokens: 1, outputTokens: 1, estCostUsd: 0.1 },
      { ...base, ts: at(3600_000), identity: "m1", model: "opus", inputTokens: 7, outputTokens: 0, estCostUsd: 0.25 },
      { ...base, ts: at(3600_000), identity: "m1", inputTokens: 2, outputTokens: 2 },
      { ...base, ts: at(5 * 86400_000), identity: "m1", model: "sonnet", inputTokens: 1000, outputTokens: 0, estCostUsd: 9 },
      { ...base, ts: at(3600_000), provider: "codex", identity: "m1", model: "gpt", inputTokens: 2, outputTokens: 2, estCostUsd: 1 },
    ]);

  test("401 without the admin token", async () => {
    expect((await call("/usage/models", null)).status).toBe(401);
    expect((await call("/usage/models", "wrong")).status).toBe(401);
  });

  test("groups the ledger by provider, identity, app and model, keeping a null model", async () => {
    await seed();
    const day = (await (await call("/usage/models?days=1&provider=claude")).json()) as any;
    expect(day.since).toBe(at(86400_000));
    expect(day.models).toEqual([
      { provider: "claude", identity: "m1", app: "web", model: "sonnet", inputTokens: 11, outputTokens: 6, cacheReadTokens: 100, cacheWriteTokens: 0, estCostUsd: 0.6, unpricedRequests: 0, requests: 2, firstTs: at(2 * 3600_000), lastTs: at(3600_000) },
      { provider: "claude", identity: "m1", app: "web", model: "opus", inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0.25, unpricedRequests: 0, requests: 1, firstTs: at(3600_000), lastTs: at(3600_000) },
      { provider: "claude", identity: "m1", app: "web", model: null, inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0, unpricedRequests: 1, requests: 1, firstTs: at(3600_000), lastTs: at(3600_000) },
    ]);
  });

  test("a wider window includes older rows; since/until bound the read", async () => {
    await seed();
    const wide = (await (await call("/usage/models?days=7&provider=claude")).json()) as any;
    expect(wide.models.find((r: any) => r.model === "sonnet").inputTokens).toBe(1011);
    const win = (await (await call(`/usage/models?since=${encodeURIComponent(at(2 * 3600_000))}&until=${encodeURIComponent(at(1800_000))}`)).json()) as any;
    expect(win.models.map((r: any) => `${r.provider}/${r.model}`).sort()).toEqual(["claude/null", "claude/opus", "claude/sonnet", "codex/gpt"]);
    expect(win.until).toBe(at(1800_000));
  });

  test("the provider filter and window validation match /usage/identities", async () => {
    await seed();
    const codex = (await (await call("/usage/models?days=1&provider=codex")).json()) as any;
    expect(codex.models.map((r: any) => r.model)).toEqual(["gpt"]);
    expect((await call("/usage/models?days=0")).status).toBe(400);
    expect((await call("/usage/models?days=91")).status).toBe(400);
    expect((await call("/usage/models?since=nope")).status).toBe(400);
    expect((await call("/usage/models?until=nope")).status).toBe(400);
    expect((await call("/usage/models?provider=bogus")).status).toBe(400);
    expect((await call(`/usage/models?since=${encodeURIComponent(at(91 * 86400_000))}`)).status).toBe(400);
  });
});