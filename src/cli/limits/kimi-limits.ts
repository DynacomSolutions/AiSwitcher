import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Identity } from "../../identities/types.ts";
import { categorizeByMinutes } from "./bucket.ts";
import { fetchWithRetry } from "./http.ts";
import { persistKimiCredentials, readFreshestKimiCredentials } from "./kimi-store.ts";
import type { LimitCategory, LimitWindow, OverageInfo, FetchedLimitResult } from "./types.ts";

const USAGES_URL = "https://api.kimi.com/coding/v1/usages";
const TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
/** kimi-code's public OAuth client id — a well-known public client, NOT a
 * secret (it's embedded in the distributed kimi binary, and tokscale's kimi
 * quota fetcher uses the same value). */
const OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"; // gitleaks:allow
const FETCH_TIMEOUT_MS = 10_000;
/** Proactively refresh when the token expires within this many seconds, so a
 * token that is technically still valid but about to die mid-report doesn't
 * turn a live read into a 401 round-trip. */
const EXPIRY_SKEW_SECONDS = 300;

/** The `limits[]` entries' counters and the top-level `usage` block's are
 * numeric STRINGS on the wire (confirmed live 2026-07-17) — never numbers. */
export interface KimiUsageDetailWire {
  limit?: string;
  used?: string;
  remaining?: string;
  resetTime?: string;
}

export interface KimiUsageWindowWire {
  window?: { duration?: number; timeUnit?: string };
  detail?: KimiUsageDetailWire;
}

/** Response shape of `GET https://api.kimi.com/coding/v1/usages`, confirmed
 * live 2026-07-17 against the real account on this machine: `limits[]`
 * carries duration-windowed quotas (the 300-minute one is the 5h session
 * window), while the top-level `usage` block is the weekly quota (resetTime
 * exactly 7 days out). The two are distinct entries in real data — see the
 * defensive dedupe in windowsFromUsagesResponse. */
/**
 * Kimi Code's real "Extra Usage" wallet — an opt-in overage feature (spend
 * real money past the subscription quota instead of waiting for a reset),
 * confirmed to exist from Kimi's own help docs. The wire shape here was
 * NOT confirmed against a live response (both identities on this machine had
 * expired refresh tokens when this was investigated) — it's read directly
 * out of the real `kimi` CLI binary's own bundled parsing logic (`strings`
 * on the compiled binary, same technique this project already uses
 * elsewhere for undocumented env vars), which is the same
 * `GET .../usages` endpoint `fetchKimiLimits` already calls, just a sibling
 * top-level key (`boosterWallet`) this project never parsed before. Only
 * `monthlyChargeLimit`/`monthlyUsed` are surfaced (both plain
 * `{priceInCents, currency}` money values) — the wallet `balance` fields use
 * an undocumented fixed-point scale this project couldn't confirm, so they're
 * deliberately left unread rather than guessed at.
 */
export interface KimiMoneyWire {
  priceInCents?: number;
  currency?: string;
}

export interface KimiBoosterWalletWire {
  monthlyChargeLimitEnabled?: boolean;
  monthlyChargeLimit?: KimiMoneyWire;
  monthlyUsed?: KimiMoneyWire;
}

export interface KimiUsagesResponseWire {
  user?: { membership?: { level?: string } };
  usage?: KimiUsageDetailWire;
  limits?: KimiUsageWindowWire[];
  boosterWallet?: KimiBoosterWalletWire;
}

/** Pure mapping from the wire shape to an OverageInfo, exported so tests can
 * exercise it without any network. Returns undefined when `monthlyUsed` isn't
 * a usable number — either the account has never touched Extra Usage (the
 * key may be entirely absent) or the response genuinely has nothing to
 * report, same "don't guess" stance as windowsFromUsagesResponse. */
export function overageFromBoosterWallet(wallet: KimiBoosterWalletWire | undefined): OverageInfo | undefined {
  const spentCents = wallet?.monthlyUsed?.priceInCents;
  if (typeof spentCents !== "number" || !Number.isFinite(spentCents)) return undefined;

  const spentUsd = spentCents / 100;
  const limitCents = wallet?.monthlyChargeLimit?.priceInCents;
  const limitUsd = typeof limitCents === "number" && Number.isFinite(limitCents) ? limitCents / 100 : undefined;
  const active = spentCents > 0;

  const label = active
    ? `extra usage: $${spentUsd.toFixed(2)}${limitUsd !== undefined ? ` of $${limitUsd.toFixed(2)} cap` : ""} this month`
    : "no extra usage this month";
  return { active, label, spentUsd, ...(limitUsd !== undefined ? { limitUsd } : {}) };
}

