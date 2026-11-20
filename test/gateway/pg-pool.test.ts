import { describe, expect, test } from "bun:test";
import { pgPoolOptions } from "../../src/gateway/pg-pool";

describe("pgPoolOptions", () => {
  test("uses safe defaults when the environment is empty", () => {
    expect(pgPoolOptions({}, {})).toEqual({ max: 4, idleTimeout: 30 });
  });

  test("reads both values from the environment", () => {
    expect(pgPoolOptions({}, { AIS_GATEWAY_PG_POOL_MAX: "6", AIS_GATEWAY_PG_IDLE_TIMEOUT_S: "10" })).toEqual({ max: 6, idleTimeout: 10 });
  });

  test("falls back to defaults for invalid values", () => {
    for (const bad of ["", "abc", "0", "-3", "1.5", "NaN", "99999999999999999999"]) {
      expect(pgPoolOptions({}, { AIS_GATEWAY_PG_POOL_MAX: bad, AIS_GATEWAY_PG_IDLE_TIMEOUT_S: bad })).toEqual({ max: 4, idleTimeout: 30 });
    }
  });

  test("maxCap lowers the pool size but never raises it", () => {
    expect(pgPoolOptions({ maxCap: 2 }, {})).toEqual({ max: 2, idleTimeout: 30 });
    expect(pgPoolOptions({ maxCap: 8 }, {})).toEqual({ max: 4, idleTimeout: 30 });
  });

  test("idle false leaves out the idle timeout", () => {
    expect(pgPoolOptions({ idle: false, maxCap: 2 }, {})).toEqual({ max: 2 });
  });
});
