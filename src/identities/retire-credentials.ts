import { chmod, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { credentialPathsForTool } from "./credential-paths.ts";
import { removeAliAuthRefreshTimer } from "./auth-session.ts";
import { expandPath } from "./match.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile } from "./store.ts";
import { PI_CONFIG } from "./tool-configs.ts";
import type { Identity, ToolConfig } from "./types.ts";

/** What a purge removed. Paths and provider names only, never values. */
export interface PurgeReport {
  /** Files deleted and file entries stripped, each as a path (plus a
   * parenthesised key name where only one entry of a shared file went). */
  removed: string[];
  /** Things the purge cannot do itself, for the user to finish by hand. */
  warnings: string[];
}

export interface PurgeOptions {
  toolName: ToolConfig["toolName"];
  identity: Identity;
  /** Home directory used for ~/.ais state and the pi registry lookup. */
  home?: string;
  /** Pi registry to find a same-named pi identity in. Defaults to the real one
   * re-rooted onto `home`. */
  piRegistryPath?: string;
  /** Overridable for tests; "darwin" adds the Keychain warning for claude. */
  platform?: NodeJS.Platform;
  /** Overridable for tests; the default removes the systemd units. */
  removeAliTimer?: (identityName: string) => Promise<boolean>;
}

/** The pi auth.json provider key holding a copy of each tool's credential
 * (see pi-auth.ts readPiCredentialSources). */
export const PI_PROVIDER_FOR_TOOL: Partial<Record<ToolConfig["toolName"], string>> = {
  claude: "anthropic",
  codex: "openai-codex",
  grok: "xai",
  kimi: "kimi-coding",
  zai: "zai",
  ali: "alibaba-plan",
};

/** crush.json provider key holding the API key for the crush-backed tools. */
export const CRUSH_PROVIDER_FOR_TOOL: Partial<Record<ToolConfig["toolName"], string>> = {
  zai: "zai",
  ali: "alibaba",
};

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function removeFile(path: string, report: PurgeReport): Promise<void> {
  if (!(await exists(path))) return;
  try {
    await rm(path, { force: true });
    report.removed.push(path);
  } catch (err) {
    report.warnings.push(`Could not remove ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function readObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = (await Bun.file(path).json()) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeObject(path: string, value: Record<string, unknown>): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/** Drop only providers.<provider>.api_key from a crush.json, keeping the rest. */
export async function stripCrushApiKey(path: string, provider: string, report: PurgeReport): Promise<void> {
  const json = await readObject(path);
  const providers = json?.providers as Record<string, unknown> | undefined;
  const entry = providers?.[provider];
  if (!json || !entry || typeof entry !== "object" || !("api_key" in entry)) return;
  const { api_key: _removed, ...rest } = entry as Record<string, unknown>;
  try {
    await writeObject(path, { ...json, providers: { ...providers, [provider]: rest } });
    report.removed.push(`${path} (providers.${provider}.api_key)`);
  } catch (err) {
    report.warnings.push(`Could not update ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Drop one provider key from a pi auth.json, keeping every other entry. */
export async function stripPiEntry(path: string, provider: string, report: PurgeReport): Promise<void> {
  const json = await readObject(path);
  if (!json || !(provider in json)) return;
  const { [provider]: _removed, ...rest } = json;
  try {
    await writeObject(path, rest);
    report.removed.push(`${path} (${provider})`);
  } catch (err) {
    report.warnings.push(`Could not update ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The pi registry path re-rooted from the real home onto `home`. */
export function piRegistryFor(home: string): string {
  const real = homedir();
  const path = PI_CONFIG.identitiesJsonPath;
  return path.startsWith(`${real}/`) ? join(home, path.slice(real.length + 1)) : path;
}

/**
 * Delete the stored credentials of a retired identity. Idempotent and
 * tolerant: missing files, unparseable JSON and absent systemd are all
 * silently skipped. Usage logs, transcripts, session data and databases are
 * never touched.
 *
 * Covers the identity's own credential files, the crush.json API key for
 * zai/ali, ali's console cookie, auth-browser state and refresh timer, and
 * the copy of the credential in a same-named pi identity's auth.json.
 */
export async function purgeRetiredIdentityCredentials(opts: PurgeOptions): Promise<PurgeReport> {
  const { toolName, identity } = opts;
  const home = opts.home ?? homedir();
  const configDir = expandPath(identity.configDir);
  const report: PurgeReport = { removed: [], warnings: [] };

  for (const path of credentialPathsForTool(toolName, configDir)) await removeFile(path, report);

  const crushProvider = CRUSH_PROVIDER_FOR_TOOL[toolName];
  if (crushProvider) await stripCrushApiKey(join(configDir, "crush.json"), crushProvider, report);

  if (toolName === "ali") {
    await removeFile(join(configDir, "console-cookie.txt"), report);
    await removeFile(join(home, ".ais", "auth-browser", `${identity.name}.json`), report);
    try {
      const removeTimer = opts.removeAliTimer ?? ((name: string) => removeAliAuthRefreshTimer(name));
      if (await removeTimer(identity.name)) report.removed.push(`systemd units ais-ali-auth-refresh-${identity.name}`);
    } catch {
      // Best effort: no systemd (macOS, containers) is not an error.
    }
  }

  const piProvider = PI_PROVIDER_FOR_TOOL[toolName];
  if (piProvider) {
    try {
      const piFile = await loadIdentitiesFile(opts.piRegistryPath ?? piRegistryFor(home));
      const piIdentity = findIdentityByNameOrAlias(piFile.identities, identity.name);
      if (piIdentity) await stripPiEntry(join(expandPath(piIdentity.configDir), "auth.json"), piProvider, report);
    } catch {
      // No pi registry (or an unreadable one): nothing to strip.
    }
  }

  if (toolName === "claude" && (opts.platform ?? process.platform) === "darwin") {
    report.warnings.push(
      "macOS: Claude Code may keep credentials in the Keychain, which ais cannot remove. " +
        "Remove any Claude Code entry for this profile from Keychain Access by hand.",
    );
  }
  return report;
}
