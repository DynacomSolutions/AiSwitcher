import { readProviderGrantCopy } from "./oauth-reconcile.ts";
import { poolStoreDirsFor, refreshIdentityOAuthGrant, type FetchImpl } from "./oauth-refresh.ts";
import type { Identity } from "./types.ts";

/**
 * Cheap live limits for one claude account: a single read-only
 * GET /api/oauth/usage with the account's own access token (the same call
 * Claude Code's /usage makes), instead of spawning `claude -p /usage`.
 * Refreshes first, through the shared oauth-refresh write-through, when the
 * access token has expired.
 */

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_USAGE_BETA = "oauth-2025-04-20";
const USAGE_TIMEOUT_MS = 10_000;
const EXPIRY_SKEW_SECONDS = 60;

export interface UsageWindowReading {
  /** 0-100 */
  utilization: number;
  resetsAt?: string;
}

export interface MemberUsage {
  status: "live" | "rate-limited" | "unavailable";
  fiveHour?: UsageWindowReading;
  sevenDay?: UsageWindowReading;
  /** Highest utilisation of the two windows, when at least one is known. */
  maxUtilization?: number;
  error?: string;
  retryAfterSeconds?: number;
  capturedAt: string;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function window(raw: unknown): UsageWindowReading | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  const utilization = num(rec.utilization);
  if (utilization === undefined) return undefined;
  const resets = rec.resets_at;
  const resetsAt = typeof resets === "string" && Number.isFinite(Date.parse(resets)) ? new Date(resets).toISOString() : undefined;
  return { utilization: Math.min(100, Math.max(0, utilization)), ...(resetsAt ? { resetsAt } : {}) };
}

/** Defensive parse of the usage body: unknown/missing windows are skipped. */
export function parseUsageBody(body: unknown, capturedAt: string = new Date().toISOString()): MemberUsage {
  const rec = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const fiveHour = window(rec.five_hour);
  const sevenDay = window(rec.seven_day);
  const values = [fiveHour?.utilization, sevenDay?.utilization].filter((v): v is number => v !== undefined);
  if (values.length === 0) return { status: "unavailable", error: "usage response carried no five_hour/seven_day utilisation", capturedAt };
  return {
    status: "live",
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    maxUtilization: Math.max(...values),
    capturedAt,
  };
}

export interface FetchUsageDeps {
  fetchImpl?: FetchImpl;
  now?: () => number;
  /** Test hook: claude registry listing swap pools. */
  claudeRegistryPath?: string;
}

/** Freshest stored access token for the account (member store or, while
 * active, the pool store), refreshed first when expired. */
async function usableAccessToken(member: Identity, deps: FetchUsageDeps): Promise<{ token?: string; error?: string }> {
  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const dirs = [member.configDir, ...(await poolStoreDirsFor(member, deps.claudeRegistryPath))];
  const read = async () => {
    let best: { access_token: string; expires_at?: number } | undefined;
    for (const dir of dirs) {
      const copy = await readProviderGrantCopy("claude", dir);
      if (copy && (!best || (copy.grant.expires_at ?? -1) > (best.expires_at ?? -1))) best = copy.grant;
    }
    return best;
  };
  let grant = await read();
  if (!grant) return { error: "no Claude login stored for this account" };
  if (grant.expires_at !== undefined && grant.expires_at - EXPIRY_SKEW_SECONDS <= nowSeconds) {
    const result = await refreshIdentityOAuthGrant("claude", member, {
      // Not forced: under the lock a fresher non-expired grant (rotated by someone else) is kept, not re-rotated.
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.claudeRegistryPath ? { claudeRegistryPath: deps.claudeRegistryPath } : {}),
    }).catch((err: unknown) => ({ outcome: "failed" as const, detail: err instanceof Error ? err.message : String(err) }));
    if (result.outcome !== "refreshed" && result.outcome !== "skipped-fresh") return { error: `token expired and refresh failed: ${result.detail}` };
    grant = await read();
    if (!grant) return { error: "no Claude login stored for this account" };
  }
  return { token: grant.access_token };
}

export async function fetchMemberUsage(member: Identity, deps: FetchUsageDeps = {}): Promise<MemberUsage> {
  const capturedAt = new Date((deps.now?.() ?? Date.now())).toISOString();
  const { token, error } = await usableAccessToken(member, deps);
  if (!token) return { status: "unavailable", error: error ?? "no token", capturedAt };
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": CLAUDE_USAGE_BETA, Accept: "application/json" },
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
    });
  } catch (err) {
    return { status: "unavailable", error: `usage endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`, capturedAt };
  }
  if (response.status === 429) {
    const retry = num(response.headers.get("retry-after"));
    return { status: "rate-limited", error: "usage endpoint answered HTTP 429", ...(retry !== undefined ? { retryAfterSeconds: retry } : {}), capturedAt };
  }
  if (!response.ok) return { status: "unavailable", error: `usage endpoint answered HTTP ${response.status}`, capturedAt };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "unavailable", error: "usage endpoint returned non-JSON", capturedAt };
  }
  return parseUsageBody(body, capturedAt);
}
