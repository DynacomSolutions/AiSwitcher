import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { PgRefreshBackend } from "../../src/gateway/pg-refresh-backend.ts";

const ACCOUNT = { provider: "claude", identity: "acct-a" };

/** A scripted stand-in for the driver pool: each reserved connection runs the next script entry for its lock query. */
function fakePool(scripts: Array<"hang" | "error" | "got" | "busy-then-got">) {
  const state = { reserved: 0, closed: 0, released: 0, lockCalls: 0 };
  const sql = {
    reserve: async () => {
      const script = scripts[state.reserved] ?? "got";
      state.reserved += 1;
      let polls = 0;
      const tag = ((strings: TemplateStringsArray) => {
        const text = strings.join("?");
        if (!text.includes("pg_try_advisory_lock")) return Promise.resolve([]);
        state.lockCalls += 1;
        if (script === "hang") return new Promise<never>(() => {});
        if (script === "error") return Promise.reject(new Error("connection terminated"));
        polls += 1;
        return Promise.resolve([{ got: script === "got" || polls > 1 }]);
      }) as unknown as Record<string, unknown>;
      tag.unsafe = async () => [];
      tag.release = () => void (state.released += 1);
      tag.close = async () => void (state.closed += 1);
      return tag;
    },
    close: async () => {},
  };
  return { sql: sql as unknown as SQL, state };
}

describe("the PostgreSQL refresh lock under a slow or restarting database", () => {
  test("a lock call that hangs is retried on a fresh connection inside the lock deadline", async () => {
    const { sql, state } = fakePool(["hang", "got"]);
    const backend = new PgRefreshBackend("postgres://unused", 30, sql);
    const lock = await backend.acquire(ACCOUNT, 3_000);
    expect(state.reserved).toBe(2);
    expect(state.closed).toBe(1); // the hung connection is ended, never reused: a late lock on it dies with the session
    await lock.release();
    expect(state.released).toBe(1);
  });

  test("a failed lock call is retried, and a busy lock is polled on the same connection", async () => {
    const { sql, state } = fakePool(["error", "busy-then-got"]);
    const backend = new PgRefreshBackend("postgres://unused", 30, sql);
    const lock = await backend.acquire(ACCOUNT, 3_000);
    expect(state.reserved).toBe(2);
    expect(lock.contended).toBe(true);
    await lock.release();
  });

  test("when every attempt fails the deadline ends it with the error, and every connection is ended", async () => {
    const { sql, state } = fakePool(["error", "error", "error", "error", "error", "error"]);
    const backend = new PgRefreshBackend("postgres://unused", 30, sql);
    const started = Date.now();
    await expect(backend.acquire(ACCOUNT, 700)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(state.closed).toBe(state.reserved);
  });
});
