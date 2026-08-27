import {
  ALI_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GROK_CONFIG,
  KIMI_CONFIG,
  PI_CONFIG,
  OPENCODE_CONFIG,
  ZAI_CONFIG,
} from "../../identities/tool-configs.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile, saveIdentitiesFile } from "../../identities/store.ts";
import type { IdentitiesFile, ToolConfig } from "../../identities/types.ts";
import { stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";

export const TOOL_CONFIGS = {
  claude: CLAUDE_CONFIG,
  codex: CODEX_CONFIG,
  grok: GROK_CONFIG,
  kimi: KIMI_CONFIG,
  zai: ZAI_CONFIG,
  ali: ALI_CONFIG,
  pi: PI_CONFIG,
  opencode: OPENCODE_CONFIG,
} as const;

const TOOL_NAMES = Object.keys(TOOL_CONFIGS) as Array<keyof typeof TOOL_CONFIGS>;
const TOOL_NAMES_JOINED = TOOL_NAMES.join("|");

export interface LoadedFile {
  cfg: ToolConfig;
  file: IdentitiesFile;
}

function isKnownToolName(tool: string): tool is keyof typeof TOOL_CONFIGS {
  return (TOOL_NAMES as string[]).includes(tool);
}

export function toolConfigFromFlag(flags: ParsedArgs["flags"]): ToolConfig | undefined {
  const tool = stringFlag(flags, "tool");
  if (tool === undefined) return undefined;
  if (!isKnownToolName(tool)) {
    throw new CliUsageError(`Invalid --tool="${tool}" — must be one of: ${TOOL_NAMES_JOINED}`);
  }
  return TOOL_CONFIGS[tool];
}

export function requireToolConfigFromFlag(flags: ParsedArgs["flags"]): ToolConfig {
  const cfg = toolConfigFromFlag(flags);
  if (!cfg) throw new CliUsageError(`Missing required --tool=${TOOL_NAMES_JOINED}`);
  return cfg;
}

export async function loadOne(cfg: ToolConfig): Promise<LoadedFile> {
  return { cfg, file: await loadIdentitiesFile(cfg.identitiesJsonPath) };
}

export async function loadAll(configs: ToolConfig[] = Object.values(TOOL_CONFIGS)): Promise<LoadedFile[]> {
  return Promise.all(configs.map(loadOne));
}

/**
 * Resolve which tool's registry a name-targeted mutation applies to:
 * --tool wins outright when given; otherwise auto-resolve when the name
 * exists in exactly one registry, and demand --tool when it exists in more
 * than one (a real case today — "work" is configured for both
 * claude and codex) or in none. Mirrors resolve.ts's own stance on ambiguity:
 * never silently guess, but don't force disambiguation when there's nothing
 * to disambiguate. Written generically over N registries (currently seven:
 * claude/codex/grok/kimi/zai/ali/pi) rather than a hardcoded pair.
 *
 * `configs` defaults to the real TOOL_CONFIGS values and is only ever
 * overridden by tests (see test/cli/resolve-tool.test.ts) — real callers
 * never pass it, since this function's whole job is choosing between the
 * real registries.
 */
export async function resolveMutationTarget(
  flags: ParsedArgs["flags"],
  name: string,
  configs: ToolConfig[] = Object.values(TOOL_CONFIGS),
): Promise<LoadedFile> {
  const explicit = toolConfigFromFlag(flags);
  if (explicit) return loadOne(explicit);

  const loaded = await loadAll(configs);
  const matches = loaded.filter((l) => findIdentityByNameOrAlias(l.file.identities, name));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new CliUsageError(
      `No identity named "${name}" in any registry — pass --tool=${TOOL_NAMES_JOINED} to target one directly.`,
    );
  }
  throw new CliUsageError(
    `"${name}" exists in more than one registry (${matches.map((m) => m.cfg.toolName).join(", ")}) — ` +
      `pass --tool=${TOOL_NAMES_JOINED} to disambiguate.`,
  );
}

export async function persist(loaded: LoadedFile): Promise<void> {
  await saveIdentitiesFile(loaded.cfg.identitiesJsonPath, loaded.file);
}
