import { homedir } from "node:os";
import { dirname, relative, sep } from "node:path";
import { copyFile } from "node:fs/promises";
import { loadIdentitiesFile, parseIdentitiesFile, saveIdentitiesFile } from "../identities/store.ts";
import type { ChromeProfileOverride, IdentitiesFile, Identity, ToolConfig } from "../identities/types.ts";

function slash(path: string): string {
  return path.split(sep).join("/");
}

function toolRootRelative(cfg: ToolConfig, home: string): string {
  const root = slash(relative(home, dirname(cfg.identitiesJsonPath)));
  if (!root || root === ".." || root.startsWith("../")) {
    throw new Error(`${cfg.toolName}: identities registry is outside the home directory and cannot be SSH-synced`);
  }
  return root;
}

function sourceHomes(file: IdentitiesFile, toolRoot: string, currentHome: string): string[] {
  const homes = new Set([currentHome]);
  for (const identity of file.identities) {
    const suffix = `/${toolRoot}/identities/${identity.name}`;
    if (identity.configDir.endsWith(suffix)) {
      homes.add(identity.configDir.slice(0, -suffix.length));
    }
  }
  return [...homes].sort((a, b) => b.length - a.length);
}

function portablePath(path: string, homes: string[]): string {
  for (const home of homes) {
    if (path === home) return "~";
    if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  }
  return path;
}

function portableOverride(override: ChromeProfileOverride, homes: string[]): ChromeProfileOverride {
  return {
    ...override,
    directories: override.directories.map((path) => portablePath(path, homes)),
  };
}

/**
 * Makes the standard profile layout portable between macOS (/Users/name)
 * and Linux (/home/name). Custom configDir values beneath the current/source
 * home become portable too; paths outside those homes remain verbatim.
 */
export function portableIdentitiesFile(
  file: IdentitiesFile,
  cfg: ToolConfig,
  home: string = homedir(),
): IdentitiesFile {
  const toolRoot = toolRootRelative(cfg, home);
  const homes = sourceHomes(file, toolRoot, home);
  return {
    version: 1,
    identities: file.identities.map((identity) => {
      const suffix = `/${toolRoot}/identities/${identity.name}`;
      const standard = homes.some((sourceHome) => identity.configDir === `${sourceHome}${suffix}`);
      return {
        ...identity,
        configDir: standard
          ? `~/${toolRoot}/identities/${identity.name}`
          : portablePath(identity.configDir, homes),
        ...(identity.directories
          ? { directories: identity.directories.map((path) => portablePath(path, homes)) }
          : {}),
      };
    }),
    ...(file.chromeProfileOverrides
      ? { chromeProfileOverrides: file.chromeProfileOverrides.map((override) => portableOverride(override, homes)) }
      : {}),
  };
}

export async function makeRegistryPortable(cfg: ToolConfig, home: string = homedir()): Promise<boolean> {
  if (!(await Bun.file(cfg.identitiesJsonPath).exists())) return false;
  const original = await loadIdentitiesFile(cfg.identitiesJsonPath);
  const portable = portableIdentitiesFile(original, cfg, home);
  if (JSON.stringify(original) === JSON.stringify(portable)) return false;
  await saveIdentitiesFile(cfg.identitiesJsonPath, portable);
  return true;
}

function mergeStrings(primary: string[] | undefined, secondary: string[] | undefined): string[] | undefined {
  const merged = [...new Set([...(primary ?? []), ...(secondary ?? [])])];
  return merged.length > 0 ? merged : undefined;
}

function mergeIdentity(primary: Identity, secondary: Identity): Identity {
  return {
    ...secondary,
    ...primary,
    directories: mergeStrings(primary.directories, secondary.directories),
    aliases: mergeStrings(primary.aliases, secondary.aliases),
  };
}

/** These entries were one-off containers created to preserve a host's
 * pre-AIS session tree. They are archives, not credentials/accounts, and must
 * never become selectable identities or quota targets merely because their
 * registry was synchronised to another machine. The exact description and
 * standard configDir shape keep this from hiding a real identity that happens
 * to have a name ending in "-legacy". */
