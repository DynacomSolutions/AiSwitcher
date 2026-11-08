import { startModelPriceRefresh } from "../identities/model-price-source.ts";
import { TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { DEAD_REFRESH_CODES, OAuthRefreshError, refreshIdentityOAuthGrant } from "../identities/oauth-refresh.ts";
import { SwapLockError } from "../identities/claude-swap-lock.ts";
import { PgRefreshBackend } from "./pg-refresh-backend.ts";
import { guardRefresh, JOURNAL_RETENTION_MS, RefreshGuardRetryable, type RefreshGuardBackend } from "./refresh-guard.ts";
import { isRetired } from "../identities/retired.ts";
import { allowedAccounts, findPool, isSwapPool } from "../identities/pool/swap-pool.ts";
import { loadIdentitiesFile } from "../identities/store.ts";
import { findIdentityByNameOrAlias } from "../identities/store.ts";
import { createAdminApp, type IdentityState } from "./admin.ts";
import { createAlerter, stderrNotifier, watchLedger, type Alerter, type Notifier } from "./alerts.ts";
import { createGatewayApp, markGatewayResponse, styleForPath, type GatewayDeps } from "./app.ts";
import { authBrowserToken } from "./browser/auth.ts";
import { BrowserHub } from "./browser/hub.ts";
import { CachedGatewayStore } from "./cache-store.ts";
import { CredentialCache, type RefreshFn } from "./credentials.ts";
import { providerError } from "./errors.ts";
import { LedgerBuffer } from "./ledger-buffer.ts";
import { PrometheusMetrics, type GatewayMetrics } from "./metrics.ts";
import { migrate, PgGatewayStore } from "./pg-store.ts";
import type { GatewayStore } from "./store.ts";
import { createUsageSource, fetchPoolUsage, type FetchUsage } from "./usage-source.ts";
import type { GatewayProvider } from "./types.ts";
import type { IdentitiesFile, Identity } from "../identities/types.ts";
import { listGatewayManagedAccounts, markGatewayOwnerProcess } from "../identities/gateway-managed.ts";

export const DEFAULT_GATEWAY_PORT = 47130;
export const DEFAULT_GATEWAY_ADMIN_PORT = 47131;
export const MIN_ADMIN_TOKEN_LENGTH = 32;

export interface GatewayOptions {
  port: number;
  adminPort: number;
  databaseUrl: string;
  adminToken: string;
  /** Install SIGTERM and SIGINT handlers that drain and exit. The CLI sets this. */
  handleSignals?: boolean;
}

/** Everything a test (or another host) may replace. Production uses the defaults. */
export interface GatewayHooks {
  /** Interface to listen on. Default all interfaces (the container needs that). */
  host?: string;
  migrate?(url: string): Promise<void>;
  openStore?(url: string): GatewayStore & { close?(): Promise<void> };
  creds?: GatewayDeps["creds"];
  /** Test hook: the refresh the guard wraps (default AIS's locked refresh). */
  refreshImpl?: RefreshFn;
  /** Lock and journal that guard login refreshes across replicas. Default: the gateway's PostgreSQL. */
  refreshBackend?: RefreshGuardBackend & { close?(): Promise<void> };
  fetch?: typeof fetch;
  now?(): Date;
  usageFor?: GatewayDeps["usageFor"];
  /** Replaces the AIS adapter fetch behind the default (cached) usage source. */
  fetchUsage?: FetchUsage;
  canonical?: GatewayDeps["canonical"];
  identityState?(provider: GatewayProvider, identity: string): Promise<IdentityState>;
  poolMembers?: GatewayDeps["poolMembers"];
  browserPoolMembers?: NonNullable<GatewayDeps["browserPoolMembers"]>;
  browserIdentityExists?: NonNullable<GatewayDeps["browserIdentityExists"]>;
  notify?: Notifier;
  warmBackoff?: { initialMs: number; maxMs: number };
  ledger?: { max: number; flushMs: number };
  /** How often the app and token cache is re-read for changes made by other instances. */
  refreshIntervalMs?: number;
  alertCheckMs?: number;
  /** How often every managed login is refreshed ahead of expiry with no traffic (default 10 minutes). */
  keepAliveMs?: number;
  keepAliveAccounts?(): Promise<Identity[]>;
  overlapMs?: number;
  exit?(code: number): void;
}

export interface RunningGateway {
  stop(): Promise<void>;
  readonly port: number;
  readonly adminPort: number;
  ready(): boolean;
}

/** Wraps a login refresh so every attempt is counted and a failure raises one owner alert until it recovers. `failed` remembers the stale token a failed refresh was for. */
export function instrumentRefresh(
  refresh: RefreshFn,
  deps: { metrics: Pick<PrometheusMetrics, "refresh">; alerter: Alerter; failed?: Map<string, string> },
): RefreshFn {
  return (async (tool, identity, opts) => {
    const key = `${tool}/${identity.name}`;
    const fail = (): void => {
      if (opts?.expectedAccessToken !== undefined) deps.failed?.set(key, opts.expectedAccessToken);
      deps.alerter.raise("refresh-failed", key, `refresh of the ${tool} login "${identity.name}" failed; it needs attention (ais auth login or ais auth refresh)`);
    };
    /** A store could not be read: the login itself may be fine, but a person must look. Names the store class only. */
    const readError = (stores: string[] | undefined): void => {
      const which = stores && stores.length > 0 ? ` (${stores.join(", ")} store)` : "";
      deps.alerter.raise("store-unreadable", key, `a credential store of the ${tool} login "${identity.name}" could not be read${which}; check the file's permissions and contents (the existing token stays in use)`);
    };
    const ok = (): void => {
      deps.failed?.delete(key);
      deps.alerter.recover("refresh-failed", key);
    };
    try {
      const result = await refresh(tool, identity, opts);
      deps.metrics.refresh(tool, result.outcome);
      if (result.outcome === "failed" || result.outcome === "no-grant" || result.outcome === "skipped-revoked") fail();
      else if (result.outcome === "skipped-read-error") readError(result.unreadableStores);
      else if (result.outcome === "refreshed") {
        ok();
        if (result.unreadableStores && result.unreadableStores.length > 0) readError(result.unreadableStores);
        else deps.alerter.recover("store-unreadable", key);
      } else if (result.outcome === "skipped-fresh" && !result.unreadableStores) deps.alerter.recover("store-unreadable", key);
      return result;
    } catch (err) {
      // A busy lock or a transient guard/read error is retried by the next caller or tick: it never means the login needs a person.
      if ((err instanceof SwapLockError && err.timedOut) || err instanceof RefreshGuardRetryable) {
        deps.metrics.refresh(tool, err instanceof RefreshGuardRetryable ? "retryable" : "lock-timeout");
        throw err;
      }
      deps.metrics.refresh(tool, "failed");
      fail();
      throw err;
    }
  }) as RefreshFn;
}

/** A successful upstream answer for an identity proves its login works: clear any open refresh alert for it. */
export function recoverOnSuccess<M extends GatewayMetrics>(inner: M, alerter: Alerter): M {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== "request" || typeof v !== "function") return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      return (e: Parameters<GatewayMetrics["request"]>[0]) => {
        (v as (e: unknown) => void).call(target, e);
        if (e.httpStatus >= 200 && e.httpStatus < 300) alerter.recover("refresh-failed", `${e.provider}/${e.identity}`);
      };
    },
  });
}

