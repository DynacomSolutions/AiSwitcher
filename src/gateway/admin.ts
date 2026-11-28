import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { AppRevokedError, revokedMessage, type GatewayStore } from "./store.ts";
import { registerBrowserAdmin } from "./browser/admin.ts";
import { registerStoreAdmin, type StoreAdminDeps } from "./admin-store.ts";
import { registerFavouritesAdmin } from "./admin-favourites.ts";
import { registerSessionsAdmin, type SessionsAdminDeps } from "./admin-sessions.ts";
import { favouritesToken } from "./favourites-token.ts";
import { instanceAppToken, instanceTokenExpiry, instanceTokenWindow, instancesToken } from "./instances-token.ts";
import { instanceIdsForApp } from "../t3/instances/plan.ts";
import type { FavouritesService } from "./chat/favourites.ts";
import type { GatewayMetrics } from "./metrics.ts";
import type { LoginRenewal } from "./renewal.ts";
import { adapterFor } from "./providers/index.ts";
import { generateToken, INSTANCE_PREFIX_MARK, isInstancePrefix } from "./tokens.ts";
import { foldSessionUsage } from "./session-usage.ts";
import type { PoolUsage } from "../identities/pool/adapter.ts";
import type { ApiStyle, GatewayApp, GatewayProvider, TokenRecord, UsageHistoryRow } from "./types.ts";
import { TOKSCALE_TIME_ZONE_NAMES } from "../cli/usage/tokscale-zones.ts";
import { USAGE_READER_PROVIDERS } from "./usage-source.ts";
import { registerPoolResetAdmin, type PoolResetAdmin } from "./admin-pool-reset.ts";
import type { AutoResetStore } from "./auto-reset-store.ts";
import type { AutoResetPool } from "./auto-reset.ts";
import { claudeManualOutcome, codexResultOutcome, failureOutcome, parseResetLogQuery, resetActor, type ResetLogger, type ResetLogStore } from "./reset-log.ts";
import {
  AUTO_RESET_PATH, AUTO_RESET_PROVIDERS, AUTO_RESET_UNSUPPORTED, AUTO_RESET_UNSUPPORTED_REASON, isAutoResetProvider,
  type AutoResetLastClaim, type AutoResetPoolStatus, type AutoResetProvider, type AutoResetProviderView, type AutoResetUnsupportedProvider,
  type AutoResetUnsupportedView, type AutoResetView,
} from "./auto-reset-view.ts";

export const DEFAULT_OVERLAP_MS = 24 * 3600_000;
const MAX_OVERLAP_HOURS = 24 * 30;
const MAX_USAGE_DAYS = 90;

const PROVIDERS: readonly GatewayProvider[] = ["claude", "codex", "kimi", "grok", "zai", "ali", "opencode"];
/** Managed providers checked by GET /limits. Providers without a usage reader do not replace host data. */
export const LIMITS_PROVIDERS: readonly GatewayProvider[] = ["claude", "codex", "kimi", "grok", "zai", "ali", "opencode"];
/** Providers with a Gateway usage reader. Other providers must not replace host-derived rows with empty Gateway data. */
const STYLES: readonly ApiStyle[] = ["anthropic", "openai"];
/** Paths the proxy port answers itself; an app of this name could never be reached. */
const RESERVED_NAMES = new Set(["healthz", "readyz", "metrics", "browser"]);
/** A DNS-1123 label: the name becomes a URL path segment and may become a Kubernetes label. */
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** Providers that speak one API style only; the others (kimi, zai) offer both. */
const FIXED_STYLE: Partial<Record<GatewayProvider, ApiStyle>> = { claude: "anthropic", ali: "anthropic", codex: "openai", grok: "openai", opencode: "openai" };

export type IdentityState = "ok" | "missing" | "retired" | "pool";

