import { startUsageProxy, type RunningUsageProxy } from "./usage-proxy.ts";
import { parseToken, verifyToken } from "./tokens.ts";
import { startModelPriceRefresh } from "../identities/model-price-source.ts";
import { TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { DEAD_REFRESH_CODES, DEFAULT_ACCESS_TOKEN_LIFETIME_S, effectiveGrantPaths, GATEWAY_RENEW_FRACTION, KIMI_RENEW_BELOW_S, OAuthRefreshError, type IdentityGrantRefresh, readEffectiveGrant, refreshIdentityOAuthGrant, type RefreshableTool } from "../identities/oauth-refresh.ts";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClusterBrowserHub, RELAY_PATH } from "./browser/cluster.ts";
import { HomeMirror } from "./home-mirror.ts";
import { importHome, STORE_META_PATH } from "./home-import.ts";
import { PgHomeStore } from "./home-store.ts";
import { PgLeader } from "./pg-leader.ts";
import { sessionsEnrichEnabled } from "./sessions/enrich-config.ts";
import { getGatewayListener, releaseGatewayListener } from "./pg-listen.ts";
import { getGatewaySql, releaseGatewaySql } from "./pg-pool.ts";
import { SwapLockError } from "../identities/claude-swap-lock.ts";
import { PgRefreshBackend } from "./pg-refresh-backend.ts";
import { bounded, guardRefresh, JOURNAL_RETENTION_MS, RefreshGuardRetryable, RefreshRefused, type RefreshGuardBackend } from "./refresh-guard.ts";
import { isRetired } from "../identities/retired.ts";
import { allowedAccounts, findPool, isSwapPool, poolsOf } from "../identities/pool/swap-pool.ts";
import { loadIdentitiesFile } from "../identities/store.ts";
import { findIdentityByNameOrAlias } from "../identities/store.ts";
import { isOperationalPath, publicHostsFromEnv, viaPublicHost } from "./public-host.ts";
import { aliSessionOnce, aliSetupSelfTest, listAliAccounts, type AliSetupDeps } from "./ali-session.ts";
import { withStoreWaitTimeout } from "./admin-store.ts";
import { SessionStore } from "./sessions/session-store.ts";
import type { SessionsIngestStore } from "./admin-sessions.ts";
import { createAdminApp, limitsIdentities, LIMITS_PROVIDERS, type IdentityState } from "./admin.ts";
import { createWarmGate, positiveIntEnv } from "../shared/warm-gate.ts";
import { createAlerter, stderrNotifier, watchLedger, type Alerter, type Notifier } from "./alerts.ts";
import { weeklyUtilisation } from "./native-limit.ts";
import { createGatewayApp, markGatewayResponse, styleForPath, type GatewayDeps } from "./app.ts";
import { authBrowserToken } from "./browser/auth.ts";
import { BrowserHub, type HubOptions } from "./browser/hub.ts";
import { SESSION_END_TOOL } from "../browser/protocol.ts";
import { MAX_CHATS_PER_WINDOW } from "../browser/chat-protocol.ts";
import { ChatBroker, chatIdleMsFromEnv } from "./chat/broker.ts";
import { MemoryChatBus, PgChatBus, type ChatBus } from "./chat/bus.ts";
import { ChatCatalog } from "./chat/catalog.ts";
import { FavouritesService } from "./chat/favourites.ts";
import { MemoryFavouriteStore, type FavouriteStore } from "./chat/favourites-store.ts";
import { ChatFrames } from "./chat/frames.ts";
import { HttpKubeApi, inClusterKube } from "./chat/kube-http.ts";
import type { KubeApi, KubeConfigEnv, PodTransport } from "./chat/kube.ts";
import { PgChatStore } from "./chat/pg-chat-store.ts";
import { PgFavouriteStore } from "./chat/pg-favourites-store.ts";
import { KubePodTransport } from "./chat/pod-transport.ts";
import { MemoryChatStore } from "./chat/store.ts";
import { chatTokenKey } from "./chat/token.ts";
import type { ChatStore } from "./chat/types.ts";
import { listAppModels } from "./models-union.ts";
import { CachedGatewayStore } from "./cache-store.ts";
import { CredentialCache, GatewayCredentialError, loginCommand, type RefreshFn } from "./credentials.ts";
import { providerError } from "./errors.ts";
import { errorTag, LedgerBuffer } from "./ledger-buffer.ts";
import { PrometheusMetrics, type GatewayMetrics } from "./metrics.ts";
import { migrate, PgGatewayStore } from "./pg-store.ts";
import type { GatewayStore } from "./store.ts";
import { MemoryUsageReadings, PgUsageReadings, type UsageReadings } from "./usage-readings.ts";
import { createUsageSource, fetchPoolUsage, withOpencodeUsage, type FetchUsage } from "./usage-source.ts";
import type { ApiStyle, GatewayProvider } from "./types.ts";
import type { IdentitiesFile, Identity } from "../identities/types.ts";
import { readHeartbeat, writeHeartbeat, type GatewayHeartbeat } from "../identities/gateway-heartbeat.ts";
import { enableMemberStore, hasMemberCopy, isMemberStoreTool, memberDir, memberLoginFile, memberStoreEnabled, setLocalWriteHook } from "../identities/gateway-members.ts";
import { clearLoginRevoked, recordLoginRevoked } from "../identities/gateway-revoked.ts";
import { grantFingerprint } from "../identities/oauth-reconcile.ts";
import { buildRenewalReport } from "./renewal.ts";
import { useClaudeReset } from "../server/claude-resets.ts";
import { createManagementCheck, GATEWAY_REFRESH_TOOLS, listGatewayManagedAccounts, listGatewayManagedAccountsStrict, markGatewayOwnerProcess } from "../identities/gateway-managed.ts";

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
  /**
   * Logins in the PostgreSQL credential store (home-store.ts) instead of host files. `key`: AIS_GATEWAY_STORE_KEY.
   * `fileStore`: this replica's HOME holds the host's real files (write-back and import). `importOnStart`: run the import first.
   */
  credentialStore?: { key: Buffer; fileStore?: boolean; importOnStart?: boolean };
  /** This replica's admin base URL for other replicas (browser relay forwarding). Multi-replica relay is on when set. */
  replicaUrl?: string;
  /**
   * The session ingest routes (`/sessions/v1/*`, admin-sessions.ts). Off when absent: the routes answer 404.
   * `token`: the ingest token, AIS_GATEWAY_SESSIONS_TOKEN. `flushGapSeconds`: AIS_GATEWAY_SESSIONS_FLUSH_GAP_SECONDS (default 120).
   */
  sessions?: { token: string; flushGapSeconds?: number };
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
  /** Test hook: how the guard reads the stored grant under the lock (default: the freshest grant AIS's refresh itself reads). */
  readGrant?: Parameters<typeof guardRefresh>[1]["readGrant"];
  /** Lock and journal that guard login refreshes across replicas. Default: the gateway's PostgreSQL. */
  refreshBackend?: RefreshGuardBackend & { close?(): Promise<void> };
  fetch?: typeof fetch;
  now?(): Date;
  usageFor?: GatewayDeps["usageFor"];
  /** Tests: replaces the reset spend behind POST /limits/claude/:identity/resets/:grant. */
  spendReset?(identity: string, grantId: string): Promise<unknown>;
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
  /** Tests: the wait before kimi is renewed again after the guard was busy (default one minute). */
  kimiRetryMs?: number;
  keepAliveAccounts?(tool: string): Promise<Identity[]>;
  /**
   * Whether the gateway manages (renews) the login of a plain identity. A refresh for any other login is skipped, so a copy in the
   * credential store of a login a host owns is never refreshed here (the host's CLI keeps rotating its token). Default with a
   * credential store: membership in listGatewayManagedAccounts, the list the keep-alive and /logins/renewal use. Tests replace it.
   */
  isManaged?(tool: string, identity: string): Promise<boolean | undefined>;
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
  /** Replica HOME for the credential store mirror (default the process home). */
  home?: string;
  /** Longest /readyz waits for the usage cache to warm (default 90 s, or AIS_GATEWAY_USAGE_WARM_TIMEOUT_MS). */
  usageWarmTimeoutMs?: number;
  /** Database reachability check behind /readyz (default SELECT 1 on the gateway database; a no-op when openStore is replaced). */
  ping?(): Promise<void>;
  /** Usage readings shared by the replicas (default: the gateway database; in memory when openStore or ping is replaced). */
  usageReadings?: UsageReadings;
  pingMs?: number;
  /** How often every replica re-reads its logins for the expiry, lifetime and revoked gauges (default 60 s). */
  gaugeMs?: number;
  /** Credential store follow interval (default 5 s). */
  storePollMs?: number;
  /** Leader election interval (default 10 s). */
  leaderTryMs?: number;
  overlapMs?: number;
  exit?(code: number): void;
  /**
   * Tests: the pod transport of the side-panel chat. Giving it turns chat on without the cluster env, with an in-memory
   * chat store and bus, and an MCP URL on this gateway's own port.
   */
  chatTransport?: PodTransport;
  /** Tests: the Kubernetes API of the chat pod transport. The chat env (`AIS_GATEWAY_CHAT_*`) is still read. Also turns the in-memory chat store and bus on. */
  chatKubeApi?: KubeApi;
  /** Tests: the chat bus (in-memory store mode only). */
  chatBus?: ChatBus;
  /** Tests: the chat store (in-memory store mode only). A second gateway given the same store sees the chats of the first. */
  chatStore?: ChatStore;
  /** Tests: the starred-model store (in-memory store mode only). */
  favouriteStore?: FavouriteStore;
  /** Tests: the session store behind the ingest routes (default: the gateway database). */
  sessionStore?: SessionsIngestStore;
  /** Tests and the object store check: whether a part object exists. Absent: the gateway does not check. */
  sessionObjectExists?(key: string): Promise<boolean>;
}

