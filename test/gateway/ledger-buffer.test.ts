import { describe, expect, test } from "bun:test";
import { LedgerBuffer } from "../../src/gateway/ledger-buffer.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import type { UsageRow } from "../../src/gateway/types.ts";

function row(i: number): UsageRow {
  return {
    ts: "2026-11-02T01:00:00.000Z",
    app: "a",
    provider: "codex",
    identity: "id1",
    inputTokens: i,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    status: "ok",
    httpStatus: 200,
    latencyMs: 1,
    streamed: false,
  };
}

class FailingStore extends MemoryGatewayStore {
  override async appendUsage(): Promise<void> {
    throw new Error("db down");
  }
}

class CountingStore extends MemoryGatewayStore {
  batches: number[] = [];
  override async appendUsage(rows: UsageRow[]): Promise<void> {
    this.batches.push(rows.length);
    await super.appendUsage(rows);
  }
}

describe("LedgerBuffer", () => {
  test("buffer flushes in batches", async () => {
    const store = new CountingStore();
    const b = new LedgerBuffer(store, { max: 100, flushMs: 60_000 });
    for (let i = 1; i <= 5; i++) b.push(row(i));
    expect(b.depth).toBe(5);
    await b.flush();
    expect(b.depth).toBe(0);
    expect(store.batches).toEqual([5]);
    expect(await store.usageSince("a", new Date(0))).toBe(15);
    await b.close();
  });

  test("timer flushes without an explicit call", async () => {
    const store = new CountingStore();
    const b = new LedgerBuffer(store, { max: 100, flushMs: 10 });
    b.push(row(1));
    await Bun.sleep(80);
    expect(b.depth).toBe(0);
    await b.close();
  });

  test("buffer overflow counts drops", async () => {
    const b = new LedgerBuffer(new FailingStore(), { max: 3, flushMs: 60_000 });
    for (let i = 1; i <= 5; i++) b.push(row(i));
    expect(b.depth).toBe(3);
    expect(b.dropped).toBe(2);
    await b.close();
  });

  test("failed flush keeps rows for retry", async () => {
    const b = new LedgerBuffer(new FailingStore(), { max: 10, flushMs: 60_000 });
    b.push(row(1));
    await b.flush();
    expect(b.depth).toBe(1);
    await b.close();
  });

  test("close flushes remaining rows", async () => {
    const store = new MemoryGatewayStore();
    const b = new LedgerBuffer(store, { max: 100, flushMs: 60_000 });
    b.push(row(7));
    await b.close();
    expect(await store.usageSince("a", new Date(0))).toBe(7);
  });
});