export interface AdminDeps {
  /** Writes go here (the replica's cached store, so its own cache updates at once). */
  store: GatewayStore;
  /** Reads behind every decision or answer. Defaults to `store`; the gateway passes the uncached database store, so a stale replica cache never decides. */
  readStore?: GatewayStore;
  adminToken: string;
  now(): Date;
  overlapMs?: number;
  /** Looks an identity up in the AIS registry. When absent, identities are not checked. */
  identityState?(provider: GatewayProvider, identity: string): Promise<IdentityState>;
  browserPoolMembers?(pool: string): Promise<string[] | undefined>;
  browserIdentityExists?(identity: string): Promise<string | undefined>;
  browserHub?: { revoke(binding: string): void };
  /** Closes the chats of a revoked binding (side-panel chat). Absent when chat is off. */
  onBindingRevoked?(binding: string, before?: number): Promise<void>;
  /** Who renews each gateway login and when (GET /logins/renewal); absent when the gateway has no refresh journal. */
  renewal?(): Promise<LoginRenewal[]>;
  /** The credential store behind the host sync routes (/store/*, admin-store.ts); absent when the gateway has no credential store. */
  storeAdmin?: StoreAdminDeps;
  /** The starred models behind GET and POST /favourites (admin-favourites.ts). Read at each call: it is undefined until the chat stack is up. */
  favourites?(): FavouritesService | undefined;
  metrics?: Pick<GatewayMetrics, "favourite" | "sessionsError">;
  /**
   * The t3-instances scope (instances-token.ts): a derived read-only token that lists apps in a reduced view and hands out one
   * derived app token per active app. `namespaces` limits which apps get a token. Absent: the scope is off. `log` gets one JSON line per token read.
   */
  instances?: { namespaces: readonly string[]; log(line: string): void };
  /**
   * The session ingest routes (admin-sessions.ts, `/sessions/v1/*`). Absent: the feature is off and the routes answer 404.
   * `token` is the ingest token (AIS_GATEWAY_SESSIONS_TOKEN). It opens these routes and no other.
   */
  sessions?: SessionsAdminDeps & { token: string };
  /** One identity's cached subscription usage (GET /limits); absent when the gateway has no usage source. */
  usageFor?(provider: GatewayProvider, identity: string): Promise<PoolUsage | undefined>;
  /**
   * Forces one account-scoped, read-only usage refresh for an explicit limits recheck. Answers false when no read ran because the
   * identity was read a moment ago or a read was already in flight (the recent reading stands). No answer counts as a read.
   */
  refreshUsageFor?(provider: GatewayProvider, identity: string): Promise<boolean | void>;
  /** Test hooks: the longest one read and the longest a whole manual refresh may take. */
  freshReadMs?: number;
  freshBudgetMs?: number;
  /** Whether the stored login of one identity is dead (the provider refused its refresh token): only a new sign-in helps. */
  loginRevokedFor?(provider: GatewayProvider, identity: string): Promise<boolean>;
  /** Why the newest usage read of one identity failed, or undefined when it worked (GET /limits shows it on a cached row). */
  usageFailureFor?(provider: GatewayProvider, identity: string): Promise<{ error: string; at: string } | undefined>;
  /** Expires the cached Codex reset credits of one identity, so the next read asks OpenAI. A failed read keeps the last known credits. */
  refreshResetCreditsFor?(identity: string): Promise<void>;
  /** Codex reset credits for one managed identity. Undefined means the provider read failed. */
  resetCreditsFor?(identity: string): Promise<import("../cli/limits/types.ts").ManualResetInfo | undefined>;
  /** The cached Codex reset credits now (marked stale), with no read. A row uses them when its credit read is not done in time. */
  cachedResetCreditsFor?(identity: string): import("../cli/limits/types.ts").ManualResetInfo | undefined;
  /** The member accounts of every swap pool of one provider (GET /limits). */
  poolMembers?(provider: GatewayProvider): Promise<string[]>;
  /** Resolves an alias to the identity's canonical name (GET /limits). */
  canonical?(provider: GatewayProvider, identity: string): Promise<string>;
  /** Spends one Claude reset grant of a managed identity with the store's member credential (POST /limits/claude/:identity/resets/:grant); absent when the gateway cannot. Throws an error with a numeric `status` and a short message to refuse. */
  spendReset?(identity: string, grantId: string): Promise<unknown>;
  /** Spends one Codex reset on the named member and invalidates shared reset and usage reads. */
  spendCodexReset?(identity: string, redeemRequestId: string, signal?: AbortSignal): Promise<unknown>;
  poolReset?: PoolResetAdmin;
  /** Writes one reset log row for each manual reset (reset-log.ts). Absent: the routes write no row. */
  resetLog?: ResetLogger;
  /** Reads the reset log (GET /reset-log). Absent: the route answers 404. */
  resetLogStore?: ResetLogStore;
  autoReset?: { store: AutoResetStore; pools: (provider: AutoResetProvider) => Promise<AutoResetPool[]> };
}

/** Longest one provider read of a manual refresh may take. The console waits 40 s for a whole refresh, so a slow read must not use it all. */
const FRESH_READ_MS = 12_000;
/** How many identities one manual refresh reads at the same time. */
const FRESH_PARALLEL = 8;
/** Longest a whole manual refresh waits. Reads still running then go on in the background and the answer holds the cached rows. */
const FRESH_BUDGET_MS = 25_000;
/** The least time the row phase keeps, so a row whose credits are cached in memory still answers when the reads used the budget. */
const ROW_PHASE_FLOOR_MS = 250;

/** One GET /limits row: a managed identity plus the usage source's reading of it (no reading yet: unavailable). */
type AdminLimitRow = { provider: GatewayProvider; identity: string } & Omit<PoolUsage, "capturedAt"> & { capturedAt?: string; loginRevoked?: true };

/** Constant-time comparison: both sides are hashed first so lengths never leak. */
function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearer(req: Request): string {
  const m = /^bearer\s+(\S+)$/i.exec(req.headers.get("authorization")?.trim() ?? "");
  return m?.[1] ?? "";
}

/** Token metadata for listings: prefix and dates only, never the hash. */
const tokenView = (t: TokenRecord) => ({ prefix: t.prefix, createdAt: t.createdAt, ...(t.expiresAt !== undefined ? { expiresAt: t.expiresAt } : {}) });

/** Said when a request names pool members. A pool app uses every live pool member of its provider. */
export const POOL_LIST_REFUSED = "pool apps follow the live pool; member lists are not accepted";

async function appView(store: GatewayStore, app: GatewayApp) {
  // An old stored row may still hold a member list: it is ignored, so it is not shown either.
  const target = app.target.kind === "pool" ? { kind: "pool" as const } : app.target;
  return { ...app, target, tokens: (await store.tokensFor(app.name)).map(tokenView) };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** Validates a PUT body into the mutable fields of an app, or a message naming the problem. */
function parseAppBody(raw: unknown): Pick<GatewayApp, "owner" | "namespace" | "provider" | "style" | "target" | "models" | "dailyTokens" | "reservePercent"> | string {
  if (!isObj(raw)) return "body must be a JSON object";
  const { owner, namespace, provider, style, target, models, dailyTokens, reservePercent } = raw;
  if (typeof owner !== "string" || !owner) return "owner is required";
  if (typeof namespace !== "string" || !namespace) return "namespace is required";
  if (!PROVIDERS.includes(provider as GatewayProvider)) return `provider must be one of ${PROVIDERS.join(", ")}`;
  if (!STYLES.includes(style as ApiStyle)) return "style must be anthropic or openai";
  const fixed = FIXED_STYLE[provider as GatewayProvider];
  if (fixed !== undefined && style !== fixed) return `${provider as string} supports only the ${fixed} style`;
  try {
    adapterFor(provider as GatewayProvider).upstreamBase(style as ApiStyle);
  } catch {
    return `${provider as string} has no ${style as string} upstream`;
  }
  let t: GatewayApp["target"];
  if (!isObj(target)) return "target is required";
  if (target.kind === "pin") {
    if (typeof target.identity !== "string" || !target.identity) return "target.identity is required for a pin";
    t = { kind: "pin", identity: target.identity };
  } else if (target.kind === "pool") {
    if (target.identities !== undefined) return POOL_LIST_REFUSED;
    t = { kind: "pool" };
  } else {
    return "target.kind must be pin or pool";
  }
  if (models !== undefined && !isStrings(models)) return "models must be a list of names";
  if (dailyTokens !== undefined && !isPosInt(dailyTokens)) return "dailyTokens must be a positive integer";
  if (reservePercent !== undefined && !(typeof reservePercent === "number" && reservePercent >= 1 && reservePercent <= 100)) return "reservePercent must be between 1 and 100";
  return {
    owner,
    namespace,
    provider: provider as GatewayProvider,
    style: style as ApiStyle,
    target: t,
    ...(models !== undefined ? { models } : {}),
    ...(dailyTokens !== undefined ? { dailyTokens } : {}),
    ...(reservePercent !== undefined ? { reservePercent } : {}),
  };
}

async function jsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.trim() === "") return {};
  return JSON.parse(text);
}