/** What `AIS_GATEWAY_CHAT_*` configures. */
export interface ChatEnvConfig { kube: KubeConfigEnv; mcpUrl: string; maxLive: number; startTimeoutMs: number }

const CHAT_MAX_DEFAULT = 12;
/** The broker refuses to start a chat older than this (its default maxAgeMs). */
const CHAT_MAX_AGE_MS = 7 * 86_400_000;
/** Closed chats are kept this long, then pruned. */
const CHAT_RETENTION_MS = 30 * 86_400_000;
const CHAT_START_TIMEOUT_DEFAULT_MS = 240_000;
const posInt = (v: string | undefined, fallback: number): number => {
  const n = v === undefined || v.trim() === "" ? Number.NaN : Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

/**
 * The chat settings from the environment. Chat is off (undefined) unless `AIS_GATEWAY_CHAT_GROUP` and `AIS_GATEWAY_CHAT_MCP_URL` are set.
 * With both set, the namespace and the node must be set too: a missing one throws, and the caller turns chat off with a warning.
 */
export function chatConfigFromEnv(env: Record<string, string | undefined>): ChatEnvConfig | undefined {
  const group = env.AIS_GATEWAY_CHAT_GROUP?.trim();
  const mcpUrl = env.AIS_GATEWAY_CHAT_MCP_URL?.trim();
  if (!group || !mcpUrl) return undefined;
  const namespace = env.AIS_GATEWAY_CHAT_NAMESPACE?.trim();
  const node = env.AIS_GATEWAY_CHAT_NODE?.trim();
  if (!namespace) throw new Error("AIS_GATEWAY_CHAT_NAMESPACE is not set");
  if (!node) throw new Error("AIS_GATEWAY_CHAT_NODE is not set");
  return {
    kube: { group, namespace, node, configMap: env.AIS_GATEWAY_CHAT_CONFIG_MAP?.trim() || "agent-runtime-config", class: env.AIS_GATEWAY_CHAT_CLASS?.trim() || "chat" },
    mcpUrl,
    maxLive: posInt(env.AIS_GATEWAY_CHAT_MAX, CHAT_MAX_DEFAULT),
    startTimeoutMs: posInt(env.AIS_GATEWAY_CHAT_START_TIMEOUT_MS, CHAT_START_TIMEOUT_DEFAULT_MS),
  };
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
  deps: { metrics: Pick<PrometheusMetrics, "refresh">; alerter: Alerter; failed?: Map<string, string>; log?: (line: string) => void; replica?: string },
): RefreshFn {
  const log = deps.log ?? ((line: string) => console.info(line));
  const replica = deps.replica ?? process.env.HOSTNAME ?? "gateway";
  /** One JSON line per refresh result: ids, outcome, expiry and OAuth code only (no token, no email). */
  const logResult = (tool: string, name: string, outcome: string, expiresAt: number | undefined, code: string | undefined): void => {
    log(JSON.stringify({ event: "refresh", provider: tool, identity: name, replica, outcome, expiresAt: expiresAt !== undefined ? new Date(expiresAt * 1000).toISOString() : null, code: code ?? null }));
  };
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
      // A pass that sent nothing and changed nothing (token not due, idle login) is not a refresh result worth a line.
      const adopted = result.outcome === "skipped-fresh" && result.detail?.startsWith("adopted") === true;
      if (result.outcome !== "skipped-fresh" && !(result.outcome === "no-grant" && opts?.keepAlive === true && !result.readError)) logResult(tool, identity.name, result.outcome, result.expiresAt, undefined);
      else if (adopted) logResult(tool, identity.name, "adopted", result.expiresAt, undefined);
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
        logResult(tool, identity.name, err instanceof RefreshGuardRetryable ? "retryable" : "lock-timeout", undefined, undefined);
        throw err;
      }
      // The journal refused to send a token it knows is dead: the dead answer was already counted, alerted and marked once.
      if (err instanceof RefreshRefused && err.kind === "dead") {
        deps.metrics.refresh(tool, "refused-dead");
        logResult(tool, identity.name, "refused-dead", undefined, err.oauthCode);
        throw err;
      }
      deps.metrics.refresh(tool, err instanceof RefreshRefused ? "refused" : "failed");
      if (err instanceof RefreshRefused) logResult(tool, identity.name, "refused", undefined, undefined);
      else logResult(tool, identity.name, err instanceof OAuthRefreshError && err.oauthCode !== undefined && DEAD_REFRESH_CODES.has(err.oauthCode) ? "dead" : "failed", undefined, err instanceof OAuthRefreshError ? err.oauthCode ?? (err.message.startsWith("token endpoint unreachable") ? "transport" : undefined) : undefined);
      fail();
      // Only a dead-grant OAuth code proves the login is gone (as in credentials.ts): record it where the portal can read it.
      if (err instanceof OAuthRefreshError && err.revoked && err.oauthCode !== undefined && DEAD_REFRESH_CODES.has(err.oauthCode)) await markRevoked(tool, identity.name, err.oauthCode, err.refreshFingerprint);
      throw err;
    }
  }) as RefreshFn;
}

