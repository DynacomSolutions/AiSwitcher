import type { PoolUsage } from "../identities/pool/adapter.ts";
import { formatLimitTimes } from "../shared/limit-times.ts";
import { GATEWAY_ERROR_HEADER, GATEWAY_MESSAGE_PREFIX, limitError } from "./errors.ts";
import type { ApiStyle, GatewayProvider } from "./types.ts";

/**
 * Provider-native "you are out of capacity" answers. Claude Code and Codex CLI decide whether to show their built-in
 * wait/continue prompt (and when to resume) from the provider's own 429 shape, not from a generic gateway error:
 *   - Claude Code reads `anthropic-ratelimit-unified-status|reset|representative-claim|5h-*|7d-*|overage-*` and `retry-after`.
 *   - Codex reads the `usage_limit_reached` error body (`resets_at`, `resets_in_seconds`) and the `x-codex-*` headers.
 * The message text also ends in `Resets at <ISO>Z.` (see `limitMessage`): T3 Code (OpenCode driver) reads the reset time only
 * from the text, to snooze a thread and wake it again.
 */

/** Used when no member carries a reset time: long enough not to hammer, short enough to recover soon. */
export const FALLBACK_RESET_SECONDS = 300;

export type LimitSlot = "short" | "long";

export interface LimitWindow {
  slot: LimitSlot;
  /** Percent, 0 to 100 or more. */
  utilization: number;
  /** Epoch seconds, when known. */
  resetsAtSec?: number;
}

export interface LimitInfo {
  /** Epoch seconds the earliest member becomes usable again. */
  resetAtSec: number;
  /** True when `resetAtSec` is a guess because no member reported a reset. */
  guessed: boolean;
  /** The window that blocks the member that frees up first. */
  claim: LimitSlot;
  /** Both windows of that member, when known. */
  windows: LimitWindow[];
}

function slotOf(label: string): LimitSlot | undefined {
  const l = label.toLowerCase();
  if (/(five|5h|session|~[1-5]h|hour)/.test(l)) return "short";
  if (/(seven|7d|week|month|day|~\d+d)/.test(l)) return "long";
  return undefined;
}

