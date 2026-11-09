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
