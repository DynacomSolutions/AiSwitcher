import { grantFingerprint } from "../identities/oauth-reconcile.ts";
import { accessTokenLifetimeSeconds, DEFAULT_EXPIRY_WINDOW_HOURS, GATEWAY_RENEW_FRACTION, MIN_RENEW_WINDOW_S, readEffectiveGrant, type RefreshableTool } from "../identities/oauth-refresh.ts";
import type { Identity } from "../identities/types.ts";
import type { RefreshSummaryRow } from "./refresh-guard.ts";

/** One login the gateway keeps alive, as GET /logins/renewal reports it. No token, no email, no path. */
export interface LoginRenewal {
  provider: string;
  identity: string;
  renewedBy: "gateway";
  lastRefreshAt: string | null;
  /** The pod that sent the last refresh (from the journal holder), or null when only the stored mint time is known. */
  lastRefreshReplica: string | null;
  /** The last failed or dead answer, only while no later refresh succeeded. */
  lastError: { at: string; code: string; detail: string } | null;
  expiresAt: string | null;
  nextRefreshAt: string | null;
  revoked: boolean;
}

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
const DAY_S = 86_400;

/** Unix seconds when the gateway keep-alive next renews a login (the rules of shouldAttemptOAuthRefresh with the gateway's options). */
export function nextRefreshSeconds(tool: string, grant: { expires_at?: number; minted_at?: number }, lastRefreshSeconds: number | undefined): number | undefined {
  const daily = lastRefreshSeconds === undefined ? undefined : lastRefreshSeconds + DAY_S;
  if (tool === "claude" || tool === "grok") {
    if (grant.expires_at === undefined) return undefined;
    const lifetime = accessTokenLifetimeSeconds({ access_token: "", ...grant }, tool, lastRefreshSeconds === undefined ? undefined : new Date(lastRefreshSeconds * 1000).toISOString());
    return grant.expires_at - Math.max(MIN_RENEW_WINDOW_S, GATEWAY_RENEW_FRACTION * lifetime);
  }
  const byExpiry = tool === "codex" && grant.expires_at !== undefined ? grant.expires_at - DEFAULT_EXPIRY_WINDOW_HOURS * 3600 : undefined;
  const candidates = [daily, byExpiry].filter((v): v is number => v !== undefined);
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

export async function buildRenewalReport(deps: {
  tools: readonly string[];
  accounts: (tool: string) => Promise<Identity[]>;
  summary: () => Promise<RefreshSummaryRow[]>;
  /** This replica's own memory of a dead login (the journal answers for the others). */
  isRevoked?: (tool: string, name: string, fingerprint: string | undefined) => boolean;
  now?: () => Date;
}): Promise<LoginRenewal[]> {
  const rows = new Map<string, RefreshSummaryRow>();
  for (const r of await deps.summary()) rows.set(`${r.provider}/${r.identity}`, r);
  const out: LoginRenewal[] = [];
  for (const tool of deps.tools) {
    for (const account of await deps.accounts(tool).catch(() => [] as Identity[])) {
      const grant = (await readEffectiveGrant(tool as RefreshableTool, account).catch(() => undefined))?.grant;
      const row = rows.get(`${tool}/${account.name}`);
      const fingerprint = grant?.refresh_token ? grantFingerprint(grant) : undefined;
      const journalRefreshS = row?.refreshed ? Math.floor(Date.parse(row.refreshed.ts) / 1000) : undefined;
      const lastS = journalRefreshS ?? grant?.minted_at;
      const newerError = row?.error && (!row.refreshed || row.error.id > row.refreshed.id) ? row.error : undefined;
      const revoked = (newerError?.outcome === "dead" && fingerprint !== undefined && newerError.oldFp === fingerprint) || deps.isRevoked?.(tool, account.name, fingerprint) === true;
      const next = grant ? nextRefreshSeconds(tool, grant, lastS) : undefined;
      out.push({
        provider: tool,
        identity: account.name,
        renewedBy: "gateway",
        lastRefreshAt: lastS !== undefined ? iso(lastS) : null,
        lastRefreshReplica: row?.refreshed ? row.refreshed.holder.split(":")[0] || null : null,
        lastError: newerError
          ? { at: newerError.ts, code: newerError.code ?? (newerError.outcome === "dead" ? "invalid_grant" : "other"), detail: newerError.outcome === "dead" ? "the provider answered a dead-grant code; only a new login helps" : "the last refresh request failed" }
          : null,
        expiresAt: grant?.expires_at !== undefined ? iso(grant.expires_at) : null,
        nextRefreshAt: revoked || next === undefined ? null : iso(next),
        revoked,
      });
    }
  }
  return out;
}
