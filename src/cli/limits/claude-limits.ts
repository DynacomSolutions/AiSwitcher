import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Identity } from "../../identities/types.ts";
import { categorizeByLabel } from "./bucket.ts";
import { fetchWithRetry } from "./http.ts";
import type { LimitWindow, OverageInfo, FetchedLimitResult } from "./types.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** The beta header claude's own client sends on this endpoint (extracted from
 * the installed 2.1.260 binary, same strings technique this project uses
 * elsewhere); without it the endpoint rejects the OAuth access token. */
const OAUTH_BETA_HEADER = "oauth-2025-04-20";

/** The one message both auth-failure paths report: an expired token before
 * the request goes out (checked locally, never refreshed here) and a
 * 401/403 from the endpoint itself mean the same thing to the user. */
const EXPIRED_TOKEN_MESSAGE = "access token expired: run `claude` once interactively under this identity to refresh";

/**
 * Why this probe is a READ-ONLY direct API call and never spawns claude
 * (the 2026-09 auth-wipe incident):
 *
 * The old probe ran `claude auth status` and `claude -p "/usage"` against the
 * live identity config dir. The `/usage` turn performs an authenticated
 * `GET /api/oauth/usage`, and Claude Code refreshes the OAuth token inline
 * whenever the access token has expired. Anthropic rotates the refresh token
 * on every refresh, so two independent processes sharing one config dir race
 * it: whichever refreshes first invalidates the other's refresh token, and
 * the loser's next refresh comes back `invalid_grant`. Claude Code's own
 * response to that rejection is to WIPE the credential file's token fields.
 * The second writer here was the root k3s pod running the AIS web server,
 * which polls this codepath against the same live identity dirs as the
 * user's own claude runs. Verified live 2026-09-07 on all three identities
 * on this machine: `.credentials.json` present with
 * `claudeAiOauth.accessToken`/`refreshToken` EMPTY and `expiresAt: 0`, while
 * the metadata (`scopes`, `subscriptionType`, `rateLimitTier`) is preserved:
 * that exact shape is the wipe signature.
 *
 * The invariant this file now keeps: AIS NEVER spawns claude against a live
 * identity config dir from a quota/auth probe. Claude Code's own client
 * sends this GET with `refreshOAuth: true` and retries after a refresh on
 * 401; this probe does the exact opposite: it never refreshes, never
 * retries on 401/403, and never writes anything into the config dir. An
 * expired token is reported as "run claude once interactively" (a real
 * user-driven claude run is the single, legitimate refresh writer), and a
 * wiped file is reported as the re-login state it is.
 */

/** The credential states a `<configDir>/.credentials.json` read can end in,
 * precise enough that each maps to its own honest report message. Shared
 * with doctor/claude-doctor.ts, which short-circuits its live probe on the
 * "wiped" state (spawning a turn against wiped credentials can only produce
 * a login error, and this codebase no longer spawns claude casually: see the
 * incident note above). */
export type ClaudeCredentialState =
  /** No credential file at all. */
  | { kind: "absent" }
  /** A file exists but holds no `claudeAiOauth` block: an API-key/console
   * billing account, which has no subscription rate-limit data. */
  | { kind: "no-oauth" }
  /** The wipe signature: `claudeAiOauth` present but no usable accessToken.
   * Verified live with both token fields empty, `expiresAt: 0`, and the
   * metadata preserved; any other unusable-accessToken shape lands here too
   * since the remedy (re-login) is the same. */
  | { kind: "wiped" }
  /** A usable access token. `expiresAtMs` is the file's own epoch-ms
   * `expiresAt` when present and sane; absent when the file doesn't carry a
   * usable one (the GET below is then the authoritative expiry check). */
  | { kind: "oauth"; accessToken: string; expiresAtMs?: number };

/** Reads `<configDir>/.credentials.json` (read-only; nothing here EVER
 * writes to the config dir). Follows the credential-reading precedent of
 * identities/pi-auth.ts's `claudeCredential` (same file, same `claudeAiOauth`
 * block) and the tolerant-read conventions of limits/kimi-store.ts. Throws on
 * an unreadable or unparseable file (the caller maps that to an honest
 * "could not parse" report); only ENOENT maps to a state. */
export async function readClaudeCredentialState(configDir: string): Promise<ClaudeCredentialState> {
  const path = join(configDir, ".credentials.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`could not parse credentials file: ${err instanceof Error ? err.message : String(err)}`);
  }
  const oauth =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { claudeAiOauth?: unknown }).claudeAiOauth
      : undefined;
  if (typeof oauth !== "object" || oauth === null || Array.isArray(oauth)) return { kind: "no-oauth" };
  const block = oauth as { accessToken?: unknown; expiresAt?: unknown };
  const accessToken = typeof block.accessToken === "string" ? block.accessToken : "";
  if (accessToken === "") return { kind: "wiped" };
  const expiresAtMs =
    typeof block.expiresAt === "number" && Number.isFinite(block.expiresAt) && block.expiresAt > 0
      ? block.expiresAt
      : undefined;
  return { kind: "oauth", accessToken, ...(expiresAtMs !== undefined ? { expiresAtMs } : {}) };
}

