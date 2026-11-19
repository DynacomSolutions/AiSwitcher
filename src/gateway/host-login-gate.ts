import { TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { listGatewayManagedAccounts } from "../identities/gateway-managed.ts";
import { isMemberStoreTool, type MemberStoreTool } from "../identities/gateway-members.ts";
import { isGatewayRoutedPool } from "../identities/pool/gateway-pool.ts";
import type { Identity } from "../identities/types.ts";
import { loadGatewayGuard, memberHere, rerooted, type GatewayGuard, type GuardedLogin } from "../sync/gateway-guard.ts";

/**
 * Which host logins the credential store may hold. The gateway renews a claude or codex login only when it manages it:
 * the login has a member store copy or a sticky ownership record on the host, or the identity belongs to a gateway-routed
 * pool (listGatewayManagedAccounts, the list the gateway itself renews). Any other identity folder login belongs to the
 * host: a real CLI keeps rotating its refresh token there, so a copy in the store goes stale, and a gateway that used the
 * copy would spend a token the CLI still holds. Host store sync therefore never pushes such a login to the store, never
 * writes a store row over it, and the import never uploads it.
 */

/** True when the gateway manages the login of `login` as this host sees it. */
export async function gatewayManagesLogin(guard: GatewayGuard, login: GuardedLogin, home: string): Promise<boolean> {
  if (memberHere(guard, login)) return true;
  const registry = rerooted(TOOL_CONFIGS[login.tool].identitiesJsonPath, home);
  return (await listGatewayManagedAccounts(registry, login.tool)).some((i) => i.name === login.name);
}

/** The claude login that pi's auth.json at `rel` copies (same identity name), or undefined when the path is not a pi copy of a real claude login. */
export function piCopyOf(guard: GatewayGuard, rel: string): GuardedLogin | undefined {
  const pi = guard.pi.get(rel);
  if (!pi) return undefined;
  for (const login of guard.native.values()) if (login.tool === "claude" && !login.pool && login.name === pi.name) return login;
  return undefined;
}

/**
 * True when the HOME-relative path is a login file the host owns: the folder login of a claude or codex identity that the
 * gateway does not manage, or pi's auth.json copy of such a claude login (it holds the same refresh token). Swap pool folders
 * and every other path are false.
 */
export async function hostOwnsFolderLogin(home: string, rel: string, guard?: GatewayGuard): Promise<boolean> {
  const g = guard ?? (await loadGatewayGuard(home));
  const login = g.native.get(rel) ?? piCopyOf(g, rel);
  if (!login || login.pool) return false;
  return !(await gatewayManagesLogin(g, login, home));
}

/**
 * True when the identity's folder login may go into the store: the gateway manages it, or the tool has no member store. A swap
 * pool folder is managed when it routes through the gateway (isGatewayRoutedPool): its folder then holds the gateway entry
 * that tells the gateway the pool is routed, so its members count as managed there. An unrouted pool is host-owned.
 */
export async function storeMayHoldLogin(tool: string, identity: Pick<Identity, "name" | "configDir" | "swapPool">, home: string, guard: GatewayGuard): Promise<boolean> {
  if (!isMemberStoreTool(tool)) return true;
  if (identity.swapPool) return isGatewayRoutedPool(tool, identity.configDir);
  return gatewayManagesLogin(guard, { tool: tool as MemberStoreTool, name: identity.name, dir: "" }, home);
}
