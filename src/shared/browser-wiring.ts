import { existsSync } from "node:fs";
import { join } from "node:path";
import { isRetired } from "../identities/retired.ts";
import type { Identity } from "../identities/types.ts";

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
}

/**
 * Launch args registering the ais-browser MCP server, or [] when the identity has no
 * browser token or is retired. The shim gets its config as args (Codex strips the MCP
 * server environment); the token itself stays in the 0600 file. Claude: --mcp-config=<json>
 * (single-token form; the flag is variadic). Codex: root -c overrides.
 */
export function browserMcpArgs(tool: string, configDir: string, identity: Pick<Identity, "retired"> | undefined, aisBinary: string, w: BrowserWiring = {}): string[] {
  if (tool !== "claude" && tool !== "codex") return [];
  if (identity && isRetired(identity)) return [];
  if (!(w.exists ?? existsSync)(join(configDir, TOKEN_FILE))) return [];
  if (tool === "claude" && w.firstArg !== undefined && CLAUDE_SUBCOMMANDS.has(w.firstArg)) return [];
  const shimArgs = ["browser", "mcp", "--config-dir", configDir, ...(w.identityName ? ["--identity", w.identityName] : []), ...(w.gateway ? ["--gateway", w.gateway] : [])];
  if (tool === "claude") {
    return [`--mcp-config=${JSON.stringify({ mcpServers: { "ais-browser": { command: aisBinary, args: shimArgs } } })}`];
  }
  return [
    "-c", `mcp_servers.ais-browser.command=${JSON.stringify(aisBinary)}`,
    "-c", `mcp_servers.ais-browser.args=${JSON.stringify(shimArgs)}`,
    "-c", `mcp_servers.ais-browser.env_vars=["CODEX_HOME","AIS_GATEWAY_PROXY_URL","AI_PROFILE_SWITCHER_SESSION"]`,
  ];
}
