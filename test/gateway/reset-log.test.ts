import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { ManualResetInfo } from "../../src/cli/limits/types.ts";
import type { PoolUsage } from "../../src/identities/pool/adapter.ts";
import { createAdminApp } from "../../src/gateway/admin.ts";
import { MemoryAutoResetStore } from "../../src/gateway/auto-reset-store.ts";
import { createAutoResetRecovery, type AutoResetUsage } from "../../src/gateway/auto-reset.ts";
import { PrometheusMetrics } from "../../src/gateway/metrics.ts";
import { migrate } from "../../src/gateway/pg-store.ts";
import {
  createResetLogger, decodeResetLogCursor, encodeResetLogCursor, MemoryResetLog, parseResetLogQuery, PgResetLog, resetLogWindows, type ResetLogEntry, type ResetLogPage, type ResetLogProvider, type ResetLogStore,
} from "../../src/gateway/reset-log.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { createUsageSource } from "../../src/gateway/usage-source.ts";
import { createApp } from "../../src/server/app.ts";

const ADMIN = "admin_SYNTHETIC_FIXTURE";
const CONSOLE = "console_SYNTHETIC_FIXTURE";
const NOW = Date.parse("2026-11-27T08:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const GRANT = "grant_SYNTHETIC_FIXTURE_one";
const REQUEST_ID = "6f1c7b52-3d2e-4f6a-8b1d-0a1b2c3d4e5f";

const claudeUsage = (week = 100, capturedAt = NOW): PoolUsage => ({
  status: week >= 100 ? "rate-limited" : "live", capturedAt: iso(capturedAt), windows: [
    { label: "five-hour", utilization: 41, resetsAt: iso(NOW + 3_600_000) },
    { label: "seven-day", utilization: week, resetsAt: iso(NOW + 86_400_000) },
    { label: "seven-day (Opus)", model: "Opus", utilization: 88, resetsAt: iso(NOW + 86_400_000) },
    { label: "seven-day (Sonnet)", model: "Sonnet", utilization: 12, resetsAt: iso(NOW + 86_400_000) },
  ],
});

const codexUsage = (used = 100, capturedAt = NOW): AutoResetUsage => ({
  status: used >= 100 ? "rate-limited" : "live", capturedAt: iso(capturedAt), windows: [
    { label: "session", utilization: used, resetsAt: iso(NOW + 600_000) },
    { label: "week", utilization: used, resetsAt: iso(NOW + 600_000) },
    { label: "week", model: "gpt-5-codex", utilization: 7, resetsAt: iso(NOW + 600_000) },
  ],
});

function entry(over: Partial<ResetLogEntry> = {}): ResetLogEntry {
  return {
    at: iso(NOW), startedAt: iso(NOW - 1_000), provider: "claude", trigger: "manual", actor: "user", identity: "fixture-account", account: null, pool: null,
    grantId: GRANT, before: resetLogWindows(claudeUsage()), outcome: "reset", message: null, resetsLeftAfter: null, ...over,
  };
}

describe("usage windows", () => {
  test("every window of a reading gets a stable key", () => {
    expect(resetLogWindows(claudeUsage())).toEqual([
      { key: "five_hour", label: "five-hour", percent: 41, resetsAt: iso(NOW + 3_600_000) },
      { key: "weekly", label: "seven-day", percent: 100, resetsAt: iso(NOW + 86_400_000) },
      { key: "weekly_opus", label: "seven-day (Opus)", percent: 88, resetsAt: iso(NOW + 86_400_000) },
      { key: "weekly_sonnet", label: "seven-day (Sonnet)", percent: 12, resetsAt: iso(NOW + 86_400_000) },
    ]);
    expect(resetLogWindows(codexUsage()).map((w) => w.key)).toEqual(["five_hour", "weekly", "weekly_gpt_5_codex"]);
  });

  test("a missing reset time is null, a repeated key is numbered, and a missing reading gives no window", () => {
    const twice = resetLogWindows({ windows: [{ label: "usage", utilization: 1 }, { label: "usage", utilization: 2 }] });
    expect(twice).toEqual([
      { key: "usage", label: "usage", percent: 1, resetsAt: null },
      { key: "usage_2", label: "usage", percent: 2, resetsAt: null },
    ]);
    expect(resetLogWindows(undefined)).toEqual([]);
  });
});

describe("query", () => {
  const parse = (q: Record<string, string>) => parseResetLogQuery((name) => q[name]);

  test("accepts the filters, makes a date-only end inclusive and caps the limit", () => {
    expect(parse({})).toEqual({});
    expect(parse({
      identity: "a", provider: "claude", trigger: "auto", outcome: "error", from: "2026-11-01", to: "2026-11-02", limit: "9999", before: encodeResetLogCursor({ at: "2026-11-27T08:00:00.000Z", id: "42" }),
    })).toEqual({
      identity: "a", provider: "claude", trigger: "auto", outcome: "error", from: "2026-11-01T00:00:00.000Z",
      toExclusive: "2026-11-03T00:00:00.000Z", limit: 500, before: { at: "2026-11-27T08:00:00.000Z", id: "42" },
    });
    expect(parse({ from: "2026-11-01T10:00:00Z", to: "2026-11-02T10:00:00.000Z" })).toEqual({
      from: "2026-11-01T10:00:00.000Z", toExclusive: "2026-11-02T10:00:00.001Z",
    });
  });

  test("ICT day bounds from the web page: the first and last instants of the day belong to it", () => {
    const filters = parse({ from: "2026-11-28T00:00:00+07:00", to: "2026-11-28T23:59:59.999+07:00" });
    expect(filters).toEqual({ from: "2026-11-27T17:00:00.000Z", toExclusive: "2026-11-28T17:00:00.000Z" });
    const inDay = (at: string) => typeof filters !== "string" && Date.parse(at) >= Date.parse(filters.from!) && Date.parse(at) < Date.parse(filters.toExclusive!);
    expect(inDay("2026-11-27T16:59:59.999Z")).toBe(false);
    expect(inDay("2026-11-27T17:00:00.000Z")).toBe(true);
    expect(inDay("2026-11-28T16:59:59.999Z")).toBe(true);
    expect(inDay("2026-11-28T17:00:00.000Z")).toBe(false);
  });

  test("names the first bad value", () => {
    for (const [query, text] of [
      [{ provider: "kimi" }, "provider"], [{ trigger: "x" }, "trigger"], [{ outcome: "x" }, "outcome"], [{ from: "yesterday" }, "from"],
      [{ to: "2026-02-31" }, "to"], [{ limit: "0" }, "limit"], [{ limit: "1.5" }, "limit"], [{ before: "abc" }, "before"],
    ] as const) expect(parse({ ...query })).toContain(text);
  });
});

describe("memory store", () => {
  async function seeded(): Promise<MemoryResetLog> {
    const store = new MemoryResetLog();
    await store.insert(entry({ at: iso(NOW), identity: "alpha" }));
    await store.insert(entry({ at: iso(NOW + 1_000), identity: "beta", provider: "codex", trigger: "auto", outcome: "no_credit" }));
    await store.insert(entry({ at: iso(NOW + 2_000), identity: "alpha", outcome: "error", message: "synthetic failure" }));
    await store.insert(entry({ at: iso(NOW + 86_400_000 + 5), identity: "alpha" }));
    return store;
  }

  test("lists newest first with the identities for the filter menu", async () => {
    const page = await (await seeded()).list({});
    expect(page.rows.map((row) => row.id)).toEqual(["4", "3", "2", "1"]);
    expect(page.identities).toEqual(["alpha", "beta"]);
    expect(page.nextBefore).toBeNull();
  });

  test("filters by identity, provider, trigger, outcome and time", async () => {
    const store = await seeded();
    const ids = async (filters: Parameters<ResetLogStore["list"]>[0]) => (await store.list(filters)).rows.map((row) => row.id);
    expect(await ids({ identity: "beta" })).toEqual(["2"]);
    expect(await ids({ provider: "codex" })).toEqual(["2"]);
    expect(await ids({ trigger: "auto" })).toEqual(["2"]);
    expect(await ids({ outcome: "error" })).toEqual(["3"]);
    expect(await ids({ from: iso(NOW + 1_000), toExclusive: iso(NOW + 3_000) })).toEqual(["3", "2"]);
    // A page keeps the filters of the menu: identities list the whole table.
    expect((await store.list({ identity: "beta" })).identities).toEqual(["alpha", "beta"]);
  });

  test("pages with a cursor", async () => {
    const store = await seeded();
    const first = await store.list({ limit: 3 });
    expect(first.rows.map((row) => row.id)).toEqual(["4", "3", "2"]);
    expect(decodeResetLogCursor(first.nextBefore!)).toEqual({ at: iso(NOW + 1_000), id: "2" });
    const second = await store.list({ limit: 3, before: decodeResetLogCursor(first.nextBefore!)! });
    expect(second.rows.map((row) => row.id)).toEqual(["1"]);
    expect(second.nextBefore).toBeNull();
    // A page of exactly the limit has no next page.
    expect((await store.list({ limit: 4 })).nextBefore).toBeNull();
  });

  test("fills `after` once per row, and only from a later reading", async () => {
    const store = new MemoryResetLog();
    await store.insert(entry({ at: iso(NOW) }));
    const after = resetLogWindows(claudeUsage(3));
    expect(await store.fillAfter("claude", "fixture-account", after, iso(NOW))).toEqual({ filled: 0, pending: true });
    expect(await store.fillAfter("claude", "other", after, iso(NOW + 1))).toEqual({ filled: 0, pending: false });
    expect(await store.fillAfter("claude", "fixture-account", after, iso(NOW + 1))).toEqual({ filled: 1, pending: false });
    expect(await store.fillAfter("claude", "fixture-account", resetLogWindows(claudeUsage(50)), iso(NOW + 2))).toEqual({ filled: 0, pending: false });
    expect((await store.list({})).rows[0]).toMatchObject({ after, afterAt: iso(NOW + 1) });
  });
});

describe("logger", () => {
  function setup(over: { failInserts?: boolean } = {}) {
    const store = new MemoryResetLog();
    store.failInserts = over.failInserts === true;
    const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
    const logs: string[] = [];
    let now = NOW;
    const logger = createResetLogger({
      store, metrics, now: () => now, log: (line) => logs.push(line), retryBackoffMs: [0, 0],
      usageFor: async () => claudeUsage(),
    });
    return { store, metrics, logs, logger, tick: (ms: number) => { now += ms; } };
  }

  test("a row takes the windows of the cached reading from before the reset, and the resets counter counts it", async () => {
    const { store, logger, metrics } = setup();
    const attempt = await logger.begin({ provider: "claude", trigger: "manual", actor: "user:console", identity: "fixture-account", grantId: GRANT });
    await attempt.finish({ outcome: "reset", resetsLeftAfter: 2 });
    await attempt.finish({ outcome: "error" });
    const rows = (await store.list({})).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "claude", trigger: "manual", actor: "user:console", identity: "fixture-account", grantId: GRANT, outcome: "reset",
      resetsLeftAfter: 2, after: null, afterAt: null, account: null, pool: null, message: null, at: iso(NOW),
    });
    expect(rows[0]?.before.map((w) => w.key)).toEqual(["five_hour", "weekly", "weekly_opus", "weekly_sonnet"]);
    expect(metrics.render()).toContain('ais_gateway_resets_total{provider="claude",trigger="manual",outcome="reset"} 1');
  });

  test("a failed write never rejects, is counted and logged without secrets", async () => {
    const { store, logger, metrics, logs } = setup({ failInserts: true });
    const attempt = await logger.begin({ provider: "codex", trigger: "auto", actor: "auto-reset-worker", identity: "fixture-account" });
    await attempt.finish({ outcome: "error", message: "Bearer token-SYNTHETIC_FIXTURE-abcdef" });
    expect(await store.list({})).toMatchObject({ rows: [] });
    const text = metrics.render();
    expect(text).toContain('ais_gateway_reset_log_write_failures_total{provider="codex"} 1');
    // The reset is still counted.
    expect(text).toContain('ais_gateway_resets_total{provider="codex",trigger="auto",outcome="error"} 1');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("reset log write failed");
    expect(logs.join("\n")).not.toContain("SYNTHETIC_FIXTURE");
  });

  test("a store that hangs is cut short, and a failing usage read leaves the windows empty", async () => {
    const hung: ResetLogStore = { ...new MemoryResetLog(), insert: () => new Promise(() => {}) } as unknown as ResetLogStore;
    const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
    const logger = createResetLogger({
      store: hung, metrics, storeTimeoutMs: 20, retryBackoffMs: [], log: () => {}, usageFor: async () => { throw new Error("synthetic usage failure"); },
    });
    const attempt = await logger.begin({ provider: "claude", trigger: "manual", actor: "user", identity: "x" });
    await attempt.finish({ outcome: "reset" });
    expect(metrics.render()).toContain('ais_gateway_reset_log_write_failures_total{provider="claude"} 1');
  });

  test("a row holds no secret field, and free text loses credential-shaped parts", async () => {
    const { store, logger } = setup();
    const attempt = await logger.begin({ provider: "claude", trigger: "manual", actor: "user", identity: "fixture-account", grantId: GRANT });
    await attempt.finish({ outcome: "error", message: "refused with Bearer token-SYNTHETIC_FIXTURE-abcdefgh and api_key=key-SYNTHETIC_FIXTURE-12345678" });
    const [row] = (await store.list({})).rows;
    expect(Object.keys(row!).sort()).toEqual([
      "account", "actor", "after", "afterAt", "at", "before", "grantId", "id", "identity", "message", "outcome", "pool",
      "provider", "resetsLeftAfter", "startedAt", "trigger",
    ]);
    expect(JSON.stringify(row)).not.toMatch(/SYNTHETIC_FIXTURE-(abcdefgh|12345678)|token-|bearer [a-z]/i);
    expect(row?.message).toContain("[redacted]");
  });

  test("the first later reading fills `after` once, and an older or stale reading does not", async () => {
    const { store, logger, tick } = setup();
    const attempt = await logger.begin({ provider: "claude", trigger: "auto", actor: "auto-reset-worker", identity: "fixture-account" });
    tick(1_000);
    await attempt.finish({ outcome: "reset" });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
    logger.onReading("claude", "fixture-account", claudeUsage(100, NOW));
    logger.onReading("claude", "fixture-account", { ...claudeUsage(2, NOW + 5_000), stale: true });
    logger.onReading("claude", "other", claudeUsage(2, NOW + 5_000));
    await settle();
    expect((await store.list({})).rows[0]?.after).toBeNull();
    logger.onReading("claude", "fixture-account", claudeUsage(2, NOW + 5_000));
    await settle();
    logger.onReading("claude", "fixture-account", claudeUsage(60, NOW + 9_000));
    await settle();
    const [row] = (await store.list({})).rows;
    expect(row?.afterAt).toBe(iso(NOW + 5_000));
    expect(row?.after?.find((w) => w.key === "weekly")?.percent).toBe(2);
  });

  test("a new replica loads the members that still wait for a reading", async () => {
    const store = new MemoryResetLog();
    await store.insert(entry({ at: iso(NOW) }));
    const logger = createResetLogger({ retryBackoffMs: [0, 0], store, now: () => NOW + 60_000, log: () => {} });
    await logger.warm();
    logger.onReading("claude", "fixture-account", claudeUsage(1, NOW + 30_000));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await store.list({})).rows[0]?.after).not.toBeNull();
  });

  test("the usage cache hands every stored current reading to the log", async () => {
    const store = new MemoryResetLog();
    await store.insert(entry({ at: iso(NOW) }));
    const logger = createResetLogger({ retryBackoffMs: [0, 0], store, now: () => NOW, log: () => {} });
    await logger.warm();
    const source = createUsageSource({
      log: () => {},
      fetchUsage: async () => claudeUsage(5, NOW + 10_000),
      onReading: (provider, identity, reading) => logger.onReading(provider, identity, reading),
    });
    await source.prefill("claude", "fixture-account");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await store.list({})).rows[0]).toMatchObject({ afterAt: iso(NOW + 10_000) });
  });
});

