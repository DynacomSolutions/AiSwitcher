import { join } from "node:path";
import {
  grantFingerprint,
  jwtExpSeconds,
  readPiEntry,
  reconcileNativeProviderStores,
  readProviderGrantCopy,
  writePiEntry,
  writeProviderGrantCopy,
  type NativeReconcilableTool,
  type OAuthGrant,
} from "./oauth-reconcile.ts";
import { expandPath } from "./match.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile } from "./store.ts";
import { PI_CONFIG } from "./tool-configs.ts";
import type { Identity } from "./types.ts";
import { persistKimiCredentials, readFreshestKimiCredentials } from "../cli/limits/kimi-store.ts";
import { refreshKimiOAuthToken } from "../cli/limits/kimi-limits.ts";
import type { KimiOAuthCredentials } from "../cli/limits/kimi-limits.ts";

/**
 * Daemon-side PROACTIVE OAuth refresh — the layer PR #60's reconcile cannot
 * provide. The reconcile only arbitrates between EXISTING copies; access
 * tokens still expire by design, and until now only the real CLI's own next
 * run ever renewed the grant (so a token pi refreshed during pi usage read
 * as expired in every other store until that CLI happened to run again, and
 * an expired grant sat expired until then). This module POSTs each
 * provider's OAuth token endpoint with the stored refresh token and writes
 * the rotated grant through to EVERY store of the account per the
 * one-credential law (atomic, 0600, one-time backup), so no copy ever has
 * to wait for its own CLI to refresh.
 *
 * Endpoints and client ids were taken from the real CLIs' own code on this
 * machine (public OAuth clients, embedded in the distributed binaries —
 * the same class of well-known constant as kimi's, already in-tree in
 * kimi-limits.ts):
 * - openai-codex: `strings` on the installed codex binary
 *   (~/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/
 *   codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex) shows
 *   `https://auth.openai.com/oauth/token` and the client id below; the
 *   refresh is a standard RFC 6749 refresh_token grant.
 * - anthropic: the installed Claude Code binary
 *   (~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/
 *   node_modules/@anthropic-ai/claude-code-linux-x64/claude) carries
 *   `https://platform.claude.com/v1/oauth/token` and the client id below.
 * - xai (grok): the grok binary refreshes via plain OIDC discovery —
 *   "The CLI discovers endpoints via `{issuer}/.well-known/
 *   openid-configuration` ... Tokens auto-refresh silently via the stored
 *   refresh_token" (its own embedded docs). The account's auth.json entry
 *   carries `oidc_issuer` and `oidc_client_id`, so no constant is
 *   hard-coded here: the token endpoint is read from the live discovery
 *   document (auth.x.ai publishes token_endpoint
 *   https://auth.x.ai/oauth2/token).
 * - kimi: the existing refresh machinery in kimi-limits.ts
 *   (auth.kimi.com/api/oauth/token), reused verbatim.
 *
 * A revoked/invalid refresh token is diagnosed from the provider's
 * `invalid_grant` / `invalid_client` error (or a 400/401) and is terminal:
 * the state is surfaced honestly (scheduler status, doctor, auth status)
 * as "re-login required" and the refresher never hammers the endpoint
 * again for the same refresh token (see RefreshRevokedError and the
 * revokedFingerprint state in auth-refresh.ts).
 */

/** Thrown when a token endpoint rejects the grant. `revoked` marks the
 * terminal invalid_grant/invalid_client class: re-login is the only fix,
 * and retrying cannot succeed. Carries the refresh token's FINGERPRINT
 * (never the token) so the scheduler can pin the diagnosis to this exact
 * grant and stop retrying until a re-login mints a different one. */
export class OAuthRefreshError extends Error {
  readonly revoked: boolean;
  readonly refreshFingerprint?: string;
  constructor(message: string, revoked: boolean, refreshFingerprint?: string) {
    super(message);
    this.name = "OAuthRefreshError";
    this.revoked = revoked;
    this.refreshFingerprint = refreshFingerprint;
  }
}

/** The codex CLI's public OAuth client id (embedded in the distributed
 * binary — a public client identifier, not a secret). */
