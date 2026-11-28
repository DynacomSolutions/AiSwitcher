import type { ResetLogOutcome, ResetLogProvider, ResetLogQuery, ResetLogTrigger, ResetLogWindow } from "../types/api";

/** Pure model of the Reset log page: the filters in the URL, the request they make and the text of a row. */

export const RESET_LOG_PATH = "/logs/resets";
export const RESET_LOG_PAGE_SIZE = 50;

export interface ResetLogFilters {
  /** Identity name, or "" for every identity. */
  identity: string;
  provider: ResetLogProvider | "";
  trigger: ResetLogTrigger | "";
  outcome: ResetLogOutcome | "";
  /** YYYY-MM-DD or "". */
  from: string;
  /** YYYY-MM-DD or "". */
  to: string;
}

export type ResetLogFilterKey = keyof ResetLogFilters;

/** The order of the keys in the address. The URL of a view is always written in this order. */
export const RESET_LOG_FILTER_KEYS: readonly ResetLogFilterKey[] = ["identity", "provider", "trigger", "outcome", "from", "to"];

export const RESET_LOG_PROVIDERS: readonly ResetLogProvider[] = ["claude", "codex"];
export const RESET_LOG_TRIGGERS: readonly ResetLogTrigger[] = ["manual", "auto"];
export const RESET_LOG_OUTCOMES: readonly ResetLogOutcome[] = ["reset", "no_credit", "already_redeemed", "rejected", "error"];

export const RESET_LOG_PROVIDER_LABELS: Record<ResetLogProvider, string> = { claude: "Claude", codex: "Codex" };
export const RESET_LOG_TRIGGER_LABELS: Record<ResetLogTrigger, string> = { manual: "Manual", auto: "Automatic" };
export const RESET_LOG_OUTCOME_LABELS: Record<ResetLogOutcome, string> = {
  reset: "Reset",
  no_credit: "No credit",
  already_redeemed: "Already redeemed",
  rejected: "Rejected",
  error: "Error",
};

export const EMPTY_RESET_LOG_FILTERS: ResetLogFilters = { identity: "", provider: "", trigger: "", outcome: "", from: "", to: "" };

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

const oneOf = <T extends string>(allowed: readonly T[], value: string | null): T | "" => (value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : "");

/**
 * Reads the filters from the URL. A value that is not valid reads as "no filter".
 * An identity is any non-empty name: the link from the Limits page must work for an identity with no log row yet.
 */
export function readResetLogFilters(params: URLSearchParams): ResetLogFilters {
  const date = (key: "from" | "to"): string => {
    const value = params.get(key) ?? "";
    return isIsoDate(value) ? value : "";
  };
  return {
    identity: (params.get("identity") ?? "").trim(),
    provider: oneOf(RESET_LOG_PROVIDERS, params.get("provider")),
    trigger: oneOf(RESET_LOG_TRIGGERS, params.get("trigger")),
    outcome: oneOf(RESET_LOG_OUTCOMES, params.get("outcome")),
    from: date("from"),
    to: date("to"),
  };
}

/** The query string of a set of filters: valid values only, fixed key order, no key for "no filter". */
export function resetLogSearch(filters: ResetLogFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of RESET_LOG_FILTER_KEYS) if (filters[key] !== "") params.set(key, filters[key]);
  return params;
}

/** The URL after one filter changed. An empty value removes the key. Unknown keys and invalid values are dropped. */
export function withResetLogFilter(params: URLSearchParams, key: ResetLogFilterKey, value: string): URLSearchParams {
  return resetLogSearch(readResetLogFilters(withKey(params, key, value)));
}

function withKey(params: URLSearchParams, key: string, value: string): URLSearchParams {
  const next = new URLSearchParams(params);
  if (value === "") next.delete(key);
  else next.set(key, value);
  return next;
}

/** True when the address holds anything but the canonical form of its own filters (an invalid value, an unknown key, another order). */
export function needsCanonicalSearch(params: URLSearchParams): boolean {
  return resetLogSearch(readResetLogFilters(params)).toString() !== params.toString();
}

export function hasResetLogFilters(filters: ResetLogFilters): boolean {
  return RESET_LOG_FILTER_KEYS.some((key) => filters[key] !== "");
}

/** The request of one page of the log. `before` is the cursor of the page. */
export function resetLogRequest(filters: ResetLogFilters, before?: string, limit: number = RESET_LOG_PAGE_SIZE): ResetLogQuery {
  const query: ResetLogQuery = { limit };
  if (filters.identity) query.identity = filters.identity;
  if (filters.provider) query.provider = filters.provider;
  if (filters.trigger) query.trigger = filters.trigger;
  if (filters.outcome) query.outcome = filters.outcome;
  if (filters.from) query.from = filters.from;
  if (filters.to) query.to = filters.to;
  if (before) query.before = before;
  return query;
}

/** The link of the Limits page to the log of one identity. */
export function resetLogPath(identity?: string): string {
  const search = resetLogSearch({ ...EMPTY_RESET_LOG_FILTERS, identity: identity ?? "" }).toString();
  return search ? `${RESET_LOG_PATH}?${search}` : RESET_LOG_PATH;
}

const WINDOW_NAMES: Record<string, string> = {
  five_hour: "5-hour",
  weekly: "Weekly",
  weekly_opus: "Weekly Opus",
  weekly_sonnet: "Weekly Sonnet",
};

/** The name of a window: its own label, else a readable form of its key ("weekly_opus" reads "Weekly Opus"). */
export function windowName(window: Pick<ResetLogWindow, "key" | "label">): string {
  if (window.label) return window.label;
  const known = WINDOW_NAMES[window.key];
  if (known) return known;
  const words = window.key.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Window";
}

/** A percentage with at most one decimal place: 62 reads "62%", 62.46 reads "62.5%". The value is not clamped. */
export function percentText(percent: number): string {
  return Number.isFinite(percent) ? `${Number(percent.toFixed(1))}%` : "unknown";
}

/** The epoch-milliseconds of an ISO time, or null when it is missing or not a date. */
export function isoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** How a row shows its "after" reading: the windows, or the reason there are none. */
export type AfterView = { kind: "windows"; windows: ResetLogWindow[]; at: string | null } | { kind: "waiting" } | { kind: "none" };

/**
 * A reset that worked waits for the next reading. A refused or failed reset has no "after" and expects none,
 * so it never claims to wait.
 */
export function afterView(row: { outcome: string; after: ResetLogWindow[] | null; afterAt: string | null }): AfterView {
  if (row.after !== null) return { kind: "windows", windows: row.after, at: row.afterAt };
  return row.outcome === "reset" ? { kind: "waiting" } : { kind: "none" };
}