/** A successful upstream answer for an identity proves its login works: clear any open refresh alert for it. */
/** Providers whose pool headroom is exported, and the weekly use in percent below which a member counts as having room. */
const POOL_HEADROOM_PROVIDERS: GatewayProvider[] = ["claude", "codex"];
const POOL_HEADROOM_PERCENT = 90;

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
export function watchCredentialReads(creds: GatewayDeps["creds"], alerter: Alerter, failed: Map<string, string>, refuse?: (provider: GatewayProvider, identity: string) => Promise<boolean>): GatewayDeps["creds"] {
  return {
    ...creds,
    get: async (provider, identity) => {
      // A login the gateway does not manage is never used or renewed here: a request that names it fails with a plain reason.
      if (refuse && (await refuse(provider, identity))) throw new GatewayCredentialError("unmanaged-login", provider, identity);
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
    loggedOut: (...a) => creds.loggedOut?.(...a) ?? Promise.resolve(false),
  } as GatewayDeps["creds"];
}

/**
 * The identities a pool app may use: the allowed members of the provider's swap pools, the same pool `ais swap` and the
 * limits page show. An account that no swap pool lists (one kept for its own threads, say) is never a pool app member,
 * even when the gateway holds its login for a pinned app. A registry with no swap pool record keeps every real login; one whose pools are all retired has no members. Retired
 * identities and swap pool folders (which hold no login of their own) are never members.
 */
export function appPoolMemberNames(file: IdentitiesFile): string[] {
  const real = file.identities.filter((i) => !isRetired(i) && !isSwapPool(i));
  // No swap pool record at all (active or retired) keeps every real login. A provider that has one, but no active pool, has no
  // members: a planned narrowing (a retired pool) must never widen the pool back to every login.
  if (!file.identities.some(isSwapPool)) return real.map((i) => i.name);
  const pools = poolsOf(file);
  const listed = new Set<string>();
  for (const pool of pools) {
    for (const name of allowedAccounts(pool)) listed.add(findIdentityByNameOrAlias(real, name)?.name ?? name);
  }
  return real.filter((i) => listed.has(i.name)).map((i) => i.name);
}

/** The names the gateway manages, in order. A name for a tool the check does not cover stays (the check answers true for it). */
export async function onlyManaged(provider: string, names: string[], isManaged: (tool: string, name: string) => Promise<boolean>): Promise<string[]> {
  const kept: string[] = [];
  for (const n of names) if (await isManaged(provider, n)) kept.push(n);
  return kept;
}

async function defaultPoolMembers(provider: GatewayProvider): Promise<string[]> {
  return appPoolMemberNames(await loadIdentitiesFile(TOOL_CONFIGS[provider].identitiesJsonPath));
}

/**
 * Whether a pool may offer an identity's login: the gateway must manage it. The refresh management check decides for the
 * tools it covers. OpenCode has no refresh, so an identity is managed only while the gateway holds a credential copy for it.
 * This gate runs even without a credential store, so a non-gateway identity is never a pool candidate.
 */
export function poolManagementCheck(
  creds: GatewayDeps["creds"],
  isManaged?: (tool: string, identity: string) => Promise<boolean>,
): (tool: string, identity: string) => Promise<boolean> {
  return async (tool, identity) => {
    if ((GATEWAY_REFRESH_TOOLS as readonly string[]).includes(tool)) return isManaged ? isManaged(tool, identity) : true;
    if (tool === "opencode") {
      const dead = creds.loggedOut ? await creds.loggedOut(tool, identity).catch(() => false) : false;
      return !dead;
    }
    return true;
  };
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
export function stampRefreshSuccess(refresh: RefreshFn, lastSuccess: Map<string, string>, now: () => Date, onSuccess?: (tool: string, identity: string, at: Date, result: IdentityGrantRefresh) => void): RefreshFn {
  return (async (tool, identity, opts) => {
    const r = await refresh(tool, identity, opts);
    if (r.outcome === "refreshed") {
      lastSuccess.set(`${tool}/${identity.name}`, now().toISOString());
      onSuccess?.(tool, identity.name, now(), r);
    }
    return r;
  }) as RefreshFn;
}

/** Typical access-token lifetimes, used to date a grant that records only its expiry. */
const ACCESS_TOKEN_LIFETIME_S: Record<string, number> = { kimi: 900, codex: 10 * 86_400 };

/** Access-token lifetime of a stored grant: expiry minus mint time, else the provider's typical lifetime. */
export function grantLifetimeSeconds(tool: string, grant: { expires_at?: number; minted_at?: number; access_token: string }, lastSuccessAt?: string): number | undefined {
  if (grant.expires_at !== undefined && grant.minted_at !== undefined && grant.expires_at > grant.minted_at) return grant.expires_at - grant.minted_at;
  const last = lastSuccessAt !== undefined ? Date.parse(lastSuccessAt) / 1000 : Number.NaN;
  if ((tool === "claude" || tool === "grok") && grant.expires_at !== undefined && Number.isFinite(last) && grant.expires_at > last) return grant.expires_at - last;
  const typical = ACCESS_TOKEN_LIFETIME_S[tool] ?? DEFAULT_ACCESS_TOKEN_LIFETIME_S[tool as RefreshableTool];
  return typical;
}

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

/** The idle keep-alive pass runs on this tick (milliseconds). */
const KEEP_ALIVE_TICK_MS = 600_000;
/** After a kimi renewal the guard could not take, the next try comes after this long (a 15 minute token cannot wait a full tick). */
const KIMI_RETRY_MS = 60_000;

/** Short-lived access tokens: the gateway renews these at half their lifetime. */
const RENEW_AHEAD_TOOLS: ReadonlySet<string> = new Set(["claude", "grok"]);

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
  /** Checked before each account: true ends the pass (the gateway is stopping and its stores are about to close). */
  shouldStop?: () => boolean;
  /** Renew claude and grok logins at this share of the access-token lifetime (default 0.5). Codex and kimi keep their own rules. */
  renewFraction?: number;
}): Promise<{ retryTools: string[] }> {
  // A grant diagnosed revoked is remembered by fingerprint and not POSTed again until a re-login mints a different one.
  const revoked = deps.revoked ?? new Map<string, string>();
  const lastSuccess = deps.lastSuccess ?? new Map<string, string>();
  const now = deps.now ?? (() => new Date());
  const held: Record<string, { lastSuccessAt?: string }> = {};
  /** Tools whose renewal the guard could not take now (database or lock busy): the caller may run them again soon. */
  const retryTools = new Set<string>();
  for (const tool of deps.tools ?? ["claude"]) {
    for (const account of await deps.accounts(tool).catch(() => [] as Identity[])) {
      if (deps.shouldStop?.()) break;
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
        const r = await deps.refresh(tool as RefreshableTool, account, {
          keepAlive: true,
          lastSuccessAt: lastSuccess.get(key) ?? null,
          ...(known ? { revokedFingerprint: known } : {}),
          ...(RENEW_AHEAD_TOOLS.has(tool) ? { renewFraction: deps.renewFraction ?? GATEWAY_RENEW_FRACTION } : {}),
          // kimi: renew on every tick, so the stored token (and the pool copies) never expires between two ticks.
          ...(tool === "kimi" ? { renewBelowSeconds: KIMI_RENEW_BELOW_S } : {}),
        });
        if (r.outcome === "skipped-revoked" && r.beforeFingerprint) revoked.set(key, r.beforeFingerprint);
        else revoked.delete(key);
        if (r.outcome === "refreshed") lastSuccess.set(key, now().toISOString());
        deps.metrics.keepAlive(tool, r.outcome);
      } catch (err) {
        if (err instanceof RefreshGuardRetryable) retryTools.add(tool);
        // Only a dead-grant OAuth code proves the login is gone; any other 400/401 is not enough (as in credentials.ts).
        if (err instanceof OAuthRefreshError && err.revoked && err.refreshFingerprint && err.oauthCode !== undefined && DEAD_REFRESH_CODES.has(err.oauthCode)) revoked.set(key, err.refreshFingerprint);
        deps.metrics.keepAlive(tool, err instanceof RefreshRefused && err.kind === "dead" ? "refused-dead" : "failed");
      }
      const last = lastSuccess.get(key);
      if (last) held[key] = { lastSuccessAt: last };
    }
  }
  await deps.onPass?.(held, now()).catch(() => undefined);
  return { retryTools: [...retryTools] };
}

/**
 * Files to push after a refresh: the grant paths, the labels the write-through lists, and the member store login when the
 * account has one (a refresh of an identity with no member copy makes it, and the grant paths name the identity's own folder).
 */
export async function refreshPushPaths(tool: RefreshableTool, identity: Identity, written: string[], grantPaths: (tool: RefreshableTool, identity: Identity) => Promise<string[]>): Promise<string[]> {
  const member = isMemberStoreTool(tool) && hasMemberCopy(tool, identity.name) ? [join(memberDir(tool, identity.name), memberLoginFile(tool))] : [];
  return [...new Set([...(await grantPaths(tool, identity)), ...written, ...member])];
}