export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // gitleaks:allow
export const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Claude Code's public OAuth client id (same class of well-known public
 * constant; the token endpoint moved from console.anthropic.com to
 * platform.claude.com — the installed binary uses the platform host). */
export const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // gitleaks:allow
export const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

export const REFRESH_TIMEOUT_MS = 15_000;

export type FetchImpl = typeof fetch;

/** The tools with a daemon-side refresher. kimi rides its own machinery;
 * the other three use this module's generic exchange. */
export type RefreshableTool = NativeReconcilableTool | "kimi";

const REFRESH_HINTS: Record<RefreshableTool, string> = {
  claude: "run `claude /login` under this identity (or `ais auth login` equivalent) and re-import to pi",
  codex: "run `codex login` under this identity and re-import to pi",
  grok: "run `grok login` under this identity and re-import to pi",
  kimi: "run `kimi` under this identity to log in again",
};

interface TokenResponseWire {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

/** One RFC 6749 refresh_token grant POST. Injectable fetch for tests — no
 * test ever touches a real token endpoint. */
export async function postRefreshTokenGrant(
  endpoint: string,
  body: Record<string, string>,
  deps: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<TokenResponseWire> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(deps.timeoutMs ?? REFRESH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OAuthRefreshError(
      `token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      false,
    );
  }
  let parsed: TokenResponseWire = {};
  try {
    parsed = (await response.json()) as TokenResponseWire;
  } catch {
    // A non-JSON error body is fine; the status check below reports it.
  }
  if (!response.ok) {
    const code = typeof parsed.error === "string" ? parsed.error : undefined;
    const revoked = response.status === 400 || response.status === 401 || code === "invalid_grant" || code === "invalid_client";
    throw new OAuthRefreshError(
      `token refresh rejected (HTTP ${response.status}${code ? ` ${code}` : ""})`,
      revoked,
    );
  }
  return parsed;
}

/** xai/grok discover their token endpoint per account via plain OIDC
 * discovery (the CLI's own mechanism): `{oidc_issuer}/.well-known/
 * openid-configuration` -> `token_endpoint`. The issuer and client id live
 * on the account's own auth.json entry, so nothing provider-specific is
 * hard-coded here. */
export async function resolveXaiTokenEndpoint(
  rawEntry: Record<string, unknown>,
  deps: { fetchImpl?: FetchImpl } = {},
): Promise<{ endpoint: string; clientId: string }> {
  const issuer = typeof rawEntry.oidc_issuer === "string" ? rawEntry.oidc_issuer : undefined;
  const clientId = typeof rawEntry.oidc_client_id === "string" ? rawEntry.oidc_client_id : undefined;
  if (!issuer || !clientId) {
    throw new OAuthRefreshError(
      "grok store entry carries no oidc_issuer/oidc_client_id (API-key or pre-OIDC entry) — cannot refresh",
      false,
    );
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  let doc: { token_endpoint?: unknown };
  try {
    const response = await fetchImpl(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    doc = (await response.json()) as { token_endpoint?: unknown };
  } catch (err) {
    throw new OAuthRefreshError(
      `OIDC discovery at ${issuer} failed: ${err instanceof Error ? err.message : String(err)}`,
      false,
    );
  }
  if (typeof doc.token_endpoint !== "string" || doc.token_endpoint.length === 0) {
    throw new OAuthRefreshError(`OIDC discovery at ${issuer} returned no token_endpoint`, false);
  }
  return { endpoint: doc.token_endpoint, clientId };
}

/** Maps a token response onto the canonical grant: minted now, expiry from
 * expires_in (falling back to the access token's JWT exp), and the NEW
 * refresh token kept only when the provider actually rotated (several do
 * not; keeping the old one is required, not a fallback). */
export function grantFromTokenResponse(
  previous: OAuthGrant,
  response: TokenResponseWire,
  nowSeconds: number,
): OAuthGrant {
  if (!response.access_token) throw new OAuthRefreshError("token refresh returned no access_token", false);
  return {
    access_token: response.access_token,
    refresh_token: response.refresh_token ?? previous.refresh_token,
    ...(response.expires_in !== undefined
      ? { expires_at: nowSeconds + response.expires_in }
      : jwtExpSeconds(response.access_token) !== undefined
        ? { expires_at: jwtExpSeconds(response.access_token) }
        : {}),
    minted_at: nowSeconds,
  };
}

export interface WriteThroughReport {
  /** Store paths the rotated grant was written to (fingerprints never
   * needed here — paths only, for honest reporting). */
  written: string[];
  failed: Array<{ path: string; error: string }>;
}

async function piIdentityFor(identityName: string): Promise<Identity | undefined> {
  try {
    const file = await loadIdentitiesFile(PI_CONFIG.identitiesJsonPath);
    const found = findIdentityByNameOrAlias(file.identities, identityName);
    return found ? { ...found, configDir: expandPath(found.configDir) } : undefined;
  } catch {
    return undefined;
  }
}

async function writePiGrant(provider: string, piDir: string, grant: OAuthGrant, backups: Set<string>): Promise<string> {
  const path = join(expandPath(piDir), "auth.json");
  await writePiEntry(path, provider, grant, backups);
  return path;
}

/** Writes the rotated grant through to EVERY store of the account per the
 * one-credential law: the native store (in its own shape) and the
 * same-named pi identity's projected copy. kimi routes through its own
 * kimi-store write-through (which covers both stores). A store that cannot
 * be written is reported, never fatal — the copies heal on the next
 * reconcile. */
export async function writeGrantThroughStores(
  tool: RefreshableTool,
  identity: Identity,
  grant: OAuthGrant,
  options: { entryKey?: string; piDir?: string } = {},
): Promise<WriteThroughReport> {
  const written: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  if (tool === "kimi") {
    const credentials: KimiOAuthCredentials = {
      access_token: grant.access_token,
      ...(grant.refresh_token ? { refresh_token: grant.refresh_token } : {}),
      ...(grant.expires_at !== undefined ? { expires_at: grant.expires_at } : {}),
    };
    try {
      await persistKimiCredentials(identity, "kimi", credentials);
      written.push("(kimi native + pi stores)");
    } catch (err) {
      failed.push({ path: "kimi stores", error: err instanceof Error ? err.message : String(err) });
    }
    return { written, failed };
  }

  const backups = new Set<string>();
  try {
    await writeProviderGrantCopy(tool, identity.configDir, grant, { entryKey: options.entryKey, backups });
    written.push(`native:${identity.configDir}`);
  } catch (err) {
    failed.push({ path: `native:${identity.configDir}`, error: err instanceof Error ? err.message : String(err) });
  }
  const piDir = options.piDir ?? (await piIdentityFor(identity.name))?.configDir;
  if (piDir) {
    const provider = tool === "claude" ? "anthropic" : tool === "codex" ? "openai-codex" : "xai";
    try {
      written.push(`pi:${await writePiGrant(provider, piDir, grant, backups)}`);
    } catch (err) {
      failed.push({ path: `pi:${piDir}`, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { written, failed };
}

/** The refresh decision for the scheduler's cadence: refresh when the
 * access token is within `expiryWindowHours` of expiry, and at least once
 * a day even for long-lived tokens (so a healthy grant is still exercised
 * and any rotation is propagated). Manual refreshes pass force=true. */
export function shouldAttemptOAuthRefresh(
  grant: OAuthGrant,
  options: { force?: boolean; expiryWindowHours?: number; lastSuccessAt?: string | null; nowSeconds?: number },
): { attempt: boolean; reason: string } {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const windowSeconds = (options.expiryWindowHours ?? DEFAULT_EXPIRY_WINDOW_HOURS) * 3600;
  const secondsLeft = grant.expires_at === undefined ? Number.POSITIVE_INFINITY : grant.expires_at - now;
  if (options.force) return { attempt: true, reason: "manual refresh" };
  if (secondsLeft <= windowSeconds) {
    return {
      attempt: true,
      reason:
        secondsLeft <= 0
          ? `access token expired ${Math.abs(secondsLeft / 3600).toFixed(1)}h ago (window ${options.expiryWindowHours ?? DEFAULT_EXPIRY_WINDOW_HOURS}h)`
          : `access token expires in ${(secondsLeft / 3600).toFixed(1)}h (window ${options.expiryWindowHours ?? DEFAULT_EXPIRY_WINDOW_HOURS}h)`,
    };
  }
  const last = options.lastSuccessAt !== null && options.lastSuccessAt !== undefined ? Date.parse(options.lastSuccessAt) : NaN;
  if (!Number.isFinite(last) || now - last / 1000 >= 86_400) {
    return { attempt: true, reason: "daily keep-alive (no successful refresh in 24h)" };
  }
  return {
    attempt: false,
    reason: `access token expires in ${(secondsLeft / 3600).toFixed(0)}h, refreshed ${Math.round((now - last / 1000) / 3600)}h ago — nothing to do`,
  };
}

export const DEFAULT_EXPIRY_WINDOW_HOURS = 24;

/** Where the freshest refreshable copy of an identity's grant lives. */
async function freshestGrant(
  tool: RefreshableTool,
  identity: Identity,
): Promise<{ grant: OAuthGrant; entryKey?: string; rawEntry?: Record<string, unknown>; source: string } | undefined> {
  if (tool === "kimi") {
    const credentials = await readFreshestKimiCredentials(identity, "kimi");
    if (!credentials) return undefined;
    return {
      grant: {
        access_token: credentials.access_token,
        ...(credentials.refresh_token ? { refresh_token: credentials.refresh_token } : {}),
        ...(credentials.expires_at !== undefined ? { expires_at: credentials.expires_at } : {}),
      },
      source: "kimi stores (freshest)",
    };
  }
  const piDir = (await piIdentityFor(identity.name))?.configDir;
  let piGrant: OAuthGrant | undefined;
  if (piDir) {
    const provider = tool === "claude" ? "anthropic" : tool === "codex" ? "openai-codex" : "xai";
    piGrant = (await readPiEntry(join(expandPath(piDir), "auth.json"), provider))?.grant;
  }
  const piFingerprint = piGrant ? grantFingerprint(piGrant) : undefined;
  const native = await readProviderGrantCopy(tool, identity.configDir, piFingerprint);
  if (!native && !piGrant) return undefined;
  if (native && piGrant) {
    const recency = (grant: OAuthGrant): number => grant.minted_at ?? grant.expires_at ?? -1;
    return recency(native.grant) >= recency(piGrant)
      ? { grant: native.grant, entryKey: native.entryKey, rawEntry: native.rawEntry, source: `native:${native.path}` }
      : { grant: piGrant, entryKey: native?.entryKey, rawEntry: native?.rawEntry, source: "pi auth.json" };
  }
  return native
    ? { grant: native.grant, entryKey: native.entryKey, rawEntry: native.rawEntry, source: `native:${native.path}` }
    : { grant: piGrant!, source: "pi auth.json" };
}

function grantRecencySeconds(grant: OAuthGrant, nowSeconds: number): number {
  return grant.minted_at ?? grant.expires_at ?? nowSeconds;
}

export interface IdentityGrantRefresh {
  tool: RefreshableTool;
  identity: string;
  outcome: "refreshed" | "skipped-fresh" | "skipped-revoked" | "no-grant" | "failed";
  detail: string;
  beforeFingerprint?: string;
  afterFingerprint?: string;
  /** New access-token expiry (unix seconds) on success. */
  expiresAt?: number;
  written: string[];
  writeFailures: Array<{ path: string; error: string }>;
}

export interface OAuthRefreshOptions {
  /** Refresh even when the stored token is still fresh (manual runs). */
  force?: boolean;
  expiryWindowHours?: number;
  /** When set and equal to the stored grant's refresh fingerprint, the
   * grant was already diagnosed revoked: skip without another endpoint
   * call (never loop; a re-login mints a different token and resumes). */
  revokedFingerprint?: string;
  lastSuccessAt?: string | null;
  fetchImpl?: FetchImpl;
  now?: () => number;
}

/** Refreshes one identity's OAuth grant for one tool: picks the freshest
 * copy across the account's stores, exchanges the refresh token at the
 * provider's token endpoint, and writes the rotated grant through to every
 * store. Read paths/fingerprints only — no token value ever leaves this
 * module's call to the token endpoint itself. */
export async function refreshIdentityOAuthGrant(
  tool: RefreshableTool,
  identity: Identity,
  options: OAuthRefreshOptions = {},
): Promise<IdentityGrantRefresh> {
  const base: IdentityGrantRefresh = { tool, identity: identity.name, outcome: "failed", detail: "", written: [], writeFailures: [] };
  const now = options.now ?? Date.now;
  const nowSeconds = () => Math.floor(now() / 1000);

  const freshest = await freshestGrant(tool, identity).catch(() => undefined);
  if (!freshest || !freshest.grant.refresh_token) {
    return {
      ...base,
      outcome: "no-grant",
      detail: "no refreshable OAuth grant in any store (API-key or logged-out identity) — nothing to refresh",
    };
  }
  const beforeFingerprint = grantFingerprint(freshest.grant);
  if (options.revokedFingerprint && options.revokedFingerprint === beforeFingerprint) {
    return {
      ...base,
      outcome: "skipped-revoked",
      beforeFingerprint,
      detail: `refresh token revoked (diagnosed earlier) — re-login required: ${REFRESH_HINTS[tool]}; not retrying until re-login`,
    };
  }

  const decision = shouldAttemptOAuthRefresh(freshest.grant, {
    force: options.force,
    expiryWindowHours: options.expiryWindowHours,
    lastSuccessAt: options.lastSuccessAt,
    nowSeconds: nowSeconds(),
  });
  if (!decision.attempt) {
    return { ...base, outcome: "skipped-fresh", beforeFingerprint, detail: decision.reason };
  }

  let grant: OAuthGrant;
  try {
    if (tool === "kimi") {
      const next = await refreshKimiOAuthToken(freshest.grant, { fetchImpl: options.fetchImpl });
      grant = {
        access_token: next.access_token,
        ...(next.refresh_token ? { refresh_token: next.refresh_token } : {}),
        ...(next.expires_at !== undefined ? { expires_at: next.expires_at } : {}),
        minted_at: nowSeconds(),
      };
    } else if (tool === "codex") {
      const response = await postRefreshTokenGrant(
        OPENAI_CODEX_TOKEN_URL,
        { client_id: OPENAI_CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: freshest.grant.refresh_token },
        { fetchImpl: options.fetchImpl },
      );
      grant = grantFromTokenResponse(freshest.grant, response, nowSeconds());
    } else if (tool === "claude") {
      const response = await postRefreshTokenGrant(
        ANTHROPIC_TOKEN_URL,
        { client_id: ANTHROPIC_CLIENT_ID, grant_type: "refresh_token", refresh_token: freshest.grant.refresh_token },
        { fetchImpl: options.fetchImpl },
      );
      grant = grantFromTokenResponse(freshest.grant, response, nowSeconds());
    } else {
      const rawEntry = freshest.rawEntry;
      if (!rawEntry) {
        throw new OAuthRefreshError(
          "no grok native store entry to read oidc_issuer/oidc_client_id from — cannot run OIDC discovery",
          false,
        );
      }
      const { endpoint, clientId } = await resolveXaiTokenEndpoint(rawEntry, { fetchImpl: options.fetchImpl });
      const response = await postRefreshTokenGrant(
        endpoint,
        { client_id: clientId, grant_type: "refresh_token", refresh_token: freshest.grant.refresh_token },
        { fetchImpl: options.fetchImpl },
      );
      grant = grantFromTokenResponse(freshest.grant, response, nowSeconds());
    }
  } catch (err) {
    if (err instanceof OAuthRefreshError && err.revoked) {
      // Keep the provider's own answer in the message: "is it really
      // revoked, or a bug in our request?" is the first question anyone
      // will ask, and the HTTP status/error code is the evidence.
      throw new OAuthRefreshError(
        `${err.message} — re-login required: ${REFRESH_HINTS[tool]}`,
        true,
        beforeFingerprint,
      );
    }
    throw err;
  }

  const afterFingerprint = grantFingerprint(grant);
  const writeThrough = await writeGrantThroughStores(tool, identity, grant, {
    entryKey: freshest.entryKey,
  });
  const wrote = writeThrough.written.length > 0;
  return {
    ...base,
    outcome: wrote ? "refreshed" : "failed",
    detail: wrote
      ? `grant refreshed (${decision.reason}); new token expires ${grant.expires_at !== undefined ? new Date(grant.expires_at * 1000).toISOString() : "at provider-determined time"}; written to ${writeThrough.written.length} store${writeThrough.written.length === 1 ? "" : "s"}${writeThrough.failed.length > 0 ? `, ${writeThrough.failed.length} store write FAILED` : ""}`
      : `grant refreshed at the provider but NO store could be written: ${writeThrough.failed.map((f) => `${f.path}: ${f.error}`).join("; ")}`,
    beforeFingerprint,
    afterFingerprint,
    expiresAt: grant.expires_at,
    written: writeThrough.written,
    writeFailures: writeThrough.failed,
  };
}

/* ------------------------------------------------------------------ */
/* Doctor / auth-status classifier: expired-but-refreshable vs revoked */
/* ------------------------------------------------------------------ */

export interface OAuthRefreshHealth {
  state: "fresh" | "expiring" | "expired-refreshable" | "expired-no-refresh-token" | "revoked" | "absent";
  /** Human line, safe to render (fingerprints/expiry only, no tokens). */
  detail: string;
  expiresAt?: number;
  refreshFingerprint?: string;
}

/** Classifies one native identity's OAuth store for the doctor and auth
 * status: is the access token expired, and if so is it refreshable (the
 * daemon or `ais auth refresh` heals it) or has the refresh token been
 * diagnosed revoked (only a re-login helps)? `revokedFingerprint` is the
 * scheduler's pinned diagnosis for this identity, when any. */
export async function oauthRefreshHealth(
  tool: RefreshableTool,
  identity: Identity,
  revokedFingerprint?: string,
): Promise<OAuthRefreshHealth> {
  const freshest = await freshestGrant(tool, identity).catch(() => undefined);
  if (!freshest) return { state: "absent", detail: "no OAuth grant in any store" };
  const grant = freshest.grant;
  const fingerprint = grant.refresh_token ? grantFingerprint(grant) : undefined;
  const expiresAt = grant.expires_at ?? jwtExpSeconds(grant.access_token);
  const secondsLeft = expiresAt === undefined ? Number.POSITIVE_INFINITY : expiresAt - Math.floor(Date.now() / 1000);
  if (revokedFingerprint && fingerprint && revokedFingerprint === fingerprint) {
    return {
      state: "revoked",
      detail: `refresh token revoked — re-login required: ${REFRESH_HINTS[tool]}`,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(fingerprint ? { refreshFingerprint: fingerprint } : {}),
    };
  }
  if (secondsLeft > 0 && Number.isFinite(secondsLeft)) {
    const hours = secondsLeft / 3600;
    return {
      state: hours <= 24 ? "expiring" : "fresh",
      detail: `access token expires in ${hours < 48 ? `${hours.toFixed(1)}h` : `${Math.round(hours / 24)}d`}`,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(fingerprint ? { refreshFingerprint: fingerprint } : {}),
    };
  }
  if (!grant.refresh_token) {
    return {
      state: "expired-no-refresh-token",
      detail: `access token expired ${Math.abs(secondsLeft / 3600).toFixed(1)}h ago and no refresh token is stored — log in again`,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
  }
  return {
    state: "expired-refreshable",
    detail: `access token expired ${Math.abs(secondsLeft / 3600).toFixed(1)}h ago — refreshable: the daemon refreshes it proactively, or run \`ais auth refresh ${identity.name} --tool=${tool}\` now`,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(fingerprint ? { refreshFingerprint: fingerprint } : {}),
  };
}

/** Convenience for the fetchers' reconcile-on-read: reconcile once, never
 * throw, and report whether the copies were rewritten (so callers can log
 * a heal without duplicating the logic). */
export async function reconcileOnceForFetch(
  tool: NativeReconcilableTool,
  identity: Identity,
): Promise<{ healed: boolean; detail?: string }> {
  try {
    const entry = await reconcileNativeProviderStores(tool, identity, { write: true });
    const healed = entry.status === "rewrote-native" || entry.status === "rewrote-pi";
    return {
      healed,
      detail: healed ? `${providerLabel(entry.provider)} copies had forked; freshest adopted before the read` : undefined,
    };
  } catch {
    return { healed: false };
  }
}

function providerLabel(provider: string): string {
  return provider;
}