/** One usage window in the `GET /api/oauth/usage` response. `utilization` is
 * ALREADY a 0-100 percentage on the wire (verified against the installed
 * binary: the usage UI renders `${Math.floor(utilization)}% used` directly),
 * and `resets_at` an ISO timestamp; both are nullable, and the UI omits any
 * window that is null or whose utilization is null. */
export interface ClaudeUsageWindowWire {
  utilization?: number | null;
  resets_at?: string | null;
}

/** The response's `extra_usage` block (Anthropic's billed-beyond-subscription
 * overage): every field is nullable/optional. The UNITS of `used_credits`/
 * `monthly_limit` are NOT confirmed: the native binary keeps its source in a
 * serialised blob, so no formatter string could be extracted to prove
 * whether these are dollars, cents, or an Anthropic-credit unit. */
export interface ClaudeExtraUsageWire {
  monthly_limit?: number | null;
  used_credits?: number | null;
  utilization?: number | null;
  currency?: string | null;
  disabled_reason?: string | null;
}

/** Response shape of `GET https://api.anthropic.com/api/oauth/usage`,
 * extracted from the installed claude 2.1.260 native binary. Only the keys
 * this adapter reads are declared; claude's own zod schema for this response
 * uses `.passthrough()`, so unknown keys (`cinder_cove`, `limits`,
 * `seven_day_oauth_apps`, anything future) must simply be ignored. */
export interface ClaudeUsageResponseWire {
  five_hour?: ClaudeUsageWindowWire | null;
  seven_day?: ClaudeUsageWindowWire | null;
  seven_day_sonnet?: ClaudeUsageWindowWire | null;
  seven_day_opus?: ClaudeUsageWindowWire | null;
  extra_usage?: ClaudeExtraUsageWire | null;
}

/** The windows this adapter reports, in the usage UI's own order, with the
 * labels the report has always rendered for them: "session (5h)" and
 * "week (all)" are the exact spellings the spawn-era probe produced
 * (normalizeLabel mapped the UI's "Current session"/"Current week (all
 * models)" titles onto them), so aggregations and user habits don't break;
 * the model-specific weeks follow the existing parenthesised-model
 * convention live data already showed ("week (Fable)" on a Max account).
 * The binary's UI titles for these are "Current session", "Current week (all
 * models)", "Current week (Sonnet only)", "Current week (Opus only)".
 * `seven_day_oauth_apps` has no UI title in the binary (the usage dialog
 * never renders it), so it is deliberately not reported. */
const WINDOW_LABELS: ReadonlyArray<[key: "five_hour" | "seven_day" | "seven_day_sonnet" | "seven_day_opus", label: string]> = [
  ["five_hour", "session (5h)"],
  ["seven_day", "week (all)"],
  ["seven_day_sonnet", "week (Sonnet)"],
  ["seven_day_opus", "week (Opus)"],
];

/** Same human formatting as kimi-limits.ts/codex-limits.ts (short month +
 * day + time in the user's locale, e.g. "Sep 12, 6:21 PM"; the report
 * prepends "resets "). An unparseable resets_at yields NO resetsAt rather
 * than the raw string leaking through half-formatted. */
function formatResetsAt(resetsAt: string | null | undefined): string | undefined {
  if (!resetsAt) return undefined;
  const parsed = new Date(resetsAt);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Pure mapping from the wire shape to display windows, exported so tests
 * can exercise it without any network or credential files. Mirrors the
 * binary's own omission rule: a window that is null, or whose utilization is
 * null (or not a finite number), is skipped rather than guessed at, same
 * "don't guess" stance as kimi-limits.ts's windowsFromUsagesResponse.
 * Categories come from the same categorizeByLabel convention the spawn-era
 * parser used. */
export function windowsFromUsageResponse(resp: ClaudeUsageResponseWire): LimitWindow[] {
  const windows: LimitWindow[] = [];
  for (const [key, label] of WINDOW_LABELS) {
    const wire = resp[key];
    const utilization = wire?.utilization;
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) continue;
    windows.push({
      label,
      category: categorizeByLabel(label),
      usedPercent: Math.min(100, Math.max(0, utilization)),
      resetsAt: formatResetsAt(wire?.resets_at),
    });
  }
  return windows;
}

