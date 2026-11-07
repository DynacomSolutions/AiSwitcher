import { isGatewayRoutedDir } from "./claude-gateway-entry.ts";
import { expandPath } from "./match.ts";
import { poolsOf } from "./pool/swap-pool.ts";
import { loadIdentitiesFile } from "./store.ts";
import { CLAUDE_CONFIG } from "./tool-configs.ts";
import type { Identity } from "./types.ts";

let ownerProcess = false;

/** Called once by `ais gateway serve`: that process alone owns gateway-managed logins (the console pod and the host never do). */
export function markGatewayOwnerProcess(): void {
  ownerProcess = true;
}

/** AIS_GATEWAY_OWNER=1 / =0 forces the role (tests); otherwise only a process that called markGatewayOwnerProcess owns. */
export function isGatewayOwnerProcess(): boolean {
  const forced = process.env.AIS_GATEWAY_OWNER;
  if (forced === "1") return true;
  if (forced === "0") return false;
  return ownerProcess;
}

/** Members (accounts) of gateway-routed claude pools, whoever asks. Unreadable registry: none. */
export async function listGatewayManagedAccounts(registryPath?: string): Promise<Identity[]> {
  try {
    const file = await loadIdentitiesFile(registryPath ?? CLAUDE_CONFIG.identitiesJsonPath);
    const names = new Set<string>();
    for (const pool of poolsOf(file)) {
      if (await isGatewayRoutedDir(expandPath(pool.configDir))) for (const a of pool.swapPool.accounts) names.add(a);
    }
    return file.identities.filter((i) => names.has(i.name) && !i.swapPool);
  } catch {
    return [];
  }
}

/**
 * True when this process must not refresh, converge, reconcile or write the account's login: the account belongs to a
 * gateway-routed claude pool and this process is not the gateway server. Unreadable registry: not managed.
 */
export async function isGatewayManagedHere(tool: string, identityName: string, registryPath?: string): Promise<boolean> {
  if (tool !== "claude" || isGatewayOwnerProcess()) return false;
  return (await listGatewayManagedAccounts(registryPath)).some((i) => i.name === identityName);
}
