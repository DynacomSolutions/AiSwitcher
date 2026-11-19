import { readSecretsKey } from "../cli/gateway/secrets-file.ts";
import type { IdentityUsageRow, ModelDailyUsageRow, ModelUsageRow } from "./types.ts";

/** One row of the admin `GET /usage` answer: an app's tokens over a window. */
export interface GatewayAppUsage {
  app: string;
  provider: string;
  days: number;
  tokens: number;
}

export interface GatewayUsageView {
  /** False when no admin URL and token are available to this process. */
  configured: boolean;
  rows: GatewayAppUsage[];
  /** Short reason when the admin API could not be read; never carries a token. */
  error?: string;
}

/** Maps the admin `GET /usage` body to rows, dropping malformed entries and sorting by tokens. */
export function mapGatewayUsage(json: unknown): GatewayAppUsage[] {
  const list = (json as { usage?: unknown } | null | undefined)?.usage;
  if (!Array.isArray(list)) return [];
  const rows: GatewayAppUsage[] = [];
  for (const raw of list) {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r.app !== "string" || r.app === "") continue;
    const tokens = Number(r.tokens ?? 0);
    const days = Number(r.days ?? 0);
    rows.push({
      app: r.app,
      provider: typeof r.provider === "string" ? r.provider : "",
      days: Number.isFinite(days) ? days : 0,
      tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : 0,
    });
  }
  return rows.sort((a, b) => b.tokens - a.tokens || a.app.localeCompare(b.app));
}

/** The text section appended to `ais usage`. Empty string when there is nothing to say. */
export function formatGatewayUsageSection(view: GatewayUsageView): string {
  if (!view.configured) return "";
  const lines = ["", "Gateway apps"];
  if (view.error) {
    lines.push(`  unavailable: ${view.error}`);
    return lines.join("\n");
  }
  if (view.rows.length === 0) {
    lines.push("  no gateway apps");
    return lines.join("\n");
  }
  const days = view.rows[0]!.days;
  const head = ["APP", "PROVIDER", `TOKENS (${days}d)`];
  const body = view.rows.map((r) => [r.app, r.provider, r.tokens.toLocaleString("en-GB")]);
  const all = [head, ...body];
  const widths = head.map((_, i) => Math.max(...all.map((r) => r[i]!.length)));
  for (const r of all) lines.push("  " + r.map((c, i) => (i === 2 ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join("  ").trimEnd());
  return lines.join("\n");
}

export interface LoadGatewayUsageDeps {
  fetch?: typeof fetch;
  secretsPath?: string;
  timeoutMs?: number;
}

/**
 * Reads per-app usage from the gateway admin API. Credentials come from ~/.secrets
 * (AIS_GATEWAY_ADMIN_URL, AIS_GATEWAY_ADMIN_TOKEN) or the same env names. Failures
 * come back as a short `error`, never thrown, so a down gateway cannot break `ais usage`
 * or the console.
 */
export async function loadGatewayUsage(days: number, deps: LoadGatewayUsageDeps = {}): Promise<GatewayUsageView> {
  const url = (await readSecretsKey("AIS_GATEWAY_ADMIN_URL", deps.secretsPath)) ?? process.env.AIS_GATEWAY_ADMIN_URL;
  const token = (await readSecretsKey("AIS_GATEWAY_ADMIN_TOKEN", deps.secretsPath)) ?? process.env.AIS_GATEWAY_ADMIN_TOKEN;
  if (!url || !token) return { configured: false, rows: [] };
  const doFetch = deps.fetch ?? fetch;
  try {
    const res = await doFetch(`${url.replace(/\/+$/, "")}/usage?days=${encodeURIComponent(String(days))}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
    });
    if (!res.ok) return { configured: true, rows: [], error: `admin answered ${res.status}` };
    return { configured: true, rows: mapGatewayUsage(await res.json()) };
  } catch {
    return { configured: true, rows: [], error: "admin unreachable" };
  }
}

export interface GatewayIdentityUsageView {
  configured: boolean;
  rows: IdentityUsageRow[];
  error?: string;
}

/** Maps the admin `GET /usage/identities` body to rows, dropping malformed entries. */
export function mapGatewayIdentityUsage(json: unknown): IdentityUsageRow[] {
  const list = (json as { identities?: unknown } | null | undefined)?.identities;
  if (!Array.isArray(list)) return [];
  const n = (v: unknown): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  const rows: IdentityUsageRow[] = [];
  for (const raw of list) {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r.identity !== "string" || r.identity === "" || typeof r.provider !== "string") continue;
    rows.push({
      provider: r.provider,
      identity: r.identity,
      app: typeof r.app === "string" ? r.app : "",
      inputTokens: n(r.inputTokens),
      outputTokens: n(r.outputTokens),
      cacheReadTokens: n(r.cacheReadTokens),
      cacheWriteTokens: n(r.cacheWriteTokens),
      estCostUsd: n(r.estCostUsd),
      unpricedRequests: n(r.unpricedRequests),
      requests: n(r.requests),
    });
  }
  return rows;
}

/** Ledger totals per provider and identity since `since`, from the admin API. Failures come back as a short `error`, never thrown. */
export async function loadGatewayIdentityUsage(since: Date, deps: LoadGatewayUsageDeps = {}): Promise<GatewayIdentityUsageView> {
  const url = (await readSecretsKey("AIS_GATEWAY_ADMIN_URL", deps.secretsPath)) ?? process.env.AIS_GATEWAY_ADMIN_URL;
  const token = (await readSecretsKey("AIS_GATEWAY_ADMIN_TOKEN", deps.secretsPath)) ?? process.env.AIS_GATEWAY_ADMIN_TOKEN;
  if (!url || !token) return { configured: false, rows: [] };
  const doFetch = deps.fetch ?? fetch;
  try {
    const res = await doFetch(`${url.replace(/\/+$/, "")}/usage/identities?since=${encodeURIComponent(since.toISOString())}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
    });
    if (!res.ok) return { configured: true, rows: [], error: res.status === 404 ? "gateway admin has no per-identity usage yet (older version)" : `admin answered ${res.status}` };
    return { configured: true, rows: mapGatewayIdentityUsage(await res.json()) };
  } catch {
    return { configured: true, rows: [], error: "admin unreachable" };
  }
}

export interface GatewayModelUsageView {
  configured: boolean;
  rows: ModelUsageRow[];
  /** Per-day rows over the same window as `rows`, bucketed in `dailyZone`. Absent when the daily route failed (`dailyError` says why). */
  daily?: ModelDailyUsageRow[];
  dailyZone?: string;
  dailyError?: string;
  error?: string;
}

/** Maps the admin `GET /usage/models/daily` body to rows, dropping malformed entries. */
export function mapGatewayModelDaily(json: unknown): ModelDailyUsageRow[] {
  const list = (json as { days?: unknown } | null | undefined)?.days;
  if (!Array.isArray(list)) return [];
  const n = (v: unknown): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  const rows: ModelDailyUsageRow[] = [];
  for (const raw of list) {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || typeof r.identity !== "string" || r.identity === "" || typeof r.provider !== "string") continue;
    rows.push({
      day: r.day,
      provider: r.provider,
      identity: r.identity,
      model: typeof r.model === "string" && r.model !== "" ? r.model : null,
      inputTokens: n(r.inputTokens),
      outputTokens: n(r.outputTokens),
      cacheReadTokens: n(r.cacheReadTokens),
      cacheWriteTokens: n(r.cacheWriteTokens),
      estCostUsd: n(r.estCostUsd),
      unpricedRequests: n(r.unpricedRequests),
      requests: n(r.requests),
    });
  }
  return rows;
}