/** A credential read that returns a token other than the one a refresh failed for means the login was repaired: clear its alert. */
export function watchCredentialReads(creds: GatewayDeps["creds"], alerter: Alerter, failed: Map<string, string>): GatewayDeps["creds"] {
  return {
    ...creds,
    get: async (provider, identity) => {
      const cred = await creds.get(provider, identity);
      const key = `${provider}/${cred.identity}`;
      const stale = failed.get(key);
      if (stale !== undefined && cred.accessToken !== stale) {
        failed.delete(key);
        alerter.recover("refresh-failed", key);
      }
      return cred;
    },
    refreshAfter401: (...a) => creds.refreshAfter401(...a),
    signature: (...a) => creds.signature?.(...a) ?? Promise.resolve(undefined),
  } as GatewayDeps["creds"];
}

async function defaultPoolMembers(provider: GatewayProvider): Promise<string[]> {
  const file = await loadIdentitiesFile(TOOL_CONFIGS[provider].identitiesJsonPath);
  return file.identities.filter((i) => !isRetired(i)).map((i) => i.name);
}

/** Allowed, non-retired members of pool `pool` in `file`, or undefined when the file has no such pool. */
export function browserPoolMemberNames(file: IdentitiesFile, pool: string): string[] | undefined {
  const found = findPool(file, pool);
  if (!found) return undefined;
  return allowedAccounts(found).filter((name) => {
    const m = findIdentityByNameOrAlias(file.identities, name);
    return !(m && isRetired(m));
  });
}

