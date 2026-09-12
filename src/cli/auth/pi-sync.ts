import { expandPath } from "../../identities/match.ts";
import { reconcilePiOAuthStores, renderOAuthReconcileReport } from "../../identities/oauth-reconcile.ts";
import { syncPiCredentials, type PiCredentialSourceDirs } from "../../identities/pi-auth.ts";
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
import { openCodeGoApiKey } from "./pi-import.ts";

const SOURCES = {
  claude: CLAUDE_CONFIG,
  codex: CODEX_CONFIG,
  grok: GROK_CONFIG,
  kimi: KIMI_CONFIG,
  zai: ZAI_CONFIG,
  ali: ALI_CONFIG,
} as const;

type SourceKey = keyof typeof SOURCES;

export type SourceVia = `--${string} flag` | "same-named identity" | "only identity in the registry";

export interface SourceResolution {
  key: SourceKey;
  configDir: string;
  /** How the source was picked - surfaced so the report stays honest. */
  via: SourceVia;
}

export type SourcePick = { name: string; via: SourceVia } | { skip: string };

/**
 * Pure: decides which source registry identity feeds a Pi identity. An
 * explicit flag wins; otherwise the SAME-NAMED identity; otherwise a
 * registry holding exactly one identity is unambiguous enough to share;
 * anything else is skipped with a note rather than guessed.
 */
export function pickSourceIdentity(
  piIdentityName: string,
  flagged: string | undefined,
  registryNames: readonly string[],
  toolName: string,
  sourceFlag: string,
): SourcePick {
  if (flagged !== undefined) {
    if (!registryNames.includes(flagged)) {
      return { skip: `${sourceFlag}: no ${toolName} identity named "${flagged}"` };
    }
    return { name: flagged, via: `--${sourceFlag} flag` };
  }
  if (registryNames.includes(piIdentityName)) {
    return { name: piIdentityName, via: "same-named identity" };
  }
  if (registryNames.length === 1) {
    return { name: registryNames[0] as string, via: "only identity in the registry" };
  }
  const names = registryNames.join(", ") || "none";
  return {
    skip:
      `${sourceFlag}: no ${toolName} identity named "${piIdentityName}" and the registry holds several or none (${names})` +
      ` - pass --${sourceFlag}=<name> to pick one`,
  };
}

/**
 * Resolves which source identity feeds each provider into the Pi identity
 * (see pickSourceIdentity for the rule).
 */
export async function resolveSyncSources(
  piIdentityName: string,
  flags: ParsedArgs["flags"],
): Promise<{ resolved: SourceResolution[]; skipped: string[] }> {
  const resolved: SourceResolution[] = [];
  const skipped: string[] = [];
  for (const [key, cfg] of Object.entries(SOURCES) as Array<[SourceKey, ToolConfig]>) {
    const file = await loadIdentitiesFile(cfg.identitiesJsonPath);
    const names = file.identities.map((identity) => identity.name);
    const pick = pickSourceIdentity(piIdentityName, stringFlag(flags, key), names, cfg.toolName, key);
    if ("skip" in pick) {
      skipped.push(pick.skip);
      continue;
    }
    const identity = findIdentityByNameOrAlias(file.identities, pick.name);
    if (!identity) {
      skipped.push(`${key}: no ${cfg.toolName} identity named "${pick.name}"`);
      continue;
    }
    resolved.push({ key, configDir: expandPath(identity.configDir), via: pick.via });
  }
  return { resolved, skipped };
}

export async function runPiAuthSync(positionals: string[], flags: ParsedArgs["flags"]): Promise<void> {
  if (stringFlag(flags, "tool") !== "pi") {
    throw new CliUsageError('Pi credential sync requires --tool=pi');
  }
  if (positionals.length > 1) throw new CliUsageError("auth sync accepts exactly one Pi identity");

  const piFile = await loadIdentitiesFile(PI_CONFIG.identitiesJsonPath);
  const piKey = positionals[0];
  const piIdentity = piKey
    ? findIdentityByNameOrAlias(piFile.identities, piKey)
    : piFile.identities.length === 1
      ? piFile.identities[0]
      : undefined;
  if (!piIdentity) {
    throw new CliUsageError(
      piKey ? `No pi identity named "${piKey}".` : "Specify the Pi identity to sync credentials into.",
    );
  }

  const piName = piIdentity.name;
  const { resolved, skipped } = await resolveSyncSources(piName, flags);

  const sourceDirs: PiCredentialSourceDirs = {};
  for (const entry of resolved) {
    sourceDirs[entry.key] = entry.configDir;
  }
  if (boolFlag(flags, "opencode-go") || process.env.OPENCODE_API_KEY?.trim()) {
    sourceDirs.opencodeGoApiKey = await openCodeGoApiKey(flags);
  } else {
    skipped.push("opencode-go: no OPENCODE_API_KEY in the environment - pass --opencode-go to be prompted");
  }

  const configDir = expandPath(piIdentity.configDir);
  const result = await syncPiCredentials(configDir, sourceDirs);

  console.log(`Pi identity: ${piName} (${configDir})`);
  console.log(
    result.added.length > 0
      ? `Added credentials for: ${result.added.join(", ")}.`
      : "Nothing to add: every offered provider already has a credential.",
  );
  if (result.kept.length > 0) {
    console.log(
      `Kept existing credentials for: ${result.kept.join(", ")} (reconciled below - the freshest ` +
        "rotating OAuth copy wins across all stores; see src/identities/oauth-reconcile.ts).",
    );
  }
  if (result.modelsPath) console.log(`Alibaba provider catalogue: ${result.modelsPath} (mode 0600).`);
  // One credential per (identity, provider): converge every projected OAuth
  // copy with its native store while we are here (the add-only sync above
  // deliberately never touches existing entries).
  const reconciliation = await reconcilePiOAuthStores({ ...piIdentity, configDir }, { write: true });
  for (const line of renderOAuthReconcileReport(reconciliation)) console.log(`  ${line}`);
  for (const entry of resolved) {
    console.log(`  ${entry.key} source: ${entry.configDir} (${entry.via})`);
  }
  for (const note of skipped) console.log(`  skipped ${note}`);
  console.log(
    "  amazon-bedrock: pi speaks it, but its auth rides the ambient AWS credential chain; " +
      "AIS holds no Bedrock credential to sync.",
  );
  console.log("Credential store: auth.json (mode 0600). Secrets are never printed.");
}
