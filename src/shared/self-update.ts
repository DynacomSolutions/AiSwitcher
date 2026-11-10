import { dirname } from "node:path";

/**
 * Each vendor CLI's own self-update subcommand, as listed in its `--help`.
 * Updating the CLI binary touches no identity, so the shim runs these on the
 * real binary directly instead of resolving an identity first. Without this,
 * a non-interactive caller (T3 Code's provider update, cron) outside any
 * identity-bound directory was refused with "no --identity given".
 * zai/ali (crush) and pi have no self-update subcommand.
 */
const SELF_UPDATE_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  claude: ["update", "upgrade"],
  codex: ["update"],
  grok: ["update"],
  kimi: ["update", "upgrade"],
  opencode: ["update", "upgrade"],
};

/** True when argv (shim flags already stripped) starts with the tool's own self-update subcommand. */
export function isSelfUpdateCommand(toolName: string, cleanedArgv: readonly string[]): boolean {
  const first = cleanedArgv[0];
  if (first === undefined) return false;
  return SELF_UPDATE_COMMANDS[toolName]?.includes(first) ?? false;
}

/**
 * npm-based self-updaters (`claude update` runs `npm install -g`) install into
 * npm's configured global prefix, which is usually not the AIS-managed one.
 * The managed binary then stays old while an unused copy is updated. When the
 * resolved binary lives in the managed bin dir, point npm at the managed prefix.
 */
export function selfUpdateEnv(realBinary: string, managedBinDir: string): Record<string, string> {
  const dir = managedBinDir.replace(/\/+$/, "");
  if (!realBinary.startsWith(`${dir}/`)) return {};
  return { npm_config_prefix: dirname(dir) };
}
