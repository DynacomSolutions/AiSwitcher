import { IDENTITY_SESSION_MARKER, IDENTITY_SESSION_TOOL_MARKER } from "./exec.ts";
export type IdentitySessionTool = "claude" | "codex" | "grok" | "kimi" | "zai" | "ali" | "pi" | "opencode";

const TOOL_ENV_VARS: Record<IdentitySessionTool, string> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  grok: "GROK_HOME",
  kimi: "KIMI_CODE_HOME",
  zai: "CRUSH_GLOBAL_CONFIG",
  ali: "ALI_CONFIG_DIR",
  pi: "PI_CODING_AGENT_DIR",
  opencode: "OPENCODE_CONFIG_DIR",
};

export interface ParsedCliArgs {
  identityFlag?: string;
  /** `--pool=<name>`: launch that pool directly. */
  poolFlag?: string;
  /** Bare `--identity` / `--pool`: open only that picker list. */
  pickerMode?: "identity" | "pool";
  desktopFlag: boolean;
  nonInteractiveHint: boolean;
  cleanedArgv: string[];
}

/**
 * Detect nested context from the source tool marker and its config env var.
 * Legacy launches without a source marker are trusted only against the
 * target tool's own config env var.
 */
export function activeParentSession(
  targetTool: IdentitySessionTool,
  env: Record<string, string | undefined>,
): { toolName: IdentitySessionTool; identity: string } | undefined {
  const identity = env[IDENTITY_SESSION_MARKER];
  if (!identity) return undefined;

  const parentTool = env[IDENTITY_SESSION_TOOL_MARKER];
  if (parentTool) {
    if (!Object.hasOwn(TOOL_ENV_VARS, parentTool)) return undefined;
    const toolName = parentTool as IdentitySessionTool;
    return env[TOOL_ENV_VARS[toolName]] ? { toolName, identity } : undefined;
  }

  return env[TOOL_ENV_VARS[targetTool]] ? { toolName: targetTool, identity } : undefined;
}

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

/**
 * Keep nesting context for lifecycle work, but inherit and validate an
 * explicit identity only when parent and child use the same provider.
 */
export function resolveParentLaunchContext(
  targetTool: IdentitySessionTool,
  env: Record<string, string | undefined>,
  requestedIdentity: string | undefined,
): {
  parentSession: { toolName: IdentitySessionTool; identity: string } | undefined;
  identityFlag: string | undefined;
} {
  const parentSession = activeParentSession(targetTool, env);
  const parentIdentity = parentSession?.toolName === targetTool ? parentSession.identity : undefined;
  const identityFlag = resolveNestedIdentity(targetTool, parentIdentity, requestedIdentity);
  return { parentSession, identityFlag };
}

// "--id" (not "-i") is the shorthand: codex already has a native "-i, --image"
// flag, so a single-letter "-i" would collide with it. "--id" is free on all
// five tools' full flag lists (confirmed against `grok --help` and
// `kimi --help` too — kimi has no --identity/--id/--desktop of its own; its
// `-p` is --prompt, not --print; zai's real binary is `crush`, whose own
// flag list — confirmed via `crush --help` — has no --id/--identity either).
const IDENTITY_PREFIXES = ["--identity=", "--id="];
const BARE_IDENTITY_FLAGS = ["--identity", "--id"];
const POOL_PREFIX = "--pool=";
const BARE_POOL_FLAG = "--pool";
const DESKTOP_FLAG = "--desktop";

/**
 * Strip our own --identity=<name>/--id=<name> and --desktop flags out of
 * argv, forwarding everything else untouched. Matches whole tokens only
 * (never a substring inside an unrelated arg), and stops scanning once a bare
 * "--" end-of-options token is seen so anything after it (e.g.
 * `codex -- --identity=foo`) is forwarded literally rather than stripped.
 */
export function stripOwnFlags(
  argv: string[],
  opts: { pools?: boolean } = {},
): {
  identityFlag?: string;
  poolFlag?: string;
  pickerMode?: "identity" | "pool";
  desktopFlag: boolean;
  cleanedArgv: string[];
} {
  const cleaned: string[] = [];
  let identityFlag: string | undefined;
  let poolFlag: string | undefined;
  let pickerMode: "identity" | "pool" | undefined;
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
    if (BARE_IDENTITY_FLAGS.includes(arg)) {
      pickerMode = "identity";
      continue;
    }
    if (opts.pools && arg.startsWith(POOL_PREFIX)) {
      poolFlag = arg.slice(POOL_PREFIX.length);
      continue;
    }
    if (opts.pools && arg === BARE_POOL_FLAG) {
      pickerMode = "pool";
      continue;
    }
    if (arg === DESKTOP_FLAG) {
      desktopFlag = true;
      continue;
    }
    cleaned.push(arg);
  }

  return {
    identityFlag,
    ...(poolFlag !== undefined ? { poolFlag } : {}),
    ...(pickerMode ? { pickerMode } : {}),
    desktopFlag,
    cleanedArgv: cleaned,
  };
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
  const { identityFlag, poolFlag, pickerMode, desktopFlag, cleanedArgv } = stripOwnFlags(argv, {
    pools: toolName === "claude",
  });
  return {
    identityFlag,
    ...(poolFlag !== undefined ? { poolFlag } : {}),
    ...(pickerMode ? { pickerMode } : {}),
    desktopFlag,
    nonInteractiveHint: detectNonInteractiveHint(toolName, cleanedArgv),
    cleanedArgv,
  };
}
