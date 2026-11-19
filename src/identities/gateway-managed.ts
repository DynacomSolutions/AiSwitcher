import { isGatewayRoutedDir } from "./claude-gateway-entry.ts";
import { expandPath } from "./match.ts";
import { poolsOf } from "./pool/swap-pool.ts";
import { heartbeatHolds } from "./gateway-heartbeat.ts";
import { hasMemberCopy, isMemberStoreTool } from "./gateway-members.ts";
import { isStickyOwned, recordOwned } from "./gateway-owned.ts";
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
  return listGatewayManagedAccountsStrict(registryPath, tool).catch(() => []);
}

/**
 * Like listGatewayManagedAccounts, but a registry that cannot be read throws, so a caller can tell "no managed logins" from
 * "could not tell". A tool the gateway does not serve is none.
 */
export async function listGatewayManagedAccountsStrict(registryPath?: string, tool: string = "claude"): Promise<Identity[]> {
  if (!isGatewayServedTool(tool)) return [];
  const file = await loadIdentitiesFile(registryPath ?? REGISTRY_OF[tool]);
  if (tool !== "claude") return file.identities.filter((i) => !isRetired(i) && !i.swapPool);
  const names = new Set<string>();
  for (const pool of poolsOf(file)) {
    if (await isGatewayRoutedDir(expandPath(pool.configDir))) for (const a of pool.swapPool.accounts) names.add(a);
  }
  return file.identities.filter((i) => !i.swapPool && (names.has(i.name) || (!isRetired(i) && hasMemberCopy(tool, i.name))));
}

/**
 * Answers "does the gateway manage this login?" for the gateway process, with a short cache of each tool's list. Undefined
 * when the registry cannot be read: only a successful read may call a login unmanaged. A tool the gateway does not serve, a
 * swap pool folder and a name the registry does not hold are never unmanaged (the credential lookup deals with those).
 */
export function createManagementCheck(opts: { ttlMs?: number; now?: () => number; registryPath?: (tool: string) => string | undefined } = {}): (tool: string, identity: string) => Promise<boolean | undefined> {
  const ttl = opts.ttlMs ?? 5_000;
  const now = opts.now ?? Date.now;
  /** managed: the gateway's list. plain: real (non swap pool) identities in the registry. */
  const cache = new Map<string, { at: number; managed: Set<string>; plain: Set<string> }>();
  return async (tool, identity) => {
    if (!isGatewayServedTool(tool)) return true;
    let hit = cache.get(tool);
    if (!hit || now() - hit.at >= ttl) {
      try {
        const path = opts.registryPath?.(tool);
        const file = await loadIdentitiesFile(path ?? REGISTRY_OF[tool]);
        const managed = new Set((await listGatewayManagedAccountsStrict(path, tool)).map((i) => i.name));
        hit = { at: now(), managed, plain: new Set(file.identities.filter((i) => !i.swapPool).map((i) => i.name)) };
        cache.set(tool, hit);
      } catch {
        return undefined;
      }
    }
    return hit.managed.has(identity) || !hit.plain.has(identity);
  };
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
 * gateway entry synced from the host that routed it (routedElsewhere). So is every login of a served tool that the gateway
 * ever named in its heartbeat (sticky ownership, gateway-owned.ts): a stale heartbeat, a stopped gateway or a failed push from
 * the database never hands the login to a host refresher; only `ais gateway release` does. Unreadable registry or unserved
 * tool: not managed.
 */
export async function isGatewayManagedHere(tool: string, identityName: string, registryPath?: string): Promise<boolean> {
  if (!isGatewayOwnerProcess() && hasMemberCopy(tool, identityName)) return true;
  if (!isGatewayOwnerProcess() && (await routedElsewhere(tool, identityName, registryPath))) return true;
  if (!isGatewayOwnerProcess() && isGatewayServedTool(tool) && (await isStickyOwned(tool, identityName))) return true;
  if ((GATEWAY_SESSION_TOOLS as readonly string[]).includes(tool)) {
    // A session tool is the gateway's only while a fresh heartbeat names it, so a stopped gateway hands it back at once.
    if (isGatewayOwnerProcess() || !(await heartbeatHolds(tool, identityName))) return false;
    return (await listAliAccounts(registryPath)).some((i) => i.name === identityName);
  }
  if (!isGatewayServedTool(tool) || isGatewayOwnerProcess()) return false;
  if (tool !== "claude" && !(await heartbeatHolds(tool, identityName))) return false; // no live gateway has said it holds this login (and none ever did, see above): refresh as before
  const managed = (await listGatewayManagedAccounts(registryPath, tool)).some((i) => i.name === identityName);
  // A live gateway named it: latch the ownership, so a later stale heartbeat never hands the login back.
  if (managed && tool !== "claude") await recordOwned([`${tool}/${identityName}`], new Date().toISOString()).catch(() => undefined);
  return managed;
}
