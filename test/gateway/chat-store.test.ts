import { afterAll, describe, test } from "bun:test";
import { SQL } from "bun";
import { MemoryChatStore } from "../../src/gateway/chat/store.ts";
import { PgChatStore } from "../../src/gateway/chat/pg-chat-store.ts";
import { migrate } from "../../src/gateway/pg-store.ts";
import { chatStoreContract } from "./chat-store-contract.ts";

const url = process.env.AIS_GATEWAY_TEST_DATABASE_URL;
const optOut = process.env.AIS_GATEWAY_TEST_NO_DATABASE === "1";

describe("MemoryChatStore contract", () => {
  chatStoreContract(async () => new MemoryChatStore());
});

if (!url && process.env.CI && !optOut) {
  test("pg chat store tests need AIS_GATEWAY_TEST_DATABASE_URL in CI", () => {
    throw new Error("AIS_GATEWAY_TEST_DATABASE_URL is unset in CI; provide a Postgres service or set AIS_GATEWAY_TEST_NO_DATABASE=1");
  });
} else if (!url) {
  console.warn("SKIP pg chat store tests: AIS_GATEWAY_TEST_DATABASE_URL is not set");
  test.skip("pg chat store tests need AIS_GATEWAY_TEST_DATABASE_URL", () => {});
} else {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.includes("test")) throw new Error(`refusing to use database "${dbName}": its name must contain "test"`);
  const stores: PgChatStore[] = [];
  afterAll(async () => {
    for (const s of stores) await s.close();
  });
  describe("PgChatStore contract", () => {
    chatStoreContract(async () => {
      for (const s of stores.splice(0)) await s.close();
      await migrate(url);
      const admin = new SQL(url);
      try {
        await admin`DELETE FROM gateway_chats`;
      } finally {
        await admin.close();
      }
      const s = new PgChatStore(url);
      stores.push(s);
      return s;
    });
  });
}
