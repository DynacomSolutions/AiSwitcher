import { SQL, type TransactionSQL } from "bun";
import type { AgentTokenRecord, BrowserBinding, BrowserPairing } from "../browser/types.ts";
import { bumpSideCountOn, type SqlTag } from "./side-count.ts";
import { errorTag } from "./ledger-buffer.ts";
import { AppRevokedError, type GatewayStore, type SessionUsageFilter } from "./store.ts";
import type { GatewayApp, GatewayProvider, IdentityUsageRow, ModelDailyUsageRow, ModelUsageRow, SessionIdentityUsageRow, TokenRecord, UsageHistoryFilter, UsageHistoryRow, UsageHistoryStored, UsageRow } from "./types.ts";
import { priceNullCostGroup } from "./usage.ts";
import { planRollupRange, rollupAggregateSql, rollupSource } from "./usage-rollup.ts";
import init0001 from "./migrations/0001_init.sql" with { type: "text" };
import browser0002 from "./migrations/0002_browser.sql" with { type: "text" };
import refreshJournal0003 from "./migrations/0003_refresh_journal.sql" with { type: "text" };
import sideCounts0004 from "./migrations/0004_side_counts.sql" with { type: "text" };
import homeFiles0005 from "./migrations/0005_home_files.sql" with { type: "text" };
import browserPresence0006 from "./migrations/0006_browser_presence.sql" with { type: "text" };
import refreshJournalCode0007 from "./migrations/0007_refresh_journal_code.sql" with { type: "text" };
import usageHistory0008 from "./migrations/0008_usage_history.sql" with { type: "text" };
import usageRollup0009 from "./migrations/0009_usage_rollup.sql" with { type: "text" };
import usageReadings0010 from "./migrations/0010_usage_readings.sql" with { type: "text" };
import usageSession0011 from "./migrations/0011_usage_session.sql" with { type: "text" };
import chat0012 from "./migrations/0012_chat.sql" with { type: "text" };
import favourites0013 from "./migrations/0013_favourites.sql" with { type: "text" };
import sessions0014 from "./migrations/0014_sessions.sql" with { type: "text" };
import sessionsOneCopy0015 from "./migrations/0015_sessions_one_copy.sql" with { type: "text" };
import resetCreditInvalidations0016 from "./migrations/0016_reset_credit_invalidations.sql" with { type: "text" };
import codexAutoReset0017 from "./migrations/0017_codex_auto_reset.sql" with { type: "text" };
import codexPoolReset0018 from "./migrations/0018_codex_pool_reset.sql" with { type: "text" };
import type { PgListener } from "./pg-listen.ts";
import { pgPoolOptions } from "./pg-pool.ts";

const USAGE_ROLLUP_VERSION = "0009_usage_rollup";

const MIGRATIONS: { version: string; sql: string }[] = [
  { version: "0001_init", sql: init0001 },
  { version: "0002_browser", sql: browser0002 },
  { version: "0003_refresh_journal", sql: refreshJournal0003 },
  { version: "0004_side_counts", sql: sideCounts0004 },
  { version: "0005_home_files", sql: homeFiles0005 },
  { version: "0006_browser_presence", sql: browserPresence0006 },
  { version: "0007_refresh_journal_code", sql: refreshJournalCode0007 },
  { version: "0008_usage_history", sql: usageHistory0008 },
  { version: USAGE_ROLLUP_VERSION, sql: usageRollup0009 },
  { version: "0010_usage_readings", sql: usageReadings0010 },
  { version: "0011_usage_session", sql: usageSession0011 },
  { version: "0012_chat", sql: chat0012 },
  { version: "0013_favourites", sql: favourites0013 },
  { version: "0014_sessions", sql: sessions0014 },
  { version: "0015_sessions_one_copy", sql: sessionsOneCopy0015 },
  { version: "0016_reset_credit_invalidations", sql: resetCreditInvalidations0016 },
  { version: "0017_codex_auto_reset", sql: codexAutoReset0017 },
  { version: "0018_codex_pool_reset", sql: codexPoolReset0018 },
];

/** Arbitrary constant key serialising concurrent migrators (including the first-run table create). */
const MIGRATION_LOCK_KEY = 7_410_102;

