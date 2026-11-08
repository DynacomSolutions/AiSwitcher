import { isGatewayRoutedDir } from "./claude-gateway-entry.ts";
import { expandPath } from "./match.ts";
import { poolsOf } from "./pool/swap-pool.ts";
import { heartbeatHolds } from "./gateway-heartbeat.ts";
import { adapterFor } from "../gateway/providers/index.ts";
import { isRetired } from "./retired.ts";
import { loadIdentitiesFile } from "./store.ts";
import { CLAUDE_CONFIG, CODEX_CONFIG, GROK_CONFIG, KIMI_CONFIG } from "./tool-configs.ts";
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

/** Every refreshable tool the gateway serves (its provider adapter refreshes logins), in keep-alive order. */
export const GATEWAY_REFRESH_TOOLS = ["claude", "codex", "grok", "kimi"] as const;
export type GatewayRefreshTool = (typeof GATEWAY_REFRESH_TOOLS)[number];

const REGISTRY_OF: Record<GatewayRefreshTool, string> = {
  claude: CLAUDE_CONFIG.identitiesJsonPath,
  codex: CODEX_CONFIG.identitiesJsonPath,
  grok: GROK_CONFIG.identitiesJsonPath,
  kimi: KIMI_CONFIG.identitiesJsonPath,
};

/** True for a tool whose logins the gateway owns: one the gateway serves and can refresh. Anything else is never claimed. */
export function isGatewayServedTool(tool: string): tool is GatewayRefreshTool {
  return (GATEWAY_REFRESH_TOOLS as readonly string[]).includes(tool) && adapterFor(tool as GatewayRefreshTool).refreshable;
}

/**
 * Accounts the gateway owns for `tool`, whoever asks. claude: members of gateway-routed pools. codex, grok, kimi: every
 * live (not retired, not a swap pool) identity in the tool's registry, which is exactly what the gateway serves.
 * Unreadable registry or a tool the gateway does not serve: none.
 */
export async function listGatewayManagedAccounts(registryPath?: string, tool: string = "claude"): Promise<Identity[]> {
  if (!isGatewayServedTool(tool)) return [];
  try {
    const file = await loadIdentitiesFile(registryPath ?? REGISTRY_OF[tool]);
    if (tool !== "claude") return file.identities.filter((i) => !isRetired(i) && !i.swapPool);
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
 * True when this process must not refresh, converge, reconcile or write the account's login: the gateway owns it (see
 * listGatewayManagedAccounts) and this process is not the gateway server. claude is decided by the pool routing marker;
 * codex, grok and kimi also need a fresh gateway heartbeat naming the login (see gateway-heartbeat.ts). Unreadable registry or unserved tool: not managed.
 */
export async function isGatewayManagedHere(tool: string, identityName: string, registryPath?: string): Promise<boolean> {
  if (!isGatewayServedTool(tool) || isGatewayOwnerProcess()) return false;
  if (tool !== "claude" && !(await heartbeatHolds(tool, identityName))) return false; // no live gateway has said it holds this login: refresh as before
  return (await listGatewayManagedAccounts(registryPath, tool)).some((i) => i.name === identityName);
}
