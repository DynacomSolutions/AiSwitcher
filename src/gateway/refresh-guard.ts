import { SwapLockError } from "../identities/claude-swap-lock.ts";
import { grantFingerprint, type OAuthGrant } from "../identities/oauth-reconcile.ts";
import { OAuthRefreshError, readEffectiveGrant, type IdentityGrantRefresh, type RefreshableTool } from "../identities/oauth-refresh.ts";
import type { Identity } from "../identities/types.ts";
import type { RefreshFn } from "./credentials.ts";

/**
 * Refresh-race guard for the cluster gateway (modelled on CLIProxyAPI's refresh journal).
 *
 * Providers rotate the refresh token on every refresh, so two refreshes of one account racing each other, or a
 * refresh replayed with an already rotated-out token, kill the login. The guard makes a refresh:
 *  1. exclusive per account across every gateway replica and process (a lock held by the backend, PostgreSQL in production);
 *  2. adopt-first: the latest stored grant is re-read under the lock and used as it is when another holder already refreshed it;
 *  3. journalled: a claim is written immediately before the token request (never for a pass that sends nothing) and
 *     resolved after it, as fingerprints only;
 *  4. fail-closed on a known-spent token: one the journal shows as rotated out is never sent again. An unresolved claim
 *     (a crash) is treated like a failed transport attempt: one journalled retry, then refused.
 * When the database (or the guard) is unavailable, refreshing carries on under AIS's own file lock and the
 * expectedAccessToken compare-and-swap, with an alert: the guard never stops all refreshes.
 */

export type JournalOutcome = "refreshed" | "failed" | "lost" | "interrupted" | "recovered";

export interface JournalEntry {
  id: number;
  ts: string;
  provider: string;
  identity: string;
  holder: string;
  /** Fingerprint of the refresh token the claim was made for. */
  oldFp: string;
  /** Fingerprint of the refresh token the claim produced or found. */
  newFp?: string;
  /** Undefined while the claim is unresolved. */
  outcome?: JournalOutcome;
}

export interface RefreshAccount {
  provider: string;
  identity: string;
}

/** Journal operations for one account, valid while its lock is held (they run on the lock's own connection). */
export interface RefreshJournalOps {
  /** Every entry for this refresh-token fingerprint (indexed lookup). */
  findByOldFp(fp: string): Promise<JournalEntry[]>;
  /** Marks unresolved claims for any other fingerprint as recovered (the stores moved on). */
  closeStale(currentFp: string): Promise<number>;
  claim(oldFp: string, holder: string): Promise<number>;
  resolve(id: number, outcome: JournalOutcome, newFp?: string): Promise<void>;
  /** Same write on a fresh connection, for retries after the lock's own connection failed. Defaults to `resolve`. */
  resolveFresh?(id: number, outcome: JournalOutcome, newFp?: string): Promise<void>;
}

export interface RefreshLockHandle extends RefreshJournalOps {
  /** Milliseconds spent waiting for the lock. */
  waitedMs: number;
  /** True when the lock was held elsewhere on the first try. */
  contended: boolean;
  release(): Promise<void>;
}

/** Cross-process lock and durable journal behind the guard. */
export interface RefreshGuardBackend {
  /** Resolves once this caller is the only holder for the account; rejects with a timed-out SwapLockError. */
  acquire(account: RefreshAccount, timeoutMs: number): Promise<RefreshLockHandle>;
  /**
   * Deletes resolved journal rows older than `retentionMs`, always keeping the newest rows per account. Rows that are
   * rotated-out evidence (`refreshed`, `lost`, `interrupted`) are kept EVIDENCE_RETENTION_FACTOR times as long.
   */
  prune?(retentionMs: number): Promise<number>;
  close?(): Promise<void>;
}

/** Per-account counters, exposed with the gateway's metrics. */
export interface RefreshGuardMetrics {
  refreshGuard(event: "attempt" | "success" | "failure" | "lock_wait" | "degraded", provider: string, identity: string, seconds?: number): void;
}

/** A guard failure that a later attempt can succeed at: never a reason to tell the owner a login is dead. */
export class RefreshGuardRetryable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefreshGuardRetryable";
  }
}

/** The journal proves this refresh token must not be sent. */
class RefreshRefused extends OAuthRefreshError {}

