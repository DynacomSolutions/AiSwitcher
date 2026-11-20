import { describe, expect, test } from "bun:test";
import { PgRefreshBackend, maxHoldersFor } from "../../src/gateway/pg-refresh-backend.ts";
import { PgGatewayStore } from "../../src/gateway/pg-store.ts";
import { PgHomeStore } from "../../src/gateway/home-store.ts";
import { getGatewaySql, pgPoolOptions, releaseGatewaySql } from "../../src/gateway/pg-pool";

describe("pgPoolOptions", () => {
  test("uses safe defaults when the environment is empty", () => {
    expect(pgPoolOptions({}, {})).toEqual({ max: 6, idleTimeout: 30 });
  });

  test("reads both values from the environment", () => {
    expect(pgPoolOptions({}, { AIS_GATEWAY_PG_POOL_MAX: "5", AIS_GATEWAY_PG_IDLE_TIMEOUT_S: "10" })).toEqual({ max: 5, idleTimeout: 10 });
  });

  test("falls back to defaults for invalid values", () => {
    for (const bad of ["", "abc", "0", "-3", "1.5", "NaN", "99999999999999999999"]) {
      expect(pgPoolOptions({}, { AIS_GATEWAY_PG_POOL_MAX: bad, AIS_GATEWAY_PG_IDLE_TIMEOUT_S: bad })).toEqual({ max: 6, idleTimeout: 30 });
    }
  });

  test("maxCap lowers the pool size but never raises it", () => {
    expect(pgPoolOptions({ maxCap: 2 }, {})).toEqual({ max: 2, idleTimeout: 30 });
    expect(pgPoolOptions({ maxCap: 8 }, {})).toEqual({ max: 6, idleTimeout: 30 });
  });

  test("idle false leaves out the idle timeout", () => {
    expect(pgPoolOptions({ idle: false, maxCap: 2 }, {})).toEqual({ max: 2 });
  });
});

function countingSql() {
  const state = { closed: 0 };
  const sql = { close: async () => void (state.closed += 1) } as never;
  return { sql, state };
}

describe("the shared pool", () => {
  test("closing a component does not close an injected shared pool", async () => {
    const { sql, state } = countingSql();
    await new PgGatewayStore("postgres://unused", { sql }).close();
    await new PgHomeStore("postgres://unused", Buffer.alloc(32), "t", () => undefined, { sql }).close();
    await new PgRefreshBackend("postgres://unused", 30, sql).close();
    expect(state.closed).toBe(0);
  });

  test("a component without a shared pool closes its own", async () => {
    // Bun opens no connection until the first query, so this needs no database.
    const store = new PgGatewayStore("postgres://127.0.0.1:1/none");
    await store.close();
    const backend = new PgRefreshBackend("postgres://127.0.0.1:1/none");
    await backend.close();
  });

  test("the shared pool is one object per URL and closes when the last user releases it", async () => {
    const url = "postgres://127.0.0.1:1/shared-test";
    const a = getGatewaySql(url);
    const b = getGatewaySql(url);
    expect(b).toBe(a);
    await releaseGatewaySql(url);
    expect(getGatewaySql(url)).toBe(a); // still held by one user, so not closed or replaced
    await releaseGatewaySql(url);
    await releaseGatewaySql(url);
    expect(getGatewaySql(url)).not.toBe(a); // released by every user, so a new pool is made
    await releaseGatewaySql(url);
  });

  test("lock holders leave two free connections in the pool", () => {
    expect(maxHoldersFor(6)).toBe(4);
    expect(maxHoldersFor(3)).toBe(1);
    expect(maxHoldersFor(1)).toBe(1);
  });
});