/**
 * Validates the ledger usage window shared by `GET /usage/identities` and `GET /usage/models`.
 * `since` (ISO instant, optional `until`) wins over `days`; both are bounded by MAX_USAGE_DAYS.
 * Returns the window, or a message naming the problem.
 */
function usageWindow(query: (name: string) => string | undefined, now: Date): { since: Date; until?: Date } | string {
  const sinceRaw = query("since");
  let since: Date;
  if (sinceRaw !== undefined) {
    since = new Date(sinceRaw);
    if (Number.isNaN(since.getTime())) return "since must be an ISO date-time";
  } else {
    const days = query("days") === undefined ? 1 : Number(query("days"));
    if (!Number.isInteger(days) || days < 1 || days > MAX_USAGE_DAYS) return `days must be a whole number from 1 to ${MAX_USAGE_DAYS}`;
    since = new Date(now.getTime() - days * 86400_000);
  }
  if (now.getTime() - since.getTime() > MAX_USAGE_DAYS * 86400_000) return `since must be within ${MAX_USAGE_DAYS} days`;
  const untilRaw = query("until");
  if (untilRaw === undefined) return { since };
  const until = new Date(untilRaw);
  if (Number.isNaN(until.getTime())) return "until must be an ISO date-time";
  return { since, until };
}

/** The largest history batch one POST accepts. */
export const MAX_HISTORY_BATCH = 2000;
const HISTORY_DAY = /^\d{4}-\d{2}-\d{2}$/;
const HISTORY_SOURCE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const validInstant = (v: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v));
const validZone = (v: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: v });
    return true;
  } catch {
    return false;
  }
};

const validDay = (v: string): boolean => HISTORY_DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

/** Validates a history import body into rows, or a message naming the first problem. */
export function parseHistoryBody(raw: unknown): UsageHistoryRow[] | string {
  const list = isObj(raw) ? raw.rows : undefined;
  if (!Array.isArray(list)) return "rows must be a list";
  if (list.length === 0) return "rows must not be empty";
  if (list.length > MAX_HISTORY_BATCH) return `rows must hold at most ${MAX_HISTORY_BATCH} entries`;
  const out: UsageHistoryRow[] = [];
  for (const [i, r] of list.entries()) {
    if (!isObj(r)) return `rows[${i}] must be an object`;
    if (typeof r.source !== "string" || !HISTORY_SOURCE.test(r.source)) return `rows[${i}].source must be 1 to 64 lowercase letters, digits, . _ or -`;
    if (typeof r.provider !== "string" || r.provider === "" || r.provider.length > 120) return `rows[${i}].provider is required`;
    if (typeof r.identity !== "string" || r.identity === "" || r.identity.length > 200) return `rows[${i}].identity is required`;
    if (typeof r.generation !== "string" || !validInstant(r.generation)) return `rows[${i}].generation must be an ISO instant ending in Z`;
    if (typeof r.zone !== "string" || !validZone(r.zone)) return `rows[${i}].zone must be an IANA time zone`;
    const day = r.day === undefined ? null : r.day;
    if (day !== null && (typeof day !== "string" || !validDay(day))) return `rows[${i}].day must be YYYY-MM-DD or null`;
    const span: Record<string, string | null> = {};
    for (const k of ["firstDay", "lastDay"] as const) {
      const v = r[k] === undefined ? null : r[k];
      if (v !== null && (typeof v !== "string" || !validDay(v))) return `rows[${i}].${k} must be YYYY-MM-DD or null`;
      span[k] = v;
    }
    const model = r.model === undefined || r.model === "" ? null : r.model;
    if (model !== null && (typeof model !== "string" || model.length > 300)) return `rows[${i}].model must be a text or null`;
    const nums: Record<string, number> = {};
    for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "messages"] as const) {
      const v = r[k] === undefined ? 0 : r[k];
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return `rows[${i}].${k} must be a whole number of 0 or more`;
      nums[k] = v;
    }
    const cost = r.estCostUsd === undefined ? 0 : r.estCostUsd;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return `rows[${i}].estCostUsd must be a number of 0 or more`;
    out.push({ source: r.source, generation: new Date(r.generation).toISOString(), zone: r.zone, firstDay: span.firstDay!, lastDay: span.lastDay!, provider: r.provider, identity: r.identity, day, model, inputTokens: nums.inputTokens!, outputTokens: nums.outputTokens!, cacheReadTokens: nums.cacheReadTokens!, cacheWriteTokens: nums.cacheWriteTokens!, messages: nums.messages!, estCostUsd: cost });
  }
  return out;
}

/**
 * The identities GET /limits lists for one provider, sorted: canonical pool members plus the identities of active pinned apps.
 * The gateway warm-up uses this too, so the warmed set and the listed set cannot drift.
 */
export async function limitsIdentities(
  deps: Pick<AdminDeps, "poolMembers" | "canonical">,
  apps: readonly GatewayApp[],
  provider: GatewayProvider,
): Promise<string[]> {
  const names = new Set<string>();
  // One unreadable registry must not blank the other providers: keep this provider's pinned identities.
  const members = deps.poolMembers ? await deps.poolMembers(provider).catch(() => [] as string[]) : [];
  for (const member of members) names.add((await deps.canonical?.(provider, member)) ?? member);
  for (const app of apps) {
    if (app.state === "active" && app.provider === provider && app.target.kind === "pin") {
      names.add((await deps.canonical?.(provider, app.target.identity)) ?? app.target.identity);
    }
  }
  return [...names].sort();
}

