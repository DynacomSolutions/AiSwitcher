export interface ParsedCliArgs {
  identityFlag?: string;
  desktopFlag: boolean;
  nonInteractiveHint: boolean;
  cleanedArgv: string[];
}

/**
 * Reconcile a nested claude/codex/grok launch's explicit --id (if any)
 * against the parent session's own identity, returning the identity that
 * should actually be used.
 *
 * A nested launch with NO --id auto-inherits the parent's identity — this is
 * the overwhelmingly common case (any script/subagent that shells out to
 * claude/codex/grok without knowing or caring about identities at all) and
 * must just work, not force every such caller across every repo to be taught
 * about --id. Only a nested launch that EXPLICITLY names a *different*
 * identity than the parent is rejected — that's the actual cross-identity
 * pollution case (e.g. a hardcoded --id=personal firing from inside a
 * identity-a session), not merely omitting the flag.
 */
export function resolveNestedIdentity(
  toolName: "claude" | "codex" | "grok" | "kimi" | "zai" | "ali" | "pi" | "opencode",
  parentIdentity: string | undefined,
  requestedIdentity: string | undefined,
): string | undefined {
  // "1" is the marker written by shims installed before identity-bearing
  // markers were introduced. Preserve compatibility for those sessions.
  if (!parentIdentity || parentIdentity === "1") return requestedIdentity;

  if (!requestedIdentity) return parentIdentity;

  if (requestedIdentity !== parentIdentity) {
    throw new Error(
      `${toolName}: nested agent identity mismatch: active identity is '${parentIdentity}', ` +
        `but the command explicitly requested '${requestedIdentity}'. Omit --id to inherit ` +
        `'${parentIdentity}', or pass --id=${parentIdentity} explicitly.`,
    );
  }
  return requestedIdentity;
}

// "--id" (not "-i") is the shorthand: codex already has a native "-i, --image"
// flag, so a single-letter "-i" would collide with it. "--id" is free on all
// five tools' full flag lists (confirmed against `grok --help` and
// `kimi --help` too — kimi has no --identity/--id/--desktop of its own; its
// `-p` is --prompt, not --print; zai's real binary is `crush`, whose own
// flag list — confirmed via `crush --help` — has no --id/--identity either).
const IDENTITY_PREFIXES = ["--identity=", "--id="];
const DESKTOP_FLAG = "--desktop";

/**
 * Strip our own --identity=<name>/--id=<name> and --desktop flags out of
 * argv, forwarding everything else untouched. Matches whole tokens only
 * (never a substring inside an unrelated arg), and stops scanning once a bare
 * "--" end-of-options token is seen so anything after it (e.g.
 * `codex -- --identity=foo`) is forwarded literally rather than stripped.
 */
export function stripOwnFlags(argv: string[]): {
  identityFlag?: string;
  desktopFlag: boolean;
  cleanedArgv: string[];
} {
  const cleaned: string[] = [];
  let identityFlag: string | undefined;
  let desktopFlag = false;
  let pastEndOfOptions = false;

  for (const arg of argv) {
    if (pastEndOfOptions) {
      cleaned.push(arg);
      continue;
    }
    if (arg === "--") {
      pastEndOfOptions = true;
      cleaned.push(arg);
      continue;
    }
    const identityPrefix = IDENTITY_PREFIXES.find((prefix) => arg.startsWith(prefix));
    if (identityPrefix) {
      identityFlag = arg.slice(identityPrefix.length);
      continue;
    }
    if (arg === DESKTOP_FLAG) {
      desktopFlag = true;
      continue;
    }
    cleaned.push(arg);
  }

  return { identityFlag, desktopFlag, cleanedArgv: cleaned };
}

/**
 * Best-effort detection of "this invocation is non-interactive" from the
 * tool's OWN flags/subcommands — the identity engine ORs this with its own
 * TTY check, since TTY-ness alone can't distinguish `claude -p "..."` (still
 * a TTY, but semantically non-interactive) from a real interactive session.
 */
export function detectNonInteractiveHint(toolName: "claude" | "codex" | "grok" | "kimi" | "zai" | "ali" | "pi" | "opencode", cleanedArgv: string[]): boolean {
  if (toolName === "claude") {
    return cleanedArgv.some((a) => a === "-p" || a === "--print");
  }
  if (toolName === "zai" || toolName === "ali") {
    // zai's and ali's real binary is `crush` (github.com/charmbracelet/crush),
    // whose own non-interactive entrypoint is the `run` subcommand (confirmed
    // via `crush --help`: "run [prompt...] [--flags]  Run a single
    // non-interactive prompt", the direct analog of claude's -p/codex's
    // exec/grok's agent/kimi's -p). Same real binary, same detection for both
    // proxy names.
    const firstPositional = cleanedArgv.find((a) => !a.startsWith("-"));
    return firstPositional === "run";
  }
  if (toolName === "grok") {
    // `-p`/`--single <PROMPT>` prints one response to stdout and exits (grok
    // --help); `grok agent ...` is grok's own "Run Grok without the
    // interactive UI" entrypoint, the direct analog of `codex exec`.
    if (cleanedArgv.some((a) => a === "-p" || a === "--single")) return true;
    const firstPositional = cleanedArgv.find((a) => !a.startsWith("-"));
    return firstPositional === "agent";
  }
  if (toolName === "kimi") {
    // `-p`/`--prompt <PROMPT>` "Run one prompt non-interactively and print the
    // response" (kimi --help) — the direct analog of claude's `-p`/`--print`.
    // `kimi acp` runs an Agent Client Protocol server over stdio, the analog
    // of `grok agent`/`codex exec`. (`--prompt=<value>` is commander.js's
    // equals form of the same flag.)
    if (cleanedArgv.some((a) => a === "-p" || a === "--prompt" || a.startsWith("--prompt="))) return true;
    const firstPositional = cleanedArgv.find((a) => !a.startsWith("-"));
    return firstPositional === "acp";
  }
  if (toolName === "pi") {
    // Pi's -p/--print mode and package-management subcommands do not have an
    // identity picker available, even when launched from a real terminal.
    if (cleanedArgv.some((a) => a === "-p" || a === "--print")) return true;
    const firstPositional = cleanedArgv.find((a) => !a.startsWith("-"));
    return ["install", "remove", "update", "list"].includes(firstPositional ?? "");
  }
  if (toolName === "opencode") {
    const firstPositional = cleanedArgv.find((a) => !a.startsWith("-"));
    return firstPositional === "run" || firstPositional === "acp" || firstPositional === "serve";
  }
  // codex: `codex exec ...` is explicitly the non-interactive entrypoint.
  const firstPositional = cleanedArgv.find((a) => !a.startsWith("-"));
  return firstPositional === "exec";
}

export function parseCliArgs(toolName: "claude" | "codex" | "grok" | "kimi" | "zai" | "ali" | "pi" | "opencode", argv: string[]): ParsedCliArgs {
  const { identityFlag, desktopFlag, cleanedArgv } = stripOwnFlags(argv);
  return {
    identityFlag,
    desktopFlag,
    nonInteractiveHint: detectNonInteractiveHint(toolName, cleanedArgv),
    cleanedArgv,
  };
}