/** Members of the named swap pool in any tool registry, or undefined when no tool has such a pool. */
async function defaultBrowserPoolMembers(pool: string): Promise<string[] | undefined> {
  for (const cfg of Object.values(TOOL_CONFIGS)) {
    const names = browserPoolMemberNames(await loadIdentitiesFile(cfg.identitiesJsonPath), pool);
    if (names) return names;
  }
  return undefined;
}

async function defaultBrowserIdentityExists(name: string): Promise<string | undefined> {
  for (const cfg of Object.values(TOOL_CONFIGS)) {
    const found = findIdentityByNameOrAlias((await loadIdentitiesFile(cfg.identitiesJsonPath)).identities, name);
    if (found && !isRetired(found) && !isSwapPool(found)) return found.name;
  }
  return undefined;
}

async function defaultIdentityState(provider: GatewayProvider, name: string): Promise<IdentityState> {
  const file = await loadIdentitiesFile(TOOL_CONFIGS[provider].identitiesJsonPath);
  const found = findIdentityByNameOrAlias(file.identities, name);
  return !found ? "missing" : isRetired(found) ? "retired" : isSwapPool(found) ? "pool" : "ok";
}

/** Alias to canonical identity name, with a short cache (also for failed reads) so the registry file is not re-read per request. */
export function createCanonicalResolver(
  load: (provider: GatewayProvider) => Promise<Array<{ name: string; aliases?: string[] }>>,
  nowMs: () => number = Date.now,
): NonNullable<GatewayDeps["canonical"]> {
  const TTL = 60_000;
  const cache = new Map<string, { name: string; at: number }>();
  const failedAt = new Map<GatewayProvider, number>();
  return async (provider, identity) => {
    const key = `${provider}\u0000${identity}`;
    const hit = cache.get(key);
    const now = nowMs();
    if (hit && now - hit.at < TTL) return hit.name;
    const failed = failedAt.get(provider);
    if (failed !== undefined && now - failed < TTL) return hit?.name ?? identity;
    try {
      const file = await load(provider);
      failedAt.delete(provider);
      const name = findIdentityByNameOrAlias(file as never, identity)?.name ?? identity;
      cache.set(key, { name, at: now });
      return name;
    } catch {
      failedAt.set(provider, now);
      return hit?.name ?? identity;
    }
  };
}

const canonicalResolver = () => createCanonicalResolver(async (provider) => (await loadIdentitiesFile(TOOL_CONFIGS[provider].identitiesJsonPath)).identities);

/** Reasons only: errors from the store or filesystem can carry connection strings or paths. */
const describe = (err: unknown): string => {
  const e = err as { name?: unknown; code?: unknown } | null;
  return [typeof e?.name === "string" ? e.name : "Error", typeof e?.code === "string" ? e.code : undefined].filter(Boolean).join(" ");
};

/**
 * Idle keep-alive: the gateway is the only refresher of managed logins, so it refreshes each one before expiry even with no
 * traffic (AIS's normal expiry window decides; a fresh login is left alone). Counted per outcome; a failure raises the usual alert.
 */
