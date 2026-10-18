import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readProviderGrantCopy } from "./oauth-reconcile.ts";
import { poolStoreDirsFor, refreshIdentityOAuthGrant, type FetchImpl } from "./oauth-refresh.ts";
import type { ExtraUsageInfo, ManualResetInfo } from "../cli/limits/types.ts";
import type { Identity } from "./types.ts";
import { aisCacheDir } from "../shared/ais-home.ts";
import { loadLastGood, saveLastGood, windowsFromUsageBody } from "../cli/limits/claude-limits.ts";

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
// Every pool member is read by many processes (daemon, hooks, one ais-usage poller per session); share reads and 429 backoff via cacheDir.
const FRESH_READ_TTL_MS = 60_000;
const DEFAULT_BACKOFF_SECONDS = 120;
const MAX_BACKOFF_SECONDS = 15 * 60;

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
  /** Test hook: where the per-member last-good read (shared with `ais limits`) lives. */
  cacheDir?: string;
}

function backoffPath(member: Identity, cacheDir: string): string {
  return join(cacheDir, "claude-usage-backoff", `${encodeURIComponent(member.name)}.json`);
}

/** Epoch ms until which the member's usage endpoint must not be called; 0 when not backing off. */
async function backoffUntil(member: Identity, cacheDir: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(backoffPath(member, cacheDir), "utf8")) as { until?: unknown };
    return typeof parsed.until === "number" ? parsed.until : 0;
  } catch {
    return 0;
  }
}

async function recordBackoff(member: Identity, cacheDir: string, nowMs: number, retrySeconds: number | undefined): Promise<number> {
  const seconds = Math.min(MAX_BACKOFF_SECONDS, retrySeconds !== undefined && retrySeconds > 0 ? retrySeconds : DEFAULT_BACKOFF_SECONDS);
  const path = backoffPath(member, cacheDir);
  try {
    await mkdir(join(cacheDir, "claude-usage-backoff"), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ until: nowMs + seconds * 1000 }));
    await rename(tmp, path);
  } catch {
    // Bookkeeping only; never fail a fetch over it.
  }
  return seconds;
}

const clearBackoff = (member: Identity, cacheDir: string) => rm(backoffPath(member, cacheDir), { force: true }).catch(() => {});

/** Rebuilds a live MemberUsage from the shared last-good read (session and week windows only); undefined when it holds neither. */
function usageFromLastGood(last: Awaited<ReturnType<typeof loadLastGood>>): MemberUsage | undefined {
  if (!last?.capturedAt) return undefined;
  const reading = (label: string): UsageWindowReading | undefined => {
    const w = last.windows.find((x) => x.label === label);
    return w ? { utilization: Math.min(100, Math.max(0, w.usedPercent)), ...(w.resetsAtMs !== undefined ? { resetsAt: new Date(w.resetsAtMs).toISOString() } : {}) } : undefined;
  };
  const fiveHour = reading("session (5h)");
  const sevenDay = reading("week (all)");
  const values = [fiveHour?.utilization, sevenDay?.utilization].filter((v): v is number => v !== undefined);
  if (values.length === 0) return undefined;
  return {
    status: "live",
    ...(last.extraUsage ? { extraUsage: last.extraUsage } : {}),
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    maxUtilization: Math.max(...values),
    capturedAt: last.capturedAt,
  };
}

/** A last-good live read younger than the TTL, shared across processes. */
export async function freshLastGood(member: Identity, cacheDir: string, nowMs: number) {
  const last = await loadLastGood(member, cacheDir);
  const age = nowMs - Date.parse(last?.capturedAt ?? "");
  return last?.status === "live" && age >= 0 && age < FRESH_READ_TTL_MS ? last : undefined;
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
    const cacheDir = deps.cacheDir ?? aisCacheDir();
    const nowMs = deps.now?.() ?? Date.now();
    if ((await backoffUntil(member, cacheDir)) > nowMs) return { error: "usage endpoint answered HTTP 429", status: 429 };
    const { token, error } = await usableAccessToken(member, deps);
    if (!token) return { error: error ?? "no token" };
    const response = await getUsage(token, CLAUDE_RESETS_URL, deps, true);
    if (response.status === 429) await recordBackoff(member, cacheDir, nowMs, num(response.headers.get("retry-after")));
    if (!response.ok) return { error: `usage endpoint answered HTTP ${response.status}`, status: response.status };
    await clearBackoff(member, cacheDir);
    return { body: await response.json() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// Extra usage is a monthly balance and changes slowly, so a read up to 6 hours old still decides well.
const EXTRA_USAGE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Live reads refresh the shared last-good file; rate-limited/failed reads inherit its fresh-enough extra usage, marked stale. */
export async function fetchMemberUsage(member: Identity, deps: FetchUsageDeps = {}): Promise<MemberUsage> {
  const cacheDir = deps.cacheDir ?? aisCacheDir();
  const usage = await readMemberUsage(member, deps, cacheDir);
  if (usage.status === "live") return usage;
  const last = await loadLastGood(member, cacheDir);
  const age = Date.parse(usage.capturedAt) - Date.parse(last?.capturedAt ?? "");
  if (!last?.extraUsage || !(age <= EXTRA_USAGE_MAX_AGE_MS)) return usage;
  return { ...usage, extraUsage: { ...last.extraUsage, stale: true, capturedAt: last.capturedAt } };
}

async function readMemberUsage(member: Identity, deps: FetchUsageDeps, cacheDir: string): Promise<MemberUsage> {
  const nowMs = deps.now?.() ?? Date.now();
  const capturedAt = new Date(nowMs).toISOString();
  const fresh = usageFromLastGood(await freshLastGood(member, cacheDir, nowMs));
  if (fresh) return fresh;
  const until = await backoffUntil(member, cacheDir);
  if (until > nowMs) {
    const last = usageFromLastGood(await loadLastGood(member, cacheDir));
    // extraUsage is left out: fetchMemberUsage re-adds it with its 6h age rule.
    const { status: _live, error: _e, capturedAt: _c, extraUsage: _x, ...data } = last ?? { status: "live" as const, capturedAt };
    return { ...data, status: "rate-limited", error: "usage endpoint answered HTTP 429", retryAfterSeconds: Math.ceil((until - nowMs) / 1000), capturedAt };
  }
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
    await recordBackoff(member, cacheDir, nowMs, retry);
    return { status: "rate-limited", error: "usage endpoint answered HTTP 429", ...(retry !== undefined ? { retryAfterSeconds: retry } : {}), capturedAt };
  }
  if (!response.ok) return { status: "unavailable", error: `usage endpoint answered HTTP ${response.status}`, capturedAt };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "unavailable", error: "usage endpoint returned non-JSON", capturedAt };
  }
  const usage = parseUsageBody(body, capturedAt);
  await clearBackoff(member, cacheDir);
  if (usage.status === "live") {
    // Keep ais limits' extra fields (overage, manual reset); replace what this read knows.
    const { extraUsage: _old, ...prev } = (await loadLastGood(member, cacheDir)) ?? { toolName: "claude" as const };
    await saveLastGood(member, { ...prev, toolName: "claude", identity: member, windows: windowsFromUsageBody(body), status: "live", capturedAt, ...(usage.extraUsage ? { extraUsage: usage.extraUsage } : {}) }, cacheDir);
  }
  return usage;
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