/** kimi's `<configDir>/credentials/kimi-code.json` (mode 0600). Unknown keys
 * are preserved verbatim across a refresh-and-persist round-trip. */
interface CredentialsFile {
  access_token?: string;
  refresh_token?: string;
  /** Unix seconds. */
  expires_at?: number;
  scope?: string;
  token_type?: string;
  expires_in?: number;
  [key: string]: unknown;
}

/** Whole-window duration in minutes, converted from whatever timeUnit the
 * API reports. A duration without a recognized unit is treated as already
 * being minutes — TIME_UNIT_MINUTE is the only unit observed live so far,
 * and minutes are categorizeByMinutes' native input. */
function durationMinutes(entry: KimiUsageWindowWire): number | undefined {
  const duration = entry.window?.duration;
  if (duration === undefined) return undefined;
  switch (entry.window?.timeUnit) {
    case "TIME_UNIT_SECOND":
      return duration / 60;
    case "TIME_UNIT_HOUR":
      return duration * 60;
    case "TIME_UNIT_DAY":
      return duration * 1440;
    default:
      return duration;
  }
}

/** Same convention as codex-limits.ts's labelAndCategoryFor: a known
 * category becomes the label verbatim ("session"/"week"/"month"), an
 * unrecognized-but-present duration gets an approximate "~Nd"/"~Nh" label,
 * and no duration at all is just "usage". */
function labelAndCategoryFor(mins: number | undefined): { label: string; category: LimitCategory } {
  if (mins === undefined) return { label: "usage", category: "other" };
  const category = categorizeByMinutes(mins);
  if (category !== "other") return { label: category, category };
  if (mins >= 1440) return { label: `~${Math.round(mins / 1440)}d`, category };
  return { label: `~${Math.round(mins / 60)}h`, category };
}

/** usedPercent derived from limit/remaining (not `used`) when `remaining` is
 * present, so a `used` counter the API zeroes or omits independently can't
 * skew the result. Falls back to limit/used ONLY when `remaining` is absent
 * from the wire entirely (confirmed live 2026-07-20: a fully-exhausted 300-
 * minute session window reports `{limit:"100",used:"100"}` with `remaining`
 * omitted altogether, not `remaining:"0"` — without this fallback the entry
 * silently vanished from the report instead of showing 100% used). A
 * `remaining` key that IS present but non-numeric ("not-a-number") is still
 * treated as corrupt data and skips the entry, same as before — this only
 * changes behavior for a genuinely missing key, not a garbage one. Returns
 * undefined — skip the entry — when limit isn't a positive finite number or
 * neither remaining nor used yields a usable percent. */