export const JOURNAL_RETENTION_MS = 30 * 24 * 3_600_000;
/** Rotated-out evidence outlives other rows by this factor (30 days x 12 = a year). */
export const EVIDENCE_RETENTION_FACTOR = 12;
export const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
export const BACKEND_CALL_TIMEOUT_MS = 5_000;
/** Resolved rows kept per account whatever their age. */
export const JOURNAL_KEEP_PER_ACCOUNT = 50;

/** In-process backend: tests, and any run without a database. */
export class MemoryRefreshBackend implements RefreshGuardBackend {
  readonly entries: JournalEntry[] = [];
  private nextId = 1;
  private readonly tails = new Map<string, Promise<void>>();
  private readonly queued = new Map<string, number>();
  acquires = 0;

  async acquire(account: RefreshAccount, timeoutMs: number): Promise<RefreshLockHandle> {
    this.acquires += 1;
    const key = `${account.provider}\u0000${account.identity}`;
    const started = Date.now();
    const contended = (this.queued.get(key) ?? 0) > 0;
    this.queued.set(key, (this.queued.get(key) ?? 0) + 1);
    const leave = (): void => void this.queued.set(key, (this.queued.get(key) ?? 1) - 1);
    const prev = this.tails.get(key) ?? Promise.resolve();
    let open!: () => void;
    const mine = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.tails.set(key, prev.then(() => mine));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const got = await Promise.race([prev.then(() => "got" as const), timedOut]);
    clearTimeout(timer);
    if (got === "timeout") {
      void prev.then(open);
      leave();
      throw new SwapLockError(`refresh lock for ${account.provider}/${account.identity} busy for ${timeoutMs} ms`, key, true);
    }
    const mineRows = (): JournalEntry[] => this.entries.filter((e) => e.provider === account.provider && e.identity === account.identity);
    return {
      waitedMs: Date.now() - started,
      contended,
      release: async () => {
        leave();
        open();
      },
      findByOldFp: async (fp) => mineRows().filter((e) => e.oldFp === fp).sort((a, b) => b.id - a.id),
      closeStale: async (currentFp) => {
        const stale = mineRows().filter((e) => e.outcome === undefined && e.oldFp !== currentFp);
        for (const e of stale) {
          e.outcome = "recovered";
          e.newFp = currentFp;
        }
        return stale.length;
      },
      claim: async (oldFp, holder) => {
        const id = this.nextId++;
        this.entries.push({ id, ts: new Date().toISOString(), ...account, holder, oldFp });
        return id;
      },
      resolve: async (id, outcome, newFp) => {
        const e = this.entries.find((x) => x.id === id);
        if (!e) return;
        e.outcome = outcome;
        if (newFp !== undefined) e.newFp = newFp;
      },
    };
  }

  async prune(retentionMs: number): Promise<number> {
    const cutoff = Date.now() - retentionMs;
    const keep = new Set<number>();
    const perAccount = new Map<string, JournalEntry[]>();
    for (const e of this.entries) perAccount.set(`${e.provider}\u0000${e.identity}`, [...(perAccount.get(`${e.provider}\u0000${e.identity}`) ?? []), e]);
    for (const rows of perAccount.values()) for (const e of rows.sort((a, b) => b.id - a.id).slice(0, JOURNAL_KEEP_PER_ACCOUNT)) keep.add(e.id);
    const before = this.entries.length;
    const evidenceCutoff = Date.now() - retentionMs * EVIDENCE_RETENTION_FACTOR;
    const evidence = (e: JournalEntry): boolean => e.outcome === "refreshed" || e.outcome === "lost" || e.outcome === "interrupted";
    const kept = this.entries.filter((e) => keep.has(e.id) || e.outcome === undefined || Date.parse(e.ts) >= (evidence(e) ? evidenceCutoff : cutoff));
    this.entries.length = 0;
    this.entries.push(...kept);
    return before - kept.length;
  }
}

