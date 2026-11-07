import { SQL, type TransactionSQL } from "bun";
import type { AgentTokenRecord, BrowserBinding, BrowserPairing } from "../browser/types.ts";
import { errorTag } from "./ledger-buffer.ts";
import type { GatewayStore } from "./store.ts";
import type { GatewayApp, GatewayProvider, IdentityUsageRow, TokenRecord, UsageRow } from "./types.ts";
import { priceNullCostGroup } from "./usage.ts";
import init0001 from "./migrations/0001_init.sql" with { type: "text" };
import browser0002 from "./migrations/0002_browser.sql" with { type: "text" };
import refreshJournal0003 from "./migrations/0003_refresh_journal.sql" with { type: "text" };

const MIGRATIONS: { version: string; sql: string }[] = [
  { version: "0001_init", sql: init0001 },
  { version: "0002_browser", sql: browser0002 },
  { version: "0003_refresh_journal", sql: refreshJournal0003 },
];

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
      `gateway: TimescaleDB unavailable, gateway_usage stays a plain table (${errorTag(err)})`,
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

function toBinding(r: Row): BrowserBinding {
  const b: BrowserBinding = {
    name: r.name,
    target: json(r.target) as BrowserBinding["target"],
    profileLabel: r.profile_label,
    state: r.state,
    createdAt: iso(r.created_at),
  };
  const seen = isoOpt(r.last_seen_at);
  if (seen !== undefined) b.lastSeenAt = seen;
  return b;
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

  async usageByIdentity(since: Date, until?: Date): Promise<IdentityUsageRow[]> {
    const to = until ? until.toISOString() : null;
    const rows = await this.sql`
      SELECT provider, identity, app,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(est_cost_usd), 0) AS est_cost_usd,
        0 AS unpriced,
        COUNT(*) AS requests
      FROM gateway_usage WHERE ts >= ${since.toISOString()}::timestamptz AND (${to}::timestamptz IS NULL OR ts < ${to}::timestamptz)
      GROUP BY provider, identity, app ORDER BY provider, identity, app`;
    // Rows stored without a cost are priced from tokens and model at read time.
    const nulls = await this.sql`
      SELECT provider, identity, app, model,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COUNT(*) AS requests
      FROM gateway_usage WHERE est_cost_usd IS NULL AND ts >= ${since.toISOString()}::timestamptz AND (${to}::timestamptz IS NULL OR ts < ${to}::timestamptz)
      GROUP BY provider, identity, app, model`;
    const extra = new Map<string, { cost: number; unpriced: number }>();
    for (const n of nulls as Record<string, unknown>[]) {
      const priced = priceNullCostGroup({
        provider: String(n.provider) as GatewayProvider,
        identity: String(n.identity),
        app: String(n.app),
        model: n.model === null || n.model === undefined ? null : String(n.model),
        inputTokens: Number(n.input_tokens),
        outputTokens: Number(n.output_tokens),
        cacheReadTokens: Number(n.cache_read_tokens),
        cacheWriteTokens: Number(n.cache_write_tokens),
        requests: Number(n.requests),
      });
      const k = `${String(n.provider)}\u0000${String(n.identity)}\u0000${String(n.app)}`;
      const e = extra.get(k) ?? { cost: 0, unpriced: 0 };
      e.cost += priced.cost;
      e.unpriced += priced.unpriced;
      extra.set(k, e);
    }
    return rows.map((r: Record<string, unknown>) => ({
      provider: String(r.provider),
      identity: String(r.identity),
      app: String(r.app),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      cacheWriteTokens: Number(r.cache_write_tokens),
      estCostUsd: Number(r.est_cost_usd) + (extra.get(`${String(r.provider)}\u0000${String(r.identity)}\u0000${String(r.app)}`)?.cost ?? 0),
      unpricedRequests: extra.get(`${String(r.provider)}\u0000${String(r.identity)}\u0000${String(r.app)}`)?.unpriced ?? 0,
      requests: Number(r.requests),
    }));
  }

  async putBrowserBinding(b: BrowserBinding): Promise<void> {
    await this.sql`
      INSERT INTO browser_bindings (name, target, profile_label, state, created_at, last_seen_at)
      VALUES (${b.name}, ${JSON.stringify(b.target)}::jsonb, ${b.profileLabel}, ${b.state},
              ${b.createdAt}::timestamptz, ${b.lastSeenAt ?? null}::timestamptz)
      ON CONFLICT (name) DO UPDATE SET
        target = EXCLUDED.target, profile_label = EXCLUDED.profile_label, state = EXCLUDED.state,
        created_at = EXCLUDED.created_at, last_seen_at = EXCLUDED.last_seen_at`;
  }

  async getBrowserBinding(name: string): Promise<BrowserBinding | undefined> {
    const rows = await this.sql`SELECT * FROM browser_bindings WHERE name = ${name}`;
    return rows[0] ? toBinding(rows[0]) : undefined;
  }

  async listBrowserBindings(): Promise<BrowserBinding[]> {
    const rows = await this.sql`SELECT * FROM browser_bindings ORDER BY name`;
    return rows.map(toBinding);
  }

  async revokeBrowserBinding(name: string): Promise<void> {
    await this.sql`UPDATE browser_bindings SET state = 'revoked' WHERE name = ${name}`;
  }

  async touchBrowserBinding(name: string, at: string): Promise<void> {
    await this.sql`UPDATE browser_bindings SET last_seen_at = ${at}::timestamptz WHERE name = ${name}`;
  }

  async addBrowserToken(binding: string, prefix: string, hash: string): Promise<void> {
    await this.sql`INSERT INTO browser_tokens (binding, prefix, hash) VALUES (${binding}, ${prefix}, ${hash})`;
  }

  async deleteBrowserTokens(binding: string): Promise<void> {
    await this.sql`DELETE FROM browser_tokens WHERE binding = ${binding}`;
  }

  async browserTokenByPrefix(prefix: string): Promise<TokenRecord | undefined> {
    const rows = await this.sql`SELECT * FROM browser_tokens WHERE prefix = ${prefix} ORDER BY id LIMIT 1`;
    const r = rows[0];
    return r ? { app: r.binding, prefix: r.prefix, hash: r.hash, createdAt: iso(r.created_at) } : undefined;
  }

  async putPairing(p: BrowserPairing): Promise<void> {
    await this.sql`
      INSERT INTO browser_pairings (code, profile_label, created_at, expires_at, poll_secret_hash, approved_binding)
      VALUES (${p.code}, ${p.profileLabel}, ${p.createdAt}::timestamptz, ${p.expiresAt}::timestamptz,
              ${p.pollSecretHash}, ${p.approvedBinding ?? null})
      ON CONFLICT (code) DO UPDATE SET
        profile_label = EXCLUDED.profile_label, created_at = EXCLUDED.created_at,
        expires_at = EXCLUDED.expires_at, poll_secret_hash = EXCLUDED.poll_secret_hash, approved_binding = EXCLUDED.approved_binding`;
  }

  async getPairing(code: string): Promise<BrowserPairing | undefined> {
    const rows = await this.sql`SELECT * FROM browser_pairings WHERE code = ${code}`;
    const r = rows[0];
    if (!r) return undefined;
    const p: BrowserPairing = {
      code: r.code,
      profileLabel: r.profile_label,
      createdAt: iso(r.created_at),
      expiresAt: iso(r.expires_at),
      pollSecretHash: r.poll_secret_hash,
    };
    if (r.approved_binding !== null) p.approvedBinding = r.approved_binding;
    return p;
  }

  async claimPairing(code: string): Promise<BrowserPairing | undefined> {
    const rows = await this.sql`DELETE FROM browser_pairings WHERE code = ${code} RETURNING *`;
    const r = rows[0];
    if (!r) return undefined;
    const p: BrowserPairing = {
      code: r.code,
      profileLabel: r.profile_label,
      createdAt: iso(r.created_at),
      expiresAt: iso(r.expires_at),
      pollSecretHash: r.poll_secret_hash,
    };
    if (r.approved_binding !== null) p.approvedBinding = r.approved_binding;
    return p;
  }

  async deletePairing(code: string): Promise<void> {
    await this.sql`DELETE FROM browser_pairings WHERE code = ${code}`;
  }

  async deleteExpiredPairings(now: Date): Promise<void> {
    await this.sql`DELETE FROM browser_pairings WHERE expires_at <= ${now.toISOString()}::timestamptz`;
  }

  async addAgentToken(r: AgentTokenRecord): Promise<void> {
    await this.sql`
      INSERT INTO browser_agent_tokens (identity, prefix, hash, created_at, revoked_at)
      VALUES (${r.identity}, ${r.prefix}, ${r.hash}, ${r.createdAt}::timestamptz, ${r.revokedAt ?? null}::timestamptz)`;
  }

  async agentTokenByPrefix(prefix: string): Promise<AgentTokenRecord | undefined> {
    const rows = await this.sql`
      SELECT * FROM browser_agent_tokens WHERE prefix = ${prefix} AND revoked_at IS NULL ORDER BY id LIMIT 1`;
    const r = rows[0];
    if (!r) return undefined;
    return { identity: r.identity, prefix: r.prefix, hash: r.hash, createdAt: iso(r.created_at) };
  }

  async revokeAgentTokens(identity: string): Promise<void> {
    await this.sql`
      UPDATE browser_agent_tokens SET revoked_at = now() WHERE identity = ${identity} AND revoked_at IS NULL`;
  }
}
