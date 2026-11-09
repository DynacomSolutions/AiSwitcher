import { ALI_MODELS } from "../identities/ali-auth.ts";
import type { GatewayDeps } from "./app.ts";
import { providerError } from "./errors.ts";
import { adapterFor } from "./providers/index.ts";
import { upstreamHeaders } from "./app.ts";
import { CODEX_UPSTREAM_BASE } from "./providers/codex.ts";
import { KIMI_ANTHROPIC_BASE } from "./providers/kimi.ts";
import { allowedMembers, memberUsages, utilisationOf } from "./select.ts";
import type { ApiStyle, GatewayApp, GatewayProvider } from "./types.ts";

/**
 * Routes that are not a plain "app prefix, then the same path on the provider" pass-through.
 *
 * - `upstream`: the request is forwarded (same credential, pool, failover, ledger and metrics as a chat call) but to a
 *   different provider URL than the pass-through would build. `side` marks a call that is not a model call: an
 *   app's model allowlist does not apply to it, and its 401/429/402/403 answers are passed through untouched (no forced login
 *   refresh, no pool hold or failover), so an unverified side route can never disable a login chat calls depend on. The
 *   daily token cap still applies, and these calls
 *   are also counted per app against SIDE_DAILY_LIMIT_DEFAULT requests a day (no token rows are invented for them).
 * - `serve`: the gateway answers itself from its own pool state. No account token and no account identity leaves the gateway.
 *
 * Sources for the provider paths:
 * - models: Anthropic `/v1/models`; Codex `<backend-api/codex>/models` (what the codex CLI calls); the OpenAI-style bases
 *   of kimi, zai, grok and opencode all expose `/models` under their base. ali's Token plan has no model-list endpoint
 *   (see ALI_MODELS in src/identities/ali-auth.ts), so the gateway lists the models AIS knows.
 * - kimi search and fetch: `<coding/v1>/search` and `<coding/v1>/fetch`, the services kimi-cli's SearchWeb and FetchURL
 *   tools call with the same OAuth bearer. Not proven live from this host (no kimi-cli installed): Task 9 style TODO.
 * - speech to text: ChatGPT's `backend-api/transcribe`, the endpoint behind ChatGPT dictation for a ChatGPT login (multipart
 *   audio, bytes passed through untouched). Named from memory of the ChatGPT backend, not present in the installed codex
 *   0.145 binary, and not proven live.
 * - Codex reset credits: `/wham/rate-limit-reset-credits` (also `/api/codex/...`), taken from the strings of the installed
 *   codex binary; its summary carries `available_count`.
 */
export type Route =
  | { kind: "upstream"; url: string; side: boolean }
  | { kind: "serve"; name: ServedName };

export type ServedName = "claude-usage" | "claude-profile" | "codex-reset-credits" | "codex-reset-consume" | "ali-models";

/** Side and served requests an app may make per day, counted apart from tokens. AIS_GATEWAY_SIDE_DAILY_LIMIT overrides. */
export const SIDE_DAILY_LIMIT_DEFAULT = 5_000;

export function sideDailyLimitFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.AIS_GATEWAY_SIDE_DAILY_LIMIT ?? "");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : SIDE_DAILY_LIMIT_DEFAULT;
}

/** Repeated slashes collapsed, so a rule and the path sent upstream agree ("/api//oauth" is "/api/oauth"). */
export function collapseSlashes(path: string): string {
  return path.replace(/\/{2,}/g, "/");
}

/** How long a codex reset-credit total is reused for one app. */
export const RESET_CREDITS_TTL_MS = 60_000;
const RESET_CREDITS_FAILURE_TTL_MS = 15_000;

/**
 * Claude account detail the gateway never lets an app read with a pool member's login. Only these are refused; every other
 * `/api/*` path (hello, settings, telemetry, other oauth/claude_cli calls) passes through as before. The gateway serves
 * `/api/oauth/usage` and `/api/oauth/profile` itself. Refused, below `/api/`:
 *   oauth/{profile,account,userinfo,organization(s),roles}, oauth/claude_cli/{roles,profile,account,organization(s)},
 *   claude_cli_profile, organization(s), account, bootstrap, me.
 * The path is matched after slash collapsing, repeated percent-decoding, lower-casing and dropping `;params`.
 */
