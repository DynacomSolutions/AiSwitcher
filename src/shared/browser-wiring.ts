import { existsSync } from "node:fs";
import { join } from "node:path";
import { expandPath } from "../identities/match.ts";
import { allowedAccounts, type PoolIdentity } from "../identities/pool/swap-pool.ts";
import { isRetired } from "../identities/retired.ts";
import { findIdentityByNameOrAlias } from "../identities/store.ts";
import type { IdentitiesFile, Identity } from "../identities/types.ts";

/** Longest relay call (wait: 120 s) plus margin; the MCP client must not give up first. */
const TOOL_TIMEOUT_SEC = 135;
const TOKEN_FILE = "ais-browser-token";

/** Claude subcommands: a leading --mcp-config would precede them, so they get no wiring. */
const CLAUDE_SUBCOMMANDS = new Set(["mcp", "doctor", "update", "upgrade", "config", "install", "migrate-installer", "setup-token", "plugin", "plugins", "agents", "auth", "api-key", "ultrareview"]);

export interface BrowserWiring {
  identityName?: string;
  /** Gateway root URL when known at launch (non-secret). */
  gateway?: string;
  /** First user argv entry, to detect subcommands. */
  firstArg?: string;
  exists?: (p: string) => boolean;
  /**
   * Swap pool launch: the shim resolves the pool's active member on every call, so the
   * wiring needs a token in ANY of these (allowed, non-retired) member config dirs.
   */
  pool?: { name: string; memberConfigDirs: string[] };
}

/** Config dirs of the allowed, non-retired members of `pool` (retired identities are never wired). */
export function poolMemberConfigDirs(file: IdentitiesFile, pool: PoolIdentity): string[] {
  const dirs: string[] = [];
  for (const name of allowedAccounts(pool)) {
    const member = findIdentityByNameOrAlias(file.identities, name);
    if (member && !isRetired(member)) dirs.push(expandPath(member.configDir));
  }
  return dirs;
}

/**
 * Launch args registering the ais-browser MCP server, or [] when the identity has no
 * browser token or is retired. The shim gets its config as args (Codex strips the MCP
 * server environment); the token itself stays in the 0600 file. Claude: --mcp-config=<json>
 * (single-token form; the flag is variadic). Codex: root -c overrides.
 */
export function browserMcpArgs(tool: string, configDir: string, identity: Pick<Identity, "retired"> | undefined, aisBinary: string | undefined, w: BrowserWiring = {}): string[] {
  if (tool !== "claude" && tool !== "codex") return [];
  if (aisBinary === undefined) return []; // never fall back to the running executable (it may be bun, not ais)
  if (identity && isRetired(identity)) return [];
  const exists = w.exists ?? existsSync;
  if (w.pool) {
    if (!w.pool.memberConfigDirs.some((d) => exists(join(d, TOKEN_FILE)))) return [];
  } else if (!exists(join(configDir, TOKEN_FILE))) return [];
  if (tool === "claude" && w.firstArg !== undefined && CLAUDE_SUBCOMMANDS.has(w.firstArg)) return [];
  const target = w.pool
    ? ["--pool", w.pool.name, "--tool", tool]
    : ["--config-dir", configDir, ...(w.identityName ? ["--identity", w.identityName] : [])];
  const shimArgs = ["browser", "mcp", ...target, ...(w.gateway ? ["--gateway", w.gateway] : [])];
  if (tool === "claude") {
    return [`--mcp-config=${JSON.stringify({ mcpServers: { "ais-browser": { command: aisBinary, args: shimArgs } } })}`];
  }
  return [
    "-c", `mcp_servers.ais-browser.command=${JSON.stringify(aisBinary)}`,
    "-c", `mcp_servers.ais-browser.args=${JSON.stringify(shimArgs)}`,
    "-c", `mcp_servers.ais-browser.env_vars=["CODEX_HOME","AIS_GATEWAY_PROXY_URL","AI_PROFILE_SWITCHER_SESSION"]`,
    "-c", `mcp_servers.ais-browser.tool_timeout_sec=${TOOL_TIMEOUT_SEC}`,
  ];
}

/**
 * Env for the claude launch when the browser server is wired. Claude Code has no per-server
 * timeout field in its MCP config, only the MCP_TOOL_TIMEOUT env (ms); set it unless the user did.
 */
export function browserLaunchEnv(tool: string, browserArgs: string[], env: Record<string, string | undefined>): Record<string, string> {
  if (tool !== "claude" || browserArgs.length === 0 || env.MCP_TOOL_TIMEOUT !== undefined) return {};
  return { MCP_TOOL_TIMEOUT: String(TOOL_TIMEOUT_SEC * 1000) };
}
