import type { AuthEntry, AuthKind, AuthState, RenewalRow } from "../types/api";
import { relTime, relUntil } from "./format";
import { renewalView, type RenewalView } from "./renewal-view";

/** Pure model of the Auth page list: one row per identity and tool, joined from the auth probe and the renewal report. */

export type AuthSortKey = "default" | "tool" | "identity" | "state" | "expires" | "next";
export type AuthSortDir = "asc" | "desc";
export type AuthStateFilter = "all" | "attention" | "ok";

export interface AuthListParams {
  /** Text filter over tool, identity, account, detail and error. */
  q: string;
  /** Tool name, or "" for every tool. */
  tool: string;
  state: AuthStateFilter;
  sort: AuthSortKey;
  dir: AuthSortDir;
}

const SORT_KEYS: readonly AuthSortKey[] = ["default", "tool", "identity", "state", "expires", "next"];
const STATE_FILTERS: readonly AuthStateFilter[] = ["all", "attention", "ok"];

export const AUTH_SORT_LABELS: Record<AuthSortKey, string> = {
  default: "Default order",
  tool: "Tool",
  identity: "Identity",
  state: "Needs attention first",
  expires: "Expires soonest",
  next: "Next renewal soonest",
};

export const AUTH_STATE_LABELS: Record<AuthStateFilter, string> = {
  all: "All states",
  attention: "Needs attention",
  ok: "Healthy",
};

/**
 * Reads the list view from the URL. An unknown value falls back to the default, so an old or hand-made link still opens.
 * With `knownTools` (the tools of the loaded list), an unknown tool reads as "all tools".
 */
export function readAuthParams(params: URLSearchParams, knownTools?: readonly string[]): AuthListParams {
  const sort = params.get("sort") as AuthSortKey | null;
  const state = params.get("state") as AuthStateFilter | null;
  const tool = params.get("tool");
  return {
    q: params.get("q") ?? "",
    tool: tool && (!knownTools || knownTools.includes(tool)) ? tool : "",
    state: state && STATE_FILTERS.includes(state) ? state : "all",
    sort: sort && SORT_KEYS.includes(sort) ? sort : "default",
    dir: params.get("dir") === "desc" ? "desc" : "asc",
  };
}

/** The URL after one view option changed. A default value leaves no key, so the plain page keeps a plain URL. */
export function withAuthParam(params: URLSearchParams, key: keyof AuthListParams, value: string): URLSearchParams {
  const next = new URLSearchParams(params);
  const isDefault = value === "" || (key === "state" && value === "all") || (key === "sort" && value === "default") || (key === "dir" && value === "asc");
  if (isDefault) next.delete(key);
  else next.set(key, value);
  // The direction means nothing without a sort key.
  if (key === "sort" && value === "default") next.delete("dir");
  return next;
}

export interface AuthListRow {
  key: string;
  tool: string;
  identity: string;
  entry: AuthEntry | null;
  renewal: RenewalRow | null;
  state: AuthState;
  /** How the identity signs in (oauth, apikey, cookie, none), or null when only the renewal report names it. */
  kind: AuthKind | null;
  /** The renewal status of the row (label and tone), or null when no renewal row exists. */
  status: RenewalView["status"] | null;
  /** The auth probe detail. Retired rows show none. */
  detail: string | null;
  retired: boolean;
  /** True when something needs a person: the auth state is not healthy, or the renewal shows an error or a sign-in need. */
  attention: boolean;
  expires: string;
  lastRenewal: string;
  nextRenewal: string;
  renewedBy: string;
  error: string | null;
  expiresMs: number | null;
  nextMs: number | null;
  canRefreshHere: boolean;
}

const DASH = "-";
/** Lower is worse: the order of "needs attention first". */
const STATE_RANK: Record<AuthState, number> = { expired: 0, missing: 1, expiring: 2, unknown: 3, gateway: 4, ok: 5, retired: 6 };
const HEALTHY: ReadonlySet<AuthState> = new Set<AuthState>(["ok", "gateway", "retired"]);

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
};

/** The short "renewed by" text of the list: "Renewed by the gateway" reads "Gateway". */
function renewedByLabel(text: string): string {
  const who = text.replace(/^Renewed by (the )?/, "");
  return who === text ? text : who.charAt(0).toUpperCase() + who.slice(1);
}

