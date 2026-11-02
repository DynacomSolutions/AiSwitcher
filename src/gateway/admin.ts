import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { GatewayStore } from "./store.ts";
import { adapterFor } from "./providers/index.ts";
import { generateToken } from "./tokens.ts";
import type { ApiStyle, GatewayApp, GatewayProvider, TokenRecord } from "./types.ts";

export const DEFAULT_OVERLAP_MS = 24 * 3600_000;
const MAX_OVERLAP_HOURS = 24 * 30;
const MAX_USAGE_DAYS = 90;

const PROVIDERS: readonly GatewayProvider[] = ["claude", "codex", "kimi", "grok", "zai", "ali", "opencode"];
const STYLES: readonly ApiStyle[] = ["anthropic", "openai"];
/** Paths the proxy port answers itself; an app of this name could never be reached. */
const RESERVED_NAMES = new Set(["healthz", "readyz", "metrics"]);
/** A DNS-1123 label: the name becomes a URL path segment and may become a Kubernetes label. */
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** Providers that speak one API style only; the others (kimi, zai) offer both. */
const FIXED_STYLE: Partial<Record<GatewayProvider, ApiStyle>> = { claude: "anthropic", ali: "anthropic", codex: "openai", grok: "openai", opencode: "openai" };

export type IdentityState = "ok" | "missing" | "retired";

export interface AdminDeps {
  store: GatewayStore;
  adminToken: string;
  now(): Date;
  overlapMs?: number;
  /** Looks an identity up in the AIS registry. When absent, identities are not checked. */
  identityState?(provider: GatewayProvider, identity: string): Promise<IdentityState>;
}

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
  const hono = new Hono();
  const err = (status: 400 | 401 | 404 | 409 | 500 | 503, message: string): Response => Response.json({ error: message }, { status });

  hono.use("*", async (c, next) => {
    if (!deps.adminToken || !sameSecret(bearer(c.req.raw), deps.adminToken)) return err(401, "admin token required");
    return next();
  });
  hono.onError(() => err(503, "store unavailable"));

  hono.get("/apps", async (c) => {
    const apps = await store.listApps();
    return c.json({ apps: await Promise.all(apps.map((a) => appView(store, a))) });
  });

  hono.get("/apps/:name", async (c) => {
    const app = await store.getApp(c.req.param("name"));
    return app ? c.json(await appView(store, app)) : err(404, "no such app");
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
    try {
    for (const identity of parsed.target.kind === "pin" ? [parsed.target.identity] : (parsed.target.identities ?? [])) {
      const state = (await deps.identityState?.(parsed.provider, identity)) ?? "ok";
      if (state !== "ok") return err(400, `identity "${identity}" is ${state === "retired" ? "retired" : "not a known"} ${parsed.provider} identity`);
    }
    } catch {
      return err(500, "identity registry unreadable");
    }
    const existing = await store.getApp(name);
    const app: GatewayApp = {
      ...parsed,
      name,
      state: existing?.state ?? "active",
      createdAt: existing?.createdAt ?? deps.now().toISOString(),
      ...(existing?.lastUsedAt !== undefined ? { lastUsedAt: existing.lastUsedAt } : {}),
    };
    await store.putApp(app);
    return c.json(await appView(store, app), existing ? 200 : 201);
  });

  hono.post("/apps/:name/tokens", async (c) => {
    const name = c.req.param("name");
    const app = await store.getApp(name);
    if (!app) return err(404, "no such app");
    if (app.state !== "active") return err(409, "app is revoked");
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
    await store.expireTokens(name, previousExpiresAt);
    const t = generateToken();
    await store.addToken({ app: name, prefix: t.prefix, hash: t.hash, createdAt: now.toISOString() });
    // The only time the token is ever returned.
    return c.json({ app: name, token: t.token, prefix: t.prefix, previousTokensExpireAt: previousExpiresAt }, 201);
  });

  hono.post("/apps/:name/revoke", async (c) => {
    const name = c.req.param("name");
    if (!(await store.getApp(name))) return err(404, "no such app");
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
    const apps = (await store.listApps()).filter((a) => (appFilter === undefined || a.name === appFilter) && (providerFilter === undefined || a.provider === providerFilter));
    const usage = await Promise.all(apps.map(async (a) => ({ app: a.name, provider: a.provider, days, tokens: await store.usageSince(a.name, since) })));
    return c.json({ usage });
  });

  return hono;
}
