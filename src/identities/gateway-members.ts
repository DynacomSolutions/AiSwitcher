import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { aisHome } from "../shared/ais-home.ts";
import type { Identity } from "./types.ts";

/**
 * The gateway's own member store: `<root>/<tool>/<identity>/` holds a private copy of each account's login, so the
 * identity folders (`~/.claude/identities/*`, `~/.codex/identities/*`) can later hold the gateway entry instead of a
 * login without the gateway losing the account.
 *
 * Before this existed the gateway read member logins straight from the identity folders (the registry's `configDir`),
 * the same files the local tools use. Replacing those files with a gateway entry would have destroyed the gateway's
 * logins. Now a gateway process (`enableMemberStore()`) reads and refreshes the store copy of any identity that has
 * one; identities without a store copy still resolve to their own folder, as before. Every other process treats an
 * account with a store copy as the gateway's (gateway-managed.ts): it never refreshes, heals or reconciles that login.
 */

/** Tools whose logins can move into the member store (those with a local gateway route, see src/gateway/local-routes.ts). */
export const MEMBER_STORE_TOOLS = ["claude", "codex"] as const;
export type MemberStoreTool = (typeof MEMBER_STORE_TOOLS)[number];

/** Registry folder name to tool, so the I/O boundary can tell which tool a registry file belongs to. */
const TOOL_OF_REGISTRY_DIR: Record<string, MemberStoreTool> = { ".claude": "claude", ".codex": "codex" };

export const isMemberStoreTool = (tool: string): tool is MemberStoreTool => (MEMBER_STORE_TOOLS as readonly string[]).includes(tool);

/** AIS_GATEWAY_MEMBERS_DIR overrides the location (tests, odd layouts). */
export const memberStoreRoot = (): string => process.env.AIS_GATEWAY_MEMBERS_DIR || join(aisHome(), "gateway-members");

export const memberDir = (tool: string, name: string, root: string = memberStoreRoot()): string => join(root, tool, name);

/** Files of an identity folder that make up its login, relative to the folder. */
export const MEMBER_FILES: Record<MemberStoreTool, string[]> = {
  claude: [".credentials.json", ".claude.json"],
  codex: ["auth.json"],
};

let enabled = false;

/** Called by the gateway processes (`ais gateway serve`, `ais gateway local`): from then on they read the member store. */
export function enableMemberStore(): void {
  enabled = true;
}

export function memberStoreEnabled(): boolean {
  const forced = process.env.AIS_GATEWAY_MEMBER_STORE;
  if (forced === "1") return true;
  if (forced === "0") return false;
  return enabled;
}

/** The tool a registry file belongs to (`.../.claude/identities.json`), or undefined. */
export function toolOfRegistryPath(path: string): MemberStoreTool | undefined {
  if (basename(path) !== "identities.json") return undefined;
  return TOOL_OF_REGISTRY_DIR[basename(dirname(path))];
}

/** The store file that holds the account's login (`.credentials.json`, `auth.json`). */
export const memberLoginFile = (tool: MemberStoreTool): string => MEMBER_FILES[tool][0]!;

/** Where each tool's login file keeps its refresh token: [object, field]. */
const REFRESH_FIELD: Record<MemberStoreTool, readonly [string, string]> = { claude: ["claudeAiOauth", "refreshToken"], codex: ["tokens", "refresh_token"] };

/**
 * True when a login file's text is a login the gateway can keep renewing: parseable JSON with a refresh token
 * (claude `claudeAiOauth.refreshToken`, codex `tokens.refresh_token`). An empty, truncated or token-less file is not.
 */
export function isRefreshableLoginText(tool: MemberStoreTool, text: string | undefined): boolean {
  if (text === undefined) return false;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return false;
  const [group, field] = REFRESH_FIELD[tool];
  const nested = (json as Record<string, unknown>)[group];
  if (typeof nested !== "object" || nested === null) return false;
  const refresh = (nested as Record<string, unknown>)[field];
  return typeof refresh === "string" && refresh.trim().length > 0;
}

/**
 * True when the member store holds a usable copy of this account's login: the login file exists and holds a refreshable
 * login (isRefreshableLoginText). An empty or partial file left by a crash does not count. `ais identities
 * route-all-via-gateway` writes the login file last, so its presence is the whole test.
 */
export function hasMemberCopy(tool: string, name: string, root: string = memberStoreRoot()): boolean {
  if (!isMemberStoreTool(tool)) return false;
  const path = join(memberDir(tool, name, root), memberLoginFile(tool));
  if (!isFile(path)) return false;
  try {
    return isRefreshableLoginText(tool, readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Points each plain identity that has a store copy at it. Swap pools keep their own folder (they hold no member login the
 * gateway reads). A pure function of its inputs plus the existence of the store files.
 */
export function remapToMemberStore(tool: string, identities: Identity[], root: string = memberStoreRoot()): Identity[] {
  if (!isMemberStoreTool(tool)) return identities;
  return identities.map((identity) => {
    if (identity.swapPool || !hasMemberCopy(tool, identity.name, root)) return identity;
    return { ...identity, configDir: memberDir(tool, identity.name, root) };
  });
}

/** Applied by loadIdentitiesFile; a no-op unless a gateway process enabled the store. */
export function applyMemberStore(registryPath: string, identities: Identity[]): Identity[] {
  if (!memberStoreEnabled()) return identities;
  const tool = toolOfRegistryPath(registryPath);
  return tool ? remapToMemberStore(tool, identities) : identities;
}

/** True when a folder is (inside) the member store: saving such a path into a registry would corrupt the local tools. */
export function isUnderMemberStore(path: string, root: string = memberStoreRoot()): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
