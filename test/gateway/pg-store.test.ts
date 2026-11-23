import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { isDataError } from "../../src/gateway/ledger-buffer.ts";
import { PgUsageReadings } from "../../src/gateway/usage-readings.ts";
import { migrate, PgGatewayStore } from "../../src/gateway/pg-store.ts";
import { CachedGatewayStore } from "../../src/gateway/cache-store.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { generateToken, verifyToken } from "../../src/gateway/tokens.ts";
import { browserStoreContract } from "./browser-store-contract.ts";
import { storeContract } from "./store-contract.ts";

const url = process.env.AIS_GATEWAY_TEST_DATABASE_URL;

describe("MemoryGatewayStore contract", () => {
  storeContract(async () => new MemoryGatewayStore());
});

const optOut = process.env.AIS_GATEWAY_TEST_NO_DATABASE === "1";

if (!url && process.env.CI && !optOut) {
  test("pg store tests need AIS_GATEWAY_TEST_DATABASE_URL in CI", () => {
    throw new Error(
      "AIS_GATEWAY_TEST_DATABASE_URL is unset in CI; provide a Postgres service or set AIS_GATEWAY_TEST_NO_DATABASE=1",
    );
  });
} else if (!url) {
  console.warn("SKIP pg-store tests: AIS_GATEWAY_TEST_DATABASE_URL is not set");
  test.skip("pg store tests need AIS_GATEWAY_TEST_DATABASE_URL", () => {});
} else {
  const stores: PgGatewayStore[] = [];
  afterAll(async () => {
    for (const s of stores) await s.close();
  });

  // Close every earlier store before making the next, so pools never pile up past max_connections.
  async function fresh(): Promise<PgGatewayStore> {
    const old = stores.splice(0);
    for (const s of old) await s.close();
    await reset();
    await migrate(url as string);
    const s = new PgGatewayStore(url as string);
    stores.push(s);
    return s;
  }

  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.includes("test")) {
    throw new Error(`refusing to reset database "${dbName}": its name must contain "test"`);
  }

  async function reset(): Promise<void> {
    const sql = new SQL(url as string);
    try {
      // One statement per table: TimescaleDB refuses to drop a hypertable together with other objects.
      for (const t of ["browser_tokens", "browser_pairings", "browser_agent_tokens", "browser_bindings"]) {
        await sql.unsafe(`DROP TABLE IF EXISTS ${t} CASCADE`);
      }
      await sql`DROP TABLE IF EXISTS gateway_chat_events CASCADE`;
      await sql`DROP TABLE IF EXISTS gateway_chats CASCADE`;
      await sql`DROP TABLE IF EXISTS gateway_side_counts CASCADE`;
      await sql`DROP TABLE IF EXISTS gateway_refresh_journal CASCADE`;
      await sql`DROP TABLE IF EXISTS gateway_usage_history CASCADE`;
      await sql`DROP TABLE IF EXISTS usage_readings CASCADE`;
      // The continuous aggregate depends on the hypertable, so it goes first.
      await sql`DROP MATERIALIZED VIEW IF EXISTS gateway_usage_15m CASCADE`;
      await sql`DROP TABLE IF EXISTS gateway_usage CASCADE`;
      await sql`DROP TABLE IF EXISTS gateway_tokens CASCADE`;
      await sql`DROP TABLE IF EXISTS gateway_apps CASCADE`;
      await sql`DROP TABLE IF EXISTS schema_migrations CASCADE`;
    } finally {
      await sql.close();
    }
  }

  describe("migrate", () => {
    test("a migration that cannot get its table lock gives up quickly instead of queueing, and succeeds on retry", async () => {
      await reset();
      await migrate(url);
      const admin = new SQL(url);
      const holder = new SQL(url);
      await admin`ALTER TABLE gateway_refresh_journal DROP COLUMN IF EXISTS code`;
      await admin`DELETE FROM schema_migrations WHERE version = '0007_refresh_journal_code'`;
      // Make 0007 pending again, then hold a share lock: its ALTER needs ACCESS EXCLUSIVE and would queue behind the holder.
      let releaseLock!: () => void;
      const held = new Promise<void>((r) => (releaseLock = r));
      let locked!: () => void;
      const lockTaken = new Promise<void>((r) => (locked = r));
      const tx = holder.begin(async (t) => {
        await t`LOCK TABLE gateway_refresh_journal IN ACCESS SHARE MODE`;
        locked();
        await held;
      });
      await lockTaken;
      const started = Date.now();
      const failure = await migrate(url, { lockTimeoutMs: 200, attempts: 1 }).then(() => undefined, (e) => e);
      expect((failure as { errno?: string } | undefined)?.errno).toBe("55P03");
      expect(Date.now() - started).toBeLessThan(5_000);
      // The retry path: the lock is released while the migration waits between attempts.
      setTimeout(() => releaseLock(), 300);
      await migrate(url, { lockTimeoutMs: 200, attempts: 5 });
      await tx;
      const col = await admin`SELECT 1 AS x FROM information_schema.columns WHERE table_name = 'gateway_refresh_journal' AND column_name = 'code'`;
      expect(col.length).toBe(1);
      await holder.close();
      await admin.close();
    });

    test("migrate is idempotent", async () => {
      await reset();
      await migrate(url);
      await migrate(url);
      await Promise.all([migrate(url), migrate(url)]);
      const sql = new SQL(url);
      try {
        const rows = await sql`SELECT version FROM schema_migrations`;
        expect(rows.length).toBe(14);
        const t = await sql`SELECT to_regclass('gateway_usage') AS r`;
        expect(t[0].r).toBe("gateway_usage");
        const ext = await sql`SELECT 1 AS x FROM pg_extension WHERE extname = 'timescaledb'`;
        const requireTimescale = Boolean(process.env.CI) && !optOut;
        if (requireTimescale) expect(ext.length).toBe(1);
        if (ext.length > 0) {
          const h = await sql`SELECT hypertable_name FROM timescaledb_information.hypertables`;
          expect(h.map((r: { hypertable_name: string }) => r.hypertable_name)).toContain("gateway_usage");
          const agg = await sql`SELECT view_name FROM timescaledb_information.continuous_aggregates WHERE view_name = 'gateway_usage_15m'`;
          expect(agg.length).toBe(1);
          // A cagg policy job names the materialization hypertable, not the view.
          const jobs = await sql`SELECT 1 AS x FROM timescaledb_information.jobs j
            JOIN timescaledb_information.continuous_aggregates c ON j.hypertable_name = c.materialization_hypertable_name
            WHERE c.view_name = 'gateway_usage_15m' AND j.proc_name = 'policy_refresh_continuous_aggregate'`;
          expect(jobs.length).toBe(1);
        } else {
          // Without TimescaleDB the plain table stays, the rollup is skipped and the version is still recorded.
          expect(rows.map((r: { version: string }) => r.version)).toContain("0009_usage_rollup");
          const view = await sql`SELECT to_regclass('gateway_usage_15m') AS r`;
          expect(view[0].r).toBeNull();
        }
      } finally {
        await sql.close();
      }
    });
  });

  describe("usage rollup", () => {
    const DAY = 86_400_000;
    const start = Date.UTC(2026, 9, 20); // 20 Oct 2026
    const zones = ["UTC", "Asia/Bangkok", "Europe/London", "Asia/Kathmandu", "Australia/Lord_Howe", "America/St_Johns"];
    const providers = ["claude", "codex"] as const;
    const apps = ["web", "batch", "bot"];
    const models = ["claude-sonnet-4-5", "claude-opus-4-1", "gpt-5", null, "unknown-model-x"];

    // Small deterministic generator (LCG), so a failure repeats.
    function rng(seed: number): () => number {
      let x = seed >>> 0;
      return () => {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        return x / 2 ** 32;
      };
    }

    function makeRows(from: number, to: number, count: number, seed: number) {
      const rnd = rng(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
      // Instants that are local midnights in the tested zones on the tested days, and bucket edges.
      const special: number[] = [];
      for (let d = Math.floor(from / DAY) * DAY; d < to; d += DAY) {
        for (const mins of [0, 17 * 60, 18 * 60 + 15, 13 * 60, 2 * 60 + 30, 3 * 60 + 30, 23 * 60, 15, 30, 45]) special.push(d + mins * 60_000);
      }
      const rows = [];
      for (let i = 0; i < count; i += 1) {
        const r = rnd();
        let ts: number;
        if (r < 0.2) ts = special[Math.floor(rnd() * special.length)] as number;
        else if (r < 0.4) ts = from + Math.floor(rnd() * ((to - from) / 900_000)) * 900_000;
        else ts = from + Math.floor(rnd() * (to - from));
        ts = Math.min(Math.max(ts, from), to - 1);
        const hasCost = rnd() < 0.6;
        const tokens = () => (rnd() < 0.1 ? 0 : Math.floor(rnd() * 5000));
        rows.push({
          ts: new Date(ts).toISOString(),
          app: pick(apps),
          provider: pick(providers),
          identity: `id${Math.floor(rnd() * 4)}`,
          model: pick(models) ?? undefined,
          inputTokens: tokens(),
          outputTokens: tokens(),
          cacheReadTokens: tokens(),
          cacheWriteTokens: tokens(),
          estCostUsd: hasCost ? Math.round(rnd() * 1e6) / 1e5 : undefined,
          status: "ok",
          httpStatus: 200,
          latencyMs: 5,
          streamed: false,
        });
      }
      return rows;
    }

    async function refresh(): Promise<void> {
      const sql = new SQL(url as string);
      try {
        await sql.unsafe("CALL refresh_continuous_aggregate('gateway_usage_15m', NULL, NULL)");
      } finally {
        await sql.close();
      }
    }

    const iso = (ms: number): Date => new Date(ms);
    // Unaligned, aligned, short and open ranges, plus a range across the London DST end (25 Oct 2026).
    const ranges: { name: string; since: Date; until?: Date }[] = [
      { name: "all time", since: new Date("1970-01-01T00:00:00.000Z") },
      { name: "all time with until", since: new Date("1970-01-01T00:00:00.000Z"), until: iso(start + 9 * DAY) },
      { name: "unaligned both ends", since: iso(start + 2 * DAY + 7 * 60_000 + 13), until: iso(start + 6 * DAY + 41 * 60_000 + 977) },
      { name: "aligned both ends", since: iso(start + 3 * DAY + 900_000), until: iso(start + 7 * DAY + 3 * 900_000) },
      { name: "until on a boundary", since: iso(start + DAY + 123_456), until: iso(start + 5 * DAY) },
      { name: "since on a boundary, until open", since: iso(start + 4 * DAY + 2 * 900_000) },
      { name: "since unaligned, until open", since: iso(start + 4 * DAY + 5 * 60_000) },
      { name: "shorter than a bucket", since: iso(start + 3 * DAY + 60_000), until: iso(start + 3 * DAY + 9 * 60_000) },
      { name: "one bucket exactly", since: iso(start + 3 * DAY), until: iso(start + 3 * DAY + 900_000) },
      { name: "just over one bucket", since: iso(start + 3 * DAY - 1), until: iso(start + 3 * DAY + 900_001) },
      { name: "empty", since: iso(start + 3 * DAY), until: iso(start + 3 * DAY) },
      { name: "DST end in London", since: new Date("2026-10-24T20:00:00.000Z"), until: new Date("2026-10-26T05:30:00.000Z") },
      { name: "before the data", since: new Date("2020-01-01T00:00:00.000Z"), until: new Date("2020-02-01T00:00:00.000Z") },
    ];

    function expectSameRows(got: unknown[], want: unknown[], label: string): void {
      expect(got.length, `${label}: row count`).toBe(want.length);
      for (let i = 0; i < want.length; i += 1) {
        const g = got[i] as Record<string, unknown>;
        const w = want[i] as Record<string, unknown>;
        const { estCostUsd: gc, ...gRest } = g;
        const { estCostUsd: wc, ...wRest } = w;
        expect(gRest, `${label}: row ${i}`).toEqual(wRest);
        expect(Math.abs((gc as number) - (wc as number)), `${label}: cost of row ${i}`).toBeLessThan(1e-6);
      }
    }

    async function compareAll(rollup: PgGatewayStore, raw: PgGatewayStore, stage: string): Promise<void> {
      for (const r of ranges) {
        const label = `${stage} / ${r.name}`;
        expectSameRows(await rollup.usageByIdentity(r.since, r.until), await raw.usageByIdentity(r.since, r.until), `${label} / identity`);
        expectSameRows(await rollup.usageByModel(r.since, r.until), await raw.usageByModel(r.since, r.until), `${label} / model`);
        for (const tz of zones) {
          expectSameRows(await rollup.usageByModelDaily(r.since, r.until, tz), await raw.usageByModelDaily(r.since, r.until, tz), `${label} / daily ${tz}`);
        }
      }
    }

    test("rollup reads equal raw reads before and after each refresh, with late rows", async () => {
      const rollup = await fresh();
      const raw = new PgGatewayStore(url as string, { usageRollup: "off" });
      stores.push(raw);
      const hasTimescale = await rollup.usesUsageRollup();
      if (Boolean(process.env.CI) && !optOut) expect(hasTimescale).toBe(true);
      expect(await raw.usesUsageRollup()).toBe(false);
      if (!hasTimescale) {
        console.warn("SKIP usage rollup equivalence: TimescaleDB is not available");
        return;
      }
      // Stage 0: nothing materialised, so every row comes from the real-time tail.
      await rollup.appendUsage(makeRows(start, start + 9 * DAY, 3000, 1));
      await compareAll(rollup, raw, "unrefreshed");
      // Stage 1: materialised.
      await refresh();
      await compareAll(rollup, raw, "refreshed");
      // Stage 2: rows after the watermark come through the real-time path.
      await rollup.appendUsage(makeRows(start + 9 * DAY, start + 10 * DAY + 6 * 3_600_000, 800, 2));
      await compareAll(rollup, raw, "real-time tail");
      // Stage 3: late rows inside the materialised range show after the next refresh.
      await rollup.appendUsage(makeRows(start + DAY, start + 8 * DAY, 500, 3));
      await refresh();
      await compareAll(rollup, raw, "second refresh");
    }, 120_000);

    test("an invalid zone fails on both paths and a zone off the 15-minute grid reads the raw ledger", async () => {
      const rollup = await fresh();
      const raw = new PgGatewayStore(url as string, { usageRollup: "off" });
      stores.push(raw);
      await rollup.appendUsage(makeRows(start, start + 3 * DAY, 200, 4));
      const since = new Date("1970-01-01T00:00:00.000Z");
      const bad = await rollup.usageByModelDaily(since, undefined, "Not/AZone").then(() => undefined, (e) => e);
      const badRaw = await raw.usageByModelDaily(since, undefined, "Not/AZone").then(() => undefined, (e) => e);
      expect(bad).toBeDefined();
      expect(badRaw).toBeDefined();
      // A fixed offset of +00:07 is not a multiple of 15 minutes.
      const odd = "<+00:07>-00:07";
      expectSameRows(await rollup.usageByModelDaily(since, undefined, odd), await raw.usageByModelDaily(since, undefined, odd), "odd offset");
    });

    test("the zone guard answers at once on an empty table and for a range past the data", async () => {
      const s = await fresh();
      const guard = (since: Date, until: Date | undefined) =>
        (s as unknown as { zoneFitsBuckets(tz: string, a: Date, b: Date | undefined): Promise<boolean> }).zoneFitsBuckets("Asia/Kathmandu", since, until);
      const epoch = new Date("1970-01-01T00:00:00.000Z");
      let t0 = Date.now();
      expect(await guard(epoch, undefined)).toBe(true);
      expect(await s.usageByModelDaily(epoch, undefined, "Asia/Kathmandu")).toEqual([]);
      expect(Date.now() - t0).toBeLessThan(2_000);
      await s.appendUsage(makeRows(start, start + DAY, 20, 5));
      t0 = Date.now();
      expect(await guard(new Date(start + 5 * DAY), undefined)).toBe(true);
      expect(await guard(new Date(start + 5 * DAY), new Date(start + 6 * DAY))).toBe(true);
      expect(await guard(epoch, new Date(start - DAY))).toBe(true);
      expect(await guard(epoch, undefined)).toBe(true);
      expect(Date.now() - t0).toBeLessThan(2_000);
    });

    test("migrate succeeds again after the rollup is dropped and rebuilds it", async () => {
      const s = await fresh();
      if (!(await s.usesUsageRollup())) return;
      const sql = new SQL(url as string);
      try {
        await sql`DROP MATERIALIZED VIEW gateway_usage_15m CASCADE`;
        await sql`DELETE FROM schema_migrations WHERE version = '0009_usage_rollup'`;
        await migrate(url as string);
        const r = await sql`SELECT to_regclass('gateway_usage_15m') AS r`;
        expect(r[0].r).toBe("gateway_usage_15m");
      } finally {
        await sql.close();
      }
    });
  });

  describe("shared usage readings", () => {
    test("save keeps the newer reading by the database clock, claims are exclusive", async () => {
      await fresh();
      const sql = new SQL(url as string);
      try {
        const r = new PgUsageReadings(sql);
        const u = (n: number) => ({ status: "live" as const, maxUtilization: n, capturedAt: "2026-11-20T00:00:00.000Z" });
        await r.save("claude", "id1", u(10), 5_000);
        await r.save("claude", "id1", u(99), 20_000); // older: ignored
        const got = await r.load("claude", "id1");
        expect(got?.reading.maxUtilization).toBe(10);
        expect(got?.ageMs).toBeGreaterThanOrEqual(5_000);
        expect(got?.ageMs).toBeLessThan(10_000);
        await r.save("claude", "id1", u(20), 0);
        expect((await r.load("claude", "id1"))?.reading.maxUtilization).toBe(20);
        // A row dated in the future is replaced by any later save.
        // save() never dates a row ahead, so set one directly, as a replica with a fast clock once could.
        await r.save("claude", "id2", u(1), 0);
        await sql`UPDATE usage_readings SET read_at = now() + interval '1 minute' WHERE provider = 'claude' AND identity = 'id2'`;
        expect((await r.load("claude", "id2"))?.ageMs).toBeLessThan(0);
        await r.save("claude", "id2", u(2), 0);
        expect((await r.load("claude", "id2"))?.reading.maxUtilization).toBe(2);
        expect(await r.load("claude", "none")).toBeUndefined();
        expect(await r.claim("claude", "new", 10_000)).toBe(true);
        expect(await r.claim("claude", "new", 10_000)).toBe(false);
        expect(await r.claim("claude", "id1", 10_000)).toBe(true);
        expect((await r.loadAll()).length).toBe(3);
      } finally {
        await sql.close();
      }
    });
  });

  describe("isDataError against real Postgres", () => {
    const usageRow = (inputTokens: number) => ({
      ts: "2026-11-02T01:00:00.000Z",
      app: "a",
      provider: "codex" as const,
      identity: "id1",
      inputTokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      status: "ok",
      httpStatus: 200,
      latencyMs: 1,
      streamed: false,
    });

    test("a rejected value is a data error", async () => {
      await reset();
      await migrate(url);
      const s = new PgGatewayStore(url);
      stores.push(s);
      let caught: unknown;
      try {
        await s.appendUsage([usageRow(1e30)]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(isDataError(caught)).toBe(true);
    });

    test("a refused connection is not a data error", async () => {
      const s = new PgGatewayStore("postgres://ais@127.0.0.1:1/x?connect_timeout=2");
      let caught: unknown;
      try {
        await s.appendUsage([usageRow(1)]);
      } catch (err) {
        caught = err;
      }
      await s.close().catch(() => {});
      expect(caught).toBeDefined();
      expect(isDataError(caught)).toBe(false);
    });
  });

  describe("PgGatewayStore contract", () => {
    storeContract(async () => {
      return fresh();
    });
  });

  describe("PgGatewayStore app change notices", () => {
    const app = { name: "web", owner: "o", namespace: "ns", provider: "claude" as const, style: "anthropic" as const, target: { kind: "pin" as const, identity: "id1" }, state: "active" as const, createdAt: "2026-11-01T00:00:00.000Z" };

    test("a write on one connection reaches a listener on another", async () => {
      const writer = await fresh();
      const listener = new PgGatewayStore(url);
      stores.push(listener);
      const seen: string[] = [];
      const unlisten = await listener.listenAppChanges?.((n) => seen.push(n));
      await writer.putApp(app);
      await writer.addToken({ app: "web", prefix: "p1", hash: "h1", createdAt: app.createdAt });
      await writer.expireTokens("web", "2099-01-01T00:00:00.000Z");
      await writer.revokeApp("web");
      const end = Date.now() + 3000;
      while (seen.length < 4 && Date.now() < end) await Bun.sleep(10);
      await unlisten?.();
      expect(seen).toEqual(["web", "web", "web", "web"]);
    });

    test("a ping notice reaches a listener and never names an app", async () => {
      const writer = await fresh();
      const listener = new PgGatewayStore(url);
      stores.push(listener);
      const seen: string[] = [];
      const unlisten = await listener.listenAppChanges?.((n) => seen.push(n));
      await writer.pingAppChanges("!ping:abc");
      const end = Date.now() + 3000;
      while (seen.length < 1 && Date.now() < end) await Bun.sleep(10);
      await unlisten?.();
      expect(seen).toEqual(["!ping:abc"]);
    });

    test("a revoke through one store makes a cache over another store reject the old token", async () => {
      const writer = await fresh();
      const other = new PgGatewayStore(url);
      stores.push(other);
      const cache = new CachedGatewayStore(other);
      await writer.putApp(app);
      const t = generateToken();
      await writer.addToken({ app: "web", prefix: t.prefix, hash: t.hash, createdAt: app.createdAt });
      await cache.warm();
      await cache.startListening();
      try {
        expect(await verifyToken(cache, "web", t.token, new Date("2026-11-02T00:00:00.000Z"))).toBe(true);
        await writer.revokeApp("web");
        const end = Date.now() + 3000;
        while ((await cache.getApp("web"))?.state !== "revoked" && Date.now() < end) await Bun.sleep(10);
        expect(await verifyToken(cache, "web", t.token, new Date("2026-11-02T00:00:00.000Z"))).toBe(false);
      } finally {
        cache.stop();
      }
    });
  });

  describe("PgGatewayStore browser contract", () => {
    browserStoreContract(async () => {
      return fresh();
    });
  });
}
