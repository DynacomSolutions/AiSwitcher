import { Database } from "bun:sqlite";
import { join } from "node:path";
import { OAuthRefreshError, REFRESH_TIMEOUT_MS, type FetchImpl } from "./oauth-refresh.ts";
import { grantFingerprint } from "./oauth-reconcile.ts";

/**
 * Renewal of the OpenCode Console login (the OpenCode Go plan's credential), done the way OpenCode itself does it.
 *
 * OpenCode v2 keeps the login in `<configDir>/data/opencode/opencode.db`, table `credential`, row
 * `integration_id = 'opencode'`, value `{type: "oauth", methodID: "device", access, refresh, expires (ms), metadata:
 * {server, orgID, ...}}`. The access token lives 30 days. OpenCode renews it only when it is used, with
 * `POST <metadata.server>/auth/device/token` (JSON `{grant_type: "refresh_token", refresh_token, client_id:
 * "opencode-cli"}`), answered by `{access_token, refresh_token, expires_in (s), org_id?}`; the refresh token rotates.
 * A 400 `{error: "invalid_grant"}` means signed out: only a new Console sign-in helps.
 *
 * AIS renews inside the expiry window, well before OpenCode would (it waits for expiry), so the two never spend the same
 * refresh token. The write is a compare-and-swap on the row's value: a row OpenCode changed meanwhile is left alone.
 * The gateway store import then carries the new access token to the gateway (home-import.ts, derived key file).
 */

export const OPENCODE_CONSOLE_CLIENT_ID = "opencode-cli";
export const OPENCODE_CONSOLE_DEFAULT_SERVER = "https://opencode.ai/console";
/** Renew when the access token has less than this left (it lives 30 days). */
export const OPENCODE_CONSOLE_EXPIRY_WINDOW_HOURS = 72;

export interface OpencodeConsoleGrant {
  rowId: string;
  /** The row's value exactly as stored (compare-and-swap basis). */
  raw: string;
  value: Record<string, unknown> & { access: string; refresh: string; expires: number };
  server: string;
}

const dbPath = (configDir: string): string => join(configDir, "data", "opencode", "opencode.db");

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The active Console OAuth login in an identity's opencode.db, or undefined (no db, no table, API key login only). */
export function readOpencodeConsoleGrant(configDir: string): OpencodeConsoleGrant | undefined {
  let db: Database;
  try {
    db = new Database(dbPath(configDir), { readonly: true });
  } catch {
    return undefined;
  }
  try {
    const rows = db
      .query("SELECT id, value, active, time_updated FROM credential WHERE integration_id = 'opencode' ORDER BY time_updated DESC")
      .all() as { id: unknown; value: unknown; active: unknown }[];
    for (const row of rows) {
      if (row.active === 0 || typeof row.id !== "string" || typeof row.value !== "string") continue;
      let v: unknown;
      try {
        v = JSON.parse(row.value);
      } catch {
        continue;
      }
      if (!isObj(v) || v.type !== "oauth") continue;
      if (typeof v.access !== "string" || typeof v.refresh !== "string" || !v.refresh || typeof v.expires !== "number") continue;
      const meta = isObj(v.metadata) ? v.metadata : {};
      const server = (typeof meta.server === "string" && meta.server ? meta.server : OPENCODE_CONSOLE_DEFAULT_SERVER).replace(/\/+$/, "");
      return { rowId: row.id, raw: row.value, value: v as OpencodeConsoleGrant["value"], server };
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/** Fingerprint of the stored Console login (never a token), for the scheduler's revoked pin. */
export function opencodeConsoleFingerprint(configDir: string): string | undefined {
  const g = readOpencodeConsoleGrant(configDir);
  return g ? grantFingerprint({ refresh_token: g.value.refresh, access_token: g.value.access }) : undefined;
}

export interface OpencodeConsoleRefreshResult {
  outcome: "refreshed" | "skipped";
  detail: string;
}

export interface OpencodeConsoleRefreshOptions {
  force?: boolean;
  expiryWindowHours?: number;
  /** A grant with this fingerprint was diagnosed signed out: skip it until a new sign-in replaces it. */
  revokedFingerprint?: string;
  fetch?: FetchImpl;
  now?: () => number;
}

/** Renews the identity's Console login when it is inside the expiry window (or `force`), and writes it back. */
export async function refreshOpencodeConsoleGrant(identityName: string, configDir: string, opts: OpencodeConsoleRefreshOptions = {}): Promise<OpencodeConsoleRefreshResult> {
  const grant = readOpencodeConsoleGrant(configDir);
  if (!grant) return { outcome: "skipped", detail: "no OpenCode Console login" };
  const fp = grantFingerprint({ refresh_token: grant.value.refresh, access_token: grant.value.access });
  if (opts.revokedFingerprint && opts.revokedFingerprint === fp) {
    return { outcome: "skipped", detail: `signed out; sign in again with opencode --identity=${identityName}` };
  }
  const now = (opts.now ?? Date.now)();
  const windowMs = (opts.expiryWindowHours ?? OPENCODE_CONSOLE_EXPIRY_WINDOW_HOURS) * 3_600_000;
  const left = grant.value.expires - now;
  if (!opts.force && left > windowMs) {
    return { outcome: "skipped", detail: `valid until ${new Date(grant.value.expires).toISOString()}` };
  }

  const url = `${grant.server}/auth/device/token`;
  const res = await (opts.fetch ?? fetch)(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: grant.value.refresh, client_id: OPENCODE_CONSOLE_CLIENT_ID }),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const errCode = isObj(body) && typeof body.error === "string" ? body.error : undefined;
  if (res.status === 400 && errCode === "invalid_grant") {
    throw new OAuthRefreshError(`OpenCode Console login is signed out; sign in again with opencode --identity=${identityName}`, true, fp, errCode);
  }
  if (!res.ok || !isObj(body) || typeof body.access_token !== "string" || typeof body.refresh_token !== "string" || typeof body.expires_in !== "number") {
    throw new OAuthRefreshError(`OpenCode Console refresh failed: HTTP ${res.status}${errCode ? ` (${errCode})` : ""}`, false, undefined, errCode);
  }

  const meta = isObj(grant.value.metadata) ? grant.value.metadata : undefined;
  const orgId = typeof body.org_id === "string" ? body.org_id : undefined;
  const next = {
    ...grant.value,
    access: body.access_token,
    refresh: body.refresh_token,
    expires: now + body.expires_in * 1000,
    ...(orgId && meta ? { metadata: { ...meta, orgID: orgId, orgName: meta.orgID === orgId && typeof meta.orgName === "string" ? meta.orgName : orgId } } : {}),
  };

  const db = new Database(dbPath(configDir));
  try {
    db.run("PRAGMA busy_timeout = 10000");
    const changed = db.run("UPDATE credential SET value = ?, time_updated = ? WHERE id = ? AND value = ?", [JSON.stringify(next), now, grant.rowId, grant.raw]).changes;
    if (changed !== 1) {
      // OpenCode wrote the row meanwhile: its copy stands; ours (from a refresh token it already spent or not) is dropped.
      return { outcome: "skipped", detail: "OpenCode changed the login meanwhile; kept its copy" };
    }
  } finally {
    db.close();
  }
  return { outcome: "refreshed", detail: `renewed, valid until ${new Date(next.expires).toISOString()}` };
}
