import { AliAuthRefreshError, refreshAliAuthSession } from "../identities/auth-session.ts";
import { isRetired } from "../identities/retired.ts";
import { loadIdentitiesFile } from "../identities/store.ts";
import { ALI_CONFIG } from "../identities/tool-configs.ts";
import type { Identity } from "../identities/types.ts";
import type { Alerter } from "./alerts.ts";

/** Gap between two successful ali session renewals of one login (the retired host timer ran every ten minutes). */
export const ALI_RENEW_EVERY_MS = 10 * 60_000;

/** Live (not retired) ali logins in the registry. An unreadable registry is no logins. */
export async function listAliAccounts(registryPath: string = ALI_CONFIG.identitiesJsonPath): Promise<Identity[]> {
  try {
    return (await loadIdentitiesFile(registryPath)).identities.filter((i) => !isRetired(i));
  } catch {
    return [];
  }
}

/**
 * The gateway owns the ali login. Alibaba's Token plan key is static, but the console session behind its usage figures is a
 * browser login that expires unless it is visited regularly: this renews it for every live ali identity, as the host's
 * `ais-ali-auth-refresh-<identity>` systemd timer did. Each attempt is counted (`ais_gateway_keepalive_total{provider="ali"}`),
 * and a failure raises one owner alert (with the exact fix) until the next success. Never throws.
 */
export async function aliSessionOnce(deps: {
  accounts?: () => Promise<Identity[]>;
  refresh?: (identity: Identity) => Promise<string>;
  metrics: { keepAlive(provider: string, outcome: string): void };
  alerter: Alerter;
  /** "ali/<name>" to the ISO time of the last success; a login renewed less than `everyMs` ago is left alone. */
  lastSuccess?: Map<string, string>;
  now?: () => Date;
  everyMs?: number;
}): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const everyMs = deps.everyMs ?? ALI_RENEW_EVERY_MS;
  const refresh = deps.refresh ?? refreshAliAuthSession;
  const lastSuccess = deps.lastSuccess ?? new Map<string, string>();
  for (const account of await (deps.accounts ?? listAliAccounts)().catch(() => [] as Identity[])) {
    const key = `ali/${account.name}`;
    const last = lastSuccess.get(key);
    if (last !== undefined && now().getTime() - Date.parse(last) < everyMs) {
      deps.metrics.keepAlive("ali", "skipped-fresh");
      continue;
    }
    try {
      await refresh(account);
      lastSuccess.set(key, now().toISOString());
      deps.metrics.keepAlive("ali", "refreshed");
      deps.alerter.recover("refresh-failed", key);
    } catch (err) {
      deps.metrics.keepAlive("ali", "failed");
      // The error text names no secret (ports, browser state, the fix); the hint is the one command a person can act on.
      const hint = err instanceof AliAuthRefreshError && err.hint ? `; fix: ${err.hint}` : "";
      const why = err instanceof Error ? err.message : "unknown error";
      deps.alerter.raise("refresh-failed", key, `renewal of the ali login "${account.name}" failed (${why})${hint}`);
    }
  }
}