const CLAUDE_ACCOUNT_PATH = /^\/api\/(?:oauth\/(?:(?:profile|account|userinfo|organizations?|roles)|claude_cli\/(?:roles|profile|account|organizations?))|claude_cli_profile|organizations?|account|bootstrap|me)(?:\/|$)/;

export function isClaudeAccountPath(rest: string): boolean {
  let p = rest;
  for (let i = 0; i < 4; i++) {
    const norm = collapseSlashes(p).replace(/;[^/]*/g, "").toLowerCase();
    if (CLAUDE_ACCOUNT_PATH.test(norm)) return true;
    let next: string;
    try {
      next = decodeURIComponent(p);
    } catch {
      return true; // undecodable: cannot be shown safe
    }
    if (next === p) return false;
    p = next;
  }
  return CLAUDE_ACCOUNT_PATH.test(collapseSlashes(p).replace(/;[^/]*/g, "").toLowerCase());
}

const CODEX_BACKEND = "https://chatgpt.com/backend-api";
const KIMI_V1 = `${KIMI_ANTHROPIC_BASE}/v1`;

/** The model-list URL for a provider, or "serve" when the gateway answers itself. `id` is "" or "/<model id>". */
function modelsRoute(provider: GatewayProvider, style: ApiStyle, id: string): Route | undefined {
  switch (provider) {
    case "claude":
      return { kind: "upstream", url: `${adapterFor("claude").upstreamBase(style)}/v1/models${id}`, side: true };
    case "codex":
      // The Codex backend lists models only as a collection.
      return id === "" ? { kind: "upstream", url: `${CODEX_UPSTREAM_BASE}/models`, side: true } : undefined;
    case "kimi":
      return { kind: "upstream", url: `${KIMI_V1}/models${id}`, side: true };
    case "ali":
      return id === "" ? { kind: "serve", name: "ali-models" } : undefined;
    case "zai":
    case "grok":
    case "opencode": {
      const base = adapterFor(provider).upstreamBase(style);
      // An Anthropic-style base has no /v1 of its own; an OpenAI-style one does (or is versioned, as zai's /v4).
      return { kind: "upstream", url: `${base}${style === "anthropic" ? "/v1" : ""}/models${id}`, side: true };
    }
  }
}

