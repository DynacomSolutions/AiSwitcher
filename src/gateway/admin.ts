import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { AppRevokedError, revokedMessage, type GatewayStore } from "./store.ts";
import { registerBrowserAdmin } from "./browser/admin.ts";
import { registerStoreAdmin, type StoreAdminDeps } from "./admin-store.ts";
import { registerFavouritesAdmin } from "./admin-favourites.ts";
import type { FavouritesService } from "./chat/favourites.ts";
import type { GatewayMetrics } from "./metrics.ts";
import type { LoginRenewal } from "./renewal.ts";
import { adapterFor } from "./providers/index.ts";
import { generateToken } from "./tokens.ts";
import { foldSessionUsage } from "./session-usage.ts";
import type { PoolUsage } from "../identities/pool/adapter.ts";
import type { ApiStyle, GatewayApp, GatewayProvider, TokenRecord, UsageHistoryRow } from "./types.ts";
import { TOKSCALE_TIME_ZONE_NAMES } from "../cli/usage/tokscale-zones.ts";

export const DEFAULT_OVERLAP_MS = 24 * 3600_000;
const MAX_OVERLAP_HOURS = 24 * 30;
const MAX_USAGE_DAYS = 90;

const PROVIDERS: readonly GatewayProvider[] = ["claude", "codex", "kimi", "grok", "zai", "ali", "opencode"];
/** Providers whose subscription usage the usage source can read (GET /limits). The others have no account windows. */
export const LIMITS_PROVIDERS: readonly GatewayProvider[] = ["claude", "codex", "kimi", "zai"];
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
  metrics?: Pick<GatewayMetrics, "favourite">;
  /** One identity's cached subscription usage (GET /limits); absent when the gateway has no usage source. */
  usageFor?(provider: GatewayProvider, identity: string): Promise<PoolUsage | undefined>;
  /** The member accounts of every swap pool of one provider (GET /limits). */
  poolMembers?(provider: GatewayProvider): Promise<string[]>;
  /** Resolves an alias to the identity's canonical name (GET /limits). */
  canonical?(provider: GatewayProvider, identity: string): Promise<string>;
  /** Spends one Claude reset grant of a managed identity with the store's member credential (POST /limits/claude/:identity/resets/:grant); absent when the gateway cannot. Throws an error with a numeric `status` and a short message to refuse. */
  spendReset?(identity: string, grantId: string): Promise<unknown>;
}

/** One GET /limits row: a managed identity plus the usage source's reading of it (no reading yet: unavailable). */
type AdminLimitRow = { provider: GatewayProvider; identity: string } & Omit<PoolUsage, "capturedAt"> & { capturedAt?: string };

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

async function appView(store: GatewayStore, app: GatewayApp) {
  return { ...app, tokens: (await store.tokensFor(app.name)).map(tokenView) };
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
    if (target.identities !== undefined && !isStrings(target.identities)) return "target.identities must be a list of names";
    t = target.identities === undefined ? { kind: "pool" } : { kind: "pool", identities: target.identities };
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
  const err = (status: 400 | 401 | 404 | 409 | 500 | 503, message: string): Response => Response.json({ error: message }, { status });

  hono.use("*", async (c, next) => {
    if (!deps.adminToken || !sameSecret(bearer(c.req.raw), deps.adminToken)) return err(401, "admin token required");
    return next();
  });
  hono.onError(() => err(503, "store unavailable"));
  registerBrowserAdmin(hono, { store, now: deps.now, ...(deps.browserHub ? { hub: deps.browserHub } : {}), ...(deps.onBindingRevoked ? { onBindingRevoked: deps.onBindingRevoked } : {}), ...(deps.browserPoolMembers ? { browserPoolMembers: deps.browserPoolMembers } : {}), ...(deps.browserIdentityExists ? { browserIdentityExists: deps.browserIdentityExists } : {}) });

  registerStoreAdmin(hono, deps.storeAdmin, (status, message, extra) => Response.json({ error: message, ...extra }, { status }));
  registerFavouritesAdmin(hono, deps.favourites, err, deps.metrics);

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
    const limits: AdminLimitRow[] = [];
    for (const provider of LIMITS_PROVIDERS) {
      if (providerFilter !== undefined && provider !== providerFilter) continue;
      const names = await limitsIdentities(deps, apps, provider);
      for (const identity of names) {
        if (identityFilter !== undefined && identity !== identityFilter) continue;
        const usage = await deps.usageFor(provider, identity).catch(() => undefined);
        limits.push({ provider, identity, ...(usage ?? { status: "unavailable" as const, windows: [] }) });
      }
    }
    return c.json({ limits });
  });

  // Spends one reset grant at the gateway, with the member credential from the store. The console never holds that credential.
  hono.post("/limits/claude/:identity/resets/:grant", async (c) => {
    if (!deps.spendReset) return err(404, "reset spending is not available");
    const requested = decodeURIComponent(c.req.param("identity"));
    const identity = (await deps.canonical?.("claude", requested).catch(() => requested)) ?? requested;
    try {
      return c.json(await deps.spendReset(identity, decodeURIComponent(c.req.param("grant"))));
    } catch (e) {
      const status = (e as { status?: unknown }).status;
      const known = status === 400 || status === 404 || status === 409 || status === 429 ? status : 502;
      return Response.json({ error: e instanceof Error ? e.message.slice(0, 300) : "reset failed" }, { status: known });
    }
  });

  hono.get("/apps", async (c) => {
    const apps = await read.listApps();
    return c.json({ apps: await Promise.all(apps.map((a) => appView(read, a))) });
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
    for (const identity of parsed.target.kind === "pin" ? [parsed.target.identity] : (parsed.target.identities ?? [])) {
      const state = (await deps.identityState?.(parsed.provider, identity)) ?? "ok";
      if (state === "pool") {
        return err(400, `"${identity}" is a swap pool, not one account: a pin would only ever use the pool's active login. Use target kind "pool" with identities set to the member accounts (CLI: --pool --identities=<members>)`);
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
