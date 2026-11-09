import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { isDataError } from "../../src/gateway/ledger-buffer.ts";
import { migrate, PgGatewayStore } from "../../src/gateway/pg-store.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
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
      await sql`DROP TABLE IF EXISTS gateway_side_counts CASCADE`;
      await sql`DROP TABLE IF EXISTS gateway_refresh_journal CASCADE`;
      await sql`DROP TABLE IF EXISTS gateway_usage CASCADE`;
      await sql`DROP TABLE IF EXISTS gateway_tokens CASCADE`;
      await sql`DROP TABLE IF EXISTS gateway_apps CASCADE`;
      await sql`DROP TABLE IF EXISTS schema_migrations CASCADE`;
    } finally {
      await sql.close();
    }
  }

  describe("migrate", () => {
    test("migrate is idempotent", async () => {
      await reset();
      await migrate(url);
      await migrate(url);
      await Promise.all([migrate(url), migrate(url)]);
      const sql = new SQL(url);
      try {
        const rows = await sql`SELECT version FROM schema_migrations`;
        expect(rows.length).toBe(4);
        const t = await sql`SELECT to_regclass('gateway_usage') AS r`;
        expect(t[0].r).toBe("gateway_usage");
        const ext = await sql`SELECT 1 AS x FROM pg_extension WHERE extname = 'timescaledb'`;
        const requireTimescale = Boolean(process.env.CI) && !optOut;
        if (requireTimescale) expect(ext.length).toBe(1);
        if (ext.length > 0) {
          const h = await sql`SELECT hypertable_name FROM timescaledb_information.hypertables`;
          expect(h.map((r: { hypertable_name: string }) => r.hypertable_name)).toContain("gateway_usage");
        }
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

  describe("PgGatewayStore browser contract", () => {
    browserStoreContract(async () => {
      return fresh();
    });
  });
}
