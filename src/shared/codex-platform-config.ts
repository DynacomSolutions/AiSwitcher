import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MACOS_CODEX_APP_RESOURCES = "/Applications/Codex.app/Contents/Resources/";
const NODE_REPL_DISABLED_OVERRIDE = "mcp_servers.node_repl.enabled=false";

export interface CodexPlatformConfigDeps {
  platform?: NodeJS.Platform;
  readConfig?: (path: string) => string;
  commandExists?: (path: string) => boolean;
}

function configuredNodeReplCommand(config: string): string | undefined {
  let inNodeReplSection = false;

  for (const line of config.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inNodeReplSection = /^\[\s*mcp_servers\.(?:node_repl|"node_repl"|'node_repl')\s*\]$/.test(trimmed);
      continue;
    }
    if (!inNodeReplSection) continue;

    const command = trimmed.match(/^command\s*=\s*(["'])(.*?)\1(?:\s*#.*)?$/);
    if (!command) continue;

    if (command[1] === "'") return command[2];
    try {
      return JSON.parse(`"${command[2]}"`) as string;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Codex.app writes an MCP entry for its bundled node_repl executable. Profile
 * sync can legitimately carry that config to Linux, where /Applications does
 * not exist. Disable only that known platform-specific entry at launch time;
 * leave the synced config intact so the same identity still gets node_repl on
 * macOS.
 */
export function codexPlatformArgs(
  configDir: string,
  args: string[],
  deps: CodexPlatformConfigDeps = {},
): string[] {
  const platform = deps.platform ?? process.platform;
  if (platform === "darwin") return args;

  const readConfig = deps.readConfig ?? ((path: string) => readFileSync(path, "utf8"));
  const commandExists = deps.commandExists ?? existsSync;

  let config: string;
  try {
    config = readConfig(join(configDir, "config.toml"));
  } catch {
    return args;
  }

  const command = configuredNodeReplCommand(config);
  if (!command?.startsWith(MACOS_CODEX_APP_RESOURCES) || commandExists(command)) return args;

  return ["-c", NODE_REPL_DISABLED_OVERRIDE, ...args];
}