/** Decides whether `rest` (the path after the app name) is one of the special routes. Undefined: plain pass-through. */
export function routeFor(provider: GatewayProvider, style: ApiStyle, method: string, rest: string): Route | undefined {
  const m = method.toUpperCase();
  const path = rest.length > 1 && rest.endsWith("/") ? rest.slice(0, -1) : rest;
  if (m === "GET") {
    const models = /^(?:\/v1)?\/models(\/[^/]+)?$/.exec(path);
    if (models) return modelsRoute(provider, style, models[1] ?? "");
    if (provider === "claude" && path === "/api/oauth/usage") return { kind: "serve", name: "claude-usage" };
    if (provider === "claude" && path === "/api/oauth/profile") return { kind: "serve", name: "claude-profile" };
    if (provider === "codex" && /^(?:\/api\/codex|\/wham)?\/rate-limit-reset-credits$/.test(path)) return { kind: "serve", name: "codex-reset-credits" };
  }
  if (m === "POST") {
    if (provider === "kimi") {
      const k = /^(?:\/v1)?\/(search|fetch)$/.exec(path);
      if (k) return { kind: "upstream", url: `${KIMI_V1}/${k[1]}`, side: true };
    }
    if (provider === "codex") {
      if (/^(?:\/v1)?\/audio\/transcriptions$|^\/transcribe$/.test(path)) return { kind: "upstream", url: `${CODEX_BACKEND}/transcribe`, side: true };
      if (/^(?:\/api\/codex|\/wham)?\/rate-limit-reset-credits\/consume$/.test(path)) return { kind: "serve", name: "codex-reset-consume" };
    }
  }
  return undefined;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export interface ResetCreditsCache {
  [app: string]: { until: number; status: number; body: string } | undefined;
}

export interface ServeContext {
  app: GatewayApp;
  /** Per-app memory of the last reset-credit answer (owned by the gateway app). */
  cache: ResetCreditsCache;
  style: ApiStyle;
  deps: GatewayDeps;
  signal: AbortSignal;
}

/** Answers a `serve` route. The result never contains a token, a login identity or an upstream error body. */
export async function serveRoute(name: ServedName, ctx: ServeContext): Promise<Response> {
  switch (name) {
    case "ali-models":
      return json({
        data: ALI_MODELS.map((m) => ({ type: "model", id: m.id, display_name: m.name, created_at: "1970-01-01T00:00:00Z" })),
        has_more: false,
        first_id: ALI_MODELS[0]?.id ?? null,
        last_id: ALI_MODELS[ALI_MODELS.length - 1]?.id ?? null,
      });
    case "claude-profile":
      // Only the app's own name: the pool's account details are never shown to an app.
      return json({ account: { uuid: null, full_name: ctx.app.name, display_name: ctx.app.name, email: null }, organization: { uuid: null, name: ctx.app.name } });
    case "claude-usage":
      return json(await claudeUsageBody(ctx));
    case "codex-reset-credits":
      return codexResetCredits(ctx);
    case "codex-reset-consume":
      return providerError(ctx.style, 403, "reset credits cannot be spent through the gateway");
  }
}

/** The two windows of the member the pool would route to (lowest utilisation), in the shape of Anthropic's usage endpoint. */
async function claudeUsageBody(ctx: ServeContext): Promise<Record<string, unknown>> {
  const readings = (await memberUsages(ctx.app, ctx.deps)).filter((u) => u !== undefined && utilisationOf(u) !== undefined);
  let best = readings[0];
  for (const u of readings) if ((utilisationOf(u) ?? 0) < (utilisationOf(best) ?? 0)) best = u;
  const win = (label: string): { utilization: number; resets_at: string | null } | null => {
    const w = best?.windows?.find((x) => x.label === label);
    return w ? { utilization: w.utilization, resets_at: w.resetsAt ?? null } : null;
  };
  return { five_hour: win("five-hour"), seven_day: win("seven-day"), seven_day_opus: null, seven_day_sonnet: null, extra_usage: null };
}

const CODEX_RESET_URL = `${CODEX_BACKEND}/wham/rate-limit-reset-credits`;

function availableCount(body: unknown): number | undefined {
  const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined);
  const top = obj(body);
  const n = top?.available_count ?? obj(top?.rate_limit_reset_credits)?.available_count;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/** Reset credits, remembered per app for RESET_CREDITS_TTL_MS so an app polling it cannot drive one upstream call per member per poll. */
async function codexResetCredits(ctx: ServeContext): Promise<Response> {
  const nowMs = ctx.deps.now().getTime();
  const hit = ctx.cache[ctx.app.name];
  if (hit && hit.until > nowMs) return new Response(hit.body, { status: hit.status, headers: { "content-type": "application/json" } });
  const res = await readResetCredits(ctx);
  const body = await res.clone().text();
  ctx.cache[ctx.app.name] = { until: nowMs + (res.ok ? RESET_CREDITS_TTL_MS : RESET_CREDITS_FAILURE_TTL_MS), status: res.status, body };
  return res;
}

/** Sums the unspent reset credits over the members the app may use. Each is read by the gateway with its own login; only the total is returned. */
async function readResetCredits(ctx: ServeContext): Promise<Response> {
  const adapter = adapterFor("codex");
  let names: string[];
  try {
    names = await allowedMembers(ctx.app, ctx.deps);
  } catch {
    return providerError(ctx.style, 502, "reset credits unavailable");
  }
  let total = 0;
  let known = 0;
  await Promise.all(
    names.map(async (name) => {
      try {
        const cred = await ctx.deps.creds.get("codex", name);
        const res = await ctx.deps.fetch(CODEX_RESET_URL, { method: "GET", headers: upstreamHeaders(adapter, cred, new Headers({ accept: "application/json" })), signal: ctx.signal, redirect: "manual" });
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          return;
        }
        const n = availableCount(await res.json().catch(() => undefined));
        if (n !== undefined) {
          total += n;
          known += 1;
        }
      } catch {
        // This member's figure is unknown; the others still count.
      }
    }),
  );
  if (names.length > 0 && known === 0) return providerError(ctx.style, 502, "reset credits unavailable");
  return json({ available_count: total });
}