export async function startGateway(opts: GatewayOptions, hooks: GatewayHooks = {}): Promise<RunningGateway> {
  if (opts.adminToken.length < MIN_ADMIN_TOKEN_LENGTH) throw new Error(`gateway: the admin token (AIS_GATEWAY_ADMIN_TOKEN) must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters`);
  if (opts.sessions) {
    if (opts.sessions.token.length < MIN_ADMIN_TOKEN_LENGTH) throw new Error(`gateway: the session ingest token (AIS_GATEWAY_SESSIONS_TOKEN) must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters`);
    if (opts.sessions.token === opts.adminToken) throw new Error("gateway: the session ingest token (AIS_GATEWAY_SESSIONS_TOKEN) must differ from the admin token");
  }
  startModelPriceRefresh();
  enableMemberStore(); // read each account's login from the gateway member store, not the local identity folders
  markGatewayOwnerProcess(); // this process alone refreshes gateway-managed logins
  const now = hooks.now ?? (() => new Date());
  const backoff = hooks.warmBackoff ?? { initialMs: 1_000, maxMs: 30_000 };
  const exit = hooks.exit ?? ((code: number) => process.exit(code));

  // One pool and one LISTEN connection for the whole process. Components borrow them and never close them.
  const sharedSql = getGatewaySql(opts.databaseUrl);
  const sharedListener = getGatewayListener(opts.databaseUrl);
  const inner = (hooks.openStore ?? ((url: string) => new PgGatewayStore(url, { sql: sharedSql, listener: sharedListener })))(opts.databaseUrl);
  const store = new CachedGatewayStore(inner);
  const publicHosts = hooks.publicHosts ?? publicHostsFromEnv();
  const ledger = new LedgerBuffer(store, hooks.ledger ?? { max: 50_000, flushMs: 2_000 });
  const metrics = new PrometheusMetrics({ ledgerDepth: () => ledger.depth, ledgerDropped: () => ledger.dropped });
  metrics.publicHostsConfigured(publicHosts.length);
  metrics.appNoticesUp = () => (store.listening ? 1 : 0);
  if (publicHosts.length === 0) console.warn("gateway: AIS_GATEWAY_PUBLIC_HOSTS is empty, so /metrics, /healthz, /readyz and /browser/pair answer on every host, including a public tunnel; set it to the public host names");
  const alerter = createAlerter(hooks.notify ?? stderrNotifier);
  const failedTokens = new Map<string, string>();
  const refreshBackend = hooks.refreshBackend ?? new PgRefreshBackend(opts.databaseUrl, undefined, sharedSql);
  // PostgreSQL credential store: this replica's HOME follows the store; refreshes pull and push under the account lock.
  const pgCreds = opts.credentialStore;
  const homeStore = pgCreds ? new PgHomeStore(opts.databaseUrl, pgCreds.key, undefined, undefined, { sql: sharedSql, listener: sharedListener }) : undefined;
  const mirror = homeStore ? new HomeMirror(homeStore, { ...(hooks.home ? { home: hooks.home } : {}), fileStore: pgCreds?.fileStore === true }) : undefined;
  const leader = pgCreds ? new PgLeader(opts.databaseUrl, hooks.leaderTryMs ?? 10_000) : undefined;
  // Session enrichment (off unless AIS_SESSIONS_ENRICH is set): runs on the leader only; without a leader election it runs here alone.
  // The modules load only when the flag is on: every `ais` process reads its imports at start.
  const sessionsEnrich = hooks.openStore || !sessionsEnrichEnabled(process.env) ? undefined : (await import("./sessions/enrich-setup.ts")).createSessionsEnrichment({ env: process.env, sql: sharedSql, isLeader: () => !leader || leader.isLeader() });
  if (sessionsEnrich) metrics.sections.push(sessionsEnrich.render);
  if (mirror) setLocalWriteHook(async (abs, kind, account) => mirror.push([abs], account, kind));
  const grantPaths = (tool: RefreshableTool, identity: Identity): Promise<string[]> => effectiveGrantPaths(tool, identity).catch(() => [] as string[]);
  const inflightRefreshes = new Set<Promise<unknown>>();
  /** Logins diagnosed dead, by "tool/name": the refresh-token fingerprint the provider rejected and its OAuth code. Cleared when a new login lands. */
  const deadLogins = new Map<string, { fingerprint: string; code: string }>();
  const markRevokedMarker = async (tool: string, name: string, code: string, rejected: string | undefined): Promise<void> => {
    if (memberStoreEnabled()) await recordLoginRevoked(tool, name, code, rejected).catch(() => undefined);
  };
  const guarded = guardRefresh(hooks.refreshImpl ?? refreshIdentityOAuthGrant, {
    backend: refreshBackend,
    metrics,
    ...(hooks.readGrant ? { readGrant: hooks.readGrant } : {}),
    // The gateway always has a database: a guard failure never refreshes (the file-lock fallback is for a gateway with no database).
    onDegraded: (account, why) => alerter.raise("refresh-guard-degraded", `${account.provider}/${account.identity}`, `the refresh guard is unavailable (${why}); the ${account.provider} login "${account.identity}" is not refreshed until the guard works again, and its current access token is served until it expires`),
    onDead: (account, { fingerprint, code, fresh }) => {
      const key = `${account.provider}/${account.identity}`;
      deadLogins.set(key, { fingerprint, code });
      metrics.loginState(account.provider, account.identity, { revoked: true });
      // Only the replica that received the dead answer counts, alerts and writes the marker. A refusal (fresh false) on any
      // other replica, after a restart or a leader change, adds nothing: one alert per dead answer.
      if (!fresh) return;
      metrics.deadGrant(account.provider, account.identity, code);
      alerter.raise("login-revoked", `${key}:${fingerprint}`, `the ${account.provider} login "${account.identity}" is dead: the provider answered ${code} and only a new login helps; the gateway sends no more refresh requests for it. Log back in with: ${loginCommand(account.provider as GatewayProvider, account.identity)}`);
      if (fingerprint) void markRevokedMarker(account.provider, account.identity, code, fingerprint);
    },
    onGrantSeen: (account, fingerprint) => {
      const key = `${account.provider}/${account.identity}`;
      const dead = deadLogins.get(key);
      if (!dead || dead.fingerprint === fingerprint) return;
      // A new login (a different refresh token) landed: the marker, the alert and the gauge clear.
      deadLogins.delete(key);
      alerter.recover("login-revoked", `${key}:${dead.fingerprint}`);
      metrics.loginState(account.provider, account.identity, { revoked: false });
      if (memberStoreEnabled()) void clearLoginRevoked(account.provider, account.identity).catch(() => undefined);
    },
    onInterrupted: (account, count) => {
      const key = `${account.provider}/${account.identity}`;
      if (count >= 2) alerter.raise("refresh-interrupted", key, `refreshes of the ${account.provider} login "${account.identity}" keep ending with an unknown outcome (${count} times); the token is retried, check the gateway and the provider`);
      else alerter.recover("refresh-interrupted", key);
    },
    onHealthy: (account) => alerter.recover("refresh-guard-degraded", `${account.provider}/${account.identity}`),
    ...(mirror
      ? {
          sync: {
            run: (account, fn) => mirror.withAccount(`${account.provider}/${account.identity}`, fn),
            pull: async (tool, identity) => mirror.pullAccount(`${tool}/${identity.name}`, await grantPaths(tool, identity)),
            push: async (tool, identity, written) => {
              const account = `${tool}/${identity.name}`;
              let first: unknown;
              try {
                await mirror.push(await refreshPushPaths(tool, identity, written, grantPaths), account, "login");
              } catch (err) {
                first = err;
              }
              // Whatever the listed paths missed (or a failed push left behind) goes too: every tracked file of the account that changed.
              await mirror.pushAccountDirty(account).catch((err) => {
                throw first ?? err;
              });
              alerter.recover("credential-store-write-failed", account);
            },
          },
          onStoreWriteFailed: (account) => alerter.raise("credential-store-write-failed", `${account.provider}/${account.identity}`, `the gateway could not write the ${account.provider} login "${account.identity}" to the credential store after a refresh; the new token only exists on this replica until it can (check the database)`),
        }
      : {}),
  });
  const instrumented = instrumentRefresh(guarded, { metrics, alerter, failed: failedTokens });
  /** The one guarded refresh: the credential cache and the keep-alive both go through it, and stop() waits for it. */
  /** Last successful refresh per "tool/name", stamped for every gateway refresh (keep-alive, 401 path, ensureUsable). */
  const lastSuccessAt = new Map<string, string>();
  const stamped = stampRefreshSuccess(instrumented, lastSuccessAt, now, (tool, name, at, result) => {
    metrics.refreshSucceededAt(tool, name, Math.floor(at.getTime() / 1000));
    if (result.expiresAt !== undefined) metrics.loginState(tool, name, { expiresAtSeconds: result.expiresAt, lifetimeSeconds: Math.max(0, result.expiresAt - Math.floor(at.getTime() / 1000)), revoked: false });
  });
  const managementCheck = hooks.isManaged ?? (pgCreds ? createManagementCheck() : undefined);
  /**
   * undefined: no gate (no credential store). true: managed, or the registry could not be read (only a successful read may mark a
   * login unmanaged, so an unreadable registry keeps the login refreshing as before, with an alert). false: unmanaged.
   */
  const isManaged = managementCheck
    ? async (tool: string, name: string): Promise<boolean> => {
        if (!(GATEWAY_REFRESH_TOOLS as readonly string[]).includes(tool)) return true;
        const managed = await managementCheck(tool, name).catch(() => undefined);
        if (managed === undefined) {
          alerter.raise("managed-check-unavailable", tool, `the gateway could not read the ${tool} identity registry to check which logins it manages; it keeps renewing logins as before until it can`);
          return true;
        }
        alerter.recover("managed-check-unavailable", tool);
        return managed;
      }
    : undefined;
  const unmanagedAlert = (tool: string, name: string): void => {
    metrics.refresh(tool, "unmanaged");
    console.info(JSON.stringify({ event: "refresh", provider: tool, identity: name, replica: process.env.HOSTNAME ?? "gateway", outcome: "unmanaged", expiresAt: null, code: null }));
    alerter.raise("login-unmanaged", `${tool}/${name}`, `the ${tool} login "${name}" is not managed by the gateway (it is not a member of a routed pool and has no gateway copy), so the gateway does not renew or serve it; route the identity through the gateway or stop using it in a gateway app`);
  };
  const refreshLogin = ((...a: Parameters<RefreshFn>) => {
    const [tool, identity] = a;
    // A swap pool folder holds no login of its own: its refresh goes through the member it names, which is checked there.
    if (isManaged && !identity.swapPool) {
      return isManaged(tool, identity.name).then((managed) => {
        if (managed) {
          alerter.recover("login-unmanaged", `${tool}/${identity.name}`);
          return refreshManaged(...a);
        }
        unmanagedAlert(tool, identity.name);
        return Promise.resolve<IdentityGrantRefresh>({ tool, identity: identity.name, outcome: "skipped-fresh", written: [], writeFailures: [], detail: "the gateway does not manage this login - not refreshed here" });
      });
    }
    return refreshManaged(...a);
  }) as RefreshFn;
  const refreshManaged = ((...a: Parameters<RefreshFn>) => {
    const p = stamped(...a);
    inflightRefreshes.add(p);
    const done = (): void => void inflightRefreshes.delete(p);
    p.then(done, done);
    return p;
  }) as RefreshFn;
  const baseCreds = hooks.creds ?? new CredentialCache({ refresh: refreshLogin });
  // Pinned apps and pools name identities: an unmanaged one is refused at use, with an alert and a count, never served until its token lapses.
  const creds = watchCredentialReads(
    baseCreds,
    alerter,
    failedTokens,
    isManaged
      ? async (provider, identity) => {
          const name = await canonical(provider, identity);
          if (await isManaged(provider, name)) return false;
          unmanagedAlert(provider, name);
          return true;
        }
      : undefined,
  );
  const canonical = hooks.canonical ?? canonicalResolver();
  // No startup parameters here: the database pooler refuses them ("unsupported startup parameter: statement_timeout").
  // The usage source bounds every shared call itself.
  const readingsSql = hooks.usageReadings || hooks.ping || hooks.openStore ? undefined : sharedSql;
  const sharedReadings: UsageReadings = hooks.usageReadings ?? (readingsSql ? new PgUsageReadings(readingsSql) : new MemoryUsageReadings());
  const usage = createUsageSource({
    fetchUsage: hooks.fetchUsage ?? withOpencodeUsage(creds, fetchPoolUsage),
    shared: sharedReadings,
    onRead: (provider, source) => metrics.usageRead(provider, source),
    onSharedError: () => metrics.usageSharedError(),
  });
  // An unrestricted pool app uses real logins only, and of those only the ones the gateway manages. The management gate
  // always runs (even without a credential store), so a non-gateway identity is never a candidate.
  const poolManaged = poolManagementCheck(creds, isManaged);
  const poolMembers =
    hooks.poolMembers ??
    (async (provider: GatewayProvider): Promise<string[]> => onlyManaged(provider, await defaultPoolMembers(provider), poolManaged));
  const browserPoolMembers = hooks.browserPoolMembers ?? defaultBrowserPoolMembers;
  const browserIdentityExists = hooks.browserIdentityExists ?? defaultBrowserIdentityExists;

  // Side-panel chat is on when the cluster env is complete, or when a test gives a pod transport.
  let chatEnv: ChatEnvConfig | undefined;
  if (!hooks.chatTransport) {
    try {
      chatEnv = chatConfigFromEnv(process.env);
    } catch (err) {
      console.warn(`gateway: side-panel chat is off (${describe(err)})`);
    }
  }
  // A test transport or test Kubernetes API also selects the in-memory chat store and bus.
  const chatTesting = hooks.chatTransport !== undefined || hooks.chatKubeApi !== undefined;
  const chatOn = hooks.chatTransport !== undefined || chatEnv !== undefined;
  let chatBroker: ChatBroker | undefined;
  // Starred models. Built with the chat stack, so the admin routes read it late.
  let favourites: FavouritesService | undefined;
  // The hub reads `onChat` and `onAttach` from this same object when a frame arrives. The chat stack sets them after it is built (below),
  // so a gateway with chat off or failed answers every chat frame with `chat.reject` unavailable.
  const hubOpts: HubOptions = { authToken: async (t) => {
      const b = await authBrowserToken(store, t);
      if (b) await store.touchBrowserBinding(b.name, new Date().toISOString()).catch(() => {});
      return b;
    },
    metrics };
  const hub = new BrowserHub(hubOpts);
  // Several replicas: a call for a browser whose socket another replica holds is forwarded there (browser/cluster.ts).
  const relay = opts.replicaUrl
    ? new ClusterBrowserHub({ hub, databaseUrl: opts.databaseUrl, replicaId: `${process.env.HOSTNAME ?? "gateway"}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`, replicaUrl: opts.replicaUrl, adminToken: opts.adminToken, sql: sharedSql, listener: sharedListener })
    : undefined;
  const browser = relay ?? hub;
  metrics.browserGauges = { connected: () => hub.connected().length, sessions: () => hub.activeSessions() };

  /** Aborts when the gateway stops: requests held for a full pool end at once, so they never block the drain. */
  const drainCtrl = new AbortController();
  const appDeps: GatewayDeps = {
    drainSignal: drainCtrl.signal,
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
    browserHub: browser,
    ...(chatOn ? { chat: { principal: async (token: string) => chatBroker?.principal(token) } } : {}),
    fetch: hooks.fetch ?? fetch,
    now,
    metrics: recoverOnSuccess(metrics, alerter),
  };
  const proxy = createGatewayApp(appDeps);
  /** The active app of one of the given providers that a gateway token belongs to, for the CONNECT proxy. */
  const appForToken = async (token: string, providers: GatewayProvider[]): Promise<{ name: string; provider: GatewayProvider; style: ApiStyle } | undefined> => {
    if (!warmed || !parseToken(token)) return undefined;
    for (const app of await store.listApps()) {
      if (app.state === "active" && providers.includes(app.provider) && (await verifyToken(store, app.name, token, now()))) return { name: app.name, provider: app.provider, style: app.style };
    }
    return undefined;
  };
  // The renewal list must not look complete when a registry could not be read: the strict list throws, and the admin route answers 503.
  const renewalAccounts = hooks.keepAliveAccounts ?? ((tool: string) => listGatewayManagedAccountsStrict(undefined, tool));
  const admin = createAdminApp({
    store,
    readStore: inner,
    adminToken: opts.adminToken,
    now,
    renewal: () => buildRenewalReport({ tools: GATEWAY_REFRESH_TOOLS, accounts: renewalAccounts, summary: () => refreshBackend.summary?.() ?? Promise.resolve([]), isRevoked: (tool, name, fingerprint) => fingerprint !== undefined && deadLogins.get(`${tool}/${name}`)?.fingerprint === fingerprint, now }),
    ...(homeStore
      ? {
          // Host credential sync over HTTP (admin-store.ts): the host never opens a database connection of its own.
          storeAdmin: {
            homeStore,
            journal: async (provider: string, identity: string, oldFp: string) => {
              const lock = await refreshBackend.acquire({ provider, identity }, 5_000);
              try {
                return await lock.findByOldFp(oldFp);
              } finally {
                await lock.release();
              }
            },
          },
        }
      : {}),
    identityState: hooks.identityState ?? defaultIdentityState,
    // The same cached usage reads the proxy selects on: the console Limits page shows them through GET /limits.
    usageFor: hooks.usageFor ?? (async (provider, identity) => usage.get(provider, await canonical(provider, identity))),
    poolMembers,
    canonical,
    // The member's stored credential spends the grant; never refreshed here (the keep-alive owns rotation).
    spendReset: hooks.spendReset ?? (async (identity, grantId) => {
      const out = await useClaudeReset(identity, grantId, { noRefresh: true });
      void usage.refreshNow("claude", identity).catch(() => {});
      return out;
    }),
    browserPoolMembers,
    browserIdentityExists,
    browserHub: browser,
    favourites: () => favourites,
    ...(opts.sessions
      ? {
          sessions: {
            token: opts.sessions.token,
            store: hooks.sessionStore ?? new SessionStore(opts.databaseUrl, { sql: sharedSql }),
            ...(opts.sessions.flushGapSeconds !== undefined ? { flushGapSeconds: opts.sessions.flushGapSeconds } : {}),
            now,
            metrics,
            ...(hooks.sessionObjectExists ? { objectExists: hooks.sessionObjectExists } : {}),
          },
        }
      : {}),
    metrics,
    onBindingRevoked: async (binding, before) => {
      await chatBroker?.closeBinding(binding, before === undefined ? {} : { before }).catch(() => metrics.chatError("close_binding"));
    },
    ...(hooks.overlapMs !== undefined ? { overlapMs: hooks.overlapMs } : {}),
  });

  let warmed = false;
  let draining = false;
  // Readiness also waits for the usage cache, so GET /limits never answers "unavailable" right after a rollout.
  const usageGate = createWarmGate({ timeoutMs: hooks.usageWarmTimeoutMs ?? positiveIntEnv("AIS_GATEWAY_USAGE_WARM_TIMEOUT_MS", 90_000) });
  let usageWarmupTimeouts = 0;
  let usageWarmupCold = 0;
  const isReady = (): boolean => warmed && !draining && usageGate.isReady();
  metrics.readiness = () => ({ ready: isReady(), state: usageGate.state() });
  metrics.usageWarmup = () => ({ seconds: (usageGate.result()?.durationMs ?? 0) / 1000, timeouts: usageWarmupTimeouts, cold: usageWarmupCold });
  let storeSynced = false;
  let relayStarted = false;
  let importTimer: ReturnType<typeof setInterval> | undefined;
  /** Last time the database answered the ping (ms); reported by /readyz, never a reason to drop out of the rotation once warm. */
  let dbOkAt = 0;
  let dbDownLogged = false;
  const pingMs = hooks.pingMs ?? 5_000;
  const pingSql = hooks.ping || hooks.openStore ? undefined : sharedSql;
  const ping = hooks.ping ?? (pingSql ? async () => void (await pingSql`SELECT 1`) : async () => undefined);
  const checkDb = async (): Promise<void> => {
    try {
      await bounded(ping(), Math.min(2_000, pingMs), "database ping");
      dbOkAt = Date.now();
      if (dbDownLogged) console.info("gateway: database reachable again");
      dbDownLogged = false;
    } catch (err) {
      if (dbOkAt > 0 && !dbOk() && !dbDownLogged) {
        dbDownLogged = true;
        console.warn(`gateway: database unreachable (${errorTag(err)}); still ready, serving from loaded logins`);
      }
    }
  };
  const dbOk = (): boolean => Date.now() - dbOkAt <= pingMs * 3;
  const pingTimer = setInterval(() => void checkDb(), pingMs);
  pingTimer.unref?.();
  void checkDb();
  /** The host home the registries were written on, so their paths translate on any node (unless the deployment set it). */
  async function adoptStoreMeta(): Promise<void> {
    if (!mirror || process.env.AIS_HOST_HOME?.trim()) return;
    try {
      const meta = JSON.parse(await readFile(mirror.abs(STORE_META_PATH), "utf8")) as { hostHome?: unknown };
      if (typeof meta.hostHome === "string" && meta.hostHome.startsWith("/")) process.env.AIS_HOST_HOME = meta.hostHome;
    } catch {
      // no import yet: paths are used as they are
    }
  }
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
      const listed = app.target.kind === "pin" ? [app.target.identity] : [];
      for (const identity of listed) {
        try {
          await creds.get(app.provider, identity);
        } catch (err) {
          metrics.credentialUnreadable(app.name, app.provider, await canonical(app.provider, identity));
          console.warn(`gateway: app "${app.name}" cannot read ${app.provider} identity "${identity}" (${describe(err)}); its requests will fail`);
        }
        await prefill(app.provider, identity);
      }
      // A pool app may use any current member.
      if (app.target.kind === "pool") {
        for (const member of await poolMembers(app.provider).catch(() => [] as string[])) await prefill(app.provider, member);
      }
    }
  }

  /**
   * Fills the usage cache for exactly the identities GET /limits lists, in parallel. The timeout covers reading the set too.
   * The set comes from the warm cached store. GET /limits reads the database, which agrees for active pinned apps
   * (the cache follows the database by change notices and a timed refresh).
   */
  async function warmUsage(): Promise<void> {
    const keys = async (): Promise<string[]> => {
      if (hooks.usageFor) return [];
      const apps = await store.listApps();
      const out: string[] = [];
      for (const provider of LIMITS_PROVIDERS) {
        for (const identity of await limitsIdentities({ poolMembers, canonical }, apps, provider)) out.push(`${provider}/${identity}`);
      }
      return out;
    };
    // Seed from the readings the other replicas took, so a fresh replica shows figures even when upstream answers 429. A failure skips it.
    const seedMs = Math.max(1, Math.min(hooks.usageWarmTimeoutMs ?? 90_000, 5_000));
    await bounded(sharedReadings.loadAll(), seedMs, "shared usage readings").then((rows) => usage.seed(rows), () => metrics.usageSharedError());
    const result = await usageGate.run(keys, (key) => {
      const slash = key.indexOf("/");
      return usage.prefill(key.slice(0, slash) as GatewayProvider, key.slice(slash + 1));
    });
    // A drain ends the run early. That is neither a timeout nor a reason to warn.
    if (result.outcome === "draining") return;
    if (result.outcome === "timeout") {
      usageWarmupTimeouts += 1;
      usageWarmupCold = result.cold.length;
      console.warn(`gateway: usage cache still cold after ${result.durationMs} ms for ${result.cold.join(", ")}; ready anyway`);
    } else {
      console.info(`gateway: usage cache warm in ${result.durationMs} ms, ready for traffic`);
    }
  }

  /** Retries with backoff until warm: a database that is down at start leaves the gateway unready, never crashed. */
  async function warmUp(): Promise<void> {
    let delay = backoff.initialMs;
    while (!draining) {
      let stage = "migrate";
      try {
        await (hooks.migrate ?? migrate)(opts.databaseUrl);
        // The tables exist now. start() does nothing when the loop runs already (this block can run again after a failed warm-up).
        if (!draining) sessionsEnrich?.enricher.start();
        if (mirror && homeStore && !storeSynced) {
          if (pgCreds?.importOnStart && pgCreds.fileStore) {
            stage = "credential store import";
            const r = await importHome(homeStore, { home: mirror.home, lock: refreshBackend });
            console.info(`gateway: credential store import: ${r.added.length} added, ${r.updated.length} updated, ${r.unchanged.length} unchanged, ${r.skipped.length} kept`);
          }
          stage = "credential store";
          await mirror.pullAll();
          await adoptStoreMeta();
          await seedFromHeartbeat();
          await mirror.start(hooks.storePollMs ?? 5_000);
          leader?.start();
          if (pgCreds?.fileStore) {
            // New host files (a login added on the host) are picked up by re-running the import now and then.
            importTimer = setInterval(() => {
              if (!draining) void importHome(homeStore, { home: mirror.home, lock: refreshBackend }).catch(() => undefined);
            }, 5 * 60_000);
            importTimer.unref?.();
          }
          storeSynced = true;
        }
        if (relay && !relayStarted) {
          relayStarted = true;
          await relay.start();
        }
        stage = "app cache";
        await store.warm();
        if (draining) return;
        warmed = true;
        // Starts before the listener below, so the timeout covers every step after the store is warm.
        void warmUsage().catch(() => undefined);
        void gaugeTick();
        pruneJournal();
        store.startRefresh(hooks.refreshIntervalMs ?? 15_000);
        // Other replicas' changes (a revoke above all) arrive at once; the timed refresh stays as the fallback.
        await store.startListening().catch((err) => console.warn(`gateway: app change notices unavailable (${describe(err)}); the ${(hooks.refreshIntervalMs ?? 15_000) / 1000} s refresh still applies`));
        console.info("gateway: store warm, usage cache warm-up started");
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
      // A call with an upload (up to 10 MiB of files, as base64) waits in the send queue while the browser reads it.
      backpressureLimit: 64 * 1024 * 1024,
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
    if (path === "/readyz") {
      if (draining) return new Response("draining\n", { status: 503 });
      if (!warmed) return new Response("warming\n", { status: 503 });
      if (!usageGate.isReady()) return new Response("warming usage cache\n", { status: 503 });
      // A warm replica serves from its loaded logins; ledger rows queue and the store sync retries until the database is back.
      // Taking it out of the rotation would leave no gateway at all while the database primary is down.
      return new Response(dbOk() ? "ready\n" : "ready, database unreachable\n");
    }
    if (path === "/metrics") return new Response(metrics.render(), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" } });
    if (!warmed) return providerError(await styleForPath({ store }, path), 503, "gateway is starting");
    srv.timeout(req, 0); // A long generation is not idle.
    return proxy.fetch(req, { ip: srv.requestIP(req)?.address });
  }
  const adminServer = Bun.serve({
    hostname: hooks.host ?? "0.0.0.0",
    port: opts.adminPort,
    // The store long poll (/store/wait) outlasts Bun's 10 s idle timeout: its request timeout is switched off.
    fetch: withStoreWaitTimeout((req) => (relay && req.method === "POST" && new URL(req.url).pathname === RELAY_PATH ? relay.handleRelay(req) : admin.fetch(req))),
  });

  const checkLedger = watchLedger(ledger, alerter);
  const alertTimer = setInterval(checkLedger, hooks.alertCheckMs ?? 5_000);
  alertTimer.unref?.();
  const revokedGrants = new Map<string, string>();
  // Seeded from the previous heartbeat so a restart does not rotate every codex and kimi login again at once.
  // With the credential store the heartbeat arrives with the first pull, so the seed runs then.
  async function seedFromHeartbeat(): Promise<void> {
    if (hooks.noHeartbeat) return;
    const prior = await readHeartbeat();
    for (const [k, v] of Object.entries(prior?.held ?? {})) {
      const seeded = v.lastSuccessAt && v.lastSuccessAt > now().toISOString() ? now().toISOString() : v.lastSuccessAt;
      if (seeded && !(lastSuccessAt.get(k) && lastSuccessAt.get(k)! >= seeded)) lastSuccessAt.set(k, seeded);
    }
  }
  if (!mirror) await seedFromHeartbeat();
  /** Dead refresh-token fingerprints the shared journal shows (newer than the account's last success), per "tool/name". Replaced on each seed. */
  let journalDead = new Map<string, string>();
  /**
   * Seeds the last-success gauges, the last-success times and the journal's dead logins from the shared journal, so a restarted
   * replica reports the cluster-wide truth. Runs at start and on every gauge tick; a failure only skips the seed.
   */
  async function seedFromJournal(): Promise<void> {
    try {
      const dead = new Map<string, string>();
      for (const row of (await refreshBackend.summary?.()) ?? []) {
        const key = `${row.provider}/${row.identity}`;
        if (row.refreshed) {
          metrics.refreshSucceededAt(row.provider, row.identity, Math.floor(Date.parse(row.refreshed.ts) / 1000));
          // The observed lifetime of the stored grant and the daily rules of codex and kimi use the cluster's last refresh.
          const iso = new Date(Math.min(Date.parse(row.refreshed.ts), now().getTime())).toISOString();
          const have = lastSuccessAt.get(key);
          if (!have || have < iso) lastSuccessAt.set(key, iso);
        }
        if (row.error?.outcome === "dead" && (!row.refreshed || row.error.id > row.refreshed.id)) dead.set(key, row.error.oldFp);
      }
      journalDead = dead;
    } catch {
      // the journal is unreadable now: the gauges fill from this replica's own refreshes until the next tick
    }
  }
  const readGrantForGauges = hooks.readGrant ?? (async (tool: RefreshableTool, account: Identity) => (await readEffectiveGrant(tool, account).catch(() => undefined))?.grant);
  /** Re-evaluates the gauges of one login from its stored grant (a new sign-in clears the revoked state on every replica). */
  async function observeLogin(tool: string, account: Identity): Promise<void> {
    const grant = await readGrantForGauges(tool as RefreshableTool, account).catch(() => undefined);
    if (!grant) return;
    const key = `${tool}/${account.name}`;
    const fingerprint = grant.refresh_token !== undefined ? grantFingerprint(grant) : undefined;
    const dead = deadLogins.get(key);
    if (dead && fingerprint !== undefined && dead.fingerprint !== fingerprint) {
      // A new login landed (here or on another replica): the alert and the marker clear.
      deadLogins.delete(key);
      alerter.recover("login-revoked", `${key}:${dead.fingerprint}`);
      if (memberStoreEnabled()) void clearLoginRevoked(tool, account.name).catch(() => undefined);
    }
    const nowDead = deadLogins.get(key)?.fingerprint ?? journalDead.get(key);
    const lifetime = grantLifetimeSeconds(tool, grant, lastSuccessAt.get(key));
    metrics.loginState(tool, account.name, {
      ...(grant.expires_at !== undefined ? { expiresAtSeconds: grant.expires_at } : {}),
      ...(lifetime !== undefined ? { lifetimeSeconds: lifetime } : {}),
      revoked: nowDead !== undefined && fingerprint !== undefined && nowDead === fingerprint,
    });
  }
  /** Pool members below the weekly-use threshold, per provider with a pool: the figure behind the low-headroom alert. */
  async function poolHeadroomTick(): Promise<void> {
    for (const provider of POOL_HEADROOM_PROVIDERS) {
      const members = await appDeps.poolMembers(provider).catch(() => undefined);
      if (members === undefined || members.length === 0) {
        // No member, or the read failed: the gauge reads 0, never the figure of an earlier tick.
        metrics.poolHeadroom(provider, POOL_HEADROOM_PERCENT, 0, 0);
        continue;
      }
      let reading = 0;
      let room = 0;
      for (const m of members) {
        const w = weeklyUtilisation(await appDeps.usageFor(provider, m).catch(() => undefined));
        if (w === undefined) continue;
        reading++;
        if (w < POOL_HEADROOM_PERCENT) room++;
      }
      metrics.poolHeadroom(provider, POOL_HEADROOM_PERCENT, room, reading);
    }
  }
  /** Every replica, every tick: seed from the journal, then re-read every managed login's gauges. */
  let gaugeRunning = false;
  async function gaugeTick(): Promise<void> {
    if (gaugeRunning || draining || !warmed) return;
    gaugeRunning = true;
    try {
      await seedFromJournal();
      if (usageGate.isReady()) await poolHeadroomTick().catch(() => undefined); // never before the warm-up: a read would start a fetch of its own
      for (const tool of GATEWAY_REFRESH_TOOLS) {
        for (const account of await renewalAccounts(tool).catch(() => [] as Identity[])) {
          if (draining) return;
          await observeLogin(tool, account).catch(() => undefined);
        }
      }
    } finally {
      gaugeRunning = false;
    }
  }
  const gaugeTimer = setInterval(() => void gaugeTick(), hooks.gaugeMs ?? 60_000);
  gaugeTimer.unref?.();
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
  // With the credential store the ali console session is not renewed here (its browser profile lives on the host): the host
  // and the console keep renewing it, and the heartbeat never claims it.
  const aliList = hooks.aliAccounts ?? (hooks.noHeartbeat || pgCreds ? undefined : listAliAccounts);
  const keepAliveDeps = (tools: readonly string[]) => ({
    refresh: refreshLogin,
    accounts: hooks.keepAliveAccounts ?? ((tool: string) => listGatewayManagedAccounts(undefined, tool)),
    tools,
    lastSuccess: lastSuccessAt,
    now,
    mintedAt: grantMintedAt,
    shouldStop: () => draining,
    metrics,
    revoked: revokedGrants,
  });
  /** A kimi token lives 15 minutes: when the guard was busy at the tick, the next try comes soon, not a full tick later. */
  let kimiRetryTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleKimiRetry = (): void => {
    if (kimiRetryTimer || draining) return;
    kimiRetryTimer = setTimeout(() => {
      kimiRetryTimer = undefined;
      if (keepAliveRunning || draining || !warmed || (leader && !leader.isLeader())) return;
      keepAliveRunning = true;
      keepAliveRun = keepAliveOnce(keepAliveDeps(["kimi"]))
        .then((r) => {
          if (r.retryTools.includes("kimi")) scheduleKimiRetry();
        })
        .catch(() => undefined)
        .finally(() => {
          keepAliveRunning = false;
        });
    }, hooks.kimiRetryMs ?? KIMI_RETRY_MS);
    kimiRetryTimer.unref?.();
  };
  const keepAliveTimer = setInterval(() => {
    if (keepAliveRunning || draining || !warmed) return;
    // Several replicas: only the leader runs the idle pass and writes the heartbeat (on-demand refreshes run everywhere).
    if (leader && !leader.isLeader()) return;
    keepAliveRunning = true;
    keepAliveRun = keepAliveOnce({
      ...keepAliveDeps(GATEWAY_REFRESH_TOOLS),
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
    })
      .then(async (r) => {
        if (r.retryTools.includes("kimi")) scheduleKimiRetry();
        if (aliList && selfTestEnabled && !aliSetupOk && !aliAbort.signal.aborted) aliSetupOk = (await aliSetupSelfTest(alerter, { ...(hooks.aliSetup ?? {}), accounts: aliList }).catch(() => ["error"])).length === 0;
      })
      .then(() => (aliList ? aliSessionOnce({ accounts: aliList, ...(hooks.aliRefresh ? { refresh: hooks.aliRefresh } : {}), metrics, alerter, lastSuccess: lastSuccessAt, now, signal: aliAbort.signal, loginPageSkips: aliSkips }) : undefined))
      .finally(() => {
        keepAliveRunning = false;
      });
  }, hooks.keepAliveMs ?? KEEP_ALIVE_TICK_MS);
  keepAliveTimer.unref?.();
  // Side-panel chat: broker, frames, catalogue. Built after the server, because a test's MCP URL needs the bound port.
  let chat: { broker: ChatBroker; frames: ChatFrames; store: ChatStore } | undefined;
  if (chatOn) {
    try {
      const testing = chatTesting;
      const transport =
        hooks.chatTransport ??
        (() => {
          const cfg = chatEnv as ChatEnvConfig;
          const api =
            hooks.chatKubeApi ??
            (() => {
              const kube = inClusterKube(process.env, (p) => readFileSync(p, "utf8"));
              return new HttpKubeApi({ baseUrl: kube.baseUrl, token: kube.token, ca: kube.ca, env: cfg.kube });
            })();
          return new KubePodTransport({ api, env: cfg.kube });
        })();
      const chatStore: ChatStore = testing ? (hooks.chatStore ?? new MemoryChatStore()) : new PgChatStore(opts.databaseUrl, { sql: sharedSql });
      const bus: ChatBus = testing ? (hooks.chatBus ?? new MemoryChatBus()) : new PgChatBus(sharedSql, sharedListener);
      const mcpUrl = chatEnv?.mcpUrl ?? `http://127.0.0.1:${server.port}/browser/mcp`;
      const replicaId = `${process.env.HOSTNAME ?? "gateway"}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
      const identityOf = async (binding: string): Promise<string | undefined> => {
        const b = await store.getBrowserBinding(binding);
        if (!b || b.state !== "active") return undefined;
        return b.target.kind === "identity" ? b.target.identity : b.target.pool;
      };
      const bindingSince = async (binding: string): Promise<number | undefined> => {
        const b = await store.getBrowserBinding(binding);
        if (!b || b.state !== "active") return undefined;
        const t = Date.parse(b.createdAt);
        return Number.isNaN(t) ? 0 : t;
      };
      const favs = new FavouritesService({ store: testing ? (hooks.favouriteStore ?? new MemoryFavouriteStore()) : new PgFavouriteStore(opts.databaseUrl, { sql: sharedSql }), bus, hub, metrics, pools: () => (catalogRef ? catalogRef.pools() : Promise.reject(new Error("the catalogue is not ready"))) });
      let frames: ChatFrames | undefined;
      let catalogRef: ChatCatalog | undefined;
      const broker = new ChatBroker({
        store: chatStore,
        transport,
        mcpUrl,
        tokenKey: chatTokenKey(opts.adminToken),
        replicaId,
        metrics,
        now: Date.now,
        log: (line) => console.info(line),
        idleMs: chatIdleMsFromEnv(process.env),
        ...(chatEnv ? { startTimeoutMs: chatEnv.startTimeoutMs } : {}),
        bus,
        publish: (chatId) => void frames?.poke(chatId),
        rejectChat: (chatId, code, message) => frames?.rejectChat(chatId, code, message),
        watchedChats: () => frames?.watchedChats() ?? [],
        identityOf,
        bindingSince,
        checkSelection: (provider, identity) => catalogRef?.check(provider, identity) ?? Promise.resolve("ok"),
        endBrowserSession: async (binding, sessionId) => {
          const identity = (await identityOf(binding)) ?? "chat";
          await browser.call(binding, { id: crypto.randomUUID(), session: { id: sessionId, identity, label: "", chat: true }, tool: SESSION_END_TOOL, args: {} }, 5_000).catch(() => undefined);
        },
      });
      const catalog = new ChatCatalog({
        transport,
        appFor: async (_provider, _identity, appName) => (appName ? store.getApp(appName) : undefined),
        models: (a) => listAppModels(a, appDeps, AbortSignal.timeout(8_000)),
        isPool: async (name) => (await browserPoolMembers(name)) !== undefined,
      });
      catalogRef = catalog;
      frames = new ChatFrames({ broker, store: chatStore, bus, catalog, hub, bindingSince, maxPerWindow: MAX_CHATS_PER_WINDOW, maxLive: chatEnv?.maxLive ?? CHAT_MAX_DEFAULT, metrics, favourites: favs });
      const live = frames;
      chatBroker = broker;
      chat = { broker, frames: live, store: chatStore };
      // The bus needs the database. A database that is down at boot must not turn chat off, so a failed start tries again with a growing wait.
      // Chat frames get `chat.reject` unavailable until the start worked: only then the hub gets its chat handlers.
      let brokerStarted = false;
      let framesStarted = false;
      let tries = 0;
      /** A start that ends after stop() must leave nothing running: it undoes its own listeners. */
      let favsStarted = false;
      const abandon = async (): Promise<void> => {
        await favs.stop().catch(() => undefined);
        await live.stop().catch(() => undefined);
        await broker.dispose().catch(() => undefined);
      };
      const startChat = async (): Promise<void> => {
        if (draining) return;
        try {
          if (!brokerStarted) {
            await broker.start();
            brokerStarted = true;
            if (draining) return abandon();
          }
          if (!framesStarted) {
            await live.start();
            framesStarted = true;
            if (draining) return abandon();
          }
          if (!favsStarted) {
            await favs.start();
            favsStarted = true;
            favourites = favs;
            if (draining) return abandon();
          }
          hubOpts.onChat = (b, m, r) => live.handle(b, m, r);
          hubOpts.onAttach = (b) => live.onAttach(b);
          // Panels that attached before the start worked got no list: send it now, as onAttach does.
          for (const b of hub.connected()) void live.onAttach(b).catch(() => undefined);
        } catch (err) {
          if (draining) return abandon();
          metrics.chatError("other");
          const wait = Math.min((hooks.warmBackoff?.initialMs ?? 5_000) * 2 ** tries, hooks.warmBackoff?.maxMs ?? 60_000);
          tries += 1;
          console.warn(`gateway: side-panel chat could not listen yet (${describe(err)}); retrying in ${wait} ms`);
          setTimeout(() => void startChat(), wait).unref?.();
        }
      };
      const first = startChat();
      if (testing) await first;
      metrics.chatGauges = { active: () => broker.active() };
    } catch (err) {
      console.warn(`gateway: side-panel chat is off (${describe(err)})`);
    }
  }
  // Refresh-journal retention: old resolved rows go, the newest per account and any rotated-out evidence stay.
  const pruneJournal = (): void => void Promise.resolve(refreshBackend.prune?.(JOURNAL_RETENTION_MS)).catch(() => undefined);
  const retryChatCleanup = async (): Promise<void> => {
    const bindings = (await store.listBrowserBindings()).filter((b) => b.state === "active").map((b) => ({ name: b.name, since: Date.parse(b.createdAt) })).filter((b) => !Number.isNaN(b.since));
    await chat?.broker.retryStaleChats(bindings);
  };
  const pruneTimer = setInterval(() => {
    if (!warmed || draining) return;
    pruneJournal();
    if (chat) void chat.store.pruneClosed(Date.now() - CHAT_RETENTION_MS).catch(() => metrics.chatError("store"));
    // A chat that never got a pod (or lost it) and has no live lease must not stay listed for ever. It is too old to start again anyway.
    // The rows are gone, so end any pod that still runs for them. Best effort: the pod also ends with its own idle sweep.
    // The same tick retries the clean-up of reused names, in case the clean-ups at revoke and approve both failed.
    if (chat) void retryChatCleanup().catch(() => metrics.chatError("close_binding"));
    if (chat) {
      const { broker, store: chatRows } = chat;
      void chatRows.pruneIdle(Date.now() - CHAT_MAX_AGE_MS).then((ids) => broker.stopPods(ids)).catch(() => metrics.chatError("store"));
    }
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
      drainCtrl.abort();
      // The chat drain starts at once: new prompts are refused and asks end as cancelled. Turns in flight finish. It is awaited below, after the servers stop.
      const chatDrain = chat?.broker.drain().catch(() => undefined);
      usageGate.drain();
      hub.closeAll(1012);
      wake?.();
      clearInterval(alertTimer);
      clearInterval(keepAliveTimer);
      clearInterval(gaugeTimer);
      clearInterval(pruneTimer);
      clearInterval(pingTimer);
      if (importTimer) clearInterval(importTimer);
      store.stop();
      // Bun's stop(false) refuses new connections and resolves once active requests are done.
      await Promise.all([server.stop(false), adminServer.stop(false), connectProxy?.stop(false)]);
      // Refreshes and the keep-alive in flight finish (or fail) before the backend that guards them goes away.
      // A browser renewal is abandoned at once and the pass given a short ceiling, so the ledger below is always flushed inside the grace period.
      aliAbort.abort();
      await Promise.allSettled([...inflightRefreshes]);
      await Promise.race([Promise.allSettled([keepAliveRun]), new Promise<void>((r) => setTimeout(r, hooks.stopCeilingMs ?? 10_000).unref?.())]);
      // A keep-alive account that was already past its stop check may have started a refresh meanwhile: wait for it too.
      await Promise.allSettled([...inflightRefreshes]);
      // The ledger flush, the relay and the leader lock do not wait for chat turns: a long turn must not hold them until the kill ceiling.
      await ledger.close();
      await relay?.stop().catch(() => undefined);
      await sessionsEnrich?.enricher.stop().catch(() => undefined);
      await leader?.stop().catch(() => undefined);
      // The chat drain needs only the shared SQL pool, the listener and the chat store, which stay open until the end.
      await chatDrain;
      await chat?.frames.stop().catch(() => undefined);
      await chat?.broker.dispose().catch(() => undefined);
      await mirror?.stop().catch(() => undefined);
      if (mirror) setLocalWriteHook(undefined);
      // Last pushes (a heartbeat written during the pass) need the store open until here.
      await homeStore?.close().catch(() => undefined);
      if (readingsSql) await bounded(usage.idle(), 2_000, "usage reads").catch(() => undefined);
      await inner.close?.();
      await refreshBackend.close?.();
      // The shared pool and listener close once, after every component that used them.
      await releaseGatewayListener(opts.databaseUrl);
      await releaseGatewaySql(opts.databaseUrl);
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
    ready: isReady,
  };
}
