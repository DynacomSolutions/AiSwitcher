import { isGatewayRoutedDir } from "./claude-gateway-entry.ts";
import { expandPath } from "./match.ts";
import { poolsOf } from "./pool/swap-pool.ts";
import { heartbeatHolds } from "./gateway-heartbeat.ts";
import { hasMemberCopy, isMemberStoreTool } from "./gateway-members.ts";
import { folderHoldsGatewayEntry } from "./gateway-routed.ts";
import { adapterFor } from "../gateway/providers/index.ts";
import { isRetired } from "./retired.ts";
import { loadIdentitiesFile } from "./store.ts";
import { ALI_CONFIG, CLAUDE_CONFIG, CODEX_CONFIG, GROK_CONFIG, KIMI_CONFIG } from "./tool-configs.ts";
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

/**
 * Tools whose login is a browser session the gateway renews itself (not an OAuth grant, so they are not in
 * GATEWAY_REFRESH_TOOLS, which drives the OAuth keep-alive). The heartbeat names them as "ali/<identity>".
 */
export const GATEWAY_SESSION_TOOLS = ["ali"] as const;

/** Live (not retired) ali logins in the registry. An unreadable registry is no logins. */
export async function listAliAccounts(registryPath: string = ALI_CONFIG.identitiesJsonPath): Promise<Identity[]> {
  try {
    return (await loadIdentitiesFile(registryPath)).identities.filter((i) => !isRetired(i));
  } catch {
    return [];
  }
}

/** True for a tool whose logins the gateway owns: one the gateway serves and can refresh. Anything else is never claimed. */
export function isGatewayServedTool(tool: string): tool is GatewayRefreshTool {
  return (GATEWAY_REFRESH_TOOLS as readonly string[]).includes(tool) && adapterFor(tool as GatewayRefreshTool).refreshable;
}

/**
 * Accounts the gateway owns for `tool`, whoever asks. claude: members of gateway-routed pools, plus every account moved
 * into the gateway member store (gateway-members.ts). codex, grok, kimi: every
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
    return file.identities.filter((i) => !i.swapPool && (names.has(i.name) || (!isRetired(i) && hasMemberCopy(tool, i.name))));
  } catch {
    return [];
  }
}

/**
 * True when the identity's own folder holds the pure gateway entry while this host has no member store copy: another host
 * routed it (`ais identities route-all-via-gateway`) and AIS sync carried the entry here. That host's gateway renews the
 * login, so nothing here may refresh it, nor reconcile pi's same-named copy into the folder (a refresh here would spend the
 * single-use refresh token the gateway renews). Unreadable registry or a tool without a member store: false.
 */
async function routedElsewhere(tool: string, identityName: string, registryPath?: string): Promise<boolean> {
  if (!isMemberStoreTool(tool)) return false;
  try {
    const identity = (await loadIdentitiesFile(registryPath ?? REGISTRY_OF[tool])).identities.find((i) => i.name === identityName);
    return identity !== undefined && folderHoldsGatewayEntry(tool, identity);
  } catch {
    return false;
  }
}

/**
 * True when this process must not refresh, converge, reconcile or write the account's login: the gateway owns it (see
 * listGatewayManagedAccounts) and this process is not the gateway server. claude is decided by the pool routing marker;
 * codex, grok and kimi also need a fresh gateway heartbeat naming the login (see gateway-heartbeat.ts). An account whose login
 * was moved into the gateway member store is the gateway's whatever the heartbeat says: its local folder holds only the
 * gateway entry, and a refresh here would fork the gateway's rotating refresh token. So is one whose folder holds the
 * gateway entry synced from the host that routed it (routedElsewhere). Unreadable registry or unserved tool:
 * not managed.
 */
export async function isGatewayManagedHere(tool: string, identityName: string, registryPath?: string): Promise<boolean> {
  if (!isGatewayOwnerProcess() && hasMemberCopy(tool, identityName)) return true;
  if (!isGatewayOwnerProcess() && (await routedElsewhere(tool, identityName, registryPath))) return true;
  if ((GATEWAY_SESSION_TOOLS as readonly string[]).includes(tool)) {
    // A session tool is the gateway's only while a fresh heartbeat names it, so a stopped gateway hands it back at once.
    if (isGatewayOwnerProcess() || !(await heartbeatHolds(tool, identityName))) return false;
    return (await listAliAccounts(registryPath)).some((i) => i.name === identityName);
  }
  if (!isGatewayServedTool(tool) || isGatewayOwnerProcess()) return false;
  if (tool !== "claude" && !(await heartbeatHolds(tool, identityName))) return false; // no live gateway has said it holds this login: refresh as before
  return (await listGatewayManagedAccounts(registryPath, tool)).some((i) => i.name === identityName);
}
