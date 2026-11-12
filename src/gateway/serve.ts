import { startUsageProxy, type RunningUsageProxy } from "./usage-proxy.ts";
import { parseToken, verifyToken } from "./tokens.ts";
import { startModelPriceRefresh } from "../identities/model-price-source.ts";
import { TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { DEAD_REFRESH_CODES, OAuthRefreshError, readEffectiveGrant, refreshIdentityOAuthGrant, type RefreshableTool } from "../identities/oauth-refresh.ts";
import { SwapLockError } from "../identities/claude-swap-lock.ts";
import { PgRefreshBackend } from "./pg-refresh-backend.ts";
import { guardRefresh, JOURNAL_RETENTION_MS, RefreshGuardRetryable, type RefreshGuardBackend } from "./refresh-guard.ts";
import { isRetired } from "../identities/retired.ts";
import { allowedAccounts, findPool, isSwapPool } from "../identities/pool/swap-pool.ts";
import { loadIdentitiesFile } from "../identities/store.ts";
import { findIdentityByNameOrAlias } from "../identities/store.ts";
import { isOperationalPath, publicHostsFromEnv, viaPublicHost } from "./public-host.ts";
import { aliSessionOnce, aliSetupSelfTest, listAliAccounts, type AliSetupDeps } from "./ali-session.ts";
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
import { readHeartbeat, writeHeartbeat, type GatewayHeartbeat } from "../identities/gateway-heartbeat.ts";
import { enableMemberStore, memberStoreEnabled } from "../identities/gateway-members.ts";
import { recordLoginRevoked } from "../identities/gateway-revoked.ts";
import { GATEWAY_REFRESH_TOOLS, listGatewayManagedAccounts, markGatewayOwnerProcess } from "../identities/gateway-managed.ts";

export const DEFAULT_GATEWAY_PORT = 47130;
export const DEFAULT_GATEWAY_ADMIN_PORT = 47131;
/** The CONNECT proxy for gateway-routed Claude Code (usage-proxy.ts). */
export const DEFAULT_GATEWAY_CONNECT_PORT = 47132;
export const MIN_ADMIN_TOKEN_LENGTH = 32;

export interface GatewayOptions {
  port: number;
  adminPort: number;
  databaseUrl: string;
  adminToken: string;
  /** Install SIGTERM and SIGINT handlers that drain and exit. The CLI sets this. */
  handleSignals?: boolean;
  /** The CONNECT proxy for gateway-routed Claude Code (usage-proxy.ts). Off when absent. */
  connect?: { port: number; tlsDir: string; publishCaTo?: string };
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
  keepAliveAccounts?(tool: string): Promise<Identity[]>;
  /** The ali logins whose console session the gateway renews, and how (tests replace both). */
  aliAccounts?(): Promise<Identity[]>;
  aliRefresh?(identity: Identity, signal?: AbortSignal): Promise<string>;
  /** Replaces the startup check that the pod can renew ali sessions (kubectl, port-forward, directories). */
  aliSetup?: AliSetupDeps;
  /** Host names the gateway is public under; metrics, health and pairing are 404 there. Defaults to AIS_GATEWAY_PUBLIC_HOSTS. */
  publicHosts?: string[];
  /** Longest stop() waits for the keep-alive pass (ali renewals are abandoned at once on drain). Default 10 s, well inside the 30 s grace. */
  stopCeilingMs?: number;
  /** Tests: do not read or write the shared gateway heartbeat file. */
  noHeartbeat?: boolean;
  overlapMs?: number;
  exit?(code: number): void;
}

export interface RunningGateway {
  stop(): Promise<void>;
  readonly port: number;
  readonly adminPort: number;
  /** The CONNECT proxy port, when it runs. */
  readonly connectPort?: number;
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
      // A forced refresh (after a 401) was asked for because the token in use was rejected: it does not stay in use.
      const effect = opts?.expectedAccessToken !== undefined || opts?.force ? "the rejected token could not be replaced" : "the existing token stays in use";
      deps.alerter.raise("store-unreadable", key, `a credential store of the ${tool} login "${identity.name}" could not be read${which}; check the file's permissions and contents (${effect})`);
    };
    /** A dead login of a member-store account is written next to its store copy for the portal (gateway-revoked.ts); best effort. */
    const markRevoked = async (t: string, name: string, code: string, rejected: string | undefined): Promise<void> => {
      if (memberStoreEnabled()) await recordLoginRevoked(t, name, code, rejected).catch(() => undefined);
    };
    const ok = (): void => {
      deps.failed?.delete(key);
      deps.alerter.recover("refresh-failed", key);
    };
    try {
      const result = await refresh(tool, identity, opts);
      deps.metrics.refresh(tool, result.outcome);
      const idleNoGrant = result.outcome === "no-grant" && opts?.keepAlive === true && !result.readError;
      if (result.outcome === "failed" || (result.outcome === "no-grant" && !idleNoGrant) || result.outcome === "skipped-revoked") fail();
      if (result.outcome === "skipped-revoked") await markRevoked(tool, identity.name, "revoked", result.beforeFingerprint);
      else if (result.outcome === "refreshed") ok();
      // Any result that names unreadable stores warns early (the alerter dedupes); only a result whose store probe ran and
      // found none closes the alert. Adopted, lock-busy and rotated-elsewhere results never probed, so they leave it open.
      if (result.unreadableStores && result.unreadableStores.length > 0) readError(result.unreadableStores);
      else if (result.outcome === "skipped-read-error") readError(result.unreadableStores);
      else if (result.outcome === "refreshed" || (result.outcome === "skipped-fresh" && result.storesProbed)) deps.alerter.recover("store-unreadable", key);
      return result;
    } catch (err) {
      // A busy lock or a transient guard/read error is retried by the next caller or tick: it never means the login needs a person.
      if ((err instanceof SwapLockError && err.timedOut) || err instanceof RefreshGuardRetryable) {
        deps.metrics.refresh(tool, err instanceof RefreshGuardRetryable ? "retryable" : "lock-timeout");
        throw err;
      }
      deps.metrics.refresh(tool, "failed");
      fail();
      // Only a dead-grant OAuth code proves the login is gone (as in credentials.ts): record it where the portal can read it.
      if (err instanceof OAuthRefreshError && err.revoked && err.oauthCode !== undefined && DEAD_REFRESH_CODES.has(err.oauthCode)) await markRevoked(tool, identity.name, err.oauthCode, err.refreshFingerprint);
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

/** The identities an unrestricted pool app may use: real logins only. A swap pool's folder holds no login of its own, so it is never a member. */
export function appPoolMemberNames(file: IdentitiesFile): string[] {
  return file.identities.filter((i) => !isRetired(i) && !isSwapPool(i)).map((i) => i.name);
}

async function defaultPoolMembers(provider: GatewayProvider): Promise<string[]> {
  return appPoolMemberNames(await loadIdentitiesFile(TOOL_CONFIGS[provider].identitiesJsonPath));
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

/** Members of the named swap pool across all tool registries (Claude and Codex may define the same pool name), or undefined when no tool has such a pool. */
async function defaultBrowserPoolMembers(pool: string): Promise<string[] | undefined> {
  const files: IdentitiesFile[] = [];
  for (const cfg of Object.values(TOOL_CONFIGS)) files.push(await loadIdentitiesFile(cfg.identitiesJsonPath));
  return browserPoolMembersAcross(files, pool);
}

/** Union (deduped, first-seen order) of the pool's members across all registries; undefined when none has the pool. */
export function browserPoolMembersAcross(files: IdentitiesFile[], pool: string): string[] | undefined {
  let all: string[] | undefined;
  for (const file of files) {
    const names = browserPoolMemberNames(file, pool);
    if (names) all = [...new Set([...(all ?? []), ...names])];
  }
  return all;
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
/** Records the time of every successful refresh per "tool/name", whoever asked (keep-alive, 401 path, ensureUsable). */
export function stampRefreshSuccess(refresh: RefreshFn, lastSuccess: Map<string, string>, now: () => Date): RefreshFn {
  return (async (tool, identity, opts) => {
    const r = await refresh(tool, identity, opts);
    if (r.outcome === "refreshed") lastSuccess.set(`${tool}/${identity.name}`, now().toISOString());
    return r;
  }) as RefreshFn;
}

/** Typical access-token lifetimes, used to date a grant that records only its expiry. */
const ACCESS_TOKEN_LIFETIME_S: Record<string, number> = { kimi: 900, codex: 10 * 86_400 };

/** When the stored grant was minted: its own minted_at, else expiry minus the tool's token lifetime. Undefined when unknown. */
export async function grantMintedAt(tool: string, account: Identity): Promise<number | undefined> {
  const found = await readEffectiveGrant(tool as RefreshableTool, account).catch(() => undefined);
  const g = found?.grant;
  if (!g) return undefined;
  const nowS = Math.floor(Date.now() / 1000);
  if (g.minted_at !== undefined) return Math.min(g.minted_at, nowS);
  const life = ACCESS_TOKEN_LIFETIME_S[tool];
  return g.expires_at !== undefined && life !== undefined ? Math.min(g.expires_at - life, nowS) : undefined;
}

/** Writes the ownership heartbeat; a failure raises one alert (cleared by the next good write) and is counted. */
export async function trackedHeartbeatWrite(deps: { metrics: Pick<PrometheusMetrics, "heartbeatWrite">; alerter: Alerter }, hb: GatewayHeartbeat, write: (hb: GatewayHeartbeat) => Promise<void> = writeHeartbeat): Promise<void> {
  try {
    await write(hb);
    deps.metrics.heartbeatWrite("ok");
    deps.alerter.recover("heartbeat-write-failed", "gateway");
  } catch {
    deps.metrics.heartbeatWrite("failed");
    deps.alerter.raise("heartbeat-write-failed", "gateway", "the gateway could not write its ownership heartbeat; other hosts will refresh its logins themselves until it can (check the ~/.ais directory)");
  }
}

export async function keepAliveOnce(deps: {
  refresh: RefreshFn;
  accounts: (tool: string) => Promise<Identity[]>;
  metrics: { keepAlive(provider: string, outcome: string): void };
  revoked?: Map<string, string>;
  /** Tools to keep alive, in order, one sequential pass over all of them (default: claude only). */
  tools?: readonly string[];
  /** "tool/name" to the ISO time of its last successful refresh; survives passes so codex and kimi rotate about daily, not per pass. */
  lastSuccess?: Map<string, string>;
  now?: () => Date;
  /** Seconds when the login's stored grant was last minted, if known: a grant minted recently counts as just refreshed (cold start, host handoff). */
  mintedAt?: (tool: string, account: Identity) => Promise<number | undefined>;
  /** Called after the pass with every login held and its last success: the gateway's heartbeat. */
  onPass?: (held: Record<string, { lastSuccessAt?: string }>, at: Date) => Promise<void>;
}): Promise<void> {
  // A grant diagnosed revoked is remembered by fingerprint and not POSTed again until a re-login mints a different one.
  const revoked = deps.revoked ?? new Map<string, string>();
  const lastSuccess = deps.lastSuccess ?? new Map<string, string>();
  const now = deps.now ?? (() => new Date());
  const held: Record<string, { lastSuccessAt?: string }> = {};
  for (const tool of deps.tools ?? ["claude"]) {
    for (const account of await deps.accounts(tool).catch(() => [] as Identity[])) {
      const key = `${tool}/${account.name}`;
      held[key] = {};
      try {
        const known = revoked.get(key);
        const minted = await deps.mintedAt?.(tool, account).catch(() => undefined);
        // A success can never lie in the future (clock skew, odd expiry maths): clamp every source to now.
        const nowIso = now().toISOString();
        const haveRaw = lastSuccess.get(key);
        if (haveRaw && haveRaw > nowIso) lastSuccess.set(key, nowIso);
        if (minted !== undefined) {
          const iso = new Date(Math.min(minted * 1000, now().getTime())).toISOString();
          const have = lastSuccess.get(key);
          if (!have || have < iso) lastSuccess.set(key, iso);
        }
        const r = await deps.refresh(tool as RefreshableTool, account, { keepAlive: true, lastSuccessAt: lastSuccess.get(key) ?? null, ...(known ? { revokedFingerprint: known } : {}) });
        if (r.outcome === "skipped-revoked" && r.beforeFingerprint) revoked.set(key, r.beforeFingerprint);
        else revoked.delete(key);
        if (r.outcome === "refreshed") lastSuccess.set(key, now().toISOString());
        deps.metrics.keepAlive(tool, r.outcome);
      } catch (err) {
        // Only a dead-grant OAuth code proves the login is gone; any other 400/401 is not enough (as in credentials.ts).
        if (err instanceof OAuthRefreshError && err.revoked && err.refreshFingerprint && err.oauthCode !== undefined && DEAD_REFRESH_CODES.has(err.oauthCode)) revoked.set(key, err.refreshFingerprint);
        deps.metrics.keepAlive(tool, "failed");
      }
      const last = lastSuccess.get(key);
      if (last) held[key] = { lastSuccessAt: last };
    }
  }
  await deps.onPass?.(held, now()).catch(() => undefined);
}

export async function startGateway(opts: GatewayOptions, hooks: GatewayHooks = {}): Promise<RunningGateway> {
  if (opts.adminToken.length < MIN_ADMIN_TOKEN_LENGTH) throw new Error(`gateway: the admin token (AIS_GATEWAY_ADMIN_TOKEN) must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters`);
  startModelPriceRefresh();
  enableMemberStore(); // read each account's login from the gateway member store, not the local identity folders
  markGatewayOwnerProcess(); // this process alone refreshes gateway-managed logins
  const now = hooks.now ?? (() => new Date());
  const backoff = hooks.warmBackoff ?? { initialMs: 1_000, maxMs: 30_000 };
  const exit = hooks.exit ?? ((code: number) => process.exit(code));

  const inner = (hooks.openStore ?? ((url: string) => new PgGatewayStore(url)))(opts.databaseUrl);
  const store = new CachedGatewayStore(inner);
  const publicHosts = hooks.publicHosts ?? publicHostsFromEnv();
  const ledger = new LedgerBuffer(store, hooks.ledger ?? { max: 50_000, flushMs: 2_000 });
  const metrics = new PrometheusMetrics({ ledgerDepth: () => ledger.depth, ledgerDropped: () => ledger.dropped });
  metrics.publicHostsConfigured(publicHosts.length);
  if (publicHosts.length === 0) console.warn("gateway: AIS_GATEWAY_PUBLIC_HOSTS is empty, so /metrics, /healthz, /readyz and /browser/pair answer on every host, including a public tunnel; set it to the public host names");
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
  /** Last successful refresh per "tool/name", stamped for every gateway refresh (keep-alive, 401 path, ensureUsable). */
  const lastSuccessAt = new Map<string, string>();
  const stamped = stampRefreshSuccess(instrumented, lastSuccessAt, now);
  const refreshLogin = ((...a: Parameters<RefreshFn>) => {
    const p = stamped(...a);
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
    ...(hooks.usageFor ? {} : { refreshUsage: async (provider: GatewayProvider, identity: string) => usage.refreshNow(provider, await canonical(provider, identity)) }),
    canonical,
    sideCountHealth: (ok) => (ok ? alerter.recover("side-count-unavailable", "gateway") : alerter.raise("side-count-unavailable", "gateway", "the gateway database could not count list, search and speech requests; the limit is enforced per replica from memory until it can")),
    poolMembers,
    browserPoolMembers,
    browserIdentityExists,
    browserHub: hub,
    fetch: hooks.fetch ?? fetch,
    now,
    metrics: recoverOnSuccess(metrics, alerter),
  });
  /** The active claude app a gateway token belongs to, for the CONNECT proxy. */
  const appForToken = async (token: string): Promise<string | undefined> => {
    if (!warmed || !parseToken(token)) return undefined;
    for (const app of await store.listApps()) {
      if (app.state === "active" && app.provider === "claude" && (await verifyToken(store, app.name, token, now()))) return app.name;
    }
    return undefined;
  };
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
        if (aliList && selfTestEnabled) void aliSetupSelfTest(alerter, { ...(hooks.aliSetup ?? {}), accounts: aliList }).then((p) => void (aliSetupOk = p.length === 0), () => undefined);
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
    // Operational endpoints answer only inside the cluster (vmagent and probes use the pod address): on a public host they do not exist.
    if (isOperationalPath(path) && viaPublicHost(req.headers, req.url, publicHosts)) return markGatewayResponse(new Response("not found\n", { status: 404 }));
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
  // Seeded from the previous heartbeat so a restart does not rotate every codex and kimi login again at once.
  if (!hooks.noHeartbeat) {
    const prior = await readHeartbeat();
    for (const [k, v] of Object.entries(prior?.held ?? {})) {
      const seeded = v.lastSuccessAt && v.lastSuccessAt > now().toISOString() ? now().toISOString() : v.lastSuccessAt;
      if (seeded && !(lastSuccessAt.get(k) && lastSuccessAt.get(k)! >= seeded)) lastSuccessAt.set(k, seeded);
    }
  }
  let keepAliveRunning = false;
  let keepAliveRun: Promise<void> | undefined;
  const aliAbort = new AbortController();
  const aliSkips = new Map<string, number>();
  /** True once the startup self-test (re-run every pass until it passes) found nothing missing. The heartbeat claims no ali login before. */
  let aliSetupOk = false;
  // Tests (noHeartbeat) never shell out to kubectl or touch the real home unless they inject the checks.
  const selfTestEnabled = !hooks.noHeartbeat || hooks.aliSetup !== undefined;
  if (!selfTestEnabled) aliSetupOk = true;
  // Tests (noHeartbeat) never touch the real registry or auth browser unless they inject an ali source.
  const aliList = hooks.aliAccounts ?? (hooks.noHeartbeat ? undefined : listAliAccounts);
  const keepAliveTimer = setInterval(() => {
    if (keepAliveRunning || draining || !warmed) return;
    keepAliveRunning = true;
    keepAliveRun = keepAliveOnce({
      refresh: refreshLogin,
      accounts: hooks.keepAliveAccounts ?? ((tool) => listGatewayManagedAccounts(undefined, tool)),
      tools: GATEWAY_REFRESH_TOOLS,
      lastSuccess: lastSuccessAt,
      now,
      mintedAt: grantMintedAt,
      // The heartbeat also names the ali logins this gateway renews, so the host timer, the daemon and the CLI stand down.
      onPass: hooks.noHeartbeat
        ? undefined
        : async (held, at) => {
            // Claimed only with a working setup and a renewal that has succeeded: until then the host keeps renewing.
            if (aliSetupOk) for (const a of (await aliList?.().catch(() => [] as Identity[])) ?? []) {
              const last = lastSuccessAt.get(`ali/${a.name}`);
              if (last) held[`ali/${a.name}`] = { lastSuccessAt: last };
            }
            await trackedHeartbeatWrite({ metrics, alerter }, { version: 1, passAt: at.toISOString(), held, memberStore: true });
          },
      metrics,
      revoked: revokedGrants,
    })
      .then(async () => {
        if (aliList && selfTestEnabled && !aliSetupOk && !aliAbort.signal.aborted) aliSetupOk = (await aliSetupSelfTest(alerter, { ...(hooks.aliSetup ?? {}), accounts: aliList }).catch(() => ["error"])).length === 0;
      })
      .then(() => (aliList ? aliSessionOnce({ accounts: aliList, ...(hooks.aliRefresh ? { refresh: hooks.aliRefresh } : {}), metrics, alerter, lastSuccess: lastSuccessAt, now, signal: aliAbort.signal, loginPageSkips: aliSkips }) : undefined))
      .finally(() => {
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
      await Promise.all([server.stop(false), adminServer.stop(false), connectProxy?.stop(false)]);
      // Refreshes and the keep-alive in flight finish (or fail) before the backend that guards them goes away.
      // A browser renewal is abandoned at once and the pass given a short ceiling, so the ledger below is always flushed inside the grace period.
      aliAbort.abort();
      await Promise.allSettled([...inflightRefreshes]);
      await Promise.race([Promise.allSettled([keepAliveRun]), new Promise<void>((r) => setTimeout(r, hooks.stopCeilingMs ?? 10_000).unref?.())]);
      await ledger.close();
      await inner.close?.();
      await refreshBackend.close?.();
    })();
    return stopping;
  };

  let connectProxy: RunningUsageProxy | undefined;
  if (opts.connect) {
    try {
      connectProxy = await startUsageProxy({
        port: opts.connect.port,
        ...(hooks.host ? { host: hooks.host } : {}),
        tlsDir: opts.connect.tlsDir,
        ...(opts.connect.publishCaTo ? { publishCaTo: opts.connect.publishCaTo } : {}),
        appForToken,
        // The gateway's own route for the app, with the client's method, headers (same token) and body.
        serve: async (app, path, req) => {
          const hasBody = req.body !== null && req.method !== "GET" && req.method !== "HEAD";
          return proxy.fetch(new Request(`http://gateway.internal/${encodeURIComponent(app)}${path}${new URL(req.url).search}`, { method: req.method, headers: req.headers, ...(hasBody ? { body: req.body, duplex: "half" } : {}) } as RequestInit), { ip: "127.0.0.1" });
        },
        ...(hooks.fetch ? { fetch: hooks.fetch } : {}),
      });
      console.info(`gateway: connect proxy on :${connectProxy.port}`);
    } catch (err) {
      // A missing certificate never takes the gateway down; only the proxy is off.
      console.warn(`gateway: connect proxy not started (${describe(err)})`);
    }
  }

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
    ...(connectProxy ? { connectPort: connectProxy.port } : {}),
    ready: () => warmed && !draining,
  };
}