function usedPercentFromStrings(
  limitRaw: string | undefined,
  remainingRaw: string | undefined,
  usedRaw: string | undefined,
): number | undefined {
  const limit = Number(limitRaw);
  if (!Number.isFinite(limit) || limit <= 0) return undefined;
  if (remainingRaw !== undefined) {
    const remaining = Number(remainingRaw);
    if (!Number.isFinite(remaining)) return undefined;
    return Math.min(100, Math.max(0, ((limit - remaining) / limit) * 100));
  }
  const used = Number(usedRaw);
  if (!Number.isFinite(used)) return undefined;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

/** Same human formatting as codex-limits.ts (short month + day + time in the
 * user's locale). An unparseable resetTime yields NO resetsAt rather than
 * the raw string leaking through half-formatted. */
function formatResetsAt(resetTime: string | undefined): string | undefined {
  if (!resetTime) return undefined;
  const parsed = new Date(resetTime);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Pure mapping from the wire shape to display windows, exported so tests
 * can exercise it without any network. Each `limits[]` entry becomes one
 * window; the top-level weekly `usage` block becomes one more ("week"),
 * UNLESS it exactly duplicates an already-listed window (same usedPercent
 * AND same resetsAt) — confirmed live that the session window and weekly
 * quota are distinct entries, but deduped defensively anyway, the same
 * guard tokscale's kimi fetcher applies. */
export function windowsFromUsagesResponse(resp: KimiUsagesResponseWire): LimitWindow[] {
  const windows: LimitWindow[] = [];
  for (const entry of resp.limits ?? []) {
    const usedPercent = usedPercentFromStrings(entry.detail?.limit, entry.detail?.remaining, entry.detail?.used);
    if (usedPercent === undefined) continue;
    const { label, category } = labelAndCategoryFor(durationMinutes(entry));
    windows.push({ label, category, usedPercent, resetsAt: formatResetsAt(entry.detail?.resetTime) });
  }

  const usage = resp.usage;
  if (usage) {
    const usedPercent = usedPercentFromStrings(usage.limit, usage.remaining, usage.used);
    if (usedPercent !== undefined) {
      const resetsAt = formatResetsAt(usage.resetTime);
      const duplicate = windows.some((w) => w.usedPercent === usedPercent && w.resetsAt === resetsAt);
      if (!duplicate) windows.push({ label: "week", category: "week", usedPercent, resetsAt });
    }
  }
  return windows;
}

/** The credential material the live usages read needs. The kimi tool's own
 * fetcher reads it from `<configDir>/credentials/kimi-code.json`; the pi
 * adapter maps its own auth.json OAuth entry onto this same shape (Pi stores
 * `access`/`refresh`/`expires`-in-ms for the same Kimi OAuth account). */
export interface KimiOAuthCredentials {
  access_token: string;
  refresh_token?: string;
  /** Unix seconds. */
  expires_at?: number;
}

/** The kimi credentials-file shape narrowed to the token fields. */
function credentialsFrom(raw: CredentialsFile): KimiOAuthCredentials | undefined {
  if (!raw.access_token) return undefined;
  return {
    access_token: raw.access_token,
    ...(typeof raw.refresh_token === "string" ? { refresh_token: raw.refresh_token } : {}),
    ...(typeof raw.expires_at === "number" ? { expires_at: raw.expires_at } : {}),
  };
}

/** The same refresh-and-persist the kimi CLI itself performs on launch and
 * tokscale performs on read (cross-checked against tokscale's kimi quota
 * fetcher, crates/tokscale-cli/src/commands/usage/kimi.rs): without it, any
 * identity whose token expired since its last real `kimi` run would make
 * this live read permanently dead weight. On success the refreshed
 * credentials are handed to `persist` — the kimi tool's fetcher persists
 * them back into its credentials file (all other keys preserved, atomic
 * temp-file rename, original 0600 mode); the pi adapter writes them back
 * into its own auth.json entry the same way. */
async function refreshCredentials(
  credentials: KimiOAuthCredentials,
  persist: (next: KimiOAuthCredentials) => Promise<void>,
): Promise<KimiOAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: credentials.refresh_token!,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`token refresh failed (HTTP ${response.status})`);
  const body = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("token refresh returned no access_token");

  const next: KimiOAuthCredentials = {
    ...credentials,
    access_token: body.access_token,
    // Not every provider rotates refresh tokens — keep the old one when the
    // response doesn't carry a new one.
    ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
    ...(typeof body.expires_in === "number" ? { expires_at: Math.floor(Date.now() / 1000) + body.expires_in } : {}),
  };
  await persist(next);
  return next;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface KimiUsageOutcome {
  windows?: LimitWindow[];
  overage?: OverageInfo;
  error?: string;
}

/** The live usages read for one Kimi OAuth credential — shared by the kimi
 * tool's own fetcher and the pi adapter (both hold the same account's
 * token/refresh pair, just in each client's own store format). Auth
 * handling: a token expiring within EXPIRY_SKEW_SECONDS is refreshed
 * proactively, and a 401/403 triggers one refresh + retry when a
 * refresh_token exists. Anything still rejected after that is reported as
 * needing re-authentication, not retried further. `persist` is only invoked
 * when a refresh actually produced new credentials. */
export async function fetchKimiUsageForCredentials(
  credentials: KimiOAuthCredentials,
  persist: (next: KimiOAuthCredentials) => Promise<void>,
): Promise<KimiUsageOutcome> {
  let accessToken = credentials.access_token;
  let refreshAttempted = false;
  let refreshError: string | undefined;

  const secondsUntilExpiry =
    credentials.expires_at === undefined ? Number.POSITIVE_INFINITY : credentials.expires_at - Date.now() / 1000;
  if (secondsUntilExpiry <= EXPIRY_SKEW_SECONDS && credentials.refresh_token) {
    refreshAttempted = true;
    try {
      accessToken = (await refreshCredentials(credentials, persist)).access_token;
    } catch (err) {
      // Fall through with the existing token: within the skew window it can
      // still be technically valid, and the GET below is the authoritative
      // check (a network failure here would sink the GET anyway).
      refreshError = errorMessage(err);
    }
  }

  const fetchUsages = (token: string) =>
    // Retry wrapper, NOT applied to the token refresh above: refreshing is
    // rotating — a blind retry after a lost response would race the rotated
    // token. The usages GET is a pure read, safe to retry.
    fetchWithRetry(USAGES_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });

  let response: Response;
  try {
    response = await fetchUsages(accessToken);
  } catch (err) {
    return { error: `usage fetch failed: ${errorMessage(err)}` };
  }

  if ((response.status === 401 || response.status === 403) && credentials.refresh_token && !refreshAttempted) {
    refreshAttempted = true;
    try {
      accessToken = (await refreshCredentials(credentials, persist)).access_token;
    } catch (err) {
      refreshError = errorMessage(err);
    }
    if (refreshError === undefined) {
      try {
        response = await fetchUsages(accessToken);
      } catch (err) {
        return { error: `usage fetch failed after token refresh: ${errorMessage(err)}` };
      }
    }
  }

  if (response.status === 401 || response.status === 403) {
    return {
      error:
        `authentication rejected (HTTP ${response.status})` +
        (refreshError ? `; token refresh also failed: ${refreshError}` : "") +
        " — re-authenticate by running `kimi` under this identity",
    };
  }
  if (!response.ok) {
    return { error: `usage fetch failed (HTTP ${response.status})` };
  }

  let payload: KimiUsagesResponseWire;
  try {
    payload = (await response.json()) as KimiUsagesResponseWire;
  } catch (err) {
    return { error: `could not parse usage response: ${errorMessage(err)}` };
  }

  const windows = windowsFromUsagesResponse(payload);
  if (windows.length === 0) {
    return { error: "kimi reported no quota windows" };
  }
  const overage = overageFromBoosterWallet(payload.boosterWallet);
  return { windows, ...(overage ? { overage } : {}) };
}

