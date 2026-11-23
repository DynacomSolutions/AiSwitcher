import { afterAll, describe, test } from "bun:test";
import { SQL } from "bun";
import { MemoryFavouriteStore } from "../../src/gateway/chat/favourites-store.ts";
import { PgFavouriteStore } from "../../src/gateway/chat/pg-favourites-store.ts";
import { migrate } from "../../src/gateway/pg-store.ts";
import { favouriteStoreContract } from "./favourites-store-contract.ts";

const url = process.env.AIS_GATEWAY_TEST_DATABASE_URL;
const optOut = process.env.AIS_GATEWAY_TEST_NO_DATABASE === "1";

describe("MemoryFavouriteStore contract", () => {
  favouriteStoreContract(async () => new MemoryFavouriteStore());
});

if (!url && process.env.CI && !optOut) {
  test("pg favourite store tests need AIS_GATEWAY_TEST_DATABASE_URL in CI", () => {
    throw new Error("AIS_GATEWAY_TEST_DATABASE_URL is unset in CI; provide a Postgres service or set AIS_GATEWAY_TEST_NO_DATABASE=1");
  });
} else if (!url) {
  console.warn("SKIP pg favourite store tests: AIS_GATEWAY_TEST_DATABASE_URL is not set");
  test.skip("pg favourite store tests need AIS_GATEWAY_TEST_DATABASE_URL", () => {});
} else {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.includes("test")) throw new Error(`refusing to use database "${dbName}": its name must contain "test"`);
  const stores: PgFavouriteStore[] = [];
  afterAll(async () => {
    for (const s of stores) await s.close();
  });
  describe("PgFavouriteStore contract", () => {
    favouriteStoreContract(async () => {
      for (const s of stores.splice(0)) await s.close();
      await migrate(url);
      const admin = new SQL(url);
      try {
        await admin`DELETE FROM gateway_favourites`;
        await admin`ALTER SEQUENCE gateway_favourites_seq RESTART WITH 1`;
      } finally {
        await admin.close();
      }
      const s = new PgFavouriteStore(url);
      stores.push(s);
      return s;
    });
  });
}
