import type { Identity } from "../../identities/types.ts";
import { readZaiApiKey } from "../../identities/zai-auth.ts";
import { fetchWithRetry } from "./http.ts";
import type { LimitCategory, LimitWindow, FetchedLimitResult } from "./types.ts";

const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Response shape of `GET https://api.z.ai/api/monitor/usage/quota/limit`,
 * confirmed live 2026-07-18 against a real "GLM Coding Max" account on this
 * machine: `data.limits[]` carries THREE distinct entries, each identified
 * by `(type, unit, number)` rather than a free-text label — `type:
 * "TOKENS_LIMIT", unit: 3, number: 5` is the 5h session window, `type:
 * "TOKENS_LIMIT", unit: 6, number: 1` is the weekly window, and `type:
 * "TIME_LIMIT", unit: 5, number: 1` is a separate monthly allowance for web
 * tools (search-prime/web-reader/zread call counts, not tokens — confirmed
 * via its `usageDetails[]`, and its `nextResetTime` landing ~30 days out
 * matched the account's own monthly billing cycle from
 * `/api/biz/subscription/list`). `percentage` is already a 0-100 value, not
 * a 0-1 fraction (confirmed: a same-day-created, barely-used account showed
 * `percentage: 1`, i.e. 1% used — a 0-1 fraction would have implied the
 * account started 100% consumed). `(unit, number)` isn't a documented enum
 * anywhere — this project only knows the three pairs actually observed live;
 * anything else is skipped rather than guessed at, same stance as
 * kimi-limits.ts's duration-unit handling. Also confirmed live: `nextResetTime`
 * is OMITTED entirely (not null, not 0) on an entry with zero usage in that
 * window — re-fetching minutes after the first live check showed the
 * session entry's `percentage` drop to 0 and its `nextResetTime` disappear
 * along with it. `formatResetsAt`'s `undefined` input already handles this
 * correctly (an omitted `resetsAt` on the resulting window, not a bogus
 * "Invalid Date" string), so no special-casing was needed — just worth
 * recording as confirmed real behavior, not an edge case this adapter had to
 * work around.
 */
export interface ZaiLimitWire {
  type?: string;
  unit?: number;
  number?: number;
  percentage?: number;
  /** Epoch milliseconds, unlike kimi's ISO string resetTime. */
  nextResetTime?: number;
}

export interface ZaiQuotaResponseWire {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: { limits?: ZaiLimitWire[]; level?: string };
}

/** The web-tools monthly allowance is a distinct resource (call counts, not
 * tokens) from the two TOKENS_LIMIT windows — labeled "web tools" and
 * bucketed "other" rather than "month", so it never reads as directly
 * comparable to a token-based monthly quota the way Codex/Grok's real
 * monthly windows are. */
function labelAndCategoryFor(entry: ZaiLimitWire): { label: string; category: LimitCategory } | undefined {
  if (entry.type === "TOKENS_LIMIT") {
    if (entry.unit === 3 && entry.number === 5) return { label: "session", category: "session" };
    if (entry.unit === 6 && entry.number === 1) return { label: "week", category: "week" };
    return undefined;
  }
  if (entry.type === "TIME_LIMIT") return { label: "web tools", category: "other" };
  return undefined;
}

/** Same human formatting as kimi/codex-limits.ts, adapted for an epoch-ms
 * input instead of an ISO string. */
function formatResetsAt(nextResetTime: number | undefined): string | undefined {
  if (nextResetTime === undefined) return undefined;
  const parsed = new Date(nextResetTime);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Pure mapping from the wire shape to display windows, exported so tests can
 * exercise it without any network. An entry with no numeric `percentage`, or
 * an unrecognized `(type, unit, number)` combination, is skipped rather than
 * guessed at. */
export function windowsFromZaiQuotaResponse(resp: ZaiQuotaResponseWire): LimitWindow[] {
  const windows: LimitWindow[] = [];
  for (const entry of resp.data?.limits ?? []) {
    if (typeof entry.percentage !== "number") continue;
    const labeled = labelAndCategoryFor(entry);
    if (!labeled) continue;
    windows.push({
      label: labeled.label,
      category: labeled.category,
      usedPercent: Math.min(100, Math.max(0, entry.percentage)),
      resetsAt: formatResetsAt(entry.nextResetTime),
    });
  }
  return windows;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ZaiQuotaOutcome {
  windows?: LimitWindow[];
  error?: string;
}

/** The live quota read for ONE Z.ai API key — shared by the zai tool's own
 * fetcher (key from that identity's crush.json) and the pi/opencode
 * adapters (keys from their own auth stores, typically the same account
 * imported at identity-creation time). Auth/network/shape handling is
 * identical either way: only the key differs. */
export async function fetchZaiQuotaForKey(apiKey: string): Promise<ZaiQuotaOutcome> {
  let response: Response;
  try {
    response = await fetchWithRetry(QUOTA_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
  } catch (err) {
    return { error: `quota fetch failed: ${errorMessage(err)}` };
  }

  if (response.status === 401 || response.status === 403) {
    return { error: `authentication rejected (HTTP ${response.status}) — check this identity's Z.ai API key` };
  }
  if (!response.ok) {
    return { error: `quota fetch failed (HTTP ${response.status})` };
  }

  let payload: ZaiQuotaResponseWire;
  try {
    payload = (await response.json()) as ZaiQuotaResponseWire;
  } catch (err) {
    return { error: `could not parse quota response: ${errorMessage(err)}` };
  }

  if (payload.success === false) {
    return { error: payload.msg ?? "Z.ai reported the quota request failed" };
  }

  const windows = windowsFromZaiQuotaResponse(payload);
  if (windows.length === 0) {
    return { error: "zai reported no quota windows" };
  }
  return { windows };
}

/**
 * Fetches live quota usage for one zai identity via
 * `GET https://api.z.ai/api/monitor/usage/quota/limit`, authenticated with
 * the plain API key `writeZaiAuthFile` wrote into `<configDir>/crush.json`
 * (via `readZaiApiKey`) — a static key, not OAuth, so unlike kimi-limits.ts
 * there is no token-refresh flow needed here at all.
 */
export async function fetchZaiLimits(identity: Identity): Promise<FetchedLimitResult> {
  const base: Pick<FetchedLimitResult, "toolName" | "identity"> = { toolName: "zai", identity };

  const apiKey = await readZaiApiKey(identity.configDir);
  if (!apiKey) {
    return {
      ...base,
      windows: [],
      status: "unavailable",
      error: "not authenticated (no Z.ai API key configured — run `ais identities update --tool=zai --api-key=<key>`)",
    };
  }

  const outcome = await fetchZaiQuotaForKey(apiKey);
  if (outcome.error || !outcome.windows) {
    return { ...base, windows: [], status: "unavailable", error: outcome.error };
  }
  return { ...base, windows: outcome.windows, status: "live", capturedAt: new Date().toISOString() };
}
