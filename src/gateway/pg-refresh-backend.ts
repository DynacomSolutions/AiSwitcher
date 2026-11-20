import { SQL } from "bun";
import { SwapLockError } from "../identities/claude-swap-lock.ts";
import { pgPoolOptions } from "./pg-pool.ts";
import { bounded, BACKEND_CALL_TIMEOUT_MS, EVIDENCE_RETENTION_FACTOR, JOURNAL_KEEP_PER_ACCOUNT, type JournalEntry, type JournalOutcome, type RefreshAccount, type RefreshGuardBackend, type RefreshLockHandle, type RefreshSummaryRow } from "./refresh-guard.ts";

const POLL_MS = 100;
/** Pause before the next attempt on a fresh connection after a slow or failed lock call. */
const RETRY_PAUSE_MS = 250;
/**
 * Connections in the backend's own pool. The size stays at 10 so that up to 8 refresh locks can be held at once.
 * The idle timeout closes connections that no lock holder uses, so idle replicas do not pin server connections.
 */
const POOL_MAX = 10;
const POOL = { ...pgPoolOptions(), max: POOL_MAX };
/** Concurrent lock holders: each pins one reserved connection, so two stay free for retention and for any queries that need the pool. */
const MAX_HOLDERS = POOL_MAX - 2;

const lockName = (a: RefreshAccount): string => `ais-gateway-refresh:${a.provider}/${a.identity}`;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(v as string).toISOString());

// biome-ignore lint/suspicious/noExplicitAny: driver rows are untyped
const toEntry = (r: any): JournalEntry => ({
  id: Number(r.id),
  ts: iso(r.ts),
  provider: r.provider,
  identity: r.identity,
  holder: r.holder,
  oldFp: r.old_fp,
  ...(r.new_fp !== null ? { newFp: r.new_fp } : {}),
  ...(r.outcome !== null ? { outcome: r.outcome as JournalOutcome } : {}),
  ...(r.code !== null && r.code !== undefined ? { code: r.code as string } : {}),
});

/**
 * Refresh lock and journal in the gateway's PostgreSQL. The lock is a session-level advisory lock on a reserved
 * connection: it is exclusive across every replica and process, and the database drops it if the holder dies.
 * The journal queries run on that same reserved connection, so a holder never needs a second pool connection (no
 * pool deadlock), and at most MAX_HOLDERS locks are held at once. Every call is bounded in time on the client; no startup
 * parameter is sent (a connection pooler such as PgBouncer rejects unknown ones, which left every refresh unguarded), and the
 * server-side statement_timeout is only set best-effort with SET on the reserved connection.
 */
export class PgRefreshBackend implements RefreshGuardBackend {
  private readonly sql: SQL;
  private holders = 0;
  private readonly waiters: Array<() => void> = [];

  /** `sql` replaces the driver pool (tests only). */
  constructor(url: string, private readonly callMs = BACKEND_CALL_TIMEOUT_MS, sql?: SQL) {
    this.sql = sql ?? new SQL(url, POOL);
  }

  async close(): Promise<void> {
    await this.sql.close();
  }