export async function keepAliveOnce(deps: { refresh: RefreshFn; accounts: () => Promise<Identity[]>; metrics: { keepAlive(provider: string, outcome: string): void }; revoked?: Map<string, string> }): Promise<void> {
  // A grant diagnosed revoked is remembered by fingerprint and not POSTed again until a re-login mints a different one.
  const revoked = deps.revoked ?? new Map<string, string>();
  for (const account of await deps.accounts().catch(() => [] as Identity[])) {
    try {
      const known = revoked.get(account.name);
      const r = await deps.refresh("claude", account, { ...(known ? { revokedFingerprint: known } : {}) });
      if (r.outcome === "skipped-revoked" && r.beforeFingerprint) revoked.set(account.name, r.beforeFingerprint);
      else revoked.delete(account.name);
      deps.metrics.keepAlive("claude", r.outcome);
    } catch (err) {
      // Only a dead-grant OAuth code proves the login is gone; any other 400/401 is not enough (as in credentials.ts).
      if (err instanceof OAuthRefreshError && err.revoked && err.refreshFingerprint && err.oauthCode !== undefined && DEAD_REFRESH_CODES.has(err.oauthCode)) revoked.set(account.name, err.refreshFingerprint);
      deps.metrics.keepAlive("claude", "failed");
    }
  }
}

