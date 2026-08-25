import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { ChromeProfileOverride, Identity, IdentitiesFile } from "./types.ts";
import { InvalidIdentitiesFileError } from "./errors.ts";
import { expandPath, parseDirectoryPattern } from "./match.ts";

function validateIdentity(identity: unknown, index: number): asserts identity is Identity {
  if (typeof identity !== "object" || identity === null) {
    throw new InvalidIdentitiesFileError(`identities[${index}] is not an object`);
  }
  const rec = identity as Record<string, unknown>;
  if (typeof rec.name !== "string" || !rec.name) {
    throw new InvalidIdentitiesFileError(`identities[${index}] missing a non-empty "name"`);
  }
  if (typeof rec.label !== "string" || !rec.label) {
    throw new InvalidIdentitiesFileError(`identity "${rec.name}" missing a non-empty "label"`);
  }
  if (rec.description !== undefined && typeof rec.description !== "string") {
    throw new InvalidIdentitiesFileError(`identity "${rec.name}" has a non-string "description"`);
  }
  if (typeof rec.configDir !== "string" || !rec.configDir) {
    throw new InvalidIdentitiesFileError(`identity "${rec.name}" missing a non-empty "configDir"`);
  }
  if (rec.directories !== undefined) {
    if (!Array.isArray(rec.directories) || rec.directories.some((d) => typeof d !== "string")) {
      throw new InvalidIdentitiesFileError(`identity "${rec.name}" has a non-string[] "directories"`);
    }
    for (const raw of rec.directories as string[]) {
      // Throws InvalidIdentitiesFileError on bad grammar — validated eagerly
      // at load time so a bad pattern is caught here, not at match time.
      parseDirectoryPattern(raw, `identity "${rec.name}"`);
    }
  }
  if (rec.aliases !== undefined) {
    if (!Array.isArray(rec.aliases) || rec.aliases.some((a) => typeof a !== "string" || !a)) {
      throw new InvalidIdentitiesFileError(`identity "${rec.name}" has a non-string[] "aliases"`);
    }
  }
}

function validateChromeProfileOverride(
  override: unknown,
  index: number,
): asserts override is ChromeProfileOverride {
  if (typeof override !== "object" || override === null) {
    throw new InvalidIdentitiesFileError(`chromeProfileOverrides[${index}] is not an object`);
  }
  const rec = override as Record<string, unknown>;
  if (
    !Array.isArray(rec.directories) ||
    rec.directories.length === 0 ||
    rec.directories.some((d) => typeof d !== "string" || !d)
  ) {
    throw new InvalidIdentitiesFileError(
      `chromeProfileOverrides[${index}] missing a non-empty "directories" string[]`,
    );
  }
  for (const raw of rec.directories as string[]) {
    parseDirectoryPattern(raw, `chromeProfileOverrides[${index}]`);
  }
  if (typeof rec.targetIdentity !== "string" || !rec.targetIdentity) {
    throw new InvalidIdentitiesFileError(
      `chromeProfileOverrides[${index}] missing a non-empty "targetIdentity"`,
    );
  }
  if (rec.label !== undefined && typeof rec.label !== "string") {
    throw new InvalidIdentitiesFileError(`chromeProfileOverrides[${index}] has a non-string "label"`);
  }
}

export function parseIdentitiesFile(raw: unknown): IdentitiesFile {
  if (typeof raw !== "object" || raw === null) {
    throw new InvalidIdentitiesFileError("identities file is not a JSON object");
  }
  const rec = raw as Record<string, unknown>;
  if (rec.version !== 1) {
    throw new InvalidIdentitiesFileError(`identities file has unsupported "version" (expected 1)`);
  }
  if (!Array.isArray(rec.identities)) {
    throw new InvalidIdentitiesFileError(`identities file missing "identities" array`);
  }

  // Names and aliases share one namespace — "--identity=<key>" must resolve
  // unambiguously, so a name can't collide with another identity's name or
  // alias, and vice versa.
  const seenKeys = new Set<string>();
  rec.identities.forEach((identity, index) => {
    validateIdentity(identity, index);
    const keys = [identity.name, ...(identity.aliases ?? [])];
    for (const key of keys) {
      if (seenKeys.has(key)) {
        throw new InvalidIdentitiesFileError(`duplicate identity name/alias "${key}"`);
      }
      seenKeys.add(key);
    }
  });

  if (rec.chromeProfileOverrides !== undefined) {
    if (!Array.isArray(rec.chromeProfileOverrides)) {
      throw new InvalidIdentitiesFileError(`identities file has a non-array "chromeProfileOverrides"`);
    }
    rec.chromeProfileOverrides.forEach(validateChromeProfileOverride);
  }

  return {
    version: 1,
    identities: rec.identities as Identity[],
    chromeProfileOverrides: rec.chromeProfileOverrides as ChromeProfileOverride[] | undefined,
  };
}

/** Look up an identity by its exact name or by any of its aliases. */
export function findIdentityByNameOrAlias(identities: Identity[], key: string): Identity | undefined {
  return identities.find((identity) => identity.name === key || (identity.aliases ?? []).includes(key));
}

export async function loadIdentitiesFile(path: string): Promise<IdentitiesFile> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { version: 1, identities: [] };
  }
  const raw = await file.json();
  const parsed = parseIdentitiesFile(raw);

  // A registry may be synchronised between hosts whose home directories
  // differ (for example /Users/name on macOS and /home/name on Linux), so
  // the on-disk form is allowed to use ~/.... Every filesystem and process
  // consumer receives an absolute configDir from this I/O boundary. Keeping
  // that invariant here prevents usage/resume/limits callers from ever
  // passing a literal "~" directory to a child process or node:path.join().
  return {
    ...parsed,
    identities: parsed.identities.map((identity) => ({
      ...identity,
      configDir: expandPath(identity.configDir),
    })),
  };
}

/** Atomic write: write to a temp file in the same dir, then rename over the target. */
export async function saveIdentitiesFile(path: string, data: IdentitiesFile): Promise<void> {
  const dir = dirname(path);
  const tmpPath = `${dir}/.identities.${randomUUID()}.tmp`;
  await Bun.write(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
  const { rename } = await import("node:fs/promises");
  await rename(tmpPath, path);
}
