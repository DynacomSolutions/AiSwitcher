import type { ChromeProfileOverride, Identity, IdentitiesFile } from "../../identities/types.ts";
import { isValidIdentityKey, parseDirectoryPattern } from "../../identities/match.ts";
import { findIdentityByNameOrAlias } from "../../identities/store.ts";
import { CliUsageError } from "../errors.ts";

/** Names and aliases share one namespace across the whole file — same rule
 * store.ts's parseIdentitiesFile enforces at load time. */
function existingKeys(file: IdentitiesFile): Set<string> {
  return new Set(file.identities.flatMap((i) => [i.name, ...(i.aliases ?? [])]));
}

function requireIdentity(file: IdentitiesFile, name: string): Identity {
  const identity = findIdentityByNameOrAlias(file.identities, name);
  if (!identity) throw new CliUsageError(`No identity named "${name}"`);
  return identity;
}

function requireValidKey(value: string, keys: Set<string>, kind: "name" | "alias"): void {
  if (!isValidIdentityKey(value)) {
    throw new CliUsageError(
      `Invalid ${kind} "${value}" — use lowercase letters, digits, and single hyphens only (e.g. identity-a)`,
    );
  }
  if (keys.has(value)) {
    throw new CliUsageError(`"${value}" is already an identity name or alias`);
  }
}

/** store.ts's validateIdentity rejects an empty label/configDir at load
 * time — enforced here too so a blank value never makes it into a
 * persisted identities.json in the first place. */
function requireNonEmpty(value: string, field: string): void {
  if (!value) throw new CliUsageError(`"${field}" must not be empty`);
}

export interface CreateIdentityInput {
  name: string;
  label: string;
  description?: string;
  configDir: string;
  directories?: string[];
  aliases?: string[];
}

export function createIdentity(file: IdentitiesFile, input: CreateIdentityInput): Identity {
  const keys = existingKeys(file);
  requireValidKey(input.name, keys, "name");
  requireNonEmpty(input.label, "label");
  requireNonEmpty(input.configDir, "configDir");
  // The new identity's own name joins the collision set immediately so a
  // duplicate alias can't slip in either against it or against another
  // alias earlier in this same aliases list (e.g. --aliases=a,a, or an
  // alias equal to --name) — existingKeys() alone only reflects identities
  // that existed before this call.
  keys.add(input.name);
  for (const alias of input.aliases ?? []) {
    requireValidKey(alias, keys, "alias");
    keys.add(alias);
  }
  for (const pattern of input.directories ?? []) {
    parseDirectoryPattern(pattern, `new identity "${input.name}"`);
  }

  const identity: Identity = {
    name: input.name,
    label: input.label,
    ...(input.description ? { description: input.description } : {}),
    configDir: input.configDir,
    ...(input.directories?.length ? { directories: input.directories } : {}),
    ...(input.aliases?.length ? { aliases: input.aliases } : {}),
  };
  file.identities.push(identity);
  return identity;
}

export interface UpdateIdentityInput {
  label?: string;
  description?: string;
  configDir?: string;
}

export function updateIdentity(file: IdentitiesFile, name: string, input: UpdateIdentityInput): Identity {
  const identity = requireIdentity(file, name);
  if (input.label !== undefined) {
    requireNonEmpty(input.label, "label");
    identity.label = input.label;
  }
  if (input.description !== undefined) identity.description = input.description;
  if (input.configDir !== undefined) {
    requireNonEmpty(input.configDir, "configDir");
    identity.configDir = input.configDir;
  }
  return identity;
}

/** Removes the identity from the registry only — never touches its
 * configDir on disk. Deleting a directory full of auth/history/plugins is
 * not something to do silently as a side effect of a registry edit. */
export function deleteIdentity(file: IdentitiesFile, name: string): Identity {
  const identity = requireIdentity(file, name);
  file.identities = file.identities.filter((i) => i !== identity);
  return identity;
}

export function addDirectory(file: IdentitiesFile, name: string, pattern: string): Identity {
  const identity = requireIdentity(file, name);
  parseDirectoryPattern(pattern, `identity "${name}"`);
  const directories = identity.directories ?? [];
  if (!directories.includes(pattern)) {
    identity.directories = [...directories, pattern];
  }
  return identity;
}

export function removeDirectory(file: IdentitiesFile, name: string, pattern: string): Identity {
  const identity = requireIdentity(file, name);
  const remaining = (identity.directories ?? []).filter((d) => d !== pattern);
  if (remaining.length > 0) identity.directories = remaining;
  else delete identity.directories;
  return identity;
}

export function addAlias(file: IdentitiesFile, name: string, alias: string): Identity {
  const identity = requireIdentity(file, name);
  requireValidKey(alias, existingKeys(file), "alias");
  identity.aliases = [...(identity.aliases ?? []), alias];
  return identity;
}

export function removeAlias(file: IdentitiesFile, name: string, alias: string): Identity {
  const identity = requireIdentity(file, name);
  const remaining = (identity.aliases ?? []).filter((a) => a !== alias);
  if (remaining.length > 0) identity.aliases = remaining;
  else delete identity.aliases;
  return identity;
}

export function addChromeOverride(file: IdentitiesFile, override: ChromeProfileOverride): ChromeProfileOverride {
  if (override.directories.length === 0) throw new CliUsageError('"directories" must not be empty');
  requireNonEmpty(override.targetIdentity, "targetIdentity");
  for (const pattern of override.directories) {
    parseDirectoryPattern(pattern, "chromeProfileOverrides");
  }
  file.chromeProfileOverrides = [...(file.chromeProfileOverrides ?? []), override];
  return override;
}

export function removeChromeOverride(file: IdentitiesFile, index: number): ChromeProfileOverride {
  const overrides = file.chromeProfileOverrides ?? [];
  if (!Number.isInteger(index) || index < 0 || index >= overrides.length) {
    throw new CliUsageError(
      `No chrome-overrides entry at index ${index} (valid range: 0-${overrides.length - 1})`,
    );
  }
  const removed = overrides[index]!;
  const remaining = overrides.filter((_, i) => i !== index);
  if (remaining.length > 0) file.chromeProfileOverrides = remaining;
  else delete file.chromeProfileOverrides;
  return removed;
}
