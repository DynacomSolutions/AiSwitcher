import { readSecretsKey } from "../cli/gateway/secrets-file.ts";
import type { IdentityUsageRow } from "./types.ts";

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
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
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
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
    });
    if (!res.ok) return { configured: true, rows: [], error: res.status === 404 ? "gateway admin has no per-identity usage yet (older version)" : `admin answered ${res.status}` };
    return { configured: true, rows: mapGatewayIdentityUsage(await res.json()) };
  } catch {
    return { configured: true, rows: [], error: "admin unreachable" };
  }
}
