import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAdminApp, MAX_HISTORY_BATCH } from "../../src/gateway/admin.ts";
import { CachedGatewayStore } from "../../src/gateway/cache-store.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";

const ADMIN = "adm-test-value-0001-0123456789abcdef";
let store: CachedGatewayStore;
let app: ReturnType<typeof createAdminApp>;

const call = (path: string, init: { method?: string; body?: unknown; token?: string | null } = {}) => {
  const token = init.token === undefined ? ADMIN : init.token;
  return app.request(`http://admin.test${path}`, {
    method: init.method ?? "GET",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    ...(init.body !== undefined ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) } : {}),
  });
};

const row = (over: Record<string, unknown> = {}) => ({ source: "host-snapshot-models", provider: "claude", identity: "m1", day: null, model: "opus", inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, messages: 5, estCostUsd: 6.5, ...over });

beforeEach(async () => {
  store = new CachedGatewayStore(new MemoryGatewayStore());
  await store.warm();
  app = createAdminApp({ store, adminToken: ADMIN, now: () => new Date("2026-11-20T10:00:00.000Z") });
});
afterEach(() => store.stop());

describe("admin /usage/history", () => {
  test("401 without the admin token", async () => {
    expect((await call("/usage/history", { token: null })).status).toBe(401);
    expect((await call("/usage/history", { method: "POST", body: { rows: [row()] }, token: "wrong" })).status).toBe(401);
  });

  test("imports a batch idempotently and reads it back over all time", async () => {
    const body = { rows: [row(), row({ day: "2020-01-02", model: null, source: "host-snapshot-daily" }), row({ provider: "codex" })] };
    const first = await call("/usage/history", { method: "POST", body });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ imported: 3 });
    await call("/usage/history", { method: "POST", body });
    const all = (await (await call("/usage/history")).json()) as any;
    expect(all.history).toHaveLength(3);
    expect(all.history.map((r: any) => `${r.provider}/${r.source}/${r.day}/${r.model}`)).toEqual([
      "claude/host-snapshot-models/null/opus",
      "claude/host-snapshot-daily/2020-01-02/null",
      "codex/host-snapshot-models/null/opus",
    ]);
    expect(all.history[0]).toMatchObject({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, messages: 5, estCostUsd: 6.5 });
  });

  test("filters by source, provider and identity; a day window leaves out all-time rows", async () => {
    await call("/usage/history", { method: "POST", body: { rows: [row(), row({ day: "2026-10-01", model: null, source: "host-snapshot-daily" }), row({ day: "2026-11-01", model: null, source: "host-snapshot-daily" }), row({ identity: "m2" })] } });
    const get = async (q: string) => ((await (await call(`/usage/history?${q}`)).json()) as any).history as any[];
    expect(await get("source=host-snapshot-daily")).toHaveLength(2);
    expect(await get("identity=m2")).toHaveLength(1);
    expect(await get("provider=codex")).toHaveLength(0);
    expect((await get("since=2026-10-15")).map((r) => r.day)).toEqual(["2026-11-01"]);
    expect((await get("until=2026-11-01")).map((r) => r.day)).toEqual(["2026-10-01"]);
    expect((await get("since=2026-10-01T00:00:00.000Z&until=2026-12-01")).map((r) => r.day)).toEqual(["2026-10-01", "2026-11-01"]);
    expect((await call("/usage/history?since=nope")).status).toBe(400);
    expect((await call("/usage/history?until=nope")).status).toBe(400);
  });

  test("rejects a bad body with a named problem", async () => {
    const post = async (body: unknown) => {
      const res = await call("/usage/history", { method: "POST", body });
      return { status: res.status, error: ((await res.json()) as any).error as string };
    };
    expect((await call("/usage/history", { method: "POST", body: "{nope" })).status).toBe(400);
    expect((await post({})).error).toContain("rows must be a list");
    expect((await post({ rows: [] })).error).toContain("must not be empty");
    expect((await post({ rows: Array.from({ length: MAX_HISTORY_BATCH + 1 }, () => row()) })).error).toContain("at most");
    expect((await post({ rows: [row({ source: "Bad Source" })] })).error).toContain("source");
    expect((await post({ rows: [row({ provider: "" })] })).error).toContain("provider");
    expect((await post({ rows: [row({ identity: 3 })] })).error).toContain("identity");
    expect((await post({ rows: [row({ day: "2026-02-30" })] })).error).toContain("day");
    expect((await post({ rows: [row({ day: "yesterday" })] })).error).toContain("day");
    expect((await post({ rows: [row({ inputTokens: -1 })] })).error).toContain("inputTokens");
    expect((await post({ rows: [row({ messages: 1.5 })] })).error).toContain("messages");
    expect((await post({ rows: [row({ estCostUsd: "1" })] })).error).toContain("estCostUsd");
    expect((await post({ rows: [row({ model: 4 })] })).error).toContain("model");
    expect((await post({ rows: ["x"] })).error).toContain("object");
    // Nothing from a rejected batch was stored.
    expect(((await (await call("/usage/history")).json()) as any).history).toEqual([]);
  });

  test("a missing model, day or figure imports as null or zero, and an empty model is null", async () => {
    await call("/usage/history", { method: "POST", body: { rows: [{ source: "s", provider: "aws-bedrock", identity: "b", model: "" }] } });
    const rows = ((await (await call("/usage/history")).json()) as any).history;
    expect(rows).toMatchObject([{ provider: "aws-bedrock", day: null, model: null, inputTokens: 0, estCostUsd: 0 }]);
  });
});
