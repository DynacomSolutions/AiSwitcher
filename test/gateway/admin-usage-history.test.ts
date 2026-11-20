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

const G1 = "2026-11-18T10:00:00.000Z";
const G2 = "2026-11-19T20:19:38.328Z";
const SRC = "source=host-snapshot-models";
const row = (over: Record<string, unknown> = {}) => ({ source: "host-snapshot-models", generation: G1, zone: "Asia/Bangkok", firstDay: "2026-04-01", lastDay: "2026-11-01", provider: "claude", identity: "m1", day: null, model: "opus", inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, messages: 5, estCostUsd: 6.5, ...over });

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

  test("source is required: a read without it, or with a bad one, is a 400", async () => {
    expect((await call("/usage/history")).status).toBe(400);
    expect(((await (await call("/usage/history?provider=claude")).json()) as any).error).toContain("source is required");
    expect((await call("/usage/history?source=Bad%20Source")).status).toBe(400);
  });

  test("imports a batch idempotently and reads one source back", async () => {
    const body = { rows: [row(), row({ day: "2020-01-02", model: null, source: "host-snapshot-daily" }), row({ provider: "codex" })] };
    const first = await call("/usage/history", { method: "POST", body });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ imported: 3 });
    await call("/usage/history", { method: "POST", body });
    const models = (await (await call(`/usage/history?${SRC}`)).json()) as any;
    expect(models).toMatchObject({ source: "host-snapshot-models", generation: "latest" });
    expect(models.history.map((r: any) => `${r.provider}/${r.source}/${r.day}/${r.model}`)).toEqual(["claude/host-snapshot-models/null/opus", "codex/host-snapshot-models/null/opus"]);
    expect(models.history[0]).toMatchObject({ generation: G1, zone: "Asia/Bangkok", firstDay: "2026-04-01", lastDay: "2026-11-01", inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, messages: 5, estCostUsd: 6.5 });
    const daily = (await (await call("/usage/history?source=host-snapshot-daily")).json()) as any;
    expect(daily.history).toHaveLength(1);
  });

  test("the same generation replaces its rows exactly; a new generation adds rows and is the default", async () => {
    await call("/usage/history", { method: "POST", body: { rows: [row()] } });
    await call("/usage/history", { method: "POST", body: { rows: [row({ estCostUsd: 1 })] } });
    const get = async (q: string) => ((await (await call(`/usage/history?${SRC}${q}`)).json()) as any).history as any[];
    expect((await get("")).map((r) => r.estCostUsd)).toEqual([1]);
    await call("/usage/history", { method: "POST", body: { rows: [row({ generation: G2, estCostUsd: 9 })] } });
    expect((await get("")).map((r) => `${r.generation}/${r.estCostUsd}`)).toEqual([`${G2}/9`]);
    expect((await get("&generation=latest")).map((r) => r.estCostUsd)).toEqual([9]);
    expect((await get(`&generation=${G1}`)).map((r) => r.estCostUsd)).toEqual([1]);
    expect((await call(`/usage/history?${SRC}&generation=yesterday`)).status).toBe(400);
  });

  test("filters by provider and identity; since and until are inclusive days and leave out all-time rows", async () => {
    const d = (day: string) => row({ day, model: null, source: "host-snapshot-daily" });
    await call("/usage/history", { method: "POST", body: { rows: [row(), d("2026-10-01"), d("2026-11-01"), d("2026-11-02"), row({ identity: "m2", day: "2026-10-05", model: null, source: "host-snapshot-daily" })] } });
    const get = async (q: string) => ((await (await call(`/usage/history?source=host-snapshot-daily&${q}`)).json()) as any).history as any[];
    expect(await get("identity=m2")).toHaveLength(1);
    expect(await get("provider=codex")).toHaveLength(0);
    expect((await get("identity=m1&since=2026-10-15")).map((r) => r.day)).toEqual(["2026-11-01", "2026-11-02"]);
    expect((await get("identity=m1&until=2026-11-01")).map((r) => r.day)).toEqual(["2026-10-01", "2026-11-01"]);
    expect((await get("identity=m1&since=2026-11-01&until=2026-11-01")).map((r) => r.day)).toEqual(["2026-11-01"]);
    expect(((await (await call(`/usage/history?${SRC}&until=2026-12-31`)).json()) as any).history).toEqual([]);
    for (const bad of ["since=nope", "until=nope", "until=2026-11-01T00:00:00.000Z", "until=2026-02-30", "since=2026-11-01T00:00:00Z"]) expect((await call(`/usage/history?${SRC}&${bad}`)).status).toBe(400);
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
    expect((await post({ rows: [row({ generation: undefined })] })).error).toContain("generation");
    expect((await post({ rows: [row({ generation: "2026-11-18" })] })).error).toContain("generation");
    expect((await post({ rows: [row({ zone: "Mars/Base" })] })).error).toContain("zone");
    expect((await post({ rows: [row({ zone: undefined })] })).error).toContain("zone");
    expect((await post({ rows: [row({ firstDay: "soon" })] })).error).toContain("firstDay");
    expect((await post({ rows: [row({ lastDay: 5 })] })).error).toContain("lastDay");
    expect((await post({ rows: [row({ day: "2026-02-30" })] })).error).toContain("day");
    expect((await post({ rows: [row({ day: "yesterday" })] })).error).toContain("day");
    expect((await post({ rows: [row({ inputTokens: -1 })] })).error).toContain("inputTokens");
    expect((await post({ rows: [row({ messages: 1.5 })] })).error).toContain("messages");
    expect((await post({ rows: [row({ estCostUsd: "1" })] })).error).toContain("estCostUsd");
    expect((await post({ rows: [row({ model: 4 })] })).error).toContain("model");
    expect((await post({ rows: ["x"] })).error).toContain("object");
    // Nothing from a rejected batch was stored.
    expect(((await (await call(`/usage/history?${SRC}`)).json()) as any).history).toEqual([]);
  });

  test("a missing model, day or figure imports as null or zero, and an empty model is null", async () => {
    await call("/usage/history", { method: "POST", body: { rows: [{ source: "s", generation: G1, zone: "UTC", provider: "aws-bedrock", identity: "b", model: "" }] } });
    const rows = ((await (await call("/usage/history?source=s")).json()) as any).history;
    expect(rows).toMatchObject([{ provider: "aws-bedrock", day: null, model: null, inputTokens: 0, estCostUsd: 0, firstDay: null, lastDay: null, zone: "UTC" }]);
  });
});
