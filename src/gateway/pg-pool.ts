import { SQL } from "bun";

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

/**
 * One pool serves the whole process: stores, readings, ping and refresh lock holders. Each lock holder pins one
 * connection, and two stay free for normal queries (see PgRefreshBackend). A size of 6 gives four holders.
 */
export const DEFAULT_PG_POOL_MAX = 6;
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

const shared = new Map<string, { sql: SQL; users: number }>();

/**
 * The process-wide pool for a database URL, created on first use. Components use it instead of opening their own pool,
 * so one gateway process holds one pool (plus one LISTEN connection and one leader connection) on the pooler.
 * Each caller counts as one user. A component must never close the pool itself: the user calls `releaseGatewaySql`
 * once at shutdown, and the pool closes when the last user has released it (several gateways can share a process in tests).
 */
export function getGatewaySql(url: string): SQL {
  let entry = shared.get(url);
  if (!entry) {
    entry = { sql: new SQL(url, pgPoolOptions()), users: 0 };
    shared.set(url, entry);
  }
  entry.users += 1;
  return entry.sql;
}

/** Gives a user's hold back. Closes the pool when no user is left. Safe to call for an unknown URL. */
export async function releaseGatewaySql(url: string): Promise<void> {
  const entry = shared.get(url);
  if (!entry) return;
  entry.users -= 1;
  if (entry.users > 0) return;
  shared.delete(url);
  await entry.sql.close().catch(() => undefined);
}
