import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { ChromeProfileOverride, Identity, IdentitiesFile } from "./types.ts";
import { InvalidIdentitiesFileError } from "./errors.ts";
import { isValidIdentityColour } from "./colour.ts";
import { expandPath, parseDirectoryPattern, translateHostPath, untranslateHostPath } from "./match.ts";

/** Structural validation only. Whether members exist, are claude identities,
 * are not retired and are not pools themselves depends on the OTHER
 * identities and is checked by identities/swap-pool.ts at the points that
 * need it, so a later retire of a member never makes the registry unloadable. */
function validateSwapPool(value: unknown, owner: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidIdentitiesFileError(`identity "${owner}" has a non-object "swapPool"`);
  }
  const pool = value as Record<string, unknown>;
  const names = (key: string): string[] | undefined => {
    const raw = pool[key];
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw) || raw.some((a) => typeof a !== "string" || !a)) {
      throw new InvalidIdentitiesFileError(`identity "${owner}" has a non-string[] "swapPool.${key}"`);
    }
    return raw as string[];
  };
  const accounts = names("accounts");
  if (!accounts) throw new InvalidIdentitiesFileError(`identity "${owner}" swapPool is missing "accounts"`);
  if (new Set(accounts).size !== accounts.length) {
    throw new InvalidIdentitiesFileError(`identity "${owner}" swapPool.accounts has duplicates`);
  }
  if (accounts.includes(owner)) {
    throw new InvalidIdentitiesFileError(`identity "${owner}" lists itself in swapPool.accounts`);
  }
  if (pool.active !== undefined && (typeof pool.active !== "string" || !accounts.includes(pool.active))) {
    throw new InvalidIdentitiesFileError(`identity "${owner}" swapPool.active must be one of swapPool.accounts`);
  }
  const disallowed = names("disallowed");
  if (disallowed?.some((name) => !accounts.includes(name))) {
    throw new InvalidIdentitiesFileError(`identity "${owner}" swapPool.disallowed must be a subset of swapPool.accounts`);
  }
  if (pool.auto !== undefined && typeof pool.auto !== "boolean") {
    throw new InvalidIdentitiesFileError(`identity "${owner}" has a non-boolean "swapPool.auto"`);
  }
  if (pool.thresholdPercent !== undefined) {
    const t = pool.thresholdPercent;
    if (typeof t !== "number" || !Number.isFinite(t) || t < 1 || t > 100) {
      throw new InvalidIdentitiesFileError(`identity "${owner}" swapPool.thresholdPercent must be a number from 1 to 100`);
    }
  }
}

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
  if (rec.colour !== undefined) {
    // Validated eagerly so a typo never lands in the registry; identities/colour.ts
    // is also what every consumer normalises through before display.
    if (typeof rec.colour !== "string" || !isValidIdentityColour(rec.colour)) {
      throw new InvalidIdentitiesFileError(`identity "${rec.name}" has an invalid "colour" (use #rgb or #rrggbb)`);
    }
  }
  if (rec.retired !== undefined && typeof rec.retired !== "boolean") {
    throw new InvalidIdentitiesFileError(`identity "${rec.name}" has a non-boolean "retired"`);
  }
  for (const key of ["retiredAt", "unretiredAt"] as const) {
    const value = rec[key];
    if (value !== undefined && (typeof value !== "string" || Number.isNaN(Date.parse(value)))) {
      throw new InvalidIdentitiesFileError(`identity "${rec.name}" has an invalid "${key}" (use an ISO 8601 timestamp)`);
    }
  }
  if (rec.swapPool !== undefined) validateSwapPool(rec.swapPool, String(rec.name));
  if (rec.env !== undefined) {
    if (typeof rec.env !== "object" || rec.env === null || Array.isArray(rec.env)) {
      throw new InvalidIdentitiesFileError(`identity "${rec.name}" has a non-object "env"`);
    }
    for (const [key, value] of Object.entries(rec.env as Record<string, unknown>)) {
      if (typeof value !== "string") {
        throw new InvalidIdentitiesFileError(`identity "${rec.name}" has a non-string env value for "${key}"`);
      }
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
      // In a container the host-absolute dir is mapped to its mount; saves reverse it.
      configDir: translateHostPath(expandPath(identity.configDir)),
    })),
  };
}

/** Atomic write: write to a temp file in the same dir, then rename over the target. */
export async function saveIdentitiesFile(path: string, data: IdentitiesFile): Promise<void> {
  const dir = dirname(path);
  const tmpPath = `${dir}/.identities.${randomUUID()}.tmp`;
  const hostData = {
    ...data,
    identities: data.identities.map((i) => ({ ...i, configDir: untranslateHostPath(i.configDir) })),
  };
  await Bun.write(tmpPath, `${JSON.stringify(hostData, null, 2)}\n`);
  const { rename } = await import("node:fs/promises");
  await rename(tmpPath, path);
}
