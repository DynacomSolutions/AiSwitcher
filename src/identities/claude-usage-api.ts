import { readProviderGrantCopy } from "./oauth-reconcile.ts";
import { poolStoreDirsFor, refreshIdentityOAuthGrant, type FetchImpl } from "./oauth-refresh.ts";
import type { ExtraUsageInfo, ManualResetInfo } from "../cli/limits/types.ts";
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
// No `skip_spend=1`: it makes the server omit `extra_usage`, which limits and the pool extra-usage fallback need.
export const CLAUDE_RESETS_URL = `${CLAUDE_USAGE_URL}?cedar_ember=1`;
// shortcut: the server gates the reset grants on a claude-cli UA (otherwise `ineligible_reason: "surface"`); upgrade if it starts checking the version.
export const CLAUDE_RESETS_USER_AGENT = "claude-cli/2.1.296 (external, cli)";
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
  extraUsage?: ExtraUsageInfo;
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

/** Pure mapping of the `extra_usage` block to an ExtraUsageInfo; undefined when the block is absent. */
export function extraUsageFromBody(body: unknown): ExtraUsageInfo | undefined {
  const block = typeof body === "object" && body !== null ? (body as Record<string, unknown>).extra_usage : undefined;
  if (typeof block !== "object" || block === null) return undefined;
  const rec = block as Record<string, unknown>;
  const enabled = rec.is_enabled === true;
  const limit = num(rec.monthly_limit);
  const used = num(rec.used_credits);
  const raw = num(rec.utilization) ?? (used !== undefined && limit !== undefined && limit > 0 ? (used / limit) * 100 : undefined);
  const usedPercent = raw === undefined ? undefined : Math.min(100, Math.max(0, raw));
  const available = enabled && rec.spend_limit_reached !== true && (usedPercent === undefined || usedPercent < 100);
  return {
    enabled,
    available,
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    label: !enabled ? "extra usage off" : available ? "extra usage" : "out of extra usage",
  };
}

/** Defensive parse of the usage body: unknown/missing windows are skipped. */
export function parseUsageBody(body: unknown, capturedAt: string = new Date().toISOString()): MemberUsage {
  const rec = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const fiveHour = window(rec.five_hour);
  const sevenDay = window(rec.seven_day);
  const values = [fiveHour?.utilization, sevenDay?.utilization].filter((v): v is number => v !== undefined);
  if (values.length === 0) return { status: "unavailable", error: "usage response carried no five_hour/seven_day utilisation", capturedAt };
  const extraUsage = extraUsageFromBody(body);
  return {
    status: "live",
    ...(extraUsage ? { extraUsage } : {}),
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
  const expired = (g: { expires_at?: number }) => g.expires_at !== undefined && g.expires_at - EXPIRY_SKEW_SECONDS <= nowSeconds;
  if (expired(grant)) {
    // Not forced first: under the lock a fresher non-expired grant (rotated by someone else) is kept, not re-rotated.
    // If that skipped (lock busy, or the freshest copy was not a native store) and the stores are still expired, force.
    for (const force of [false, true]) {
      const result = await refreshIdentityOAuthGrant("claude", member, {
        ...(force ? { force: true } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.claudeRegistryPath ? { claudeRegistryPath: deps.claudeRegistryPath } : {}),
      }).catch((err: unknown) => ({ outcome: "failed" as const, detail: err instanceof Error ? err.message : String(err) }));
      if (result.outcome !== "refreshed" && result.outcome !== "skipped-fresh") return { error: `token expired and refresh failed: ${result.detail}` };
      grant = await read();
      if (!grant) return { error: "no Claude login stored for this account" };
      if (!expired(grant)) break;
      if (force) return { error: "token expired and refresh failed: stores still hold an expired grant" };
    }
  }
  return { token: grant.access_token };
}

/** The one shared GET: bearer token plus the beta header, optionally the claude-cli UA the reset grants need. */
function getUsage(token: string, url: string, deps: FetchUsageDeps, cliUserAgent = false): Promise<Response> {
  return (deps.fetchImpl ?? fetch)(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": CLAUDE_USAGE_BETA,
      ...(cliUserAgent ? { "User-Agent": CLAUDE_RESETS_USER_AGENT } : {}),
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
  });
}

/** Raw usage body including the `cedar_ember` reset grants, from one request; `error` on ANY failure (never throws). */
export async function fetchUsageBodyWithResets(
  member: Identity,
  deps: FetchUsageDeps = {},
): Promise<{ body?: unknown; error?: string; status?: number }> {
  try {
    const { token, error } = await usableAccessToken(member, deps);
    if (!token) return { error: error ?? "no token" };
    const response = await getUsage(token, CLAUDE_RESETS_URL, deps, true);
    if (!response.ok) return { error: `usage endpoint answered HTTP ${response.status}`, status: response.status };
    return { body: await response.json() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function fetchMemberUsage(member: Identity, deps: FetchUsageDeps = {}): Promise<MemberUsage> {
  const capturedAt = new Date((deps.now?.() ?? Date.now())).toISOString();
  const { token, error } = await usableAccessToken(member, deps);
  if (!token) return { status: "unavailable", error: error ?? "no token", capturedAt };
  let response: Response;
  try {
    response = await getUsage(token, CLAUDE_USAGE_URL, deps);
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

/**
 * Pure mapping from the `cedar_ember` block of the usage body (what Claude
 * Code's /limit-reset reads) to a ManualResetInfo. Counts `resets_left` over
 * grants that are not paused and not past `ends_at`; zero, an ineligible
 * account or a malformed block yield undefined so nothing renders.
 */
export function manualResetFromCedarEmber(block: unknown, now: number = Date.now()): ManualResetInfo | undefined {
  if (typeof block !== "object" || block === null) return undefined;
  const rec = block as Record<string, unknown>;
  if (rec.eligible !== true || !Array.isArray(rec.grants)) return undefined;
  let count = 0;
  let first: { label?: string; endsAt?: number } | undefined;
  for (const raw of rec.grants) {
    if (typeof raw !== "object" || raw === null) continue;
    const grant = raw as Record<string, unknown>;
    const left = num(grant.resets_left);
    if (left === undefined || left <= 0 || grant.paused === true) continue;
    const endsAt = typeof grant.ends_at === "string" ? Date.parse(grant.ends_at) : Number.NaN;
    if (Number.isFinite(endsAt) && endsAt <= now) continue;
    count += left;
    first ??= { ...(typeof grant.label === "string" && grant.label ? { label: grant.label } : {}), ...(Number.isFinite(endsAt) ? { endsAt } : {}) };
  }
  if (count <= 0) return undefined;
  const expiresAt =
    first?.endsAt !== undefined
      ? new Date(first.endsAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : undefined;
  return { availableCount: count, ...(first?.label ? { label: first.label } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) };
}

/** Spendable usage-limit reset grants for one account; undefined on none or on ANY failure (never throws). */
export async function fetchMemberResets(member: Identity, deps: FetchUsageDeps = {}): Promise<ManualResetInfo | undefined> {
  const { body } = await fetchUsageBodyWithResets(member, deps);
  return manualResetFromCedarEmber((body as { cedar_ember?: unknown } | null)?.cedar_ember, deps.now?.() ?? Date.now());
}