export interface MigrateOptions {
  /** A migration statement that waits longer than this for a table lock fails (default 5 s), so it never queues behind long work. */
  lockTimeoutMs?: number;
  /** Attempts after a lock timeout (default 3), with a short pause between them. */
  attempts?: number;
}

/** Applies pending migrations. Idempotent and safe to run from several processes at once. */
export async function migrate(url: string, opts: MigrateOptions = {}): Promise<void> {
  const attempts = opts.attempts ?? 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await migrateOnce(url, opts.lockTimeoutMs ?? 5_000);
      return;
    } catch (err) {
      // 55P03: lock_not_available. A queued ALTER blocks every query behind it, so it gives up and tries again later.
      const lockTimeout = (err as { errno?: unknown; code?: unknown } | null)?.errno === "55P03";
      if (!lockTimeout || attempt >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

async function migrateOnce(url: string, lockTimeoutMs: number): Promise<void> {
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
        await tx.unsafe(`SET LOCAL lock_timeout = ${Math.trunc(lockTimeoutMs)}`);
        if (m.version === USAGE_ROLLUP_VERSION) {
          if (!(await tryUsageRollup(tx, m.sql))) continue;
        } else {
          await tx.unsafe(m.sql);
        }
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

/**
 * Creates the usage rollup when gateway_usage is a hypertable. Without TimescaleDB it warns once and returns true,
 * so the version is recorded and the store reads the raw ledger. Returns false after a failed create:
 * the version stays pending and the next start tries again. A lock timeout is rethrown for the caller's retry.
 */
async function tryUsageRollup(tx: TransactionSQL, ddl: string): Promise<boolean> {
  try {
    // The checks run inside the savepoint too: a failure there must skip 0009 only, never abort the whole migration run.
    const created = await tx.savepoint(async (sp) => {
      const view = await sp`SELECT to_regclass('timescaledb_information.hypertables') IS NOT NULL AS present`;
      let hypertable = false;
      if (view[0]?.present === true) {
        const rows = await sp`SELECT 1 AS x FROM timescaledb_information.hypertables WHERE hypertable_schema = current_schema() AND hypertable_name = 'gateway_usage'`;
        hypertable = rows.length > 0;
      }
      if (!hypertable) return false;
      await sp.unsafe(ddl);
      return true;
    });
    if (!created) {
      console.warn("gateway: gateway_usage is not a hypertable, so the usage rollup is skipped and usage reads scan the raw ledger");
    }
    return true;
  } catch (err) {
    if ((err as { errno?: unknown } | null)?.errno === "55P03") throw err;
    console.warn(`gateway: usage rollup not created, usage reads scan the raw ledger and the next start retries (${errorTag(err)})`);
    return false;
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

/** NOTIFY channel carrying the name of an app that changed, so other replicas re-read it at once. */
const APPS_CHANNEL = "gateway_apps_changed";

export interface PgGatewayStoreOptions {
  /** "auto" (default) reads wide usage ranges from the gateway_usage_15m rollup when it exists. "off" always reads the raw ledger. */
  usageRollup?: "auto" | "off";
  /** The process-wide pool. The store then never closes it. Without it, the store opens and owns its own pool. */
  sql?: SQL;
  /** The process-wide LISTEN connection. Without it, app-change notices use the store's own pool. */
  listener?: PgListener;
}

/** How long a missing or failing rollup is left alone before the next check. */
const ROLLUP_RECHECK_MS = 60_000;

export class PgGatewayStore implements GatewayStore {
  private readonly sql: SQL;
  private readonly ownsSql: boolean;
  private readonly listener: PgListener | undefined;
  private readonly rollupMode: "auto" | "off";
  private rollupReady = false;
  private rollupRetryAt = 0;

  constructor(url: string, opts: PgGatewayStoreOptions = {}) {
    this.ownsSql = !opts.sql;
    this.sql = opts.sql ?? new SQL(url, pgPoolOptions());
    this.listener = opts.listener;
    this.rollupMode = opts.usageRollup ?? "auto";
  }

  /** True when usage reads use the rollup: the mode is "auto" and gateway_usage_15m exists. A success is cached. */
  async usesUsageRollup(): Promise<boolean> {
    if (this.rollupMode === "off") return false;
    if (this.rollupReady) return true;
    if (Date.now() < this.rollupRetryAt) return false;
    try {
      const rows = await this.sql`SELECT to_regclass('gateway_usage_15m') IS NOT NULL AS present`;
      this.rollupReady = rows[0]?.present === true;
    } catch {
      this.rollupReady = false;
    }
    if (!this.rollupReady) this.rollupRetryAt = Date.now() + ROLLUP_RECHECK_MS;
    return this.rollupReady;
  }

  /** Runs a rollup read. Returns undefined when the rollup cannot serve the range, so the caller reads the raw ledger. */
  private async viaRollup<T>(since: Date, until: Date | undefined, read: (plan: NonNullable<ReturnType<typeof planRollupRange>>) => Promise<T>): Promise<T | undefined> {
    const plan = planRollupRange(since, until);
    if (!plan || !(await this.usesUsageRollup())) return undefined;
    try {
      return await read(plan);
    } catch (err) {
      console.warn(`gateway: usage rollup read failed, reading the raw ledger (${errorTag(err)})`);
      this.rollupReady = false;
      this.rollupRetryAt = Date.now() + ROLLUP_RECHECK_MS;
      return undefined;
    }
  }

  /** Closes the store's own pool. A shared pool stays open. */
  async close(): Promise<void> {
    if (this.ownsSql) await this.sql.close();
  }

  async getApp(name: string): Promise<GatewayApp | undefined> {
    const rows = await this.sql`SELECT * FROM gateway_apps WHERE name = ${name}`;
    return rows[0] ? toApp(rows[0]) : undefined;
  }

  async listApps(): Promise<GatewayApp[]> {
    const rows = await this.sql`SELECT * FROM gateway_apps ORDER BY name`;
    return rows.map(toApp);
  }

  /** Tells the other replicas an app changed. Best effort: the periodic refresh is the fallback. */
  private async notifyApp(name: string): Promise<void> {
    await this.sql`SELECT pg_notify(${APPS_CHANNEL}, ${name})`.catch(() => undefined);
  }

  /** Calls `onApp` for every app-change NOTIFY. Resolves once listening; returns an unlisten function. */
  async listenAppChanges(onApp: (name: string) => void): Promise<() => Promise<void>> {
    if (this.listener) return this.listener.listen(APPS_CHANNEL, onApp);
    // biome-ignore lint/suspicious/noExplicitAny: Bun's SQL listen is not in the published types yet
    const handle: any = await (this.sql as any).listen(APPS_CHANNEL, (payload: string) => onApp(payload));
    return async () => {
      await Promise.resolve(handle?.unlisten?.()).catch(() => undefined);
    };
  }

  /** A control notice on the app-change channel; unlike a write notice it throws, so a failed probe shows. */
  async pingAppChanges(payload: string): Promise<void> {
    await this.sql`SELECT pg_notify(${APPS_CHANNEL}, ${payload})`;
  }

  async putApp(a: GatewayApp): Promise<void> {
    const models = a.models === undefined ? null : JSON.stringify(a.models);
    // The WHERE keeps a revoked row untouched: a revoked app is final, whatever a stale replica sends.
    const rows = await this.sql`
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
        state = EXCLUDED.state, created_at = EXCLUDED.created_at, last_used_at = EXCLUDED.last_used_at
      WHERE gateway_apps.state <> 'revoked'
      RETURNING name`;
    if (rows.length === 0) throw new AppRevokedError(a.name);
    await this.notifyApp(a.name);
  }

  async addToken(t: TokenRecord): Promise<void> {
    // FOR SHARE blocks a concurrent revoke until this insert commits, so the revoke then expires the new token too.
    const rows = await this.sql`
      INSERT INTO gateway_tokens (app, prefix, hash, created_at, expires_at)
      SELECT name, ${t.prefix}::text, ${t.hash}::text, ${t.createdAt}::timestamptz, ${t.expiresAt ?? null}::timestamptz
      FROM gateway_apps WHERE name = ${t.app} AND state = 'active' FOR SHARE OF gateway_apps
      RETURNING id`;
    if (rows.length === 0) throw new AppRevokedError(t.app);
    await this.notifyApp(t.app);
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
    await this.notifyApp(app);
  }

  async capMarkedTokens(app: string, mark: string, at: string): Promise<void> {
    await this.sql`
      UPDATE gateway_tokens SET expires_at = ${at}::timestamptz
      WHERE app = ${app} AND starts_with(prefix, ${mark}::text) AND (expires_at IS NULL OR expires_at > ${at}::timestamptz)`;
    await this.notifyApp(app);
  }

  async pruneMarkedTokens(app: string, mark: string, before: string): Promise<void> {
    await this.sql`
      DELETE FROM gateway_tokens
      WHERE app = ${app} AND starts_with(prefix, ${mark}::text) AND expires_at IS NOT NULL AND expires_at < ${before}::timestamptz`;
    await this.notifyApp(app);
  }

  async revokeApp(name: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`UPDATE gateway_apps SET state = 'revoked' WHERE name = ${name}`;
      await tx`
        UPDATE gateway_tokens SET expires_at = now()
        WHERE app = ${name} AND (expires_at IS NULL OR expires_at > now())`;
    });
    await this.notifyApp(name);
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
      session_key: r.sessionKey ?? null,
      client: r.client ?? null,
    }));
    await this.sql`INSERT INTO gateway_usage ${this.sql(values)}`;
  }

  async usageBySession(since: Date, until?: Date, filter: SessionUsageFilter = {}): Promise<SessionIdentityUsageRow[]> {
    const to = until ? until.toISOString() : null;
    const keys = filter.sessionKeys && filter.sessionKeys.length > 0 ? filter.sessionKeys : null;
    const rows = await this.sql`
      SELECT session_key, provider, app, identity, max(client) AS client,
        COUNT(*) AS turns,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        MIN(ts) AS first_ts,
        MAX(ts) AS last_ts
      FROM gateway_usage
      WHERE ts >= ${since.toISOString()}::timestamptz AND (${to}::timestamptz IS NULL OR ts < ${to}::timestamptz)
        AND session_key IS NOT NULL AND status = 'ok' AND identity <> '-'
        AND (${filter.provider ?? null}::text IS NULL OR provider = ${filter.provider ?? null}::text)
        AND (${filter.app ?? null}::text IS NULL OR app = ${filter.app ?? null}::text)
        AND (${keys}::text[] IS NULL OR session_key = ANY(${keys}::text[]))
      GROUP BY session_key, provider, app, identity ORDER BY session_key, provider, app, identity`;
    return rows.map((r: Row) => ({
      sessionKey: String(r.session_key),
      provider: String(r.provider),
      app: String(r.app),
      client: r.client === null || r.client === undefined ? null : String(r.client),
      identity: String(r.identity),
      turns: Number(r.turns),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      cacheWriteTokens: Number(r.cache_write_tokens),
      firstTs: iso(r.first_ts),
      lastTs: iso(r.last_ts),
    }));
  }

  async usageSince(app: string, since: Date): Promise<number> {
    const rows = await this.sql`
      SELECT COALESCE(SUM(input_tokens + output_tokens + cache_write_tokens), 0) AS total
      FROM gateway_usage WHERE app = ${app} AND ts >= ${since.toISOString()}::timestamptz`;
    return Number(rows[0]?.total ?? 0);
  }

  async usageTotalsSince(since: Date): Promise<Map<string, number>> {
    const rows = await this.sql`
      SELECT app, COALESCE(SUM(input_tokens + output_tokens + cache_write_tokens), 0) AS total
      FROM gateway_usage WHERE ts >= ${since.toISOString()}::timestamptz GROUP BY app`;
    return new Map(rows.map((r: { app: unknown; total: unknown }) => [String(r.app), Number(r.total ?? 0)]));
  }

  bumpSideCount(app: string, day: string, signal?: AbortSignal): Promise<number> {
    return bumpSideCountOn(this.sql as unknown as SqlTag, app, day, signal);
  }

  async usageByIdentity(since: Date, until?: Date): Promise<IdentityUsageRow[]> {
    const viaRollup = await this.viaRollup(since, until, async (plan) => {
      const q = rollupAggregateSql(rollupSource(plan), "provider, identity, app, model", "provider, identity, app, model");
      // One row per model, in (provider, identity, app) order, so each (provider, identity, app) group is contiguous.
      const rows = (await this.sql.unsafe(q.text, q.params)) as Record<string, unknown>[];
      const out = new Map<string, IdentityUsageRow>();
      for (const r of rows) {
        const k = `${String(r.provider)}\u0000${String(r.identity)}\u0000${String(r.app)}`;
        let row = out.get(k);
        if (!row) {
          row = {
            provider: String(r.provider),
            identity: String(r.identity),
            app: String(r.app),
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            estCostUsd: 0,
            unpricedRequests: 0,
            requests: 0,
          };
          out.set(k, row);
        }
        row.inputTokens += Number(r.input_tokens);
        row.outputTokens += Number(r.output_tokens);
        row.cacheReadTokens += Number(r.cache_read_tokens);
        row.cacheWriteTokens += Number(r.cache_write_tokens);
        row.requests += Number(r.requests);
        row.estCostUsd += Number(r.est_cost_usd);
        if (Number(r.n_requests) > 0) {
          const priced = priceNullCostGroup({
            provider: String(r.provider) as GatewayProvider,
            identity: String(r.identity),
            app: String(r.app),
            model: r.model === null || r.model === undefined ? null : String(r.model),
            inputTokens: Number(r.n_input),
            outputTokens: Number(r.n_output),
            cacheReadTokens: Number(r.n_cache_read),
            cacheWriteTokens: Number(r.n_cache_write),
            requests: Number(r.n_requests),
          });
          row.estCostUsd += priced.cost;
          row.unpricedRequests += priced.unpriced;
        }
      }
      return [...out.values()];
    });
    return viaRollup ?? this.usageByIdentityRaw(since, until);
  }

  private async usageByIdentityRaw(since: Date, until?: Date): Promise<IdentityUsageRow[]> {
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

  async usageByModel(since: Date, until?: Date): Promise<ModelUsageRow[]> {
    const viaRollup = await this.viaRollup(since, until, async (plan) => {
      const q = rollupAggregateSql(rollupSource(plan), "provider, identity, app, model", "provider, identity, app, model");
      const rows = (await this.sql.unsafe(q.text, q.params)) as Record<string, unknown>[];
      return rows.map((r): ModelUsageRow => {
        const priced = Number(r.n_requests) > 0
          ? priceNullCostGroup({
              provider: String(r.provider) as GatewayProvider,
              identity: String(r.identity),
              app: String(r.app),
              model: r.model === null || r.model === undefined ? null : String(r.model),
              inputTokens: Number(r.n_input),
              outputTokens: Number(r.n_output),
              cacheReadTokens: Number(r.n_cache_read),
              cacheWriteTokens: Number(r.n_cache_write),
              requests: Number(r.n_requests),
            })
          : { cost: 0, unpriced: 0 };
        return {
          provider: String(r.provider),
          identity: String(r.identity),
          app: String(r.app),
          model: r.model === null || r.model === undefined ? null : String(r.model),
          inputTokens: Number(r.input_tokens),
          outputTokens: Number(r.output_tokens),
          cacheReadTokens: Number(r.cache_read_tokens),
          cacheWriteTokens: Number(r.cache_write_tokens),
          estCostUsd: Number(r.est_cost_usd) + priced.cost,
          unpricedRequests: priced.unpriced,
          requests: Number(r.requests),
          firstTs: iso(r.first_ts),
          lastTs: iso(r.last_ts),
        };
      });
    });
    return viaRollup ?? this.usageByModelRaw(since, until);
  }

  private async usageByModelRaw(since: Date, until?: Date): Promise<ModelUsageRow[]> {
    const to = until ? until.toISOString() : null;
    const rows = await this.sql`
      SELECT provider, identity, app, model,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(est_cost_usd), 0) AS est_cost_usd,
        0 AS unpriced,
        COUNT(*) AS requests,
        MIN(ts) AS first_ts,
        MAX(ts) AS last_ts
      FROM gateway_usage WHERE ts >= ${since.toISOString()}::timestamptz AND (${to}::timestamptz IS NULL OR ts < ${to}::timestamptz)
      GROUP BY provider, identity, app, model ORDER BY provider, identity, app, model`;
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
    const mkey = (m: unknown): string => (m === null || m === undefined ? "" : String(m));
    const gkey = (r: Record<string, unknown>): string => `${String(r.provider)}\u0000${String(r.identity)}\u0000${String(r.app)}\u0000${mkey(r.model)}`;
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
      const e = extra.get(gkey(n)) ?? { cost: 0, unpriced: 0 };
      e.cost += priced.cost;
      e.unpriced += priced.unpriced;
      extra.set(gkey(n), e);
    }
    return rows.map((r: Record<string, unknown>) => ({
      provider: String(r.provider),
      identity: String(r.identity),
      app: String(r.app),
      model: r.model === null || r.model === undefined ? null : String(r.model),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      cacheWriteTokens: Number(r.cache_write_tokens),
      estCostUsd: Number(r.est_cost_usd) + (extra.get(gkey(r))?.cost ?? 0),
      unpricedRequests: extra.get(gkey(r))?.unpriced ?? 0,
      requests: Number(r.requests),
      firstTs: iso(r.first_ts),
      lastTs: iso(r.last_ts),
    }));
  }

  async upsertUsageHistory(rows: UsageHistoryRow[]): Promise<void> {
    // One statement per row inside one transaction: a batch lands whole or not at all.
    await this.sql.begin(async (tx) => {
      for (const r of rows) {
        await tx`
          INSERT INTO gateway_usage_history (source, generation, provider, identity, day, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, messages, est_cost_usd, first_day, last_day, zone)
          VALUES (${r.source}, ${r.generation}::timestamptz, ${r.provider}, ${r.identity}, ${r.day}::date, ${r.model}, ${r.inputTokens}, ${r.outputTokens}, ${r.cacheReadTokens}, ${r.cacheWriteTokens}, ${r.messages}, ${r.estCostUsd}, ${r.firstDay}::date, ${r.lastDay}::date, ${r.zone})
          ON CONFLICT (source, generation, provider, identity, (COALESCE(day, 'infinity'::date)), (COALESCE(model, ''))) DO UPDATE SET
            input_tokens = EXCLUDED.input_tokens,
            output_tokens = EXCLUDED.output_tokens,
            cache_read_tokens = EXCLUDED.cache_read_tokens,
            cache_write_tokens = EXCLUDED.cache_write_tokens,
            messages = EXCLUDED.messages,
            est_cost_usd = EXCLUDED.est_cost_usd,
            first_day = EXCLUDED.first_day,
            last_day = EXCLUDED.last_day,
            zone = EXCLUDED.zone,
            imported_at = now()`;
      }
    });
  }

  async usageHistory(filter: UsageHistoryFilter = {}): Promise<UsageHistoryStored[]> {
    const generation = filter.generation === undefined || filter.generation === "latest" ? null : new Date(filter.generation).toISOString();
    const rows = await this.sql`
      SELECT source, generation, provider, identity, to_char(day, 'YYYY-MM-DD') AS day, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, messages, est_cost_usd,
        to_char(first_day, 'YYYY-MM-DD') AS first_day, to_char(last_day, 'YYYY-MM-DD') AS last_day, zone, imported_at
      FROM gateway_usage_history h
      WHERE (${generation}::timestamptz IS NULL AND h.generation = (SELECT max(m.generation) FROM gateway_usage_history m WHERE m.source = h.source)
             OR h.generation = ${generation}::timestamptz)
        AND (${filter.source ?? null}::text IS NULL OR source = ${filter.source ?? null})
        AND (${filter.provider ?? null}::text IS NULL OR provider = ${filter.provider ?? null})
        AND (${filter.identity ?? null}::text IS NULL OR identity = ${filter.identity ?? null})
      ORDER BY provider, identity, day NULLS FIRST, model NULLS FIRST, source`;
    const opt = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
    return rows.map((r: Record<string, unknown>) => ({
      source: String(r.source),
      generation: iso(r.generation),
      provider: String(r.provider),
      identity: String(r.identity),
      day: opt(r.day),
      model: opt(r.model),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      cacheWriteTokens: Number(r.cache_write_tokens),
      messages: Number(r.messages),
      estCostUsd: Number(r.est_cost_usd),
      firstDay: opt(r.first_day),
      lastDay: opt(r.last_day),
      zone: String(r.zone),
      importedAt: iso(r.imported_at),
    }));
  }

  async usageByModelDaily(since: Date, until: Date | undefined, tz: string): Promise<ModelDailyUsageRow[]> {
    const viaRollup = await this.viaRollup(since, until, async (plan) => {
      // A 15-minute bucket sits in one local day only when the zone's offset is a whole number of 15 minutes.
      if (!(await this.zoneFitsBuckets(tz, since, until))) return undefined;
      const q = rollupAggregateSql(rollupSource(plan, tz), "day, provider, identity, model", "day, provider, identity, model");
      return this.dailyRows((await this.sql.unsafe(q.text, q.params)) as Record<string, unknown>[]);
    });
    return viaRollup ?? this.usageByModelDailyRaw(since, until, tz);
  }

  /**
   * True when every UTC offset of `tz` across the stored data inside [since, until) is a multiple of 900 s.
   * Samples one instant a day between the first and the last stored row, so the series stays short.
   * An unknown zone answers false: the raw query then raises its usual error.
   */
  private async zoneFitsBuckets(tz: string, since: Date, until: Date | undefined): Promise<boolean> {
    try {
      // No data in range (empty table, or since after the last row) gives an empty series, so the answer is true at once.
      const rows = await this.sql`
        WITH bounds AS (
          SELECT greatest(${since.toISOString()}::timestamptz, mn) AS lo,
                 CASE WHEN mx IS NULL THEN NULL ELSE least(coalesce(${until ? until.toISOString() : null}::timestamptz, mx), mx) END AS hi
          FROM (SELECT min(ts) AS mn, max(ts) AS mx FROM gateway_usage) m
        )
        SELECT coalesce(bool_and(mod(EXTRACT(epoch FROM (g AT TIME ZONE ${tz}::text) - (g AT TIME ZONE 'UTC'))::int, 900) = 0), true) AS ok
        FROM bounds,
          generate_series(bounds.lo, CASE WHEN bounds.lo > bounds.hi THEN bounds.lo - interval '1 day' ELSE bounds.hi + interval '1 day' END, interval '1 day') g`;
      return rows[0]?.ok === true;
    } catch {
      return false;
    }
  }

  private dailyRows(rows: Record<string, unknown>[]): ModelDailyUsageRow[] {
    return rows.map((r) => {
      const nullRequests = Number(r.n_requests);
      const priced = nullRequests > 0
        ? priceNullCostGroup({
            provider: String(r.provider) as GatewayProvider,
            identity: String(r.identity),
            app: "",
            model: r.model === null || r.model === undefined ? null : String(r.model),
            inputTokens: Number(r.n_input),
            outputTokens: Number(r.n_output),
            cacheReadTokens: Number(r.n_cache_read),
            cacheWriteTokens: Number(r.n_cache_write),
            requests: nullRequests,
          })
        : { cost: 0, unpriced: 0 };
      return {
        day: String(r.day),
        provider: String(r.provider),
        identity: String(r.identity),
        model: r.model === null || r.model === undefined ? null : String(r.model),
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        cacheReadTokens: Number(r.cache_read_tokens),
        cacheWriteTokens: Number(r.cache_write_tokens),
        estCostUsd: Number(r.est_cost_usd) + priced.cost,
        unpricedRequests: priced.unpriced,
        requests: Number(r.requests),
      };
    });
  }

  private async usageByModelDailyRaw(since: Date, until: Date | undefined, tz: string): Promise<ModelDailyUsageRow[]> {
    const to = until ? until.toISOString() : null;
    // One pass over the ts range: rows with a cost sum it, rows without one are priced from their tokens below.
    const rows = await this.sql`
      SELECT to_char(ts AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, provider, identity, model,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(est_cost_usd), 0) AS est_cost_usd,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens) FILTER (WHERE est_cost_usd IS NULL), 0) AS n_input,
        COALESCE(SUM(output_tokens) FILTER (WHERE est_cost_usd IS NULL), 0) AS n_output,
        COALESCE(SUM(cache_read_tokens) FILTER (WHERE est_cost_usd IS NULL), 0) AS n_cache_read,
        COALESCE(SUM(cache_write_tokens) FILTER (WHERE est_cost_usd IS NULL), 0) AS n_cache_write,
        COUNT(*) FILTER (WHERE est_cost_usd IS NULL) AS n_requests
      FROM gateway_usage WHERE ts >= ${since.toISOString()}::timestamptz AND (${to}::timestamptz IS NULL OR ts < ${to}::timestamptz)
      GROUP BY 1, provider, identity, model ORDER BY 1, provider, identity, model`;
    return this.dailyRows(rows);
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