export function isSyntheticLegacySessionContainer(identity: Identity): boolean {
  return (
    identity.name.endsWith("-legacy") &&
    /^Preserved pre-AIS (?:Claude|Codex|Grok|Kimi|Zai) sessions from [A-Za-z0-9._-]+$/.test(identity.description ?? "") &&
    identity.configDir.replace(/\/$/, "").endsWith(`/identities/${identity.name}`)
  );
}

export interface RemovedLegacyRegistryEntry {
  toolName: ToolConfig["toolName"];
  name: string;
  configDir: string;
  registryBackup: string;
}

/** Remove only synthetic archive containers from registries. Their profile
 * directories are deliberately left byte-for-byte intact. */
export async function removeSyntheticLegacyRegistryEntries(
  configs: ToolConfig[],
): Promise<RemovedLegacyRegistryEntry[]> {
  const removed: RemovedLegacyRegistryEntry[] = [];
  for (const cfg of configs) {
    const file = Bun.file(cfg.identitiesJsonPath);
    if (!(await file.exists())) continue;
    const parsed = parseIdentitiesFile(await file.json());
    const legacy = parsed.identities.filter(isSyntheticLegacySessionContainer);
    if (legacy.length === 0) continue;

    const backup = `${cfg.identitiesJsonPath}.pre-legacy-cleanup-${new Date().toISOString().replaceAll(":", "-")}-${crypto.randomUUID()}`;
    await copyFile(cfg.identitiesJsonPath, backup);
    await saveIdentitiesFile(cfg.identitiesJsonPath, {
      ...parsed,
      identities: parsed.identities.filter((identity) => !isSyntheticLegacySessionContainer(identity)),
    });
    for (const identity of legacy) {
      removed.push({
        toolName: cfg.toolName,
        name: identity.name,
        configDir: identity.configDir,
        registryBackup: backup,
      });
    }
  }
  return removed;
}

/** Semantic registry union used after a pull has preserved the previous
 * local file in rsync's conflict backup. Whole-file newest-wins would drop
 * identities independently created on the other host. */
export async function mergeRegistryConflict(
  livePath: string,
  previousLocalPath: string,
): Promise<boolean> {
  const liveFile = Bun.file(livePath);
  const previousFile = Bun.file(previousLocalPath);
  if (!(await liveFile.exists()) || !(await previousFile.exists())) return false;

  const [live, previous, liveStat, previousStat] = await Promise.all([
    liveFile.json().then(parseIdentitiesFile),
    previousFile.json().then(parseIdentitiesFile),
    import("node:fs/promises").then(({ stat }) => stat(livePath)),
    import("node:fs/promises").then(({ stat }) => stat(previousLocalPath)),
  ]);
  const primary = liveStat.mtimeMs >= previousStat.mtimeMs ? live : previous;
  const secondary = primary === live ? previous : live;
  const byName = new Map(secondary.identities.map((identity) => [identity.name, identity]));
  const identities = primary.identities.map((identity) => {
    const other = byName.get(identity.name);
    byName.delete(identity.name);
    return other ? mergeIdentity(identity, other) : identity;
  });
  identities.push(...byName.values());

  const overrideKeys = new Set<string>();
  const chromeProfileOverrides = [...(primary.chromeProfileOverrides ?? []), ...(secondary.chromeProfileOverrides ?? [])].filter(
    (override) => {
      const key = JSON.stringify(override);
      if (overrideKeys.has(key)) return false;
      overrideKeys.add(key);
      return true;
    },
  );
  await saveIdentitiesFile(livePath, {
    version: 1,
    identities: identities.filter((identity) => !isSyntheticLegacySessionContainer(identity)),
    ...(chromeProfileOverrides.length > 0 ? { chromeProfileOverrides } : {}),
  });
  return true;
}
