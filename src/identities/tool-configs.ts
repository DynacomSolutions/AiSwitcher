import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolConfig } from "./types.ts";

export const CLAUDE_CONFIG: ToolConfig = {
  toolName: "claude",
  realBinaryName: "claude",
  envVarName: "CLAUDE_CONFIG_DIR",
  globalMemoryProjection: "claude-append-file",
  identitiesJsonPath: join(homedir(), ".claude", "identities.json"),
  identitiesRootDir: join(homedir(), ".claude", "identities"),
};

export const CODEX_CONFIG: ToolConfig = {
  toolName: "codex",
  realBinaryName: "codex",
  envVarName: "CODEX_HOME",
  globalMemoryProjection: "codex-developer-instructions",
  identitiesJsonPath: join(homedir(), ".codex", "identities.json"),
  identitiesRootDir: join(homedir(), ".codex", "identities"),
};

export const GROK_CONFIG: ToolConfig = {
  toolName: "grok",
  realBinaryName: "grok",
  envVarName: "GROK_HOME",
  globalMemoryProjection: "grok-rules",
  identitiesJsonPath: join(homedir(), ".grok", "identities.json"),
  identitiesRootDir: join(homedir(), ".grok", "identities"),
};

// Kimi Code's home is `~/.kimi-code` (NOT `~/.kimi` — that's the legacy
// kimi-cli, a different product). KIMI_CODE_HOME confirmed live: a redirected
// `kimi doctor` looks for config.toml/tui.toml under the override.
export const KIMI_CONFIG: ToolConfig = {
  toolName: "kimi",
  realBinaryName: "kimi",
  envVarName: "KIMI_CODE_HOME",
  globalMemoryProjection: "kimi-global-agents",
  identitiesJsonPath: join(homedir(), ".kimi-code", "identities.json"),
  identitiesRootDir: join(homedir(), ".kimi-code", "identities"),
};

// Pi is a multi-provider coding agent. Unlike the provider-specific wrappers
// above, one Pi identity can hold credentials for several providers at once.
// PI_CODING_AGENT_DIR is Pi's documented complete profile boundary: auth,
// settings, extensions and sessions all live underneath it, which makes it a
// natural fit for AIS's one-config-directory-per-identity model.
export const PI_CONFIG: ToolConfig = {
  toolName: "pi",
  realBinaryName: "pi",
  envVarName: "PI_CODING_AGENT_DIR",
  globalMemoryProjection: "pi-append-file",
  identitiesJsonPath: join(homedir(), ".pi", "identities.json"),
  identitiesRootDir: join(homedir(), ".pi", "identities"),
};

// OpenCode spreads one profile across its bespoke config override and three
// XDG roots. Point all four at one AIS identity directory so config, auth,
// cache and state are isolated together. OpenCode appends its own `opencode`
// subdirectory to the XDG roots; OPENCODE_CONFIG_DIR is used as-is.
export const OPENCODE_CONFIG: ToolConfig = {
  toolName: "opencode",
  realBinaryName: "opencode",
  envVarName: "OPENCODE_CONFIG_DIR",
  globalMemoryProjection: "opencode-config-content",
  extraEnvVarNames: [
    { name: "XDG_DATA_HOME", subdir: "data" },
    { name: "XDG_CACHE_HOME", subdir: "cache" },
    { name: "XDG_STATE_HOME", subdir: "state" },
  ],
  identitiesJsonPath: join(homedir(), ".opencode", "identities.json"),
  identitiesRootDir: join(homedir(), ".opencode", "identities"),
};