/** Pure mapping from the `extra_usage` block to an OverageInfo, exported for
 * tests. Keeps the spawn-era probe's conservative states and exact labels
 * (usage/report.ts renders `spentUsd` as a dollar figure and anything else
 * as the label verbatim, so the confirmed-zero states carry `spentUsd: 0`
 * and the nonzero state stays label-only):
 *
 * - `disabled_reason` set, or `monthly_limit` null: extra usage isn't a
 *   thing this account can spend on, an unambiguous confirmed $0. (A null
 *   `monthly_limit` COULD in principle mean "no cap configured" rather than
 *   "no extra-usage plan"; it is read conservatively as the confirmed-zero
 *   state, same as the text-probe era.)
 * - `monthly_limit` present with `used_credits` null/0: the account has the
 *   feature but isn't drawing on it, also a confirmed $0.
 * - `used_credits` > 0: real nonzero spend, but the field's units are
 *   unconfirmed (see ClaudeExtraUsageWire), so NO spentUsd is derived from
 *   it: label-only, exactly like the text era's "using extra usage".
 *
 * No "out of extra usage" state is derived: `utilization`'s scale for this
 * block (0-1 vs 0-100) is unconfirmed, so exhaustion can't be told apart
 * from partial use honestly. */
export function overageFromExtraUsage(extra: ClaudeExtraUsageWire | undefined): OverageInfo | undefined {
  if (!extra) return undefined;
  if (extra.disabled_reason || extra.monthly_limit === null || extra.monthly_limit === undefined) {
    return { active: false, label: "extra usage not available on this seat", spentUsd: 0 };
  }
  const used = extra.used_credits;
  if (typeof used !== "number" || !Number.isFinite(used) || used <= 0) {
    return { active: false, label: "subscription only", spentUsd: 0 };
  }
  return { active: true, label: "using extra usage" };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fetches live quota usage for one claude identity via a READ-ONLY
 * `GET https://api.anthropic.com/api/oauth/usage`, authenticated with the
 * OAuth access token read straight out of `<configDir>/.credentials.json`.
 * No claude binary is resolved or spawned for any reason (see the incident
 * note at the top of this file), and nothing is ever written back: an
 * expired access token is terminal (reported, never refreshed here), and a
 * 401/403 is terminal (claude's own client would refresh-and-retry; this
 * probe deliberately does the opposite, since refreshing from a second
 * writer is what caused the 2026-09 wipes). The GET itself rides http.ts's
 * shared fetchWithRetry like the other live adapters: transient transport
 * blips are retried with backoff (the user has been explicit that transient
 * failures must not become rows), HTTP statuses are never retried.
 */
export async function fetchClaudeLimits(identity: Identity): Promise<FetchedLimitResult> {
  const base: Pick<FetchedLimitResult, "toolName" | "identity"> = { toolName: "claude", identity };

  let state: ClaudeCredentialState;
  try {
    state = await readClaudeCredentialState(identity.configDir);
  } catch (err) {
    return { ...base, windows: [], status: "unavailable", error: errorMessage(err) };
  }
  switch (state.kind) {
    case "absent":
      return { ...base, windows: [], status: "unavailable", error: "not authenticated" };
    case "no-oauth":
      return {
        ...base,
        windows: [],
        status: "unavailable",
        error: "no subscription rate-limit data (may be using API-key/console billing instead of a Claude.ai plan)",
      };
    case "wiped":
      return {
        ...base,
        windows: [],
        status: "unavailable",
        error: "credentials invalidated by a failed token refresh: run `claude auth login` under this identity to re-authenticate",
      };
  }

  // Never refreshed from here, ever: expiry is checked locally first and
  // reported, so an expired token doesn't even produce the API call (the
  // call is what made spawned claude refresh inline, and a second writer
  // refreshing is exactly the race this probe exists to eliminate).
  if (state.expiresAtMs !== undefined && state.expiresAtMs <= Date.now()) {
    return { ...base, windows: [], status: "unavailable", error: EXPIRED_TOKEN_MESSAGE };
  }

  let response: Response;
  try {
    response = await fetchWithRetry(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${state.accessToken}`,
        "anthropic-beta": OAUTH_BETA_HEADER,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    return { ...base, windows: [], status: "unavailable", error: `usage fetch failed: ${errorMessage(err)}` };
  }

  if (response.status === 401 || response.status === 403) {
    return { ...base, windows: [], status: "unavailable", error: EXPIRED_TOKEN_MESSAGE };
  }
  if (!response.ok) {
    return { ...base, windows: [], status: "unavailable", error: `usage fetch failed (HTTP ${response.status})` };
  }

  let payload: ClaudeUsageResponseWire;
  try {
    payload = (await response.json()) as ClaudeUsageResponseWire;
  } catch (err) {
    return { ...base, windows: [], status: "unavailable", error: `could not parse usage response: ${errorMessage(err)}` };
  }

  const windows = windowsFromUsageResponse(payload);
  if (windows.length === 0) {
    return {
      ...base,
      windows: [],
      status: "unavailable",
      error: "no subscription rate-limit data (may be using API-key/console billing instead of a Claude.ai plan)",
    };
  }

  const overage = overageFromExtraUsage(payload.extra_usage ?? undefined);
  return { ...base, windows, status: "live", capturedAt: new Date().toISOString(), ...(overage ? { overage } : {}) };
}
