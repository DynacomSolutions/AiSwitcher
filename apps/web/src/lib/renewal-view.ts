import type { RenewalRow } from "../types/api";
import { relTime, relUntil } from "./format";

/** Mirrors ESCALATION_THRESHOLD in src/server/auth-refresh.ts. */
export const RENEWAL_ESCALATION_THRESHOLD = 3;

export type RenewalTone = "ok" | "warning" | "destructive" | "muted";

/** What one renewal table row shows. Pure, so the wording is testable without a DOM. */
export interface RenewalView {
  renewedBy: string;
  lastRefresh: string;
  nextRefresh: string;
  expires: string;
  status: { tone: RenewalTone; label: string };
  /** Last error text with its time, or null. */
  error: string | null;
  /** Only a login this host renews can be refreshed from here. */
  canRefreshHere: boolean;
}

const DASH = "-";

export function renewalView(row: RenewalRow, nowMs: number = Date.now()): RenewalView {
  if (row.renewer === "pool") {
    return { renewedBy: "No login of its own", lastRefresh: DASH, nextRefresh: DASH, expires: DASH, status: { tone: "muted", label: "Members renewed by the gateway" }, error: null, canRefreshHere: false };
  }
  if (row.renewer === "gateway") {
    const g = row.gateway;
    if (!g) {
      const label = row.gatewayState === "unconfigured" ? "Gateway admin not set up here" : "Gateway renewal state unavailable";
      return { renewedBy: "Renewed by the gateway", lastRefresh: DASH, nextRefresh: DASH, expires: DASH, status: { tone: "muted", label }, error: null, canRefreshHere: false };
    }
    const error = g.lastError ? `${g.lastError.code}, ${relTime(g.lastError.at, nowMs)}${g.lastError.detail ? `: ${g.lastError.detail}` : ""}` : null;
    const status: RenewalView["status"] = g.revoked
      ? { tone: "destructive", label: "Sign-in needed" }
      : g.lastError && (!g.lastRefreshAt || Date.parse(g.lastError.at) > Date.parse(g.lastRefreshAt))
        ? { tone: "warning", label: "Last refresh failed" }
        : { tone: "ok", label: "Renewing" };
    return {
      renewedBy: "Renewed by the gateway",
      lastRefresh: g.lastRefreshAt ? relTime(g.lastRefreshAt, nowMs) : "No refresh recorded yet",
      nextRefresh: g.revoked ? DASH : g.nextRefreshAt ? relUntil(g.nextRefreshAt, nowMs) : DASH,
      expires: g.expiresAt ? relUntil(g.expiresAt, nowMs) : DASH,
      status,
      error,
      canRefreshHere: false,
    };
  }
  const h = row.host;
  const base = { renewedBy: "Renewed by this host", nextRefresh: DASH, expires: DASH, canRefreshHere: true };
  if (!h) return { ...base, lastRefresh: "No attempt yet", status: { tone: "muted", label: "Waiting for first pass" }, error: null };
  const lastRefresh = h.lastSuccessAt ? relTime(h.lastSuccessAt, nowMs) : "Not needed yet";
  if (h.revoked) return { ...base, lastRefresh, status: { tone: "destructive", label: "Sign-in needed" }, error: h.lastError };
  if (h.consecutiveFailures >= RENEWAL_ESCALATION_THRESHOLD) {
    return { ...base, lastRefresh, status: { tone: "destructive", label: `${h.consecutiveFailures} failures in a row` }, error: h.lastError };
  }
  if (h.lastError) return { ...base, lastRefresh, status: { tone: "warning", label: "Last refresh failed" }, error: h.lastError };
  return { ...base, lastRefresh, status: { tone: "ok", label: h.lastDetail ?? "Renewing" }, error: null };
}