// "zai" is NOT a real CLI — it's a fake proxy identity name this project
// invents for the real `crush` binary (github.com/charmbracelet/crush, npm
// `@charmland/crush`, brew `charmbracelet/tap/crush`), a multi-provider
// terminal coding agent by Charm, configured to talk to the ZAI/Z.ai
// provider. Two prior designs were tried and retired the same day
// (2026-07-17) — see AGENTS.md's "zai case study" for the full history:
// take 1 proxied `opencode` (also multi-provider, correct model display, but
// its auth had no known non-interactive path at the time); take 2 proxied
// `claude` redirected via ANTHROPIC_BASE_URL (simple non-interactive auth,
// but Claude Code's UI always shows its own model alias — e.g. "Opus" —
// regardless of what actually answers server-side, which is unacceptable
// for a tool whose whole point is running GLM models).
//
// Crush gets both properties at once: it's a real multi-provider CLI (shows
// the actual model, e.g. literal `zai/glm-4.6`, not a translated alias) AND
// its Z.ai auth can be provisioned non-interactively — confirmed live
// (2026-07-17): writing a plain `crush.json` with a "zai" provider entry
// (id/name/base_url/api_key) and running NO login at all was enough for
// `crush run "..." --model zai/glm-4.6` to attempt a REAL request to Z.ai's
// endpoint (rejected only for an invalid placeholder key — "unauthorized:
// token expired or incorrect" — proving the config was actually read and
// used for the request, not just listed from Crush's own static model
// catalog, which lists every `zai/glm-*` entry unconditionally even with
// zero config present). See identities/zai-auth.ts for the writer this
// project uses at identity-creation time.
//
// Config isolation needs only two vars (simpler than opencode's four-way XDG
// spread, and no collision-avoidance workaround like take 2's claude-sharing
// needed): CRUSH_GLOBAL_CONFIG (the directory holding crush.json — confirmed
// via `crush dirs` that this env var actually redirects it) and
// CRUSH_GLOBAL_DATA (session/model-cache state). crush's real binary name is
// unique to this tool, so envVarName can be the literal var crush itself
// reads, with no bespoke-var-to-avoid-collision trick needed.
//
// CRUSH_GLOBAL_DATA MUST resolve to a directory distinct from
// CRUSH_GLOBAL_CONFIG, not the identity's bare configDir — confirmed live
// (2026-07-18): pointing both env vars at the literal same path makes crush
// double-register every provider/model (11 configured GLM models showed up
// as 22 in `crush models`). Hence `subdir: "data"` below, a nested
// subdirectory of the identity's own configDir — still "one directory = one
// identity, holds everything" from identities.json's point of view (nothing
// else in this project treats configDir as needing to be a single flat
// directory), just with crush's own session/model-cache state one level
// deeper than crush.json itself.
//
// Kept in its OWN `~/.zai` registry (not merged into any other tool's), per
// an explicit ask: a user may want a "identity-a" identity in multiple
// providers at once (e.g. one real Anthropic-backed via `claude`, one
// Z.ai-backed via `zai`), and they must stay fully separate, distinguishable
// registries for that to work.
export const ZAI_CONFIG: ToolConfig = {
  toolName: "zai",
  realBinaryName: "crush",
  envVarName: "CRUSH_GLOBAL_CONFIG",
  globalMemoryProjection: "crush-global-context",
  extraEnvVarNames: [{ name: "CRUSH_GLOBAL_DATA", subdir: "data" }],
  identitiesJsonPath: join(homedir(), ".zai", "identities.json"),
  identitiesRootDir: join(homedir(), ".zai", "identities"),
};

// "ali" is the SECOND fake proxy identity this project invents for the real
// `crush` binary, this time pointed at Alibaba Cloud Model Studio's "Token
// plan" (an Anthropic-compatible endpoint at
// https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic).
// Confirmed live (2026-08-07): a self-contained "alibaba" provider entry
// (type: "anthropic", that base_url, disable_default_providers: true, a
// static models array) makes `crush models` list exactly those models, and
// `crush run --model alibaba/<id>` sends a REAL request to
// `<base_url>/v1/messages` (a genuine Alibaba 401 with a request_id for a
// placeholder key, proving the config is actually read and used, the same
// proof shape zai's take-3 design used). See identities/ali-auth.ts for the
// writer, and AGENTS.md's "ali case study" for the fuller history.
//
// envVarName is the bespoke ALI_CONFIG_DIR, NOT CRUSH_GLOBAL_CONFIG (zai's
// own envVarName), even though both proxy the same real binary. `open.ts`
// and resolve.ts step (b) identify the active tool by envVarName: if ali
// reused zai's, an ali session and a zai session would be indistinguishable
// from each other, the exact collision class zai's own take-2 design hit
// when it shared `claude`'s envVarName with CLAUDE_CONFIG. The real crush
// vars are mirrored via extraEnvVarNames instead, same mechanism zai already
// uses (including the mandatory `subdir: "data"` split for
// CRUSH_GLOBAL_DATA: pointing CRUSH_GLOBAL_CONFIG and CRUSH_GLOBAL_DATA at
// the same directory makes crush double-register every model (see the
// 2026-07-18 zai addendum in AGENTS.md).
//
// Known accepted residual, same class as zai take-2's claude-sharing: a
// nested bare `zai` launch inside an ali session sees CRUSH_GLOBAL_CONFIG
// already set (via ali's own extraEnvVarNames) and resolve.ts step (b)
// resolves it to the ali identity's configDir instead of prompting. Not
// specifically guarded against, same as the equivalent zai/claude case.
//
// Kept in its OWN `~/.ali` registry, same rationale as zai's own `~/.zai`: a
// "identity-a" identity might exist in claude, zai, AND ali at once, each a
// genuinely different account/provider.
export const ALI_CONFIG: ToolConfig = {
  toolName: "ali",
  realBinaryName: "crush",
  envVarName: "ALI_CONFIG_DIR",
  globalMemoryProjection: "crush-global-context",
  extraEnvVarNames: [{ name: "CRUSH_GLOBAL_CONFIG" }, { name: "CRUSH_GLOBAL_DATA", subdir: "data" }],
  identitiesJsonPath: join(homedir(), ".ali", "identities.json"),
  identitiesRootDir: join(homedir(), ".ali", "identities"),
};