export interface LoadGatewayModelUsageDeps extends LoadGatewayUsageDeps {
  /** IANA zone the per-day rows are bucketed in; the same zone the host usage view buckets in. Default UTC. */
  zone?: string;
  now?: () => Date;
}

/** Maps the admin `GET /usage/models` body to rows, dropping malformed entries. A missing model stays null (its tokens still count). */
export function mapGatewayModelUsage(json: unknown): ModelUsageRow[] {
  const list = (json as { models?: unknown } | null | undefined)?.models;
  if (!Array.isArray(list)) return [];
  const n = (v: unknown): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  const rows: ModelUsageRow[] = [];
  for (const raw of list) {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r.identity !== "string" || r.identity === "" || typeof r.provider !== "string") continue;
    rows.push({
      provider: r.provider,
      identity: r.identity,
      app: typeof r.app === "string" ? r.app : "",
      model: typeof r.model === "string" && r.model !== "" ? r.model : null,
      inputTokens: n(r.inputTokens),
      outputTokens: n(r.outputTokens),
      cacheReadTokens: n(r.cacheReadTokens),
      cacheWriteTokens: n(r.cacheWriteTokens),
      estCostUsd: n(r.estCostUsd),
      unpricedRequests: n(r.unpricedRequests),
      requests: n(r.requests),
      ...(typeof r.firstTs === "string" ? { firstTs: r.firstTs } : {}),
      ...(typeof r.lastTs === "string" ? { lastTs: r.lastTs } : {}),
    });
  }
  return rows;
}

/**
 * Ledger totals per provider, identity, app and model over the last `days`, plus the per-day split, from the admin API.
 * Both reads use one fixed `since`, so day sums equal the totals. A failed totals read is the view's `error`; a failed
 * daily read only sets `dailyError` (the totals still show, without day history). Never throws.
 */
export async function loadGatewayModelUsage(days: number, deps: LoadGatewayModelUsageDeps = {}): Promise<GatewayModelUsageView> {
  const url = (await readSecretsKey("AIS_GATEWAY_ADMIN_URL", deps.secretsPath)) ?? process.env.AIS_GATEWAY_ADMIN_URL;
  const token = (await readSecretsKey("AIS_GATEWAY_ADMIN_TOKEN", deps.secretsPath)) ?? process.env.AIS_GATEWAY_ADMIN_TOKEN;
  if (!url || !token) return { configured: false, rows: [] };
  const doFetch = deps.fetch ?? fetch;
  const base = url.replace(/\/+$/, "");
  // A minute inside the admin's 90-day bound, so clock skew between the console and the gateway never gives a 400.
  const since = encodeURIComponent(new Date((deps.now?.() ?? new Date()).getTime() - days * 86400_000 + 60_000).toISOString());
  const zone = deps.zone ?? "UTC";
  const get = (path: string) => doFetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000) });
  try {
    const [res, dailyRes] = await Promise.all([
      get(`/usage/models?since=${since}`),
      get(`/usage/models/daily?since=${since}&tz=${encodeURIComponent(zone)}`).catch(() => undefined),
    ]);
    if (!res.ok) return { configured: true, rows: [], error: res.status === 404 ? "gateway admin has no per-model usage yet (older version)" : `admin answered ${res.status}` };
    const rows = mapGatewayModelUsage(await res.json());
    if (dailyRes?.ok) return { configured: true, rows, daily: mapGatewayModelDaily(await dailyRes.json()), dailyZone: zone };
    return { configured: true, rows, dailyError: !dailyRes ? "admin unreachable" : dailyRes.status === 404 ? "gateway admin has no per-day usage yet (older version)" : `admin answered ${dailyRes.status}` };
  } catch {
    return { configured: true, rows: [], error: "admin unreachable" };
  }
}
