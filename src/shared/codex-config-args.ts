const VALUE_OPTIONS = new Set([
  "--enable", "--disable", "--remote", "--remote-auth-token-env",
  "--image", "-i", "--model", "-m", "--local-provider", "--profile", "-p",
  "--sandbox", "-s", "--cd", "-C", "--add-dir", "--ask-for-approval", "-a",
]);
const FLAG_OPTIONS = new Set([
  "--strict-config", "--oss", "--approve-for-me", "--full-auto", "--worktree",
  "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust",
  "--search", "--no-alt-screen", "--help", "-h", "--version", "-V",
]);

/**
 * Native app-server/exec config parsers replace root -c values when a child -c
 * is present. Move the complete root override list after the command, keeping
 * its order and placing it before user child overrides. Run after both shared
 * configuration and global memory projection so neither can be discarded.
 */
export function codexSubcommandConfigArgs(argv: string[]): string[] {
  const root: string[] = [];
  const overrides: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") return argv;
    if (arg === "-c" || arg === "--config") {
      if (index + 1 === argv.length) return argv;
      overrides.push(arg, argv[++index]!);
    } else if (arg.startsWith("--config=") || (arg.startsWith("-c") && arg.length > 2)) {
      overrides.push(arg);
    } else if (VALUE_OPTIONS.has(arg)) {
      if (index + 1 === argv.length) return argv;
      root.push(arg, argv[++index]!);
    } else if (FLAG_OPTIONS.has(arg) || (arg.startsWith("--") && arg.includes("="))
      || /^-[impsCa].+/.test(arg)) {
      root.push(arg);
    } else {
      // Stop at the first positional; prompts and other subcommands are opaque.
      if (!["app-server", "exec", "e"].includes(arg) || overrides.length === 0) return argv;
      return [...root, arg, ...overrides, ...argv.slice(index + 1)];
    }
  }
  return argv;
}