describe("manual resets through the gateway admin API", () => {
  function fixture(over: Partial<Parameters<typeof createAdminApp>[0]> = {}) {
    const store = new MemoryResetLog();
    const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
    const logger = createResetLogger({
      retryBackoffMs: [0, 0], store, metrics, now: () => NOW, log: () => {},
      usageFor: async (provider: ResetLogProvider) => (provider === "claude" ? claudeUsage() : codexUsage()),
    });
    const app = createAdminApp({
      store: new MemoryGatewayStore(), adminToken: ADMIN, now: () => new Date(NOW), instances: { namespaces: [], log() {} },
      resetLog: logger, resetLogStore: store, ...over,
    });
    const call = (path: string, init: RequestInit = {}, token = ADMIN) => app.request(path, {
      ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    });
    return { store, metrics, app, call, logger };
  }

  test("a manual Claude reset writes one row with the windows from before it", async () => {
    const { call, store, metrics } = fixture({
      spendReset: async (identity, grant) => ({ identity, grantId: grant, result: "reset", resetsLeft: 2, cleared: ["seven_day"] }),
    });
    const response = await call(`/limits/claude/fixture-account/resets/${GRANT}`, { method: "POST", headers: { "x-ais-actor": "console" } });
    expect(response.status).toBe(200);
    const [row] = (await store.list({})).rows;
    expect(row).toMatchObject({
      provider: "claude", trigger: "manual", actor: "user:console", identity: "fixture-account", grantId: GRANT, outcome: "reset", resetsLeftAfter: 2,
    });
    expect(row?.before.map((w) => [w.key, w.percent])).toEqual([["five_hour", 41], ["weekly", 100], ["weekly_opus", 88], ["weekly_sonnet", 12]]);
    expect(metrics.render()).toContain('ais_gateway_resets_total{provider="claude",trigger="manual",outcome="reset"} 1');
  });

  test("each Claude answer and refusal maps to one outcome", async () => {
    const cases: Array<[string, () => Promise<unknown>, string]> = [
      ["no credit", async () => ({ result: "no_credit", cleared: [] }), "no_credit"],
      ["already redeemed", async () => ({ result: "already_redeemed", cleared: [] }), "already_redeemed"],
      ["nothing to reset", async () => ({ result: "nothing_to_reset", cleared: [] }), "rejected"],
      ["unclear answer", async () => ({ result: "unknown", cleared: [] }), "error"],
      ["refused before any POST", async () => { throw Object.assign(new Error("An automatic reset has no outcome yet"), { status: 409 }); }, "rejected"],
      ["lost answer", async () => { throw Object.assign(new Error("Anthropic reset endpoint unreachable"), { status: 502 }); }, "error"],
      ["plain failure", async () => { throw new Error("synthetic failure"); }, "error"],
    ];
    for (const [name, spendReset, outcome] of cases) {
      const { call, store } = fixture({ spendReset });
      await call(`/limits/claude/fixture-account/resets/${GRANT}`, { method: "POST" });
      const rows = (await store.list({})).rows;
      expect(rows.map((row) => row.outcome), name).toEqual([outcome] as never);
      expect(rows[0]?.actor).toBe("user");
      if (outcome !== "reset") expect(rows[0]?.message, name).toBeTruthy();
    }
  });

  test("a reset that the log cannot record still works", async () => {
    const { call, store, metrics, logger } = fixture({ spendReset: async () => ({ result: "reset", cleared: ["x"] }) });
    store.failInserts = true;
    const response = await call(`/limits/claude/fixture-account/resets/${GRANT}`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: "reset" });
    await logger.drain();
    expect(metrics.render()).toContain('ais_gateway_reset_log_write_failures_total{provider="claude"} 1');
  });

  test("a manual Codex reset writes one row, and a bad request ID writes none", async () => {
    const { call, store } = fixture({
      spendCodexReset: async (identity) => ({ identity, result: "reset", windowsReset: 2, creditId: "credit-SYNTHETIC_FIXTURE-one" }),
    });
    expect((await call("/limits/codex/fixture-codex/resets/use", { method: "POST", body: JSON.stringify({ redeemRequestId: "nope" }) })).status).toBe(400);
    expect((await store.list({})).rows).toEqual([]);
    expect((await call("/limits/codex/fixture-codex/resets/use", { method: "POST", body: JSON.stringify({ redeemRequestId: REQUEST_ID }) })).status).toBe(200);
    const [row] = (await store.list({})).rows;
    expect(row).toMatchObject({
      provider: "codex", trigger: "manual", actor: "user", identity: "fixture-codex", grantId: "credit-SYNTHETIC_FIXTURE-one", outcome: "reset",
    });
    expect(row?.before.map((w) => w.key)).toEqual(["five_hour", "weekly", "weekly_gpt_5_codex"]);
  });

  test("each Codex answer maps to one outcome", async () => {
    for (const [result, outcome] of [["no_credit", "no_credit"], ["already_redeemed", "already_redeemed"], ["nothing_to_reset", "rejected"]] as const) {
      const { call, store } = fixture({ spendCodexReset: async (identity) => ({ identity, result, windowsReset: 0 }) });
      await call("/limits/codex/fixture-codex/resets/use", { method: "POST", body: JSON.stringify({ redeemRequestId: REQUEST_ID }) });
      expect((await store.list({})).rows.map((row) => row.outcome)).toEqual([outcome]);
    }
    const { call, store } = fixture({ spendCodexReset: async () => { throw Object.assign(new Error("synthetic lost answer"), { status: 502 }); } });
    await call("/limits/codex/fixture-codex/resets/use", { method: "POST", body: JSON.stringify({ redeemRequestId: REQUEST_ID }) });
    expect((await store.list({})).rows.map((row) => row.outcome)).toEqual(["error"]);
  });

  test("GET /reset-log needs the admin token, validates the query, filters and pages", async () => {
    const { call, store } = fixture();
    expect((await call("/reset-log", {}, "")).status).toBe(401);
    for (let i = 0; i < 5; i++) {
      await store.insert(entry({ at: iso(NOW + i), identity: i % 2 ? "odd" : "even", outcome: i === 4 ? "error" : "reset" }));
    }
    const page = await (await call("/reset-log?limit=2")).json() as ResetLogPage;
    expect(page.rows.map((row) => row.id)).toEqual(["5", "4"]);
    expect(decodeResetLogCursor(page.nextBefore!)?.id).toBe("4");
    expect(page.identities).toEqual(["even", "odd"]);
    const next = await (await call(`/reset-log?limit=2&before=${encodeURIComponent(page.nextBefore!)}`)).json() as ResetLogPage;
    expect(next.rows.map((row) => row.id)).toEqual(["3", "2"]);
    const odd = await (await call("/reset-log?identity=odd&outcome=reset")).json() as ResetLogPage;
    expect(odd.rows.map((row) => row.id)).toEqual(["4", "2"]);
    const day = await (await call("/reset-log?from=2026-11-27&to=2026-11-27")).json() as ResetLogPage;
    expect(day.rows).toHaveLength(5);
    const none = await (await call("/reset-log?to=2026-11-26")).json() as ResetLogPage;
    expect(none).toEqual({ rows: [], nextBefore: null, identities: ["even", "odd"] });
    expect((await call("/reset-log?provider=kimi")).status).toBe(400);
    expect((await call("/reset-log?limit=0")).status).toBe(400);
  });

  test("the console serves the log at /api/logs/resets through its admin connection", async () => {
    const { app, store } = fixture();
    await store.insert(entry({ at: iso(NOW), identity: "alpha" }));
    await store.insert(entry({ at: iso(NOW + 1), identity: "beta", provider: "codex" }));
    const calls: string[] = [];
    const consoleApp = createApp({
      port: 47129, startedAt: Date.now(), token: CONSOLE,
      gatewayResetLog: {
        adminConfig: async () => ({ url: "http://admin.test", token: ADMIN }),
        fetch: (async (url: string, init: RequestInit) => {
          const { pathname, search } = new URL(url);
          calls.push(`${pathname}${search}`);
          expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${ADMIN}`);
          return app.request(`${pathname}${search}`, init);
        }) as typeof fetch,
      },
    });
    const headers = { Host: "localhost", authorization: `Bearer ${CONSOLE}` };
    const get = (query = "") => consoleApp.request(`/api/logs/resets${query}`, { headers });
    const page = await (await get("?provider=codex&junk=1")).json() as ResetLogPage;
    expect(page.rows.map((row) => row.identity)).toEqual(["beta"]);
    expect(page.identities).toEqual(["alpha", "beta"]);
    expect(page.nextBefore).toBeNull();
    expect(calls).toEqual(["/reset-log?provider=codex"]);
    expect((await get("?outcome=nonsense")).status).toBe(400);
    expect(calls).toHaveLength(1);
    expect((await consoleApp.request("/api/logs/resets", { headers: { Host: "localhost" } })).status).toBe(401);
  });

  test("the console answers an empty page when no gateway admin is configured", async () => {
    const consoleApp = createApp({ port: 47129, startedAt: Date.now(), token: CONSOLE, gatewayResetLog: { adminConfig: async () => undefined } });
    const response = await consoleApp.request("/api/logs/resets", { headers: { Host: "localhost", authorization: `Bearer ${CONSOLE}` } });
    expect(await response.json()).toMatchObject({ rows: [], nextBefore: null, identities: [] });
  });
});

describe("automatic resets", () => {
  const credit = (id: string): ManualResetInfo => ({ availableCount: 1, creditExpiries: [{ id, endsAt: iso(NOW + 100_000) }] });
  const input = () => ({ members: ["alpha", "beta"], reservePercent: 90, signal: AbortSignal.timeout(2_500) });

  async function run(provider: "claude" | "codex", spend: (identity: string, creditId: string) => Promise<{ result: "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed"; creditId?: string }>) {
    const autoStore = new MemoryAutoResetStore(() => NOW);
    await autoStore.setEnabled(provider, "fixture-pool", true);
    const store = new MemoryResetLog();
    const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
    const resetLog = createResetLogger({ retryBackoffMs: [0, 0], store, metrics, now: () => NOW, log: () => {} });
    let recovered = false;
    const reading = (full: boolean): AutoResetUsage => {
      const used = full ? 100 : 4;
      if (provider === "codex") return codexUsage(used);
      return {
        status: full ? "rate-limited" : "live", capturedAt: iso(NOW), windows: [
          { label: "five-hour", utilization: 30, resetsAt: iso(NOW + 600_000) },
          { label: "seven-day", utilization: used, resetsAt: iso(NOW + 610_000) },
          { label: "seven-day (Opus)", model: "Opus", utilization: 55, resetsAt: iso(NOW + 610_000) },
        ],
      };
    };
    const recovery = createAutoResetRecovery({
      provider, store: autoStore, resetLog, now: () => NOW, confirmationBudgetMs: 55, log: () => {},
      pools: async () => [{ name: "fixture-pool", members: ["alpha", "beta"] }],
      freshUsage: async () => reading(!recovered),
      readCredits: async (identity) => credit(`credit-SYNTHETIC_FIXTURE-${identity}`),
      spend: async (identity, creditId) => {
        const result = await spend(identity, creditId);
        if (result.result === "reset") recovered = true;
        return result;
      },
    });
    const winner = await recovery.recover(input());
    return { winner, rows: (await store.list({})).rows, metrics: metrics.render() };
  }

  test("an automatic Claude reset writes one row with every window from before it", async () => {
    const { winner, rows, metrics } = await run("claude", async (_identity, creditId) => ({ result: "reset", creditId }));
    expect(winner).toBe("alpha");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "claude", trigger: "auto", actor: "auto-reset-worker", identity: "alpha", pool: "fixture-pool",
      grantId: "credit-SYNTHETIC_FIXTURE-alpha", outcome: "reset", account: null,
    });
    expect(rows[0]?.before.map((w) => [w.key, w.percent])).toEqual([["five_hour", 30], ["weekly", 100], ["weekly_opus", 55]]);
    expect(metrics).toContain('ais_gateway_resets_total{provider="claude",trigger="auto",outcome="reset"} 1');
  });

  test("an automatic Codex reset writes one row, including the model windows", async () => {
    const { rows } = await run("codex", async (_identity, creditId) => ({ result: "reset", creditId }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "codex", trigger: "auto", actor: "auto-reset-worker", pool: "fixture-pool", outcome: "reset" });
    expect(rows[0]?.before.map((w) => w.key)).toEqual(["five_hour", "weekly", "weekly_gpt_5_codex"]);
  });

  test("each provider answer and failure maps to one outcome", async () => {
    const cases: Array<[string, Parameters<typeof run>[1], string]> = [
      ["no credit", async () => ({ result: "no_credit" }), "no_credit"],
      ["already redeemed", async () => ({ result: "already_redeemed" }), "already_redeemed"],
      ["nothing to reset", async () => ({ result: "nothing_to_reset" }), "rejected"],
      ["refused by the provider", async () => { throw Object.assign(new Error("Claude refused the reset (HTTP 403)"), { status: 403 }); }, "rejected"],
      ["no POST was sent", async () => { throw Object.assign(new Error("synthetic preflight failure"), { postAttempted: false }); }, "rejected"],
      ["no recorded answer", async () => { throw new Error("synthetic lost answer"); }, "error"],
    ];
    for (const provider of ["claude", "codex"] as const) {
      for (const [name, spend, outcome] of cases) {
        const { rows } = await run(provider, spend);
        expect(rows.map((row) => row.outcome), `${provider} ${name}`).toEqual([outcome] as never);
        expect(rows[0]?.message, `${provider} ${name}`).toBeTruthy();
      }
    }
  });

  test("a log that cannot write never blocks or changes the reset", async () => {
    const autoStore = new MemoryAutoResetStore(() => NOW);
    await autoStore.setEnabled("claude", "fixture-pool", true);
    const store = new MemoryResetLog();
    store.failInserts = true;
    const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
    const failing = createResetLogger({ retryBackoffMs: [0, 0], store, metrics, now: () => NOW, log: () => {} });
    let spent = 0;
    let recovered = false;
    const recovery = createAutoResetRecovery({
      provider: "claude", store: autoStore, now: () => NOW, confirmationBudgetMs: 55, log: () => {},
      resetLog: failing,
      pools: async () => [{ name: "fixture-pool", members: ["alpha", "beta"] }],
      freshUsage: async () => ({
        status: recovered ? "live" : "rate-limited", capturedAt: iso(NOW),
        windows: [{ label: "seven-day", utilization: recovered ? 4 : 100, resetsAt: iso(NOW + 600_000) }],
      }),
      readCredits: async (identity) => credit(`credit-SYNTHETIC_FIXTURE-${identity}`),
      spend: async (_identity, creditId) => { spent++; recovered = true; return { result: "reset", creditId }; },
    });
    expect(await recovery.recover(input())).toBe("alpha");
    expect(spent).toBe(1);
    await failing.drain();
    expect(metrics.render()).toContain('ais_gateway_reset_log_write_failures_total{provider="claude"} 1');
  });
});

describe("write path", () => {
  const start = { provider: "claude", trigger: "manual", actor: "user", identity: "fixture-account" } as const;
  const metricsOf = () => new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });

  test("a row keeps when the attempt started next to when it ended", async () => {
    const store = new MemoryResetLog();
    let now = NOW;
    const logger = createResetLogger({ store, now: () => now, log: () => {} });
    const attempt = await logger.begin(start);
    now += 4_000;
    await attempt.finish({ outcome: "reset" });
    expect((await store.list({})).rows[0]).toMatchObject({ startedAt: iso(NOW), at: iso(NOW + 4_000) });
  });

  test("the counter moves at once, and a slow store never delays the caller", async () => {
    const hung: ResetLogStore = { ...new MemoryResetLog(), insert: () => new Promise(() => {}) } as unknown as ResetLogStore;
    const metrics = metricsOf();
    const logger = createResetLogger({ store: hung, metrics, now: () => NOW, log: () => {}, storeTimeoutMs: 50, retryBackoffMs: [] });
    const attempt = await logger.begin(start);
    const write = attempt.finish({ outcome: "reset" });
    // The counter is already there, before the write ends.
    expect(metrics.render()).toContain('ais_gateway_resets_total{provider="claude",trigger="manual",outcome="reset"} 1');
    const started = performance.now();
    await logger.drain();
    await write;
    expect(performance.now() - started).toBeGreaterThanOrEqual(40);
    expect(metrics.render()).toContain('ais_gateway_reset_log_write_failures_total{provider="claude"} 1');
  });

  test("a failed write is tried three times, with a wait between, and a later success counts no failure", async () => {
    class Flaky extends MemoryResetLog {
      calls = 0;
      override async insert(entryToWrite: ResetLogEntry): Promise<void> {
        this.calls += 1;
        if (this.calls < 3) throw new Error("synthetic outage");
        await super.insert(entryToWrite);
      }
    }
    const store = new Flaky();
    const metrics = metricsOf();
    const waits: number[] = [];
    const logger = createResetLogger({ store, metrics, now: () => NOW, log: () => {}, sleep: async (ms) => { waits.push(ms); } });
    await (await logger.begin(start)).finish({ outcome: "reset" });
    expect(store.calls).toBe(3);
    expect(waits).toEqual([250, 1_000]);
    expect((await store.list({})).rows).toHaveLength(1);
    expect(metrics.render()).not.toMatch(/reset_log_write_failures_total\{/);
  });

  test("a write that fails every try is counted once", async () => {
    const store = new MemoryResetLog();
    store.failInserts = true;
    const metrics = metricsOf();
    const logger = createResetLogger({ store, metrics, now: () => NOW, log: () => {}, sleep: async () => {} });
    await (await logger.begin(start)).finish({ outcome: "reset" });
    expect(metrics.render()).toContain('ais_gateway_reset_log_write_failures_total{provider="claude"} 1');
  });

  test("a full queue drops the write and counts it", async () => {
    const release = Promise.withResolvers<void>();
    const slow: ResetLogStore = { ...new MemoryResetLog(), insert: () => release.promise } as unknown as ResetLogStore;
    const metrics = metricsOf();
    const logger = createResetLogger({ store: slow, metrics, now: () => NOW, log: () => {}, queueLimit: 2, retryBackoffMs: [] });
    const attempts = await Promise.all([1, 2, 3, 4, 5].map(() => logger.begin(start)));
    const writes = attempts.map((attempt) => attempt.finish({ outcome: "reset" }));
    // Three writes fit (the limit is checked before a write joins), so the other two are dropped.
    expect(metrics.render()).toContain('ais_gateway_reset_log_write_failures_total{provider="claude"} 2');
    release.resolve();
    await Promise.all(writes);
  });

  test("only a reset row waits for an `after` reading", async () => {
    const store = new MemoryResetLog();
    const logger = createResetLogger({ store, now: () => NOW, log: () => {} });
    for (const outcome of ["no_credit", "already_redeemed", "rejected", "error"] as const) await (await logger.begin(start)).finish({ outcome });
    logger.onReading("claude", "fixture-account", claudeUsage(2, NOW + 5_000));
    await Bun.sleep(5);
    expect((await store.list({})).rows.every((row) => row.after === null)).toBe(true);
    expect(await store.pendingMembers()).toEqual([]);
    await (await logger.begin(start)).finish({ outcome: "reset" });
    expect(await store.pendingMembers()).toEqual([{ provider: "claude", identity: "fixture-account" }]);
  });

  test("a row that lands during a fill keeps its member in the waiting list", async () => {
    // The fill reads the table, then a new reset row lands, then the fill answers `pending: false`.
    const store = new MemoryResetLog();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const original = store.fillAfter.bind(store);
    let held = false;
    store.fillAfter = async (...args) => {
      const result = await original(...args);
      if (!held) {
        held = true;
        entered.resolve();
        await gate.promise;
        return { ...result, pending: false };
      }
      return result;
    };
    const logger = createResetLogger({ store, now: () => NOW + 10_000, log: () => {} });
    await (await logger.begin(start)).finish({ outcome: "reset" });
    logger.onReading("claude", "fixture-account", claudeUsage(2, NOW + 5_000));
    await entered.promise;
    await (await logger.begin(start)).finish({ outcome: "reset" });
    gate.resolve();
    await Bun.sleep(5);
    // The second row has no `after` yet: the next reading must still fill it.
    logger.onReading("claude", "fixture-account", claudeUsage(3, NOW + 20_000));
    await Bun.sleep(5);
    expect((await store.list({})).rows.map((row) => row.after !== null)).toEqual([true, true]);
  });
});

describe("list order and cursor", () => {
  test("rows with the same time keep a stable order, and the cursor never skips or repeats a row", async () => {
    const store = new MemoryResetLog();
    // Rows are not inserted in time order: the ID order and the time order differ.
    for (const ms of [5, 1, 5, 3, 5, 1]) await store.insert(entry({ at: iso(NOW + ms) }));
    const seenIds: string[] = [];
    let before: ReturnType<typeof decodeResetLogCursor>;
    for (let guard = 0; guard < 10; guard++) {
      const result = await store.list({ limit: 2, ...(before ? { before } : {}) });
      seenIds.push(...result.rows.map((row) => row.id));
      if (!result.nextBefore) break;
      before = decodeResetLogCursor(result.nextBefore);
      expect(before).toBeDefined();
    }
    // `at` descending, then `id` descending.
    expect(seenIds).toEqual(["5", "3", "1", "4", "6", "2"]);
  });

  test("a cursor is an opaque string, and anything else is refused", () => {
    const cursor = encodeResetLogCursor({ at: "2026-11-27T08:00:00.123456Z", id: "9" });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeResetLogCursor(cursor)).toEqual({ at: "2026-11-27T08:00:00.123456Z", id: "9" });
    for (const text of ["42", "abc", "", "!!", Buffer.from("x|1").toString("base64url"), Buffer.from("2026-11-27T08:00:00Z|1;drop").toString("base64url")]) {
      expect(decodeResetLogCursor(text)).toBeUndefined();
    }
  });

  test("the identity list is read at most once a minute, and a new identity shows at once", async () => {
    let reads = 0;
    let t = 0;
    const sql = ((strings: TemplateStringsArray) => {
      const text = strings.join("?");
      if (text.includes("SELECT DISTINCT identity")) { reads += 1; return Promise.resolve([{ identity: "alpha" }]); }
      if (text.includes("INSERT INTO reset_log")) return Promise.resolve([]);
      return Promise.resolve([]);
    }) as unknown as SQL;
    const store = new PgResetLog(sql, { now: () => t });
    expect((await store.list({})).identities).toEqual(["alpha"]);
    t += 59_000;
    await store.list({});
    expect(reads).toBe(1);
    await store.insert(entry({ identity: "beta" }));
    expect((await store.list({})).identities).toEqual(["alpha", "beta"]);
    expect(reads).toBe(1);
    t += 2_000;
    await store.list({});
    expect(reads).toBe(2);
  });
});

describe("admin route paths", () => {
  test("a stray percent sign in a path parameter does not throw", async () => {
    const store = new MemoryResetLog();
    const logger = createResetLogger({ store, now: () => NOW, log: () => {}, retryBackoffMs: [0] });
    const seenGrants: string[] = [];
    const app = createAdminApp({
      store: new MemoryGatewayStore(), adminToken: ADMIN, now: () => new Date(NOW), instances: { namespaces: [], log() {} },
      resetLog: logger, resetLogStore: store,
      spendReset: async (_identity, grant) => { seenGrants.push(grant); throw Object.assign(new Error("invalid grant id"), { status: 400 }); },
    });
    const response = await app.request("/limits/claude/fixture-account/resets/%25ZZ", { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } });
    expect(response.status).toBe(400);
    expect(seenGrants).toEqual(["%ZZ"]);
    await logger.drain();
    // A grant that is not a well-formed ID is never stored as one.
    expect((await store.list({})).rows[0]).toMatchObject({ outcome: "rejected", grantId: null });
  });
});

// The PostgreSQL contract needs a test database. It is skipped, like the other PostgreSQL tests, when none is set.
const url = process.env.AIS_GATEWAY_TEST_DATABASE_URL;
if (!url) {
  test.skip("PostgreSQL reset log tests need AIS_GATEWAY_TEST_DATABASE_URL", () => {});
} else {
  if (!new URL(url).pathname.includes("test")) throw new Error("The PostgreSQL reset log test needs a database with test in its name");
  test("the PostgreSQL reset log filters, pages, fills `after` once and is never pruned", async () => {
    await migrate(url);
    const sql = new SQL(url, { max: 2 });
    const identity = `reset-log-test-${crypto.randomUUID()}`;
    try {
      const store = new PgResetLog(sql);
      const a = entry({ at: iso(NOW), identity });
      const b = entry({ at: iso(NOW + 1_000), identity, trigger: "auto", outcome: "error", message: "synthetic failure" });
      await store.insert(a);
      await store.insert(b);
      const all = await store.list({ identity });
      expect(all.rows.map((row) => row.outcome)).toEqual(["error", "reset"]);
      expect(all.rows[1]).toMatchObject({ ...a, after: null, afterAt: null });
      expect(all.identities).toContain(identity);
      const first = await store.list({ identity, limit: 1 });
      expect(decodeResetLogCursor(first.nextBefore!)?.id).toBe(first.rows[0]?.id as string);
      expect((await store.list({ identity, limit: 1, before: decodeResetLogCursor(first.nextBefore!)! })).rows.map((row) => row.outcome)).toEqual(["reset"]);
      expect((await store.list({ identity, trigger: "auto" })).rows).toHaveLength(1);
      expect((await store.list({ identity, from: iso(NOW + 500), toExclusive: iso(NOW + 2_000) })).rows).toHaveLength(1);
      const after = resetLogWindows(claudeUsage(1));
      expect(await store.fillAfter("claude", identity, after, iso(NOW + 500))).toEqual({ filled: 1, pending: true });
      expect(await store.fillAfter("claude", identity, after, iso(NOW + 2_000))).toEqual({ filled: 1, pending: false });
      expect(await store.fillAfter("claude", identity, after, iso(NOW + 3_000))).toEqual({ filled: 0, pending: false });
      expect((await store.list({ identity })).rows.map((row) => row.afterAt)).toEqual([iso(NOW + 2_000), iso(NOW + 500)]);
    } finally {
      await sql.close();
    }
  });
}