/**
 * Fetches live quota usage for one kimi identity via
 * `GET https://api.kimi.com/coding/v1/usages`, authenticated with the OAuth
 * access token from `<configDir>/credentials/kimi-code.json`.
 *
 * Response shape, confirmed live 2026-07-17 against the real account on this
 * machine (LEVEL_STANDARD membership):
 * - `limits[]`: duration-windowed quotas — the 300-minute window is the 5h
 *   session window; counters (`limit`/`used`/`remaining`) are numeric
 *   STRINGS, and each window carries its own `resetTime`.
 * - top-level `usage`: the weekly quota (resetTime exactly 7 days out),
 *   reported separately from `limits[]`.
 */
export async function fetchKimiLimits(identity: Identity): Promise<FetchedLimitResult> {
  const base: Pick<FetchedLimitResult, "toolName" | "identity"> = { toolName: "kimi", identity };
  const credentialsPath = join(identity.configDir, "credentials", "kimi-code.json");

  let credentials: CredentialsFile;
  try {
    credentials = JSON.parse(await readFile(credentialsPath, "utf8")) as CredentialsFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      credentials = {};
    } else if (err instanceof SyntaxError) {
      return { ...base, windows: [], status: "unavailable", error: `could not parse credentials file: ${err.message}` };
    } else {
      return { ...base, windows: [], status: "unavailable", error: errorMessage(err) };
    }
  }

  // ONE credential per (identity, provider): when this identity's own file
  // is missing or blank, a same-named pi identity's projected copy may hold
  // the live token — prefer the freshest copy across stores before giving
  // up (see kimi-store.ts).
  let source: KimiOAuthCredentials | undefined = credentialsFrom(credentials);
  if (!source) {
    source = await readFreshestKimiCredentials(identity, "kimi");
    if (!source) {
      return {
        ...base,
        windows: [],
        status: "unavailable",
        error: credentials.access_token || credentials.refresh_token
          ? "not authenticated (credentials file has no usable access_token — run `kimi` under this identity to log in)"
          : "not authenticated (no credentials file — run `kimi` under this identity to log in)",
      };
    }
  }

  // Write-through: the rotated token lands in EVERY store of this account
  // (own credentials file AND the same-named pi identity's projected copy),
  // so the two never race for the live refresh token (see kimi-store.ts).
  const persist = (next: KimiOAuthCredentials): Promise<void> => persistKimiCredentials(identity, "kimi", next);

  const outcome = await fetchKimiUsageForCredentials(source, persist);
  if (outcome.error || !outcome.windows) {
    return { ...base, windows: [], status: "unavailable", error: outcome.error };
  }
  return {
    ...base,
    windows: outcome.windows,
    status: "live",
    capturedAt: new Date().toISOString(),
    ...(outcome.overage ? { overage: outcome.overage } : {}),
  };
}
