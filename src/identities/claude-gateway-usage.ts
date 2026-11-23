import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchedLimitResult, ToolLimitResult } from "../cli/limits/types.ts";
import type { MemberUsage, ScopedWindowReading, UsageWindowReading } from "./claude-usage-api.ts";
import { loadGatewayLimits, type LoadGatewayLimitsDeps } from "./gateway-limits-reader.ts";
import { hasMemberCopy, memberLoginFile, memberStoreEnabled } from "./gateway-members.ts";
import { classifyLogin, folderHoldsGatewayEntry } from "./gateway-routed.ts";
import { expandPath } from "./match.ts";
import type { Identity } from "./types.ts";

/**
 * Claude usage of a login the gateway holds: read from the gateway, never from Anthropic.
 *
 * The gateway reads each member's `/api/oauth/usage` itself (src/gateway/providers/claude.ts) and serves the result on the
 * admin `GET /limits`. A host that also called Anthropic for the same account would poll it twice, and Anthropic answers
 * HTTP 429. So for a gateway-held login every host-side read asks the gateway admin API.
 * There is no fallback to a direct call: a missing admin URL or token, or a failed read, is an honest "unavailable".
 * Identities the gateway does not hold keep the direct read in claude-usage-api.ts.
 */

/** Test hooks for the gateway admin read (fetch, secrets file, timeout). */
export interface ClaudeGatewayUsageDeps {
  gateway?: Pick<LoadGatewayLimitsDeps, "fetch" | "secretsPath" | "timeoutMs">;
  /** Member store root (tests). */
  memberRoot?: string;
}

/** The prefix of every error that means "the gateway could not be read" (the console and tests match on it). */
export const GATEWAY_LIMITS_UNAVAILABLE = "gateway limits unavailable";

/**
 * True when this process must read the identity's Claude usage from the gateway admin API:
 * - the identity's own folder holds the pure gateway entry (a routed identity, on this host or synced from another), or
 * - this host has a member store copy of the login and the folder holds no real login of its own.
 * A gateway process (memberStoreEnabled: `ais gateway serve` and `ais gateway local`) reads its own store copy and never
 * calls its own admin API, so it is never "via gateway" here.
 */
export function claudeReadsViaGateway(identity: Identity, memberRoot?: string): boolean {
  if (memberStoreEnabled()) return false;
  if (identity.swapPool) return false;
  if (folderHoldsGatewayEntry("claude", identity)) return true;
  if (!hasMemberCopy("claude", identity.name, memberRoot)) return false;
  let text: string | undefined;
  try {
    text = readFileSync(join(expandPath(identity.configDir), memberLoginFile("claude")), "utf8");
  } catch {
    text = undefined;
  }
  return classifyLogin("claude", text) !== "login";
}

type GatewayRead = { row: ToolLimitResult; error?: undefined } | { row?: undefined; error: string };

/** One read of the gateway admin API for one claude identity. Never throws. */
async function readGatewayRow(identity: Identity, deps: ClaudeGatewayUsageDeps): Promise<GatewayRead> {
  const view = await loadGatewayLimits({ provider: "claude", identity: identity.name, ...deps.gateway });
  if (!view.configured) return { error: `${GATEWAY_LIMITS_UNAVAILABLE}: the gateway admin is not configured on this host (AIS_GATEWAY_ADMIN_URL and AIS_GATEWAY_ADMIN_TOKEN)` };
  if (view.error) return { error: `${GATEWAY_LIMITS_UNAVAILABLE}: ${view.error}` };
  const names = new Set([identity.name, ...(identity.aliases ?? [])]);
  const row = view.rows.find((r) => r.toolName === "claude" && names.has(r.identity.name));
  if (!row) return { error: `${GATEWAY_LIMITS_UNAVAILABLE}: the gateway reports no usage for this identity` };
  return { row };
}

/** The limits of a gateway-held claude identity, in the shape `ais limits` and the console use. */
export async function fetchClaudeLimitsViaGateway(identity: Identity, deps: ClaudeGatewayUsageDeps = {}): Promise<FetchedLimitResult> {
  const read = await readGatewayRow(identity, deps);
  if (read.error !== undefined) return { toolName: "claude", identity, windows: [], status: "unavailable", error: read.error };
  const { provider: _provider, ...result } = read.row;
  return { ...result, identity };
}

const isoOf = (ms: number | undefined): string | undefined => (ms !== undefined && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);

/** The pool usage of a gateway-held claude member (status, windows, extra usage and reset grants of the gateway row). */
export async function fetchMemberUsageViaGateway(member: Identity, deps: ClaudeGatewayUsageDeps & { now?: () => number } = {}): Promise<MemberUsage> {
  const read = await readGatewayRow(member, deps);
  const nowIso = new Date(deps.now?.() ?? Date.now()).toISOString();
  if (read.error !== undefined) return { status: "unavailable", error: read.error, capturedAt: nowIso };
  const row = read.row;
  const capturedAt = row.capturedAt ?? nowIso;
  const reading = (w: { usedPercent: number; resetsAtMs?: number }): UsageWindowReading => {
    const resetsAt = isoOf(w.resetsAtMs);
    return { utilization: Math.min(100, Math.max(0, w.usedPercent)), ...(resetsAt ? { resetsAt } : {}) };
  };
  const fiveHour = row.windows.find((w) => w.label === "session (5h)");
  const sevenDay = row.windows.find((w) => w.label === "week (all)");
  const scoped: ScopedWindowReading[] = row.windows.flatMap((w) => (w.model ? [{ model: w.model, ...reading(w) }] : []));
  const values = [fiveHour, sevenDay].filter((w) => w !== undefined).map((w) => reading(w).utilization);
  const carried = {
    ...(row.extraUsage ? { extraUsage: row.extraUsage } : {}),
    ...(row.manualReset ? { manualReset: row.manualReset } : {}),
  };
  if (row.status === "unavailable" || values.length === 0) {
    return { status: "unavailable", error: row.error ?? "no usage reading from the gateway yet", capturedAt, ...carried };
  }
  return {
    // A stale gateway reading (its own usage read is backing off) keeps its figures but is not a live reading.
    status: row.status === "cached" ? "rate-limited" : "live",
    ...(row.status === "cached" ? { error: "the gateway reading is stale (its usage read is backing off)" } : {}),
    ...(fiveHour ? { fiveHour: reading(fiveHour) } : {}),
    ...(sevenDay ? { sevenDay: reading(sevenDay) } : {}),
    ...(scoped.length > 0 ? { scoped } : {}),
    maxUtilization: Math.max(...values),
    ...carried,
    capturedAt,
  };
}
