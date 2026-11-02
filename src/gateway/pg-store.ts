import { SQL, type TransactionSQL } from "bun";
import type { GatewayStore } from "./store.ts";
import type { GatewayApp, TokenRecord, UsageRow } from "./types.ts";
import init0001 from "./migrations/0001_init.sql" with { type: "text" };

const MIGRATIONS: { version: string; sql: string }[] = [{ version: "0001_init", sql: init0001 }];

/** Arbitrary constant key serialising concurrent migrators (including the first-run table create). */
const MIGRATION_LOCK_KEY = 7_410_102;

/** Applies pending migrations. Idempotent and safe to run from several processes at once. */
export async function migrate(url: string): Promise<void> {
  const sql = new SQL(url);
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
      await tx`CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`;
      await tx`LOCK TABLE schema_migrations IN EXCLUSIVE MODE`;
      const done = new Set((await tx`SELECT version FROM schema_migrations`).map((r: { version: string }) => r.version));
      for (const m of MIGRATIONS) {
        if (done.has(m.version)) continue;
        await tx.unsafe(m.sql);
        if (m.version === "0001_init") await tryHypertable(tx);
        await tx`INSERT INTO schema_migrations (version) VALUES (${m.version})`;
      }
    });
  } finally {
    await sql.close();
  }
}

/** Turns gateway_usage into a hypertable when TimescaleDB is available, else warns once and keeps the plain table. */
async function tryHypertable(tx: TransactionSQL): Promise<void> {
  try {
    await tx.savepoint(async (sp) => {
      await sp`CREATE EXTENSION IF NOT EXISTS timescaledb`;
      await sp`SELECT create_hypertable('gateway_usage', 'ts', if_not_exists => true, migrate_data => true)`;
    });
  } catch (err) {
    console.warn(
      `gateway: TimescaleDB unavailable, gateway_usage stays a plain table (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(v as string).toISOString());
const isoOpt = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : iso(v));
const json = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : v);

// biome-ignore lint/suspicious/noExplicitAny: driver rows are untyped
type Row = Record<string, any>;

function toApp(r: Row): GatewayApp {
  const app: GatewayApp = {
    name: r.name,
    owner: r.owner,
    namespace: r.namespace,
    provider: r.provider,
    style: r.style,
    target: json(r.target) as GatewayApp["target"],
    state: r.state,
    createdAt: iso(r.created_at),
  };
  if (r.models !== null) app.models = json(r.models) as string[];
  if (r.daily_tokens !== null) app.dailyTokens = Number(r.daily_tokens);
  if (r.reserve_percent !== null) app.reservePercent = Number(r.reserve_percent);
  const last = isoOpt(r.last_used_at);
  if (last !== undefined) app.lastUsedAt = last;
  return app;
}

export class PgGatewayStore implements GatewayStore {
  private readonly sql: SQL;

  constructor(url: string) {
    this.sql = new SQL(url);
  }

  async close(): Promise<void> {
    await this.sql.close();
  }

  async getApp(name: string): Promise<GatewayApp | undefined> {
    const rows = await this.sql`SELECT * FROM gateway_apps WHERE name = ${name}`;
    return rows[0] ? toApp(rows[0]) : undefined;
  }

  async listApps(): Promise<GatewayApp[]> {
    const rows = await this.sql`SELECT * FROM gateway_apps ORDER BY name`;
    return rows.map(toApp);
  }

  async putApp(a: GatewayApp): Promise<void> {
    const models = a.models === undefined ? null : JSON.stringify(a.models);
    await this.sql`
      INSERT INTO gateway_apps
        (name, owner, namespace, provider, style, target, models, daily_tokens, reserve_percent, state, created_at, last_used_at)
      VALUES
        (${a.name}, ${a.owner}, ${a.namespace}, ${a.provider}, ${a.style}, ${JSON.stringify(a.target)}::jsonb,
         ${models}::jsonb, ${a.dailyTokens ?? null}, ${a.reservePercent ?? null}, ${a.state},
         ${a.createdAt}::timestamptz, ${a.lastUsedAt ?? null}::timestamptz)
      ON CONFLICT (name) DO UPDATE SET
        owner = EXCLUDED.owner, namespace = EXCLUDED.namespace, provider = EXCLUDED.provider,
        style = EXCLUDED.style, target = EXCLUDED.target, models = EXCLUDED.models,
        daily_tokens = EXCLUDED.daily_tokens, reserve_percent = EXCLUDED.reserve_percent,
        state = EXCLUDED.state, created_at = EXCLUDED.created_at, last_used_at = EXCLUDED.last_used_at`;
  }

  async addToken(t: TokenRecord): Promise<void> {
    await this.sql`
      INSERT INTO gateway_tokens (app, prefix, hash, created_at, expires_at)
      VALUES (${t.app}, ${t.prefix}, ${t.hash}, ${t.createdAt}::timestamptz, ${t.expiresAt ?? null}::timestamptz)`;
  }

  async tokensFor(app: string): Promise<TokenRecord[]> {
    const rows = await this.sql`SELECT * FROM gateway_tokens WHERE app = ${app} ORDER BY id`;
    return rows.map((r: Row) => {
      const rec: TokenRecord = { app: r.app, prefix: r.prefix, hash: r.hash, createdAt: iso(r.created_at) };
      const exp = isoOpt(r.expires_at);
      if (exp !== undefined) rec.expiresAt = exp;
      return rec;
    });
  }

  async expireTokens(app: string, at: string): Promise<void> {
    await this.sql`
      UPDATE gateway_tokens SET expires_at = ${at}::timestamptz
      WHERE app = ${app} AND expires_at IS NULL`;
  }

  async revokeApp(name: string): Promise<void> {
    await this.sql`UPDATE gateway_apps SET state = 'revoked' WHERE name = ${name}`;
  }

  async appendUsage(rows: UsageRow[]): Promise<void> {
    if (rows.length === 0) return;
    const values = rows.map((r) => ({
      ts: r.ts,
      app: r.app,
      provider: r.provider,
      identity: r.identity,
      model: r.model ?? null,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      cache_read_tokens: r.cacheReadTokens,
      cache_write_tokens: r.cacheWriteTokens,
      est_cost_usd: r.estCostUsd ?? null,
      status: r.status,
      http_status: r.httpStatus,
      latency_ms: r.latencyMs,
      streamed: r.streamed,
    }));
    await this.sql`INSERT INTO gateway_usage ${this.sql(values)}`;
  }

  async usageSince(app: string, since: Date): Promise<number> {
    const rows = await this.sql`
      SELECT COALESCE(SUM(input_tokens + output_tokens + cache_write_tokens), 0) AS total
      FROM gateway_usage WHERE app = ${app} AND ts >= ${since.toISOString()}::timestamptz`;
    return Number(rows[0]?.total ?? 0);
  }
}