export interface GuardDeps {
  backend: RefreshGuardBackend;
  metrics: RefreshGuardMetrics;
  /** Test hook: defaults to the read-only freshest-grant read the refresh itself uses. */
  readGrant?: (tool: RefreshableTool, identity: Identity, claudeRegistryPath?: string) => Promise<OAuthGrant | undefined>;
  holder?: string;
  /** How long to wait for the account lock; must outlast one refresh (its token request times out at 15 s). */
  lockTimeoutMs?: number;
  /** Bound on every other backend call. */
  callTimeoutMs?: number;
  /** The guard could not run for this account and the refresh went ahead on the file lock alone. */
  onDegraded?(account: RefreshAccount, reason: string): void;
  /** Consecutive interrupted attempts with the current refresh token (0 once it is cleared). Alert from 2 up. */
  onInterrupted?(account: RefreshAccount, count: number): void;
  /** A refresh's result could not be written to the credential store (after retries); the local file stays ahead for the background pass. */
  onStoreWriteFailed?(account: RefreshAccount): void;
  /** The guard worked again for this account. */
  onHealthy?(account: RefreshAccount): void;
  warn?(message: string): void;
  /**
   * The PostgreSQL credential store (home-mirror.ts), when the gateway runs on it. `run` serialises the whole refresh with
   * this process's other work on the account; `pull` brings the store's copy into the local files once the lock is held
   * (so adopt-first and the journal see the store), and `push` writes what the refresh changed back before the lock goes.
   */
  sync?: GuardSync;
}

export interface GuardSync {
  run<T>(account: RefreshAccount, fn: () => Promise<T>): Promise<T>;
  pull(tool: RefreshableTool, identity: Identity): Promise<void>;
  push(tool: RefreshableTool, identity: Identity, written: string[]): Promise<void>;
}

const defaultReadGrant = async (tool: RefreshableTool, identity: Identity, claudeRegistryPath?: string): Promise<OAuthGrant | undefined> =>
  (await readEffectiveGrant(tool, identity, claudeRegistryPath ? { claudeRegistryPath } : {}))?.grant;

/**
 * Why the guard is unavailable, for an alert. A PostgresError yields only its name, code, SQLSTATE and the server's own message.
 * Any other error is masked first: URLs, `user:pw@host`, secret-looking keys (also JSON-quoted) and every quoted value. Short.
 */