function parseReset(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const asNumber = Number(v);
  const ms = Number.isFinite(asNumber) && /^\d+(\.\d+)?$/.test(v.trim()) ? (asNumber < 1e11 ? asNumber * 1000 : asNumber) : Date.parse(v);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/** One member's windows, in the shapes the native answers need. */
function windowsOf(usage: PoolUsage | undefined, reservePercent = 100): LimitWindow[] {
  const out: LimitWindow[] = [];
  for (const w of usage?.windows ?? []) {
    const slot = slotOf(w.label) ?? (out.some((o) => o.slot === "short") ? "long" : "short");
    const reset = parseReset(w.resetsAt);
    const entry: LimitWindow = { slot, utilization: w.utilization, ...(reset !== undefined ? { resetsAtSec: reset } : {}) };
    const at = out.findIndex((o) => o.slot === slot);
    // A per-model weekly window (left in only for a request for that model) stands for the week when it is fuller.
    if (at >= 0) {
      const have = out[at] as LimitWindow;
      // Two plain windows in one slot (a weekly and a monthly): the fuller one stands, and of two full ones the later reset.
      const later = (reset ?? 0) > (have.resetsAtSec ?? 0);
      const bothFull = w.utilization >= reservePercent && have.utilization >= reservePercent;
      if (w.model !== undefined ? w.utilization > have.utilization : bothFull ? later : w.utilization > have.utilization && have.utilization < reservePercent) out[at] = entry;
      continue;
    }
    out.push(entry);
  }
  return out;
}

/**
 * When one member is usable again, and which window holds it back. A member is back once every window at or over
 * `reservePercent` has reset (the latest of those resets); with no window over the reserve, the busiest window decides.
 */
function memberRecovery(usage: PoolUsage | undefined, reservePercent: number): { resetAtSec: number; claim: LimitSlot; windows: LimitWindow[] } | undefined {
  const windows = windowsOf(usage, reservePercent);
  if (windows.length === 0) return undefined;
  let blocking = windows.filter((w) => w.utilization >= reservePercent);
  if (blocking.length === 0) blocking = [windows.reduce((a, b) => (b.utilization > a.utilization ? b : a))];
  const timed = blocking.filter((w) => w.resetsAtSec !== undefined);
  if (timed.length === 0) return undefined;
  const last = timed.reduce((a, b) => ((b.resetsAtSec as number) > (a.resetsAtSec as number) ? b : a));
  return { resetAtSec: last.resetsAtSec as number, claim: last.slot, windows };
}

/** A reset a member's own 429 reported during the request: it counts even when the member's usage reading is stale or missing. */
export interface LimitCandidate {
  resetAtSec: number;
  claim: LimitSlot;
}

/** The earliest reset across the members, from their usage readings and their own 429 answers. Resets already in the past are ignored (stale figures). */
export function summariseLimit(usages: Array<PoolUsage | undefined>, reservePercent: number, now: Date, extra: LimitCandidate[] = []): LimitInfo {
  const nowSec = Math.floor(now.getTime() / 1000);
  let best: { resetAtSec: number; claim: LimitSlot; windows: LimitWindow[] } | undefined;
  for (const u of usages) {
    const r = memberRecovery(u, reservePercent);
    if (!r || r.resetAtSec <= nowSec) continue;
    if (!best || r.resetAtSec < best.resetAtSec) best = r;
  }
  for (const c of extra) {
    if (c.resetAtSec <= nowSec) continue;
    if (!best || c.resetAtSec < best.resetAtSec) best = { resetAtSec: c.resetAtSec, claim: c.claim, windows: [] };
  }
  if (best) return { ...best, guessed: false };
  return { resetAtSec: nowSec + FALLBACK_RESET_SECONDS, guessed: true, claim: "short", windows: [] };
}

/**
 * The text of every limit answer the gateway makes: `You've hit your <kind> limit (<reason>; resets <ICT time>, <UK time>). Resets at <ISO UTC>.`
 * The opening and the final timestamp are the form T3 Code reads (it matches `^You've hit your ... limit` and a trailing
 * `Resets at <ISO>Z.`) to snooze a thread until the reset and then resume it. Nothing may follow the final full stop.
 * The bracket is for people: the AIS reason and the reset in local time (Bangkok first, UK alongside, see `formatLimitTimes`).
 */
export function limitMessage(kind: string, resetAtSec: number, reason?: string, zones?: string[]): string {
  const local = `resets ${formatLimitTimes(resetAtSec * 1000, zones)}`;
  // The opening stays as clients read it. The reason inside the bracket names the gateway as the maker of this answer.
  const why = reason ?? `${GATEWAY_MESSAGE_PREFIX}all pool members are at their limit`;
  return `You've hit your ${kind} limit (${why}; ${local}). Resets at ${new Date(resetAtSec * 1000).toISOString()}.`;
}

/**
 * A limit answer for a provider with no native shape: the provider-style error body, the shared message and `retry-after`.
 * `kind` defaults to "usage".
 */
export function genericLimitResponse(style: ApiStyle, resetAtSec: number, now: Date, reason: string, kind = "usage"): Response {
  const res = limitError(style, limitMessage(kind, resetAtSec, reason), "provider_limit");
  res.headers.set("retry-after", String(Math.max(1, resetAtSec - Math.floor(now.getTime() / 1000))));
  return res;
}

const kindOf = (claim: LimitSlot): string => (claim === "short" ? "5-hour" : "weekly");

function slotFor(info: LimitInfo, slot: LimitSlot): LimitWindow | undefined {
  return info.windows.find((w) => w.slot === slot);
}

/** The fraction Anthropic's headers use (0 to 1), rounded to two places. */
function fraction(percent: number): string {
  return String(Math.round(Math.min(Math.max(percent, 0), 100)) / 100);
}

/**
 * Anthropic's own 429 for an exhausted subscription: `rate_limit_error` body plus the unified headers, status
 * `rejected`, reset in epoch seconds. The gateway app marks it `x-ais-gateway` like every answer it makes.
 */
export function anthropicLimitResponse(info: LimitInfo, now: Date): Response {
  const nowSec = Math.floor(now.getTime() / 1000);
  const retryAfter = Math.max(1, info.resetAtSec - nowSec);
  const headers = new Headers({
    "content-type": "application/json",
    "retry-after": String(retryAfter),
    [GATEWAY_ERROR_HEADER]: "provider_limit",
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-reset": String(info.resetAtSec),
    "anthropic-ratelimit-unified-representative-claim": info.claim === "short" ? "five_hour" : "seven_day",
    "anthropic-ratelimit-unified-overage-status": "rejected",
    "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
  });
  for (const [slot, abbrev] of [["short", "5h"], ["long", "7d"]] as const) {
    const w = slotFor(info, slot);
    if (!w && slot !== info.claim) continue;
    const blocked = slot === info.claim || (w !== undefined && w.utilization >= 100);
    headers.set(`anthropic-ratelimit-unified-${abbrev}-status`, blocked ? "rejected" : "allowed");
    headers.set(`anthropic-ratelimit-unified-${abbrev}-reset`, String(slot === info.claim ? info.resetAtSec : (w?.resetsAtSec ?? info.resetAtSec)));
    headers.set(`anthropic-ratelimit-unified-${abbrev}-utilization`, blocked ? "1" : fraction(w?.utilization ?? 0));
  }
  return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: limitMessage(kindOf(info.claim), info.resetAtSec) } }), { status: 429, headers });
}

