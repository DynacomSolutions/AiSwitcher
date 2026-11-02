import { TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { refreshIdentityOAuthGrant } from "../identities/oauth-refresh.ts";
import { isRetired } from "../identities/retired.ts";
import { loadIdentitiesFile } from "../identities/store.ts";
import { findIdentityByNameOrAlias } from "../identities/store.ts";
import { createAdminApp, type IdentityState } from "./admin.ts";
import { createAlerter, stderrNotifier, watchLedger, type Alerter, type Notifier } from "./alerts.ts";
import { createGatewayApp, styleForPath, type GatewayDeps } from "./app.ts";
import { CachedGatewayStore } from "./cache-store.ts";
import { CredentialCache, type RefreshFn } from "./credentials.ts";
import { providerError } from "./errors.ts";
import { LedgerBuffer } from "./ledger-buffer.ts";
import { PrometheusMetrics, type GatewayMetrics } from "./metrics.ts";
import { migrate, PgGatewayStore } from "./pg-store.ts";
import type { GatewayStore } from "./store.ts";
import { createUsageSource, fetchPoolUsage, type FetchUsage } from "./usage-source.ts";
import type { GatewayProvider } from "./types.ts";

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
  fetch?: typeof fetch;
  now?(): Date;
  usageFor?: GatewayDeps["usageFor"];
  /** Replaces the AIS adapter fetch behind the default (cached) usage source. */
  fetchUsage?: FetchUsage;
  canonical?: GatewayDeps["canonical"];
  identityState?(provider: GatewayProvider, identity: string): Promise<IdentityState>;
  poolMembers?: GatewayDeps["poolMembers"];
  notify?: Notifier;
  warmBackoff?: { initialMs: number; maxMs: number };
  ledger?: { max: number; flushMs: number };
  /** How often the app and token cache is re-read for changes made by other instances. */
  refreshIntervalMs?: number;
  alertCheckMs?: number;
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
    const ok = (): void => {
      deps.failed?.delete(key);
      deps.alerter.recover("refresh-failed", key);
    };
    try {
      const result = await refresh(tool, identity, opts);
      deps.metrics.refresh(tool, result.outcome);
      if (result.outcome === "failed" || result.outcome === "no-grant" || result.outcome === "skipped-revoked") fail();
      else if (result.outcome === "refreshed") ok();
      return result;
    } catch (err) {
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
  } as GatewayDeps["creds"];
}

async function defaultPoolMembers(provider: GatewayProvider): Promise<string[]> {
  const file = await loadIdentitiesFile(TOOL_CONFIGS[provider].identitiesJsonPath);
  return file.identities.filter((i) => !isRetired(i)).map((i) => i.name);
}

async function defaultIdentityState(provider: GatewayProvider, name: string): Promise<IdentityState> {
  const file = await loadIdentitiesFile(TOOL_CONFIGS[provider].identitiesJsonPath);
  const found = findIdentityByNameOrAlias(file.identities, name);
  return !found ? "missing" : isRetired(found) ? "retired" : "ok";
}

/** Reasons only: errors from the store or filesystem can carry connection strings or paths. */
/** Alias to canonical identity name, with a short cache so the registry file is not read per request. */
function canonicalResolver(): NonNullable<GatewayDeps["canonical"]> {
  const cache = new Map<string, { name: string; at: number }>();
  return async (provider, identity) => {
    const key = `${provider}\u0000${identity}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.name;
    try {
      const file = await loadIdentitiesFile(TOOL_CONFIGS[provider].identitiesJsonPath);
      const name = findIdentityByNameOrAlias(file.identities, identity)?.name ?? identity;
      cache.set(key, { name, at: Date.now() });
      return name;
    } catch {
      return hit?.name ?? identity;
    }
  };
}

const describe = (err: unknown): string => {
  const e = err as { name?: unknown; code?: unknown } | null;
  return [typeof e?.name === "string" ? e.name : "Error", typeof e?.code === "string" ? e.code : undefined].filter(Boolean).join(" ");
};

export async function startGateway(opts: GatewayOptions, hooks: GatewayHooks = {}): Promise<RunningGateway> {
  if (opts.adminToken.length < MIN_ADMIN_TOKEN_LENGTH) throw new Error(`gateway: the admin token (AIS_GATEWAY_ADMIN_TOKEN) must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters`);
  const now = hooks.now ?? (() => new Date());
  const backoff = hooks.warmBackoff ?? { initialMs: 1_000, maxMs: 30_000 };
  const exit = hooks.exit ?? ((code: number) => process.exit(code));

  const inner = (hooks.openStore ?? ((url: string) => new PgGatewayStore(url)))(opts.databaseUrl);
  const store = new CachedGatewayStore(inner);
  const ledger = new LedgerBuffer(store, hooks.ledger ?? { max: 50_000, flushMs: 2_000 });
  const metrics = new PrometheusMetrics({ ledgerDepth: () => ledger.depth, ledgerDropped: () => ledger.dropped });
  const alerter = createAlerter(hooks.notify ?? stderrNotifier);
  const failedTokens = new Map<string, string>();
  const baseCreds = hooks.creds ?? new CredentialCache({ refresh: instrumentRefresh(refreshIdentityOAuthGrant, { metrics, alerter, failed: failedTokens }) });
  const creds = watchCredentialReads(baseCreds, alerter, failedTokens);
  const canonical = hooks.canonical ?? canonicalResolver();
  const usage = createUsageSource({ fetchUsage: hooks.fetchUsage ?? fetchPoolUsage });
  const poolMembers = hooks.poolMembers ?? defaultPoolMembers;

  const proxy = createGatewayApp({
    store,
    ledger,
    creds,
    usageFor: hooks.usageFor ?? (async (provider, identity) => usage.get(provider, await canonical(provider, identity))),
    canonical,
    poolMembers,
    fetch: hooks.fetch ?? fetch,
    now,
    metrics: recoverOnSuccess(metrics, alerter),
  });
  const admin = createAdminApp({ store, adminToken: opts.adminToken, now, identityState: hooks.identityState ?? defaultIdentityState, ...(hooks.overlapMs !== undefined ? { overlapMs: hooks.overlapMs } : {}) });

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
          metrics.credentialUnreadable(app.name, app.provider, identity);
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
    async fetch(req, srv) {
      const res = await route(req, srv);
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
  async function route(req: Request, srv: { timeout(r: Request, s: number): void }): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/healthz") return new Response("ok\n");
    if (path === "/readyz") return warmed && !draining ? new Response("ready\n") : new Response(draining ? "draining\n" : "warming\n", { status: 503 });
    if (path === "/metrics") return new Response(metrics.render(), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" } });
    if (!warmed) return providerError(await styleForPath({ store }, path), 503, "gateway is starting");
    srv.timeout(req, 0); // A long generation is not idle.
    return proxy.fetch(req);
  }
  const adminServer = Bun.serve({
    hostname: hooks.host ?? "0.0.0.0",
    port: opts.adminPort,
    fetch: (req) => admin.fetch(req),
  });

  const checkLedger = watchLedger(ledger, alerter);
  const alertTimer = setInterval(checkLedger, hooks.alertCheckMs ?? 5_000);
  alertTimer.unref?.();

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
      wake?.();
      clearInterval(alertTimer);
      store.stop();
      // Bun's stop(false) refuses new connections and resolves once active requests are done.
      await Promise.all([server.stop(false), adminServer.stop(false)]);
      await ledger.close();
      await inner.close?.();
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
