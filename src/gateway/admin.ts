import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { AppRevokedError, revokedMessage, type GatewayStore } from "./store.ts";
import { registerBrowserAdmin } from "./browser/admin.ts";
import type { LoginRenewal } from "./renewal.ts";
import { adapterFor } from "./providers/index.ts";
import { generateToken } from "./tokens.ts";
import type { PoolUsage } from "../identities/pool/adapter.ts";
import type { ApiStyle, GatewayApp, GatewayProvider, TokenRecord } from "./types.ts";

export const DEFAULT_OVERLAP_MS = 24 * 3600_000;
const MAX_OVERLAP_HOURS = 24 * 30;
const MAX_USAGE_DAYS = 90;

const PROVIDERS: readonly GatewayProvider[] = ["claude", "codex", "kimi", "grok", "zai", "ali", "opencode"];
/** Providers whose subscription usage the usage source can read (GET /limits). The others have no account windows. */
const LIMITS_PROVIDERS: readonly GatewayProvider[] = ["claude", "codex", "kimi", "zai"];
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
  /** Who renews each gateway login and when (GET /logins/renewal); absent when the gateway has no refresh journal. */
  renewal?(): Promise<LoginRenewal[]>;
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
  registerBrowserAdmin(hono, { store, now: deps.now, ...(deps.browserHub ? { hub: deps.browserHub } : {}), ...(deps.browserPoolMembers ? { browserPoolMembers: deps.browserPoolMembers } : {}), ...(deps.browserIdentityExists ? { browserIdentityExists: deps.browserIdentityExists } : {}) });

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
      const names = new Set<string>();
      // One unreadable registry must not blank the other providers: keep this provider's pinned identities.
      const members = deps.poolMembers ? await deps.poolMembers(provider).catch(() => [] as string[]) : [];
      for (const member of members) names.add((await deps.canonical?.(provider, member)) ?? member);
      for (const app of apps) {
        if (app.state === "active" && app.provider === provider && app.target.kind === "pin") {
          names.add((await deps.canonical?.(provider, app.target.identity)) ?? app.target.identity);
        }
      }
      for (const identity of [...names].sort()) {
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
    const now = deps.now();
    const sinceRaw = c.req.query("since");
    const untilRaw = c.req.query("until");
    let since: Date;
    if (sinceRaw !== undefined) {
      since = new Date(sinceRaw);
      if (Number.isNaN(since.getTime())) return err(400, "since must be an ISO date-time");
    } else {
      const days = c.req.query("days") === undefined ? 1 : Number(c.req.query("days"));
      if (!Number.isInteger(days) || days < 1 || days > MAX_USAGE_DAYS) return err(400, `days must be a whole number from 1 to ${MAX_USAGE_DAYS}`);
      since = new Date(now.getTime() - days * 86400_000);
    }
    if (now.getTime() - since.getTime() > MAX_USAGE_DAYS * 86400_000) return err(400, `since must be within ${MAX_USAGE_DAYS} days`);
    let until: Date | undefined;
    if (untilRaw !== undefined) {
      until = new Date(untilRaw);
      if (Number.isNaN(until.getTime())) return err(400, "until must be an ISO date-time");
    }
    const provider = c.req.query("provider");
    if (provider !== undefined && !PROVIDERS.includes(provider as GatewayProvider)) return err(400, "unknown provider");
    const rows = (await store.usageByIdentity(since, until)).filter((r) => provider === undefined || r.provider === provider);
    return c.json({ since: since.toISOString(), ...(until ? { until: until.toISOString() } : {}), identities: rows });
  });

  return hono;
}