export async function startGateway(opts: GatewayOptions, hooks: GatewayHooks = {}): Promise<RunningGateway> {
  if (opts.adminToken.length < MIN_ADMIN_TOKEN_LENGTH) throw new Error(`gateway: the admin token (AIS_GATEWAY_ADMIN_TOKEN) must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters`);
  startModelPriceRefresh();
  markGatewayOwnerProcess(); // this process alone refreshes gateway-managed logins
  const now = hooks.now ?? (() => new Date());
  const backoff = hooks.warmBackoff ?? { initialMs: 1_000, maxMs: 30_000 };
  const exit = hooks.exit ?? ((code: number) => process.exit(code));

  const inner = (hooks.openStore ?? ((url: string) => new PgGatewayStore(url)))(opts.databaseUrl);
  const store = new CachedGatewayStore(inner);
  const ledger = new LedgerBuffer(store, hooks.ledger ?? { max: 50_000, flushMs: 2_000 });
  const metrics = new PrometheusMetrics({ ledgerDepth: () => ledger.depth, ledgerDropped: () => ledger.dropped });
  const alerter = createAlerter(hooks.notify ?? stderrNotifier);
  const failedTokens = new Map<string, string>();
  const refreshBackend = hooks.refreshBackend ?? new PgRefreshBackend(opts.databaseUrl);
  const inflightRefreshes = new Set<Promise<unknown>>();
  const guarded = guardRefresh(hooks.refreshImpl ?? refreshIdentityOAuthGrant, {
    backend: refreshBackend,
    metrics,
    onDegraded: (account, why) => alerter.raise("refresh-guard-degraded", `${account.provider}/${account.identity}`, `the refresh guard is unavailable (${why}); refreshing under the file lock and compare-and-swap only`),
    onInterrupted: (account, count) => {
      const key = `${account.provider}/${account.identity}`;
      if (count >= 2) alerter.raise("refresh-interrupted", key, `refreshes of the ${account.provider} login "${account.identity}" keep ending with an unknown outcome (${count} times); the token is retried, check the gateway and the provider`);
      else alerter.recover("refresh-interrupted", key);
    },
    onHealthy: (account) => alerter.recover("refresh-guard-degraded", `${account.provider}/${account.identity}`),
  });
  const instrumented = instrumentRefresh(guarded, { metrics, alerter, failed: failedTokens });
  /** The one guarded refresh: the credential cache and the keep-alive both go through it, and stop() waits for it. */
  const refreshLogin = ((...a: Parameters<RefreshFn>) => {
    const p = instrumented(...a);
    inflightRefreshes.add(p);
    const done = (): void => void inflightRefreshes.delete(p);
    p.then(done, done);
    return p;
  }) as RefreshFn;
  const baseCreds = hooks.creds ?? new CredentialCache({ refresh: refreshLogin });
  const creds = watchCredentialReads(baseCreds, alerter, failedTokens);
  const canonical = hooks.canonical ?? canonicalResolver();
  const usage = createUsageSource({ fetchUsage: hooks.fetchUsage ?? fetchPoolUsage });
  const poolMembers = hooks.poolMembers ?? defaultPoolMembers;
  const browserPoolMembers = hooks.browserPoolMembers ?? defaultBrowserPoolMembers;
  const browserIdentityExists = hooks.browserIdentityExists ?? defaultBrowserIdentityExists;

  const hub = new BrowserHub({ authToken: async (t) => {
      const b = await authBrowserToken(store, t);
      if (b) await store.touchBrowserBinding(b.name, new Date().toISOString()).catch(() => {});
      return b;
    },
    metrics });
  metrics.browserGauges = { connected: () => hub.connected().length, sessions: () => hub.activeSessions() };

  const proxy = createGatewayApp({
    store,
    ledger,
    creds,
    usageFor: hooks.usageFor ?? (async (provider, identity) => usage.get(provider, await canonical(provider, identity))),
    canonical,
    poolMembers,
    browserPoolMembers,
    browserIdentityExists,
    browserHub: hub,
    fetch: hooks.fetch ?? fetch,
    now,
    metrics: recoverOnSuccess(metrics, alerter),
  });
  const admin = createAdminApp({ store, adminToken: opts.adminToken, now, identityState: hooks.identityState ?? defaultIdentityState, browserPoolMembers, browserIdentityExists, browserHub: hub, ...(hooks.overlapMs !== undefined ? { overlapMs: hooks.overlapMs } : {}) });

  let warmed = false;
  let draining = false;
  let wake: (() => void) | undefined;
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });

  /**
   * Reads each configured identity once, to log and count the ones that fail and to prefill the usage
   * cache. A bad identity only fails its own app's requests, so this never blocks readiness.
   */
  async function probeIdentities(): Promise<void> {
    const prefilled = new Set<string>();
    const prefill = async (provider: GatewayProvider, name: string): Promise<void> => {
      const c = await canonical(provider, name);
      const key = `${provider}\u0000${c}`;
      if (prefilled.has(key)) return;
      prefilled.add(key);
      await usage.prefill(provider, c).catch(() => undefined);
    };
    for (const app of await store.listApps()) {
      if (app.state !== "active") continue;
      const listed = app.target.kind === "pin" ? [app.target.identity] : (app.target.identities ?? []);
      for (const identity of listed) {
        try {
          await creds.get(app.provider, identity);
        } catch (err) {
          metrics.credentialUnreadable(app.name, app.provider, await canonical(app.provider, identity));
          console.warn(`gateway: app "${app.name}" cannot read ${app.provider} identity "${identity}" (${describe(err)}); its requests will fail`);
        }
        await prefill(app.provider, identity);
      }
      // A pool with no list may use any current member.
      if (app.target.kind === "pool" && listed.length === 0) {
        for (const member of await poolMembers(app.provider).catch(() => [] as string[])) await prefill(app.provider, member);
      }
    }
  }

  /** Retries with backoff until warm: a database that is down at start leaves the gateway unready, never crashed. */
  async function warmUp(): Promise<void> {
    let delay = backoff.initialMs;
    while (!draining) {
      let stage = "migrate";
      try {
        await (hooks.migrate ?? migrate)(opts.databaseUrl);
        stage = "app cache";
        await store.warm();
        if (draining) return;
        warmed = true;
        pruneJournal();
        store.startRefresh(hooks.refreshIntervalMs ?? 15_000);
        console.info("gateway: warm, ready for traffic");
        void probeIdentities().catch(() => undefined);
        return;
      } catch (err) {
        console.warn(`gateway: warm-up failed at ${stage} (${describe(err)}); retrying in ${delay} ms`);
        await sleep(delay);
        delay = Math.min(delay * 2, backoff.maxMs);
      }
    }
  }

  const server = Bun.serve({
    hostname: hooks.host ?? "0.0.0.0",
    port: opts.port,
    // The longest allowed idle gap; SSE streams carry their own keepalives.
    idleTimeout: 255,
    websocket: {
      // Screenshots arrive base64 inside one frame.
      maxPayloadLength: 32 * 1024 * 1024,
      open: (ws) => hub.open(ws),
      message: (ws, data) => {
        void hub.message(ws, typeof data === "string" ? data : data.toString("utf8"));
      },
      close: (ws) => hub.detach(ws),
    },
    async fetch(req, srv) {
      if (!draining && warmed && req.method === "GET" && new URL(req.url).pathname === "/browser/connect") {
        // Authentication is the first `hello` message; the token is never in the URL.
        if (srv.upgrade(req)) return undefined as unknown as Response;
        return markGatewayResponse(new Response("websocket upgrade required\n", { status: 426 }));
      }
      const res = markGatewayResponse(await route(req, srv));
      if (draining) {
        // Keep-alive clients reconnect (to another replica) instead of reusing this connection.
        try {
          res.headers.set("connection", "close");
        } catch {
          return new Response(res.body, { status: res.status, statusText: res.statusText, headers: new Headers([...res.headers, ["connection", "close"]]) });
        }
      }
      return res;
    },
  });
  async function route(req: Request, srv: { timeout(r: Request, s: number): void; requestIP(r: Request): { address: string } | null }): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/healthz") return new Response("ok\n");
    if (path === "/readyz") return warmed && !draining ? new Response("ready\n") : new Response(draining ? "draining\n" : "warming\n", { status: 503 });
    if (path === "/metrics") return new Response(metrics.render(), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" } });
    if (!warmed) return providerError(await styleForPath({ store }, path), 503, "gateway is starting");
    srv.timeout(req, 0); // A long generation is not idle.
    return proxy.fetch(req, { ip: srv.requestIP(req)?.address });
  }
  const adminServer = Bun.serve({
    hostname: hooks.host ?? "0.0.0.0",
    port: opts.adminPort,
    fetch: (req) => admin.fetch(req),
  });

  const checkLedger = watchLedger(ledger, alerter);
  const alertTimer = setInterval(checkLedger, hooks.alertCheckMs ?? 5_000);
  alertTimer.unref?.();
  const revokedGrants = new Map<string, string>();
  let keepAliveRunning = false;
  let keepAliveRun: Promise<void> | undefined;
  const keepAliveTimer = setInterval(() => {
    if (keepAliveRunning || draining || !warmed) return;
    keepAliveRunning = true;
    keepAliveRun = keepAliveOnce({ refresh: refreshLogin, accounts: hooks.keepAliveAccounts ?? (() => listGatewayManagedAccounts()), metrics, revoked: revokedGrants }).finally(() => {
      keepAliveRunning = false;
    });
  }, hooks.keepAliveMs ?? 600_000);
  keepAliveTimer.unref?.();
  // Refresh-journal retention: old resolved rows go, the newest per account and any rotated-out evidence stay.
  const pruneJournal = (): void => void Promise.resolve(refreshBackend.prune?.(JOURNAL_RETENTION_MS)).catch(() => undefined);
  const pruneTimer = setInterval(() => {
    if (warmed && !draining) pruneJournal();
  }, 6 * 3_600_000);
  pruneTimer.unref?.();

  void warmUp();

  let stopping: Promise<void> | undefined;
  /**
   * Readiness drops at once, new connections are refused, in-flight requests
   * (including long streams) finish, the ledger is flushed. No timer: the
   * platform's grace period is the only ceiling.
   */
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      draining = true;
      hub.closeAll(1012);
      wake?.();
      clearInterval(alertTimer);
      clearInterval(keepAliveTimer);
      clearInterval(pruneTimer);
      store.stop();
      // Bun's stop(false) refuses new connections and resolves once active requests are done.
      await Promise.all([server.stop(false), adminServer.stop(false)]);
      // Refreshes and the keep-alive in flight finish (or fail) before the backend that guards them goes away.
      await Promise.allSettled([...inflightRefreshes, keepAliveRun]);
      await ledger.close();
      await inner.close?.();
      await refreshBackend.close?.();
    })();
    return stopping;
  };

  const onSignal = (): void => {
    void stop().then(
      () => exit(0),
      () => exit(1),
    );
  };
  if (opts.handleSignals) {
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }

  return {
    stop: async () => {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      await stop();
    },
    port: server.port as number,
    adminPort: adminServer.port as number,
    ready: () => warmed && !draining,
  };
}
