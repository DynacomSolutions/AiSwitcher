import { isGatewayRoutedDir } from "./claude-gateway-entry.ts";
import { expandPath } from "./match.ts";
import { poolsOf } from "./pool/swap-pool.ts";
import { loadIdentitiesFile } from "./store.ts";
import { CLAUDE_CONFIG } from "./tool-configs.ts";

/**
 * The cluster AIS gateway owns the logins of every account in a gateway-routed claude pool: it alone refreshes them.
 * The gateway's own processes run in a pod (KUBERNETES_SERVICE_HOST); AIS_GATEWAY_OWNER=1 / =0 forces the role (tests).
 */
export function isGatewayOwnerProcess(): boolean {
  const forced = process.env.AIS_GATEWAY_OWNER;
  if (forced === "1") return true;
  if (forced === "0") return false;
  return Boolean(process.env.KUBERNETES_SERVICE_HOST);
}

/**
 * True when this process must not refresh, converge, reconcile or write the account's login: the account is a member of a
 * gateway-routed claude pool and this process is not the cluster gateway. Unreadable registry: not managed (nothing is skipped by guess).
 */
export async function isGatewayManagedHere(tool: string, identityName: string, registryPath?: string): Promise<boolean> {
  if (tool !== "claude" || isGatewayOwnerProcess()) return false;
  try {
    const file = await loadIdentitiesFile(registryPath ?? CLAUDE_CONFIG.identitiesJsonPath);
    for (const pool of poolsOf(file)) {
      if (pool.swapPool.accounts.includes(identityName) && (await isGatewayRoutedDir(expandPath(pool.configDir)))) return true;
    }
  } catch {
    // fall through
  }
  return false;
}