export function createAdminApp(deps: AdminDeps): Hono {
  const { store } = deps;
  const read = deps.readStore ?? store;
  const hono = new Hono();
  const err = (status: 400 | 401 | 404 | 409 | 410 | 422 | 429 | 500 | 503, message: string): Response => Response.json({ error: message }, { status, ...(status === 429 ? { headers: { "retry-after": "5" } } : {}) });

  // The favourites token (derived from the admin token) opens GET and POST /favourites and nothing else.
  const favouritesBearer = deps.adminToken ? favouritesToken(deps.adminToken) : undefined;
  // The ingest token opens `/sessions/v1/*` and nothing else, and only while the feature is on.
  const sessionsBearer = deps.sessions?.token || undefined;
  // The t3-instances token opens GET /apps (reduced view) and POST /apps/:name/instance-token and nothing else.
  const instancesBearer = deps.instances && deps.adminToken ? instancesToken(deps.adminToken) : undefined;
  const instancesRoute = (c: { req: { path: string; method: string } }): "list" | "token" | undefined => {
    if (c.req.path === "/apps" && c.req.method === "GET") return "list";
    if (c.req.method === "POST" && /^\/apps\/[^/]+\/instance-token$/.test(c.req.path)) return "token";
    return undefined;
  };
  hono.use("*", async (c, next) => {
    const given = bearer(c.req.raw);
    if (deps.adminToken && sameSecret(given, deps.adminToken)) return next();
    if (instancesBearer && instancesRoute(c) && sameSecret(given, instancesBearer)) {
      c.set("scope" as never, "instances" as never);
      return next();
    }
    if (favouritesBearer && c.req.path === "/favourites" && (c.req.method === "GET" || c.req.method === "POST") && sameSecret(given, favouritesBearer)) return next();
    if (sessionsBearer && c.req.path.startsWith("/sessions/v1/") && sameSecret(given, sessionsBearer)) return next();
    if (c.req.path.startsWith("/sessions/v1/")) deps.metrics?.sessionsError?.("auth");
    return err(401, "admin token required");
  });
  hono.onError(() => err(503, "store unavailable"));
  registerBrowserAdmin(hono, { store, now: deps.now, ...(deps.browserHub ? { hub: deps.browserHub } : {}), ...(deps.onBindingRevoked ? { onBindingRevoked: deps.onBindingRevoked } : {}), ...(deps.browserPoolMembers ? { browserPoolMembers: deps.browserPoolMembers } : {}), ...(deps.browserIdentityExists ? { browserIdentityExists: deps.browserIdentityExists } : {}) });

  registerStoreAdmin(hono, deps.storeAdmin, (status, message, extra) => Response.json({ error: message, ...extra }, { status }));
  if (deps.poolReset) registerPoolResetAdmin(hono, deps.poolReset, LIMITS_PROVIDERS);
  registerFavouritesAdmin(hono, deps.favourites, err, deps.metrics);
  registerSessionsAdmin(hono, deps.sessions, (status, message, extra) => Response.json({ error: message, ...extra }, { status }));

  // Renewal state of every login the gateway keeps alive: journal (last refresh, last error) plus the stored login (expiry).
  hono.get("/logins/renewal", async (c) => {
    if (!deps.renewal) return err(404, "renewal data is not available");
    return c.json({ logins: await deps.renewal() });
  });

  // Live subscription windows of every managed identity, from the same cached usage source the proxy selects on.
  // A read never waits on a fresh fetch and never refreshes a token: a cold identity answers "unavailable" and fills in behind.
  hono.get("/limits", async (c) => {
    if (!deps.usageFor) return err(404, "limits data is not available");
    const providerFilter = c.req.query("provider");
    if (providerFilter !== undefined && !PROVIDERS.includes(providerFilter as GatewayProvider)) return err(400, "unknown provider");
    const identityFilter = c.req.query("identity");
    const apps = await read.listApps();
    const providers = LIMITS_PROVIDERS.filter((provider) => providerFilter === undefined || provider === providerFilter);
    const namesByProvider = await Promise.all(providers.map(async (provider) => ({ provider, names: await limitsIdentities(deps, apps, provider) })));
    const answerStarted = Date.now();
    const budgetMs = deps.freshBudgetMs ?? FRESH_BUDGET_MS;
    const identities = namesByProvider.flatMap(({ provider, names }) => names
      .filter((identity) => identityFilter === undefined || identity === identityFilter)
      .map((identity) => ({ provider, identity })));
    // A manual refresh (`fresh=1`) reads the provider again for every matching identity, past the 45 second caches. It needs a
    // provider, and an identity when one is named must be managed. Each read is bounded, and a failed read never fails the answer:
    // the row then carries the failure text.
    if (c.req.query("fresh") === "1") {
      if (providerFilter === undefined || !deps.refreshUsageFor || (identityFilter !== undefined && identities.length === 0)) {
        return err(400, "fresh limits reads require a provider, and an identity when one is named must be managed");
      }
      let nextFresh = 0;
      const freshWorkers = Array.from({ length: Math.min(FRESH_PARALLEL, identities.length) }, async () => {
        while (nextFresh < identities.length) {
          const { provider, identity } = identities[nextFresh++]!;
          let timer: ReturnType<typeof setTimeout> | undefined;
          // The read decides whether it ran: a read in flight is joined and a young reading stands, so a burst of clicks is one read.
          const ran = await Promise.race([
            deps.refreshUsageFor!(provider, identity).then((r) => r !== false, () => true),
            new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), deps.freshReadMs ?? FRESH_READ_MS); }),
          ]);
          if (timer) clearTimeout(timer);
          // The reset credits are asked again only after a real read. A failed credit read keeps the last known credits.
          if (ran && provider === "codex") await deps.refreshResetCreditsFor?.(identity).catch(() => undefined);
        }
      });
      // The answer never waits past the budget: a slow read goes on in the background, and its identity keeps its cached row.
      let budgetTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(freshWorkers),
        new Promise<void>((resolve) => { budgetTimer = setTimeout(resolve, budgetMs); }),
      ]);
      if (budgetTimer) clearTimeout(budgetTimer);
    }
    const limits = new Array<AdminLimitRow>();
    let next = 0;
    const workers = Array.from({ length: Math.min(64, identities.length) }, async () => {
      while (next < identities.length) {
        const index = next++;
        const { provider, identity } = identities[index]!;
        const usage = await deps.usageFor!(provider, identity).catch(() => undefined);
        // The whole answer stays inside the budget, this phase included: a credit read still running at the end of the budget
        // gives way to the cached credits (stale) and goes on in the background.
        let fetchedReset: Awaited<ReturnType<NonNullable<AdminDeps["resetCreditsFor"]>>> | undefined;
        if (provider === "codex" && deps.resetCreditsFor) {
          const left = Math.max(ROW_PHASE_FLOOR_MS, budgetMs - (Date.now() - answerStarted));
          let rowTimer: ReturnType<typeof setTimeout> | undefined;
          fetchedReset = await Promise.race([
            deps.resetCreditsFor(identity).catch(() => undefined),
            new Promise<undefined>((resolve) => { rowTimer = setTimeout(() => resolve(undefined), left); }).then(() => deps.cachedResetCreditsFor?.(identity)),
          ]);
          if (rowTimer) clearTimeout(rowTimer);
        }
        const manualReset = fetchedReset ?? usage?.manualReset;
        const hasFigure = (usage?.windows?.length ?? 0) > 0 || typeof usage?.maxUtilization === "number";
        const shouldShowNoFigure = USAGE_READER_PROVIDERS.has(provider) && usage?.noPlan !== true;
        if (!hasFigure && !manualReset && !shouldShowNoFigure) continue;
        // A reading that is not fresh says why: the newest failed read of this identity (a rejected login, a rate limit).
        const failure = await deps.usageFailureFor?.(provider, identity).catch(() => undefined);
        // A login the provider refused for good: the host reads this flag from here and never opens a login file itself.
        const loginRevoked = failure || !hasFigure ? await deps.loginRevokedFor?.(provider, identity).catch(() => false) : false;
        limits[index] = { provider, identity, ...(usage ?? { status: "unavailable" as const, windows: [] }), ...(failure && (usage?.stale === true || !hasFigure) ? { error: failure.error } : {}), ...(manualReset ? { manualReset } : {}), ...(loginRevoked ? { loginRevoked: true as const } : {}) };
      }
    });
    await Promise.all(workers);
    return c.json({ limits: limits.filter((row): row is AdminLimitRow => row !== undefined) });
  });

  /** The pools of one provider with their setting, last claim, and the last claim a pool made on each member. */
  async function autoResetProviderView(provider: AutoResetProvider): Promise<AutoResetProviderView | undefined> {
    const settings = deps.autoReset;
    if (!settings) return undefined;
    const pools = await settings.pools(provider);
    const claim = (summary: Awaited<ReturnType<AutoResetStore["lastClaim"]>>): AutoResetLastClaim | undefined => {
      if (!summary) return undefined;
      const { pool, identity, startedAt, creditExpiresAt, status, spendPending } = summary;
      return { pool, identity, startedAt, creditExpiresAt, status, ...(spendPending ? { spendPending } : {}) };
    };
    const poolRows = await Promise.all(pools.map(async ({ name, members }): Promise<AutoResetPoolStatus> => {
      const [enabled, last] = await Promise.all([settings.store.enabled(provider, name), settings.store.lastClaim(provider, name)]);
      const lastClaim = claim(last);
      return { name, enabled, members, ...(lastClaim ? { lastClaim } : {}) };
    }));
    const memberClaims: Record<string, AutoResetLastClaim> = {};
    await Promise.all([...new Set(pools.flatMap((pool) => pool.members))].map(async (member) => {
      const last = claim(await settings.store.lastMemberClaim(provider, member));
      if (last) memberClaims[member] = last;
    }));
    return { provider, supported: true, pools: poolRows, memberClaims };
  }

  const noAutoReset = () => err(404, "Automatic resets are not available");
  const unsupportedView = (provider: AutoResetUnsupportedProvider): AutoResetUnsupportedView => ({
    provider, supported: false, reason: AUTO_RESET_UNSUPPORTED_REASON,
  });
  const noHeaders = { "cache-control": "no-store" };

  hono.get(AUTO_RESET_PATH, async (c) => {
    if (!deps.autoReset) return noAutoReset();
    const supported = await Promise.all(AUTO_RESET_PROVIDERS.map((provider) => autoResetProviderView(provider)));
    const view: AutoResetView = {
      providers: [...supported.filter((row): row is AutoResetProviderView => row !== undefined), ...AUTO_RESET_UNSUPPORTED.map(unsupportedView)],
    };
    return c.json(view, 200, noHeaders);
  });

  // Codex used this path first, so `GET /limits/codex/auto-reset` keeps working as the Codex form of the generic path.
  hono.get("/limits/:provider/auto-reset", async (c) => {
    if (!deps.autoReset) return noAutoReset();
    const provider = c.req.param("provider");
    if (isAutoResetProvider(provider)) return c.json(await autoResetProviderView(provider), 200, noHeaders);
    if ((AUTO_RESET_UNSUPPORTED as readonly string[]).includes(provider)) return c.json(unsupportedView(provider as AutoResetUnsupportedProvider), 200, noHeaders);
    return err(404, "no such provider");
  });

  hono.put("/limits/:provider/auto-reset/:kind", async (c) => {
    const settings = deps.autoReset;
    if (!settings) return noAutoReset();
    const provider = c.req.param("provider");
    // An identity can never carry this setting. The old path answers with a clear error and writes nothing.
    if (c.req.param("kind") === "identity") {
      return err(410, "Automatic reset is a pool setting only. Identity settings are removed.");
    }
    if (c.req.param("kind") !== "pool") return err(400, "scope must be pool");
    if ((AUTO_RESET_UNSUPPORTED as readonly string[]).includes(provider)) {
      return err(400, `${provider} has no reset credit or grant API, so automatic reset is not supported`);
    }
    if (!isAutoResetProvider(provider)) return err(404, "no such provider");
    const body: unknown = await c.req.json().catch(() => undefined);
    if (!isObj(body) || typeof body.name !== "string" || !body.name.trim() || typeof body.enabled !== "boolean") {
      return err(400, "name and boolean enabled are required");
    }
    const name = body.name;
    if (!(await settings.pools(provider)).some((pool) => pool.name === name)) return err(404, `no such ${provider} pool`);
    await settings.store.setEnabled(provider, name, body.enabled);
    return c.json({ provider, name, enabled: body.enabled });
  });

  // Spends one reset grant at the gateway, with the member credential from the store. The console never holds that credential.
  hono.post("/limits/claude/:identity/resets/:grant", async (c) => {
    if (!deps.spendReset) return err(404, "reset spending is not available");
    // Hono has decoded the path parameters already. A second decode would throw on a stray `%`.
    const requested = c.req.param("identity");
    const identity = (await deps.canonical?.("claude", requested).catch(() => requested)) ?? requested;
    const grant = c.req.param("grant");
    // The log keeps only a well-formed grant ID. Anything else is refused by the spend and is not logged as an ID.
    const attempt = await deps.resetLog?.begin({
      provider: "claude", trigger: "manual", actor: resetActor(c.req.raw, "user"), identity, grantId: /^[A-Za-z0-9._:-]{1,128}$/.test(grant) ? grant : null,
    });
    try {
      const out = await deps.spendReset(identity, grant);
      const body = (typeof out === "object" && out !== null ? out : {}) as { result?: unknown; cleared?: unknown; resetsLeft?: unknown; grantId?: unknown };
      // The write is not awaited: the log never delays or changes the answer. The logger tracks it, and `drain` waits at stop.
      void attempt?.finish({ ...claudeManualOutcome(body), ...(typeof body.grantId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(body.grantId) ? { grantId: body.grantId } : {}) });
      return c.json(out);
    } catch (e) {
      void attempt?.finish(failureOutcome(e));
      const status = (e as { status?: unknown }).status;
      const known = status === 400 || status === 404 || status === 409 || status === 429 ? status : 502;
      return Response.json({ error: e instanceof Error ? e.message.slice(0, 300) : "reset failed" }, { status: known });
    }
  });

  // A Codex consume has no grant id. The identity path pins the stored login used for its one POST.
  hono.post("/limits/codex/:identity/resets/use", async (c) => {
    if (!deps.spendCodexReset) return err(404, "Codex reset spending is not available");
    const requested = c.req.param("identity");
    const identity = (await deps.canonical?.("codex", requested).catch(() => requested)) ?? requested;
    const body = await c.req.json().catch(() => undefined) as { redeemRequestId?: unknown } | undefined;
    if (typeof body?.redeemRequestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.redeemRequestId)) return err(400, "a valid reset request ID is required");
    const attempt = await deps.resetLog?.begin({ provider: "codex", trigger: "manual", actor: resetActor(c.req.raw, "user"), identity });
    try {
      const out = await deps.spendCodexReset(identity, body.redeemRequestId, c.req.raw.signal);
      const result = (typeof out === "object" && out !== null ? out : {}) as { result?: unknown; creditId?: unknown };
      void attempt?.finish({
        ...codexResultOutcome(typeof result.result === "string" ? result.result : ""),
        ...(typeof result.creditId === "string" ? { grantId: result.creditId } : {}),
      });
      return c.json(out);
    } catch (e) {
      void attempt?.finish(failureOutcome(e));
      const status = (e as { status?: unknown }).status;
      const known = status === 400 || status === 403 || status === 404 || status === 409 || status === 429 ? status : 502;
      return Response.json({ error: e instanceof Error ? e.message.slice(0, 300) : "reset failed" }, { status: known });
    }
  });

  // The reset log: every reset attempt, newest first (reset-log.ts). The console serves it as GET /api/logs/resets.
  hono.get("/reset-log", async (c) => {
    if (!deps.resetLogStore) return err(404, "the reset log is not available");
    const filters = parseResetLogQuery((name) => c.req.query(name));
    if (typeof filters === "string") return err(400, filters);
    return c.json(await deps.resetLogStore.list(filters), 200, { "cache-control": "no-store" });
  });

  hono.get("/apps", async (c) => {
    const apps = await read.listApps();
    // The t3-instances scope sees names, provider, mode, target and namespace only: no owner, models, limits or token data.
    if (c.get("scope" as never) === ("instances" as never)) {
      const allowed = new Set(deps.instances?.namespaces ?? []);
      return c.json({ apps: apps.filter((a) => a.state === "active" && allowed.has(a.namespace)).map((a) => ({ name: a.name, namespace: a.namespace, provider: a.provider, style: a.style, state: a.state, target: a.target.kind === "pool" ? { kind: "pool" as const } : a.target })) });
    }
    return c.json({ apps: await Promise.all(apps.map((a) => appView(read, a))) });
  });

  // Hands a T3 instance the token it uses for one app. The gateway keeps only hashes, so it cannot return an existing token:
  // the token is derived (instances-token.ts), added once, and returned again on every later call. Other tokens are not touched.
  hono.post("/apps/:name/instance-token", async (c) => {
    const cfg = deps.instances;
    const name = c.req.param("name");
    const log = (outcome: "minted" | "served" | "refused", extra: Record<string, unknown> = {}) => cfg?.log(JSON.stringify({ event: "instance-token", app: name, outcome, at: deps.now().toISOString(), ...extra }));
    if (!cfg) return err(404, "no such app");
    const app = await read.getApp(name);
    if (!app || app.state !== "active") {
      log("refused", { reason: "no active app" });
      return err(404, "no such app");
    }
    if (!cfg.namespaces.includes(app.namespace)) {
      log("refused", { reason: "namespace" });
      return Response.json({ error: "the app is outside the namespaces of this credential" }, { status: 403 });
    }
    // Only an app that one of the T3 instance shapes uses gets a token: an app that no instance maps to has no use for one.
    if (instanceIdsForApp({ name: app.name, provider: app.provider, state: app.state, target: app.target }).length === 0) {
      log("refused", { reason: "no instance uses this app" });
      return Response.json({ error: "no T3 instance uses this app" }, { status: 403 });
    }
    const nowMs = deps.now().getTime();
    const window = instanceTokenWindow(nowMs);
    const expiresAt = instanceTokenExpiry(window);
    // Expired minted records go first, so the store does not grow by one record per window.
    await store.pruneMarkedTokens(name, INSTANCE_PREFIX_MARK, deps.now().toISOString());
    const records = await read.tokensFor(name);
    // One token per app, rotation generation and window. An app rotation changes the generation (the number of the app's own tokens) and caps the minted tokens at its overlap.
    const generation = records.filter((r) => !isInstancePrefix(r.prefix)).length;
    const t = instanceAppToken(deps.adminToken, name, generation, window);
    const found = records.some((r) => r.prefix === t.prefix && r.hash === t.hash);
    if (!found) {
      try {
        await store.addToken({ app: name, prefix: t.prefix, hash: t.hash, createdAt: deps.now().toISOString(), expiresAt });
      } catch (e) {
        if (e instanceof AppRevokedError) {
          log("refused", { reason: "revoked" });
          return err(404, "no such app");
        }
        throw e;
      }
    }
    log(found ? "served" : "minted", { prefix: t.prefix, expiresAt });
    return c.json({ app: name, token: t.token, prefix: t.prefix, expiresAt });
  });

  hono.get("/apps/:name", async (c) => {
    const app = await read.getApp(c.req.param("name"));
    return app ? c.json(await appView(read, app)) : err(404, "no such app");
  });

  hono.put("/apps/:name", async (c) => {
    const name = c.req.param("name");
    if (!NAME.test(name) || RESERVED_NAMES.has(name)) return err(400, "name must be 1 to 63 lowercase letters, digits or -, start and end with a letter or digit, and not be a reserved path");
    let raw: unknown;
    try {
      raw = await jsonBody(c.req.raw);
    } catch {
      return err(400, "body is not valid JSON");
    }
    const parsed = parseAppBody(raw);
    if (typeof parsed === "string") return err(400, parsed);
    // A fresh read from the database: a revoked app is final and never changed or reused.
    const existing = await read.getApp(name);
    if (existing?.state === "revoked") return err(409, revokedMessage(name));
    try {
    for (const identity of parsed.target.kind === "pin" ? [parsed.target.identity] : []) {
      const state = (await deps.identityState?.(parsed.provider, identity)) ?? "ok";
      if (state === "pool") {
        return err(400, `"${identity}" is a swap pool, not one account: a pin would only ever use the pool's active login. Use target kind "pool": it uses every pool member (CLI: --pool)`);
      }
      if (state !== "ok") return err(400, `identity "${identity}" is ${state === "retired" ? "retired" : "not a known"} ${parsed.provider} identity`);
    }
    } catch {
      return err(500, "identity registry unreadable");
    }
    const app: GatewayApp = {
      ...parsed,
      name,
      state: "active",
      createdAt: existing?.createdAt ?? deps.now().toISOString(),
      ...(existing?.lastUsedAt !== undefined ? { lastUsedAt: existing.lastUsedAt } : {}),
    };
    try {
      await store.putApp(app);
    } catch (e) {
      if (e instanceof AppRevokedError) return err(409, e.message);
      throw e;
    }
    return c.json(await appView(read, app), existing ? 200 : 201);
  });

  hono.post("/apps/:name/tokens", async (c) => {
    const name = c.req.param("name");
    const app = await read.getApp(name);
    if (!app) return err(404, "no such app");
    if (app.state !== "active") return err(409, revokedMessage(name));
    let raw: unknown;
    try {
      raw = await jsonBody(c.req.raw);
    } catch {
      return err(400, "body is not valid JSON");
    }
    let overlapMs = deps.overlapMs ?? DEFAULT_OVERLAP_MS;
    if (isObj(raw) && raw.overlapHours !== undefined) {
      const h = raw.overlapHours;
      if (typeof h !== "number" || !(h >= 0 && h <= MAX_OVERLAP_HOURS)) return err(400, `overlapHours must be between 0 and ${MAX_OVERLAP_HOURS}`);
      overlapMs = h * 3600_000;
    }
    const now = deps.now();
    // Older tokens first (the store expires every token without an expiry), then the new one.
    const previousExpiresAt = new Date(now.getTime() + overlapMs).toISOString();
    // Safe in any order against a racing revoke: a revoke gives every token an expiry, and this only sets one where none exists.
    // The store refuses the new token for a revoked app.
    await store.expireTokens(name, previousExpiresAt);
    await store.capMarkedTokens(name, INSTANCE_PREFIX_MARK, previousExpiresAt);
    const t = generateToken();
    try {
      await store.addToken({ app: name, prefix: t.prefix, hash: t.hash, createdAt: now.toISOString() });
    } catch (e) {
      if (e instanceof AppRevokedError) return err(409, e.message);
      throw e;
    }
    // The only time the token is ever returned.
    return c.json({ app: name, token: t.token, prefix: t.prefix, previousTokensExpireAt: previousExpiresAt }, 201);
  });

  hono.post("/apps/:name/revoke", async (c) => {
    const name = c.req.param("name");
    if (!(await read.getApp(name))) return err(404, "no such app");
    await store.revokeApp(name);
    return c.json({ app: name, state: "revoked" });
  });

  hono.get("/usage", async (c) => {
    const days = c.req.query("days") === undefined ? 1 : Number(c.req.query("days"));
    if (!Number.isInteger(days) || days < 1 || days > MAX_USAGE_DAYS) return err(400, `days must be a whole number from 1 to ${MAX_USAGE_DAYS}`);
    const appFilter = c.req.query("app");
    const providerFilter = c.req.query("provider");
    if (providerFilter !== undefined && !PROVIDERS.includes(providerFilter as GatewayProvider)) return err(400, "unknown provider");
    const since = new Date(deps.now().getTime() - days * 86400_000);
    const apps = (await read.listApps()).filter((a) => (appFilter === undefined || a.name === appFilter) && (providerFilter === undefined || a.provider === providerFilter));
    // One grouped ledger read for every app (was one SUM per app in parallel, which took seconds with ~60 apps).
    const totals = await store.usageTotalsSince(since);
    const usage = apps.map((a) => ({ app: a.name, provider: a.provider, days, tokens: totals.get(a.name) ?? 0 }));
    return c.json({ usage });
  });

  // Ledger totals per provider and identity, so the console can sum a pool's members.
  // `since` (ISO instant, optional `until`) wins over `days`; both are bounded by MAX_USAGE_DAYS.
  hono.get("/usage/identities", async (c) => {
    const win = usageWindow((n) => c.req.query(n), deps.now());
    if (typeof win === "string") return err(400, win);
    const provider = c.req.query("provider");
    if (provider !== undefined && !PROVIDERS.includes(provider as GatewayProvider)) return err(400, "unknown provider");
    const rows = (await store.usageByIdentity(win.since, win.until)).filter((r) => provider === undefined || r.provider === provider);
    return c.json({ since: win.since.toISOString(), ...(win.until ? { until: win.until.toISOString() } : {}), identities: rows });
  });

  // Ledger totals per provider, identity, app and model, so the console can show per-model usage.
  // Same window rules as /usage/identities.
  hono.get("/usage/models", async (c) => {
    const win = usageWindow((n) => c.req.query(n), deps.now());
    if (typeof win === "string") return err(400, win);
    const provider = c.req.query("provider");
    if (provider !== undefined && !PROVIDERS.includes(provider as GatewayProvider)) return err(400, "unknown provider");
    const rows = (await store.usageByModel(win.since, win.until)).filter((r) => provider === undefined || r.provider === provider);
    return c.json({ since: win.since.toISOString(), ...(win.until ? { until: win.until.toISOString() } : {}), models: rows });
  });

  // Client sessions with the split of their served requests over accounts: the account of the latest request is `activeIdentity`,
  // `identities` lists each account the session used with its turns, tokens by type and first and last time. Only requests that carry
  // a session id count. Same window rules as /usage/models. `session` (repeatable or comma separated, at most 500) limits it to those sessions.
  hono.get("/usage/sessions", async (c) => {
    const win = usageWindow((n) => c.req.query(n), deps.now());
    if (typeof win === "string") return err(400, win);
    const provider = c.req.query("provider");
    if (provider !== undefined && !PROVIDERS.includes(provider as GatewayProvider)) return err(400, "unknown provider");
    const sessionKeys = c.req.queries("session")?.flatMap((v) => v.split(",")).map((v) => v.trim()).filter((v) => v !== "");
    if (sessionKeys && sessionKeys.length > 500) return err(400, "session takes at most 500 ids");
    const app = c.req.query("app");
    const rows = await store.usageBySession(win.since, win.until, { ...(provider ? { provider } : {}), ...(app ? { app } : {}), ...(sessionKeys && sessionKeys.length > 0 ? { sessionKeys } : {}) });
    return c.json({ since: win.since.toISOString(), ...(win.until ? { until: win.until.toISOString() } : {}), sessions: foldSessionUsage(rows) });
  });

  // Per-day split of the same ledger (apps summed), bucketed in the IANA zone `tz` (default UTC), so the console can chart days.
  // Same window rules as /usage/models; one GROUP BY over the ts range.
  hono.get("/usage/models/daily", async (c) => {
    const win = usageWindow((n) => c.req.query(n), deps.now());
    if (typeof win === "string") return err(400, win);
    const provider = c.req.query("provider");
    if (provider !== undefined && !PROVIDERS.includes(provider as GatewayProvider)) return err(400, "unknown provider");
    const tz = c.req.query("tz") ?? "UTC";
    if (!TOKSCALE_TIME_ZONE_NAMES.has(tz) && tz !== "UTC") return err(400, "tz must be an IANA time zone name");
    const rows = (await store.usageByModelDaily(win.since, win.until, tz)).filter((r) => provider === undefined || r.provider === provider);
    return c.json({ since: win.since.toISOString(), ...(win.until ? { until: win.until.toISOString() } : {}), tz, days: rows });
  });

  // Imports a batch of host usage history. Rows of one generation replace each other exactly (idempotent); a new generation adds rows. Never a delete.
  hono.post("/usage/history", async (c) => {
    let raw: unknown;
    try {
      raw = await jsonBody(c.req.raw);
    } catch {
      return err(400, "body is not valid JSON");
    }
    const rows = parseHistoryBody(raw);
    if (typeof rows === "string") return err(400, rows);
    await store.upsertUsageHistory(rows);
    return c.json({ imported: rows.length }, 200);
  });

  // Imported history of ONE source (required: sources are different cuts of the same usage and must never be summed together).
  // `generation` is "latest" (default, the newest generation of the source) or one exact ISO instant.
  // `since` and `until` are inclusive days (YYYY-MM-DD, in the zone each row carries); a window leaves out all-time rows (no day). Filters: provider, identity.
  hono.get("/usage/history", async (c) => {
    const source = c.req.query("source");
    if (source === undefined || !HISTORY_SOURCE.test(source)) return err(400, "source is required: one of host-snapshot-models, host-snapshot-daily or host-snapshot-daily-tokens (sources must never be summed together)");
    const day = (name: string): string | undefined | null => {
      const v = c.req.query(name);
      if (v === undefined) return undefined;
      return validDay(v) ? v : null;
    };
    const since = day("since");
    const until = day("until");
    if (since === null) return err(400, "since must be a day, YYYY-MM-DD");
    if (until === null) return err(400, "until must be a day, YYYY-MM-DD (inclusive)");
    const generation = c.req.query("generation") ?? "latest";
    if (generation !== "latest" && !validInstant(generation)) return err(400, "generation must be latest or an ISO instant ending in Z");
    const filter = { source, generation, ...(c.req.query("provider") !== undefined ? { provider: c.req.query("provider") as string } : {}), ...(c.req.query("identity") !== undefined ? { identity: c.req.query("identity") as string } : {}) };
    let rows = await read.usageHistory(filter);
    if (since !== undefined || until !== undefined) rows = rows.filter((r) => r.day !== null && (since === undefined || r.day >= since) && (until === undefined || r.day <= until));
    return c.json({ source, generation, ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}), history: rows });
  });

  return hono;
}
