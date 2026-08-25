import * as clack from "@clack/prompts";
import { expandPath } from "../../identities/match.ts";
import { importPiCredentials, type PiCredentialSourceDirs } from "../../identities/pi-auth.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile } from "../../identities/store.ts";
import {
  ALI_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GROK_CONFIG,
  KIMI_CONFIG,
  PI_CONFIG,
  ZAI_CONFIG,
} from "../../identities/tool-configs.ts";
import type { ToolConfig } from "../../identities/types.ts";
import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";

const SOURCES = {
  claude: CLAUDE_CONFIG,
  codex: CODEX_CONFIG,
  grok: GROK_CONFIG,
  kimi: KIMI_CONFIG,
  zai: ZAI_CONFIG,
  ali: ALI_CONFIG,
} as const;

async function resolveConfigDir(cfg: ToolConfig, key: string): Promise<string> {
  const file = await loadIdentitiesFile(cfg.identitiesJsonPath);
  const identity = findIdentityByNameOrAlias(file.identities, key);
  if (!identity) throw new CliUsageError(`No ${cfg.toolName} identity named "${key}".`);
  return expandPath(identity.configDir);
}

async function openCodeGoApiKey(flags: ParsedArgs["flags"]): Promise<string | undefined> {
  if (!boolFlag(flags, "opencode-go")) return undefined;

  const fromEnvironment = process.env.OPENCODE_API_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;
  if (!process.stdin.isTTY) {
    throw new CliUsageError(
      "--opencode-go needs a terminal for its masked API-key prompt, or OPENCODE_API_KEY set in the environment",
    );
  }

  const result = await clack.password({
    message: "OpenCode Go API key",
    validate: (value) => value.trim() ? undefined : "API key is required",
  });
  if (clack.isCancel(result)) throw new CliUsageError("OpenCode Go credential import cancelled");
  return result.trim();
}

export async function runPiAuthImport(positionals: string[], flags: ParsedArgs["flags"]): Promise<void> {
  if (stringFlag(flags, "tool") !== "pi") {
    throw new CliUsageError('Pi credential import requires --tool=pi');
  }
  if (positionals.length > 1) throw new CliUsageError("auth import accepts exactly one Pi identity");

  const piFile = await loadIdentitiesFile(PI_CONFIG.identitiesJsonPath);
  const piKey = positionals[0];
  const piIdentity = piKey
    ? findIdentityByNameOrAlias(piFile.identities, piKey)
    : piFile.identities.length === 1
      ? piFile.identities[0]
      : undefined;
  if (!piIdentity) {
    throw new CliUsageError(
      piKey ? `No pi identity named "${piKey}".` : "Specify the Pi identity to receive credentials.",
    );
  }

  const sourceDirs: PiCredentialSourceDirs = {};
  for (const [name, cfg] of Object.entries(SOURCES)) {
    const identityKey = stringFlag(flags, name);
    if (identityKey) sourceDirs[name as keyof PiCredentialSourceDirs] = await resolveConfigDir(cfg, identityKey);
  }
  sourceDirs.opencodeGoApiKey = await openCodeGoApiKey(flags);

  const result = await importPiCredentials(expandPath(piIdentity.configDir), sourceDirs);
  console.log(`Imported Pi credentials for: ${result.providers.join(", ")}.`);
  console.log(`Credential store: ${result.authPath} (mode 0600).`);
  if (result.modelsPath) console.log(`Alibaba provider catalogue: ${result.modelsPath} (mode 0600).`);
}
