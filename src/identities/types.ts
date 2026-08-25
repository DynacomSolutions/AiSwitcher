export interface Identity {
  name: string;
  label: string;
  description?: string;
  configDir: string;
  directories?: string[];
  /** Alternate short names that resolve to this identity, e.g. "wk" for "work". */
  aliases?: string[];
}

/**
 * Directory-scoped override that redirects an auto-opened link (OAuth login,
 * etc.) to a DIFFERENT identity's Chrome (Claude MCP) instance than whichever
 * identity is actually active for that directory — e.g. a shared script
 * invoked from several projects. Without a matching override, an auto-opened
 * link always targets the currently active identity's own Chrome (Claude
 * MCP) instance (see chrome-mcp.ts) — no per-identity config value is needed
 * for that default case. Same pattern grammar as Identity.directories (see
 * match.ts); most-specific match wins.
 */
export interface ChromeProfileOverride {
  directories: string[];
  targetIdentity: string;
  label?: string;
}

export interface IdentitiesFile {
  version: 1;
  identities: Identity[];
  chromeProfileOverrides?: ChromeProfileOverride[];
}

export interface ToolConfig {
  toolName: "claude" | "codex" | "grok" | "kimi" | "zai" | "ali" | "pi";
  /**
   * Literal binary name resolveRealBinary() searches PATH for — identical to
   * toolName for every real wrapped CLI. "zai" and "ali" are the two
   * exceptions: both are fake identity-switching proxy names for the real
   * `crush` binary (github.com/charmbracelet/crush), configured against the
   * ZAI/Z.ai provider and Alibaba Cloud Model Studio's Token plan
   * respectively (see tool-configs.ts's ZAI_CONFIG/ALI_CONFIG).
   */
  realBinaryName: "claude" | "codex" | "grok" | "kimi" | "crush" | "pi";
  /**
   * The env var resolve.ts/open.ts treat as "this identity is already
   * resolved" (step (b) of resolveIdentity, and the tool-disambiguation
   * lookup in open.ts).
   */
  envVarName:
    | "CLAUDE_CONFIG_DIR"
    | "CODEX_HOME"
    | "GROK_HOME"
    | "KIMI_CODE_HOME"
    | "CRUSH_GLOBAL_CONFIG"
    | "ALI_CONFIG_DIR"
    | "PI_CODING_AGENT_DIR";
  /**
   * Extra env vars for a tool whose real binary needs more than one
   * directory redirected to achieve full identity isolation. Each entry's
   * value is the resolved configDirValue, optionally joined with `subdir` —
   * NOT always the identical bare configDirValue. zai splits its config
   * (CRUSH_GLOBAL_CONFIG, envVarName above) from its session/model-cache
   * data (CRUSH_GLOBAL_DATA); see tool-configs.ts's ZAI_CONFIG. ali needs
   * BOTH of crush's real vars mirrored this way (its own envVarName,
   * ALI_CONFIG_DIR, isn't one crush itself reads at all); see
   * tool-configs.ts's ALI_CONFIG. Every other tool needs none. `subdir` is
   * REQUIRED for CRUSH_GLOBAL_DATA specifically (not just tidiness):
   * confirmed live (2026-07-18) that pointing CRUSH_GLOBAL_CONFIG and
   * CRUSH_GLOBAL_DATA at the literal same directory causes crush to
   * double-register every provider/model (11 configured models showed up as
   * 22 in `crush models`); the two must resolve to different,
   * non-overlapping paths.
   */
  extraEnvVarNames?: Array<{ name: string; subdir?: string }>;
  identitiesJsonPath: string;
  identitiesRootDir: string;
}

export interface ResolveOptions {
  explicitIdentityFlag?: string;
  cwd: string;
  env: Record<string, string | undefined>;
  nonInteractiveHint?: boolean;
  promptTimeoutMs?: number;
}

export type ResolveSource =
  | "flag"
  | "env"
  | "directory-match"
  | "interactive-existing"
  | "interactive-created";

export interface ResolvedIdentity {
  identity?: Identity;
  configDirValue: string;
  source: ResolveSource;
}
