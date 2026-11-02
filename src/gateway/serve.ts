import { TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { refreshIdentityOAuthGrant } from "../identities/oauth-refresh.ts";
import { isRetired } from "../identities/retired.ts";
import { loadIdentitiesFile } from "../identities/store.ts";
import type { PoolUsage } from "../identities/pool/adapter.ts";
import { createAdminApp } from "./admin.ts";
import { createAlerter, stderrNotifier, watchLedger, type Alerter, type Notifier } from "./alerts.ts";
import { createGatewayApp, type GatewayDeps } from "./app.ts";
import { CachedGatewayStore } from "./cache-store.ts";
import { CredentialCache, type RefreshFn } from "./credentials.ts";
import { providerError } from "./errors.ts";
import { LedgerBuffer } from "./ledger-buffer.ts";
import { PrometheusMetrics } from "./metrics.ts";
import { migrate, PgGatewayStore } from "./pg-store.ts";
import type { GatewayStore } from "./store.ts";
import type { GatewayProvider } from "./types.ts";

export const DEFAULT_GATEWAY_PORT = 47130;
export const DEFAULT_GATEWAY_ADMIN_PORT = 47131;

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

/** Wraps a login refresh so every attempt is counted and a failure raises one owner alert until it recovers. */
export function instrumentRefresh(refresh: RefreshFn, deps: { metrics: Pick<PrometheusMetrics, "refresh">; alerter: Alerter }): RefreshFn {
  return (async (tool, identity, opts) => {
    const key = `${tool}/${identity.name}`;
    const fail = (): void => deps.alerter.raise("refresh-failed", key, `refresh of the ${tool} login "${identity.name}" failed; it needs attention (ais auth login or ais auth refresh)`);
    try {
      const result = await refresh(tool, identity, opts);
      deps.metrics.refresh(tool, result.outcome);
      if (result.outcome === "failed") fail();
      else if (result.outcome === "refreshed" || result.outcome === "skipped-fresh") deps.alerter.recover("refresh-failed", key);
      return result;
    } catch (err) {
      deps.metrics.refresh(tool, "failed");
      fail();
      throw err;
    }
  }) as RefreshFn;
}

async function defaultPoolMembers(provider: GatewayProvider): Promise<string[]> {
  const file = await loadIdentitiesFile(TOOL_CONFIGS[provider].identitiesJsonPath);
  return file.identities.filter((i) => !isRetired(i)).map((i) => i.name);
}

const noUsage = async (): Promise<PoolUsage | undefined> => undefined;

/** Reasons only: errors from the store or filesystem can carry connection strings or paths. */
const describe = (err: unknown): string => {
  const e = err as { name?: unknown; code?: unknown } | null;
  return [typeof e?.name === "string" ? e.name : "Error", typeof e?.code === "string" ? e.code : undefined].filter(Boolean).join(" ");
};

export async function startGateway(opts: GatewayOptions, hooks: GatewayHooks = {}): Promise<RunningGateway> {
  if (!opts.adminToken) throw new Error("gateway: an admin token is required (AIS_GATEWAY_ADMIN_TOKEN)");
  const now = hooks.now ?? (() => new Date());
  const backoff = hooks.warmBackoff ?? { initialMs: 1_000, maxMs: 30_000 };
  const exit = hooks.exit ?? ((code: number) => process.exit(code));

  const inner = (hooks.openStore ?? ((url: string) => new PgGatewayStore(url)))(opts.databaseUrl);
  const store = new CachedGatewayStore(inner);
  const ledger = new LedgerBuffer(store, hooks.ledger ?? { max: 50_000, flushMs: 2_000 });
  const metrics = new PrometheusMetrics({ ledgerDepth: () => ledger.depth, ledgerDropped: () => ledger.dropped });
  const alerter = createAlerter(hooks.notify ?? stderrNotifier);
  const creds = hooks.creds ?? new CredentialCache({ refresh: instrumentRefresh(refreshIdentityOAuthGrant, { metrics, alerter }) });
  const poolMembers = hooks.poolMembers ?? defaultPoolMembers;

  const proxy = createGatewayApp({
    store,
    ledger,
    creds,
    // No usage source is wired yet: a missing figure is allowed and counted (see select.ts).
    usageFor: hooks.usageFor ?? noUsage,
    poolMembers,
    fetch: hooks.fetch ?? fetch,
    now,
    metrics,
  });
  const admin = createAdminApp({ store, adminToken: opts.adminToken, now, ...(hooks.overlapMs !== undefined ? { overlapMs: hooks.overlapMs } : {}) });

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

  /** Every pinned or listed identity must be readable; a pool with no list needs one readable member. */
  async function checkCredentials(): Promise<void> {
    const required = new Set<string>();
    const open = new Map<GatewayProvider, true>();
    for (const app of await store.listApps()) {
      if (app.state !== "active") continue;
      if (app.target.kind === "pin") required.add(`${app.provider}\u0000${app.target.identity}`);
      else if (app.target.identities && app.target.identities.length > 0) for (const i of app.target.identities) required.add(`${app.provider}\u0000${i}`);
      else open.set(app.provider, true);
    }
    for (const key of required) {
      const [provider, identity] = key.split("\u0000") as [GatewayProvider, string];
      await creds.get(provider, identity);
    }
    for (const provider of open.keys()) {
      let ok = false;
      for (const member of await poolMembers(provider)) {
        try {
          await creds.get(provider, member);
          ok = true;
          break;
        } catch {
          // try the next member
        }
      }
      if (!ok) throw new Error(`no readable ${provider} credential`);
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
        stage = "credentials";
        await checkCredentials();
        warmed = true;
        store.startRefresh(hooks.refreshIntervalMs ?? 15_000);
        console.info("gateway: warm, ready for traffic");
        return;
      } catch (err) {
        console.warn(`gateway: warm-up failed at ${stage} (${describe(err)}); retrying in ${delay} ms`);
        await sleep(delay);
        delay = Math.min(delay * 2, backoff.maxMs);
      }
    }
  }

  const unready = (): Response => providerError("openai", 503, "gateway is starting");
  const server = Bun.serve({
    hostname: hooks.host ?? "0.0.0.0",
    port: opts.port,
    // The longest allowed idle gap; SSE streams carry their own keepalives.
    idleTimeout: 255,
    async fetch(req, srv) {
      const path = new URL(req.url).pathname;
      if (path === "/healthz") return new Response("ok\n");
      if (path === "/readyz") return warmed && !draining ? new Response("ready\n") : new Response(draining ? "draining\n" : "warming\n", { status: 503 });
      if (path === "/metrics") return new Response(metrics.render(), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" } });
      if (!warmed) return unready();
      srv.timeout(req, 0); // A long generation is not idle.
      return proxy.fetch(req);
    },
  });
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