/**
 * Codex's own usage-limit answer: a 429 whose `error.type` is `usage_limit_reached` with `resets_at` (epoch seconds)
 * and `resets_in_seconds`, plus the `x-codex-primary-*` and `x-codex-secondary-*` snapshot headers.
 */
export function codexLimitResponse(info: LimitInfo, now: Date): Response {
  const nowSec = Math.floor(now.getTime() / 1000);
  const headers = new Headers({ "content-type": "application/json", [GATEWAY_ERROR_HEADER]: "provider_limit" });
  const short = slotFor(info, "short");
  const long = slotFor(info, "long");
  const primary = info.claim === "short" ? { ...short, utilization: 100, resetsAtSec: info.resetAtSec } : short;
  const secondary = info.claim === "long" ? { ...long, utilization: 100, resetsAtSec: info.resetAtSec } : long;
  if (primary) {
    headers.set("x-codex-primary-used-percent", String(Math.min(100, Math.round(primary.utilization ?? 100))));
    headers.set("x-codex-primary-window-minutes", "300");
    headers.set("x-codex-primary-reset-at", String(primary.resetsAtSec ?? info.resetAtSec));
  }
  if (secondary) {
    headers.set("x-codex-secondary-used-percent", String(Math.min(100, Math.round(secondary.utilization ?? 100))));
    headers.set("x-codex-secondary-window-minutes", "10080");
    headers.set("x-codex-secondary-reset-at", String(secondary.resetsAtSec ?? info.resetAtSec));
  }
  const body = { error: { type: "usage_limit_reached", message: limitMessage(kindOf(info.claim), info.resetAtSec), resets_at: info.resetAtSec, resets_in_seconds: Math.max(1, info.resetAtSec - nowSec) } };
  return new Response(JSON.stringify(body), { status: 429, headers });
}

/** The native limit answer for `provider`, or undefined when the provider has no native shape to copy (callers keep their generic error). */
export function nativeLimitResponse(provider: GatewayProvider, usages: Array<PoolUsage | undefined>, reservePercent: number, now: Date, extra: LimitCandidate[] = []): Response | undefined {
  if (provider !== "claude" && provider !== "codex") return undefined;
  const info = summariseLimit(usages, reservePercent, now, extra);
  return provider === "claude" ? anthropicLimitResponse(info, now) : codexLimitResponse(info, now);
}

/**
 * The earliest time a member is usable again, only when some member is blocked by a full window (at or over the reserve)
 * with a known reset. Undefined when no reading shows a full window, so callers keep a short hold for a real burst 429.
 */
export function fullWindowReset(usages: Array<PoolUsage | undefined>, reservePercent: number, now: Date): number | undefined {
  const nowSec = Math.floor(now.getTime() / 1000);
  // A stale figure may predate a reset: it never sets a reset here.
  const full = usages.filter((u) => u && !u.stale && !u.noPlan && windowsOf(u, reservePercent).some((w) => w.utilization >= reservePercent));
  const info = summariseLimit(full, reservePercent, now);
  return info.guessed || full.length === 0 ? undefined : Math.max(info.resetAtSec, nowSec + 1);
}

/**
 * A member's weekly use in percent: the fullest weekly (long) window that applies to every model. Without a weekly window it is the
 * fullest window of any kind. Undefined when the reading has no figure or the member has no plan that can serve.
 */
export function weeklyUtilisation(usage: PoolUsage | undefined): number | undefined {
  if (!usage || usage.noPlan) return undefined;
  const nums = (usage.windows ?? []).filter((w) => w.model === undefined && slotOf(w.label) === "long" && Number.isFinite(w.utilization)).map((w) => w.utilization);
  if (nums.length > 0) return Math.max(...nums);
  const any = (usage.windows ?? []).filter((w) => w.model === undefined && Number.isFinite(w.utilization)).map((w) => w.utilization);
  if (any.length > 0) return Math.max(...any);
  return typeof usage.maxUtilization === "number" && Number.isFinite(usage.maxUtilization) ? usage.maxUtilization : undefined;
}
