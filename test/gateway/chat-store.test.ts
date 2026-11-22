import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { MemoryChatStore } from "../../src/gateway/chat/store.ts";
import { PgChatStore } from "../../src/gateway/chat/pg-chat-store.ts";
import { migrate } from "../../src/gateway/pg-store.ts";
import { chatStoreContract } from "./chat-store-contract.ts";

const url = process.env.AIS_GATEWAY_TEST_DATABASE_URL;
const optOut = process.env.AIS_GATEWAY_TEST_NO_DATABASE === "1";

describe("MemoryChatStore contract", () => {
  chatStoreContract(async () => new MemoryChatStore());

  test("the memory store uses its own clock and ignores nowMs", async () => {
    let t = 1_000_000;
    const s = new MemoryChatStore(() => t);
    const c = (await s.create({ id: "c1", binding: "b", windowId: 1, name: "n", color: "#000", selection: { provider: "claude", identity: "i" }, tabIds: [], createdAt: t }, 6)) as { id: string };
    const epoch = (await s.acquireLease(c.id, "r1", 1_000, 0)) as number;
    expect((await s.get(c.id))?.leaseUntil).toBe(1_001_000);
    expect(await s.acquireLease(c.id, "r2", 1_000, 99_999_999)).toBeUndefined();
    t += 1_500;
    expect(await s.acquireLease(c.id, "r2", 1_000, 0)).toBe(epoch + 1);
    expect((await s.get(c.id))?.leaseUntil).toBe(t + 1_000);
    await s.renewLease(c.id, { replica: "r2", epoch: epoch + 1 }, 5_000, 0);
    expect((await s.get(c.id))?.leaseUntil).toBe(t + 5_000);
  });
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
  describe("PgChatStore jsonb columns", () => {
    test("stored jsonb values are objects and arrays, not JSON strings", async () => {
      const s = new PgChatStore(url);
      stores.push(s);
      await migrate(url);
      const c = (await s.create({ id: `jsonb-${crypto.randomUUID()}`, binding: "b", windowId: 1, name: "n", color: "#000000", selection: { provider: "claude", identity: "i" }, tabIds: [1, 2], createdAt: Date.now() }, 6, { replica: "r1", ttlMs: 60_000 })) as { id: string; epoch: number };
      const fence = { replica: "r1", epoch: c.epoch };
      await s.appendEvent(c.id, { k: "notice", text: "x" }, fence);
      await s.update(c.id, { selection: { provider: "claude", identity: "j" }, tabIds: [3] }, fence);
      const admin = new SQL(url);
      try {
        const chat = await admin`SELECT jsonb_typeof(selection) AS sel, jsonb_typeof(tab_ids) AS tabs FROM gateway_chats WHERE id = ${c.id}`;
        expect(chat[0]).toEqual({ sel: "object", tabs: "array" });
        const ev = await admin`SELECT jsonb_typeof(body) AS body FROM gateway_chat_events WHERE chat_id = ${c.id}`;
        expect(ev.map((r: { body: string }) => r.body)).toEqual(["object"]);
      } finally {
        await admin.close();
      }
    });
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