/** Joins the auth probe with the renewal report by tool and identity. A key present in only one source still shows. */
export function combineAuthRows(entries: readonly AuthEntry[], renewals: readonly RenewalRow[], nowMs: number = Date.now()): AuthListRow[] {
  const renewalByKey = new Map(renewals.map((r) => [`${r.tool}/${r.identity}`, r]));
  const out: AuthListRow[] = [];
  const seen = new Set<string>();
  const push = (tool: string, identity: string, entry: AuthEntry | null, renewal: RenewalRow | null) => {
    const key = `${tool}/${identity}`;
    seen.add(key);
    const view = renewal ? renewalView(renewal, nowMs) : null;
    const gateway = renewal?.gateway ?? null;
    const expiresIso = gateway?.expiresAt ?? entry?.expiresAt ?? null;
    const state: AuthState = entry?.state ?? "unknown";
    const error = view?.error ?? entry?.refreshError ?? null;
    out.push({
      key,
      tool,
      identity,
      entry,
      renewal,
      state,
      kind: entry?.kind ?? null,
      status: view?.status ?? null,
      detail: state === "retired" ? null : entry?.detail ?? null,
      retired: state === "retired",
      attention: (!HEALTHY.has(state) || view?.status.tone === "destructive" || view?.status.tone === "warning" || error !== null) && state !== "retired",
      expires: view && view.expires !== DASH ? view.expires : expiresIso ? relUntil(expiresIso, nowMs) : DASH,
      lastRenewal: view && view.lastRefresh !== DASH ? view.lastRefresh : entry?.lastRefreshAt ? relTime(entry.lastRefreshAt, nowMs) : DASH,
      nextRenewal: view?.nextRefresh ?? DASH,
      renewedBy: view ? renewedByLabel(view.renewedBy) : DASH,
      error,
      expiresMs: ms(expiresIso),
      nextMs: ms(gateway?.nextRefreshAt),
      canRefreshHere: view?.canRefreshHere ?? false,
    });
  };
  for (const entry of entries) push(entry.toolName, entry.identity, entry, renewalByKey.get(`${entry.toolName}/${entry.identity}`) ?? null);
  for (const renewal of renewals) if (!seen.has(`${renewal.tool}/${renewal.identity}`)) push(renewal.tool, renewal.identity, null, renewal);
  // Retired identities are listed last and never offer fixes.
  return out.sort((a, b) => Number(a.retired) - Number(b.retired));
}

/**
 * True when the list may be trusted to name every tool. Both answers must have settled (data or error).
 * The renewal report names logins the auth probe does not list, so one answer alone can miss a tool in the URL.
 */
export function authListLoaded(rowCount: number, authPending: boolean, renewalPending: boolean): boolean {
  return rowCount > 0 && !authPending && !renewalPending;
}

/**
 * "Refresh token" only reads the quota and renews an expired token. A login that this host renews has the real
 * OAuth refresh, "Run host renewal", so the weaker button hides there.
 */
export function showTokenRefresh(row: Pick<AuthListRow, "canRefreshHere">): boolean {
  return !row.canRefreshHere;
}

/** The tools that appear in the list, for the tool filter. */
export function authTools(rows: readonly AuthListRow[]): string[] {
  return [...new Set(rows.map((r) => r.tool))].sort();
}

function matches(row: AuthListRow, params: AuthListParams): boolean {
  if (params.tool && row.tool !== params.tool) return false;
  if (params.state === "attention" && !row.attention) return false;
  if (params.state === "ok" && (row.attention || row.retired)) return false;
  const needle = params.q.trim().toLowerCase();
  if (!needle) return true;
  const hay = [row.tool, row.identity, row.entry?.account?.email, row.detail, row.kind, row.status?.label, row.renewedBy, row.error, row.state].filter(Boolean).join(" ").toLowerCase();
  return hay.includes(needle);
}

const byNumber = (a: number | null, b: number | null): number => {
  // A missing value sorts last in both directions of the caller's compare, so the caller flips only the present values.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
};

/** Filters, then sorts. "default" keeps the list order. A missing expiry or next renewal always sorts last. */
export function visibleAuthRows(rows: readonly AuthListRow[], params: AuthListParams): AuthListRow[] {
  const filtered = rows.filter((row) => matches(row, params));
  if (params.sort === "default") return filtered;
  const sign = params.dir === "desc" ? -1 : 1;
  const compare = (a: AuthListRow, b: AuthListRow): number => {
    switch (params.sort) {
      case "tool":
        return sign * a.tool.localeCompare(b.tool) || a.identity.localeCompare(b.identity);
      case "identity":
        return sign * a.identity.localeCompare(b.identity) || a.tool.localeCompare(b.tool);
      case "state":
        return sign * (STATE_RANK[a.state] - STATE_RANK[b.state]) || a.identity.localeCompare(b.identity);
      case "expires":
      case "next": {
        const x = params.sort === "expires" ? a.expiresMs : a.nextMs;
        const y = params.sort === "expires" ? b.expiresMs : b.nextMs;
        if (x === null || y === null) return byNumber(x, y);
        return sign * (x - y) || a.identity.localeCompare(b.identity);
      }
      default:
        return 0;
    }
  };
  return [...filtered].sort(compare);
}
