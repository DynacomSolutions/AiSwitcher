/**
 * Shared Bun SQL pool options for the gateway.
 *
 * The gateway talks to PostgreSQL through PgBouncer in session mode. Every idle client connection then pins one server
 * connection. So pools stay small and close idle connections quickly. Bun's defaults are max 10 and no idle timeout.
 * Bun reads `idleTimeout` and `maxLifetime` in seconds. A value of 0 turns the timeout off.
 */
export interface PgPoolOptions {
  max: number;
  idleTimeout?: number;
}

export const DEFAULT_PG_POOL_MAX = 4;
export const DEFAULT_PG_IDLE_TIMEOUT_S = 30;

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/**
 * Pool options from AIS_GATEWAY_PG_POOL_MAX and AIS_GATEWAY_PG_IDLE_TIMEOUT_S. Missing, zero, negative or
 * non-numeric values fall back to the defaults. `maxCap` lowers the pool size for small pools.
 * `idle: false` leaves out the idle timeout, for pools that must keep a connection open.
 */
export function pgPoolOptions(opts: { maxCap?: number; idle?: boolean } = {}, env: Record<string, string | undefined> = process.env): PgPoolOptions {
  let max = positiveInt(env.AIS_GATEWAY_PG_POOL_MAX, DEFAULT_PG_POOL_MAX);
  if (opts.maxCap !== undefined) max = Math.min(max, opts.maxCap);
  if (opts.idle === false) return { max };
  return { max, idleTimeout: positiveInt(env.AIS_GATEWAY_PG_IDLE_TIMEOUT_S, DEFAULT_PG_IDLE_TIMEOUT_S) };
}