const reason = (err: unknown): string => {
  if (!(err instanceof Error)) return "Error";
  const code = (err as { code?: unknown }).code;
  const codeText = typeof code === "string" ? code : undefined;
  if (err.name === "PostgresError") {
    const sqlstate = (err as { errno?: unknown }).errno;
    const message = err.message.replace(/\s+/g, " ").slice(0, 160);
    return [err.name, codeText, typeof sqlstate === "string" ? sqlstate : undefined, message ? `- ${message}` : undefined].filter(Boolean).join(" ");
  }
  const message = err.message
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/[^\s:@/'"]+:[^\s@/'"]+@\S*/g, "<credentials>@")
    .replace(/"(password|passwd|pwd|token|secret|authorization|api[_-]?key)"\s*:\s*"[^"]*"/gi, '"$1":"<hidden>"')
    .replace(/(password|passwd|pwd|token|secret)\s*[=:]\s*\S+/gi, "$1=<hidden>")
    .replace(/"[^"]*"|'[^']*'/g, "<value>")
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return [err.name, codeText, message ? `- ${message}` : undefined].filter(Boolean).join(" ");
};

/** Rejects when `p` takes longer than `ms`; the call itself may still finish later. */
export function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function adopted(tool: RefreshableTool, identity: Identity, fp: string): IdentityGrantRefresh {
  return { tool, identity: identity.name, outcome: "skipped-fresh", detail: "adopted the grant another holder already refreshed - no token request made", written: [], writeFailures: [], beforeFingerprint: fp, afterFingerprint: fp };
}

/** Wraps a refresh function with the cross-replica lock, adopt-first re-read, journal and rotated-out refusal. */
export function guardRefresh(refresh: RefreshFn, deps: GuardDeps): RefreshFn {
  const holder = deps.holder ?? `${process.env.HOSTNAME ?? "gateway"}:${process.pid}`;
  const lockTimeoutMs = deps.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const callMs = deps.callTimeoutMs ?? BACKEND_CALL_TIMEOUT_MS;
  const read = deps.readGrant ?? defaultReadGrant;
  const warn = deps.warn ?? ((m: string) => console.warn(`gateway: ${m}`));
  /** Refresh tokens this process saw rotated out (bounded), for the stretches when the journal cannot be read. */
  const rotatedOut = new Set<string>();
  const markRotatedOut = (key: string): void => {
    rotatedOut.add(key);
    if (rotatedOut.size > 2000) rotatedOut.delete(rotatedOut.values().next().value as string);
  };
  const ROTATED_OUT_MESSAGE = "refresh refused: this refresh token was already rotated out (journal) and is not sent again; the newer grant is missing from the stores";

  /** Pushes what a refresh wrote; retried, then left to the store's background pass (the local file stays ahead). */
  const pushBack = async (tool: RefreshableTool, identity: Identity, written: string[]): Promise<void> => {
    if (!deps.sync) return;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await bounded(deps.sync.push(tool, identity, written), callMs * 2, "credential store write");
        return;
      } catch (err) {
        if (attempt >= 2) {
          warn(`credential store write for ${tool}/${identity.name} failed (${reason(err)}); retried in the background`);
          deps.onStoreWriteFailed?.({ provider: tool, identity: identity.name });
          return;
        }
        await sleep(200 * (attempt + 1));
      }
    }
  };

  const guarded = (async (tool, identity, opts) => {
    const account: RefreshAccount = { provider: tool, identity: identity.name };
    const count = (event: Parameters<RefreshGuardMetrics["refreshGuard"]>[0], seconds?: number): void => deps.metrics.refreshGuard(event, tool, identity.name, seconds);
    const settle = (res: IdentityGrantRefresh): IdentityGrantRefresh => {
      count(res.outcome === "refreshed" || res.outcome === "skipped-fresh" ? "success" : "failure");
      return res;
    };
    count("attempt");

    // What the caller saw before it queued: a grant that differs once the lock is ours was refreshed by another holder.
    const before = await read(tool, identity, opts?.claudeRegistryPath).catch(() => undefined);

    let lock: RefreshLockHandle;
    const acquiring = deps.backend.acquire(account, lockTimeoutMs);
    try {
      lock = await bounded(acquiring, lockTimeoutMs + callMs, "refresh lock");
    } catch (err) {
      // A handle that arrives after the outer bound is nobody's: release it, or the account stays locked for good.
      acquiring.then((late) => late.release().catch(() => undefined), () => undefined);
      if (err instanceof SwapLockError) {
        count("failure");
        throw err;
      }
      if (deps.sync) {
        // Each replica's file lock is local: refreshing here could send the same single-use refresh token as another replica.
        count("failure");
        deps.onDegraded?.(account, reason(err));
        throw new RefreshGuardRetryable(`refresh lock unavailable (${reason(err)}); not refreshing without it on the shared credential store`);
      }
      // The guard cannot run. Refreshing still goes ahead under AIS's file lock and the expectedAccessToken compare-and-swap.
      count("degraded");
      deps.onDegraded?.(account, reason(err));
      // No journal here, but a token this process itself saw rotated out is still never sent again.
      const guardLocal = async ({ fingerprint }: { fingerprint: string }): Promise<void> => {
        if (rotatedOut.has(`${tool}\u0000${identity.name}\u0000${fingerprint}`)) throw new RefreshRefused(ROTATED_OUT_MESSAGE, false);
      };
      const res = await refresh(tool, identity, { ...opts, beforePost: guardLocal });
      await pushBack(tool, identity, res.written ?? []);
      return settle(res);
    }
    deps.onHealthy?.(account);
    if (lock.contended) count("lock_wait", lock.waitedMs / 1000);

    let claim: number | undefined;
    let degraded = false;
    const degrade = (err: unknown): void => {
      degraded = true;
      count("degraded");
      deps.onDegraded?.(account, reason(err));
    };
    /** Resolve writes: the first on the lock's connection, the retries on a fresh pool connection (the lock's may be the broken one). */
    const resolveClaim = async (id: number, outcome: JournalOutcome, newFp?: string): Promise<void> => {
      let attempt = 0;
      await journal(() => {
        const fresh = attempt++ > 0 && lock.resolveFresh;
        return fresh ? lock.resolveFresh!(id, outcome, newFp) : lock.resolve(id, outcome, newFp);
      });
    };
    const journal = async (fn: () => Promise<void>): Promise<void> => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await bounded(fn(), callMs, "refresh journal write");
          return;
        } catch (err) {
          if (attempt >= 2) throw err;
          await sleep(100 * (attempt + 1));
        }
      }
    };

    try {
      let latest: OAuthGrant | undefined;
      try {
        if (deps.sync) await bounded(deps.sync.pull(tool, identity), callMs * 2, "credential store read");
        latest = await read(tool, identity, opts?.claudeRegistryPath);
      } catch (err) {
        // A transient read error must neither send the token request unseen nor report a dead login.
        count("failure");
        throw new RefreshGuardRetryable(`stored grant unreadable (${reason(err)}); retry`);
      }
      if (latest?.refresh_token) {
        const cur = grantFingerprint(latest);
        // Adopt-first: another holder already refreshed this account while we waited.
        const moved =
          (before?.refresh_token !== undefined && grantFingerprint(before) !== cur) ||
          (before?.expires_at !== undefined && latest.expires_at !== undefined && latest.expires_at > before.expires_at) ||
          (opts?.expectedAccessToken !== undefined && opts.expectedAccessToken !== latest.access_token);
        if (moved) return settle(adopted(tool, identity, cur));
      }

      // The claim is written by the refresher itself, under its file locks, immediately before the token request.
      const refuseIfRotatedOut = (fingerprint: string): void => {
        if (rotatedOut.has(`${tool}\u0000${identity.name}\u0000${fingerprint}`)) throw new RefreshRefused(ROTATED_OUT_MESSAGE, false);
      };
      const beforePost = async ({ fingerprint }: { fingerprint: string }): Promise<void> => {
        let rows: JournalEntry[];
        try {
          await bounded(lock.closeStale(fingerprint), callMs, "refresh journal");
          rows = await bounded(lock.findByOldFp(fingerprint), callMs, "refresh journal");
        } catch (err) {
          degrade(err);
          refuseIfRotatedOut(fingerprint);
          return;
        }
        for (const e of rows) if (e.outcome === "refreshed" && e.newFp !== undefined && e.newFp !== e.oldFp) markRotatedOut(`${tool}\u0000${identity.name}\u0000${e.oldFp}`);
        if (rotatedOut.has(`${tool}\u0000${identity.name}\u0000${fingerprint}`)) throw new RefreshRefused(ROTATED_OUT_MESSAGE, false);
        let interrupted = rows.filter((e) => e.outcome === "interrupted").length;
        try {
          // An unresolved claim for this very token is a request whose outcome is unknown, like a failed transport attempt:
          // it is retried (the provider's own dead-grant answer decides), and the owner is alerted from the second one.
          for (const e of rows.filter((x) => x.outcome === undefined)) {
            await resolveClaim(e.id, "interrupted");
            interrupted += 1;
          }
        } catch (err) {
          degrade(err);
          refuseIfRotatedOut(fingerprint);
          return;
        }
        deps.onInterrupted?.(account, interrupted);
        try {
          claim = await bounded(lock.claim(fingerprint, holder), callMs, "refresh journal");
        } catch (err) {
          degrade(err);
        }
      };

      let res: IdentityGrantRefresh;
      try {
        res = await refresh(tool, identity, { ...opts, beforePost });
      } catch (err) {
        if (claim !== undefined) await resolveClaim(claim, "failed").catch((e) => warn(`refresh journal write failed (${reason(e)})`));
        await pushBack(tool, identity, []);
        count("failure");
        throw err;
      }
      // Under the lock, before the journal resolves: another replica must never pull the spent grant once the lock is free.
      await pushBack(tool, identity, res.written ?? []);
      if (res.outcome === "refreshed" && res.beforeFingerprint && res.afterFingerprint && res.beforeFingerprint !== res.afterFingerprint) {
        markRotatedOut(`${tool}\u0000${identity.name}\u0000${res.beforeFingerprint}`);
        deps.onInterrupted?.(account, 0);
      }
      if (claim !== undefined) {
        const lost = res.outcome === "failed" && res.afterFingerprint !== undefined;
        const outcome: JournalOutcome = res.outcome === "refreshed" ? "refreshed" : lost ? "lost" : res.outcome === "failed" ? "failed" : "recovered";
        const id = claim;
        await resolveClaim(id, outcome, outcome === "refreshed" || lost ? res.afterFingerprint : undefined).catch((e) => warn(`refresh journal write failed (${reason(e)})`));
      }
      if (!degraded) deps.onHealthy?.(account);
      return settle(res);
    } finally {
      await bounded(lock.release(), callMs, "refresh lock release").catch((e) => warn(`refresh lock release failed (${reason(e)})`));
    }
  }) as RefreshFn;
  if (!deps.sync) return guarded;
  const sync = deps.sync;
  return ((tool, identity, opts) => sync.run({ provider: tool, identity: identity.name }, () => guarded(tool, identity, opts))) as RefreshFn;
}