  private async takeSlot(deadline: number, account: RefreshAccount): Promise<void> {
    if (this.holders < MAX_HOLDERS) {
      this.holders += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new SwapLockError(`refresh lock for ${account.provider}/${account.identity}: no free guard connection`, lockName(account), true));
      }, Math.max(0, deadline - Date.now()));
      const grant = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(grant);
    });
    // The releasing holder handed its slot over: holders is unchanged.
  }

  private freeSlot(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.holders -= 1;
  }

  async acquire(account: RefreshAccount, timeoutMs: number): Promise<RefreshLockHandle> {
    const name = lockName(account);
    const started = Date.now();
    const deadline = started + timeoutMs;
    await this.takeSlot(deadline, account);
    let conn: Awaited<ReturnType<SQL["reserve"]>> | undefined;
    let contended = this.holders >= MAX_HOLDERS && Date.now() - started > 0;
    const timedOut = (): SwapLockError => new SwapLockError(`refresh lock for ${account.provider}/${account.identity} busy for ${timeoutMs} ms`, name, true);
    /** Ends a connection that may still hold the lock (or hang): it is never returned to the pool. */
    const endConn = async (dead: typeof conn): Promise<void> => {
      if (dead) await Promise.race([dead.close().catch(() => undefined), new Promise((r) => setTimeout(r, this.callMs))]);
    };
    try {
      if (Date.now() >= deadline) throw timedOut();
      // A slow or failed call (a database restart, a failover) is retried on a fresh connection while the lock deadline lasts,
      // never on the same one: a lock query that arrives late could still take the lock on the old session.
      for (let attempt = 0; ; attempt += 1) {
        try {
          const reserving = this.sql.reserve();
          try {
            conn = await bounded(reserving, Math.min(this.callMs, Math.max(1, deadline - Date.now())), "guard connection");
          } catch (err) {
            // A connection that arrives after we gave up goes back to the pool instead of leaking.
            reserving.then((late) => late.release(), () => undefined);
            throw err;
          }
          const c = conn;
          // Server-side bound too, where the server allows a SET (never a startup parameter); the client timeout is what is relied on.
          await bounded(c.unsafe(`SET statement_timeout = ${Math.trunc(this.callMs)}`), this.callMs, "guard setup").catch(() => undefined);
          for (;;) {
            if (Date.now() >= deadline) throw timedOut();
            const rows = await bounded(c`SELECT pg_try_advisory_lock(hashtextextended(${name}, 0)) AS got`, this.callMs, "guard lock");
            if (rows[0]?.got === true) break;
            contended = true;
            if (Date.now() >= deadline) throw timedOut();
            await new Promise((r) => setTimeout(r, POLL_MS));
          }
          break;
        } catch (err) {
          await endConn(conn);
          conn = undefined;
          if (err instanceof SwapLockError || Date.now() + RETRY_PAUSE_MS >= deadline) throw err;
          await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS * Math.min(attempt + 1, 4)));
        }
      }
    } catch (err) {
      this.freeSlot();
      throw err;
    }
    const c = conn;
    let released = false;
    return {
      waitedMs: Date.now() - started,
      contended,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await bounded(c`SELECT pg_advisory_unlock(hashtextextended(${name}, 0))`, this.callMs, "guard unlock");
          // A connection whose RESET failed or timed out may still carry the bound: end it rather than return it to the pool.
          const reset = await bounded(c.unsafe("RESET statement_timeout"), this.callMs, "guard reset").then(() => true, () => false);
          if (reset) c.release();
          else await Promise.race([c.close().catch(() => undefined), new Promise((r) => setTimeout(r, this.callMs))]);
        } catch (err) {
          // An unlock that failed would leave the lock on a pooled connection: end the session, which frees it.
          await Promise.race([c.close().catch(() => undefined), new Promise((r) => setTimeout(r, this.callMs))]);
          throw err;
        } finally {
          this.freeSlot();
        }
      },
      findByOldFp: async (fp) => {
        const rows = await c`
          SELECT id, ts, provider, identity, holder, old_fp, new_fp, outcome, code
          FROM gateway_refresh_journal
          WHERE provider = ${account.provider} AND identity = ${account.identity} AND old_fp = ${fp}
          ORDER BY id DESC`;
        return rows.map(toEntry);
      },
      closeStale: async (currentFp) => {
        const rows = await c`
          UPDATE gateway_refresh_journal
          SET outcome = 'recovered', new_fp = ${currentFp}, resolved_at = now()
          WHERE provider = ${account.provider} AND identity = ${account.identity} AND outcome IS NULL AND old_fp <> ${currentFp}
          RETURNING id`;
        return rows.length;
      },
      claim: async (oldFp, holder) => {
        const rows = await c`
          INSERT INTO gateway_refresh_journal (provider, identity, holder, old_fp)
          VALUES (${account.provider}, ${account.identity}, ${holder}, ${oldFp})
          RETURNING id`;
        return Number(rows[0].id);
      },
      resolve: async (id, outcome, newFp, code) => {
        await c`
          UPDATE gateway_refresh_journal
          SET outcome = ${outcome}, new_fp = COALESCE(${newFp ?? null}, new_fp), code = COALESCE(${code ?? null}, code), resolved_at = now()
          WHERE id = ${id}`;
      },
      // The lock's own connection may be the broken one: retries go through the pool (two connections are kept free for this).
      resolveFresh: async (id, outcome, newFp, code) => {
        await this.sql`
          UPDATE gateway_refresh_journal
          SET outcome = ${outcome}, new_fp = COALESCE(${newFp ?? null}, new_fp), code = COALESCE(${code ?? null}, code), resolved_at = now()
          WHERE id = ${id}`;
      },
    };
  }

  /** Newest `refreshed` row and newest `failed` or `dead` row per account (index scan per account, no lock). */
  async summary(): Promise<RefreshSummaryRow[]> {
    const refreshed = await bounded(
      this.sql`
        SELECT DISTINCT ON (provider, identity) provider, identity, id, ts, holder
        FROM gateway_refresh_journal WHERE outcome = 'refreshed'
        ORDER BY provider, identity, id DESC`,
      10_000,
      "journal summary",
    );
    const errors = await bounded(
      this.sql`
        SELECT DISTINCT ON (provider, identity) provider, identity, id, ts, holder, outcome, code, old_fp
        FROM gateway_refresh_journal WHERE outcome IN ('failed', 'dead')
        ORDER BY provider, identity, id DESC`,
      10_000,
      "journal summary",
    );
    const rows = new Map<string, RefreshSummaryRow>();
    const row = (provider: string, identity: string): RefreshSummaryRow => {
      const key = `${provider}\u0000${identity}`;
      const found = rows.get(key) ?? { provider, identity };
      rows.set(key, found);
      return found;
    };
    // biome-ignore lint/suspicious/noExplicitAny: driver rows are untyped
    for (const r of refreshed as any[]) row(r.provider, r.identity).refreshed = { id: Number(r.id), ts: iso(r.ts), holder: r.holder };
    // biome-ignore lint/suspicious/noExplicitAny: driver rows are untyped
    for (const r of errors as any[]) row(r.provider, r.identity).error = { id: Number(r.id), ts: iso(r.ts), holder: r.holder, outcome: r.outcome as "failed" | "dead", oldFp: r.old_fp, ...(r.code !== null && r.code !== undefined ? { code: r.code as string } : {}) };
    return [...rows.values()];
  }

  /**
   * Deletes resolved rows past the retention, beyond the newest JOURNAL_KEEP_PER_ACCOUNT per account. Open claims stay;
   * rotated-out evidence (refreshed, lost, interrupted) stays EVIDENCE_RETENTION_FACTOR times as long.
   */
  async prune(retentionMs: number): Promise<number> {
    const rows = await bounded(
      this.sql`
        DELETE FROM gateway_refresh_journal WHERE id IN (
          SELECT id FROM (
            SELECT id, ts, outcome, row_number() OVER (PARTITION BY provider, identity ORDER BY id DESC) AS rn
            FROM gateway_refresh_journal
          ) t
          WHERE t.rn > ${JOURNAL_KEEP_PER_ACCOUNT}
            AND t.outcome IS NOT NULL
            AND t.ts < now() - make_interval(secs => ${retentionMs / 1000} * CASE WHEN t.outcome IN ('refreshed', 'lost', 'interrupted', 'dead') THEN ${EVIDENCE_RETENTION_FACTOR} ELSE 1 END)
        ) RETURNING id`,
      30_000,
      "journal retention",
    );
    return rows.length;
  }
}
