import { existsSync } from "node:fs";
import { join } from "node:path";
import { isRetired } from "../identities/retired.ts";
import type { Identity } from "../identities/types.ts";

const TOKEN_FILE = "ais-browser-token";

/**
 * Launch args that register the ais-browser MCP server, or [] when the identity has no
 * browser token or is retired. Claude: --mcp-config=<json> (single-token form; the flag is
 * variadic). Codex: root -c overrides.
 */
export function browserMcpArgs(tool: string, configDir: string, identity: Pick<Identity, "retired"> | undefined, aisBinary: string, exists: (p: string) => boolean = existsSync): string[] {
  if (tool !== "claude" && tool !== "codex") return [];
  if (identity && isRetired(identity)) return [];
  if (!exists(join(configDir, TOKEN_FILE))) return [];
  if (tool === "claude") {
    return [`--mcp-config=${JSON.stringify({ mcpServers: { "ais-browser": { command: aisBinary, args: ["browser", "mcp"] } } })}`];
  }
  return ["-c", `mcp_servers.ais-browser.command=${JSON.stringify(aisBinary)}`, "-c", `mcp_servers.ais-browser.args=["browser","mcp"]`];
}
