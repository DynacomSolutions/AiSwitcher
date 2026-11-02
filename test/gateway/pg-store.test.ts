import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { migrate, PgGatewayStore } from "../../src/gateway/pg-store.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
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

  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.includes("test")) {
    throw new Error(`refusing to reset database "${dbName}": its name must contain "test"`);
  }

  async function reset(): Promise<void> {
    const sql = new SQL(url as string);
    try {
      await sql`DROP TABLE IF EXISTS gateway_usage, gateway_tokens, gateway_apps, schema_migrations CASCADE`;
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
        expect(rows.length).toBe(1);
        const t = await sql`SELECT to_regclass('gateway_usage') AS r`;
        expect(t[0].r).toBe("gateway_usage");
        const ext = await sql`SELECT 1 AS x FROM pg_extension WHERE extname = 'timescaledb'`;
        if (ext.length > 0) {
          const h = await sql`SELECT hypertable_name FROM timescaledb_information.hypertables`;
          expect(h.map((r: { hypertable_name: string }) => r.hypertable_name)).toContain("gateway_usage");
        }
      } finally {
        await sql.close();
      }
    });
  });

  describe("PgGatewayStore contract", () => {
    storeContract(async () => {
      await reset();
      await migrate(url);
      const s = new PgGatewayStore(url);
      stores.push(s);
      return s;
    });
  });
}
