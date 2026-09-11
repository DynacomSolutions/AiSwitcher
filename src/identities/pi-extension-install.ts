import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
// The extension ships as TypeScript source and is embedded into this binary
// as raw text (Bun's `type: "text"` import attribute). At runtime the default
// export IS the file content, both under `bun run` and inside a
// `bun build --compile` executable; TypeScript however still resolves the
// specifier as a module, so the value's static type is the module namespace
// and the string read needs this one documented cast.
import extensionSourceModule from "../pi-extension/ais-identity-extension.ts" with { type: "text" };

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Bun quirk (observed 2026-09-11): when the SAME file is imported as a
// module somewhere else in the process (the tests import the extension
// directly to drive its factory), the attribute import resolves to the
// module namespace instead of the text. In that case fall back to reading
// the file off disk - only ever true in dev/test processes, where this
// module still lives next to the source; a compiled binary always embeds
// the true text.
function resolveExtensionSource(): string {
  if (typeof extensionSourceModule === "string") return extensionSourceModule;
  return readFileSync(join(import.meta.dir, "..", "pi-extension", "ais-identity-extension.ts"), "utf8");
}

const EXTENSION_SOURCE: string = resolveExtensionSource();

/** The raw extension TypeScript source this build ships. Exported so tests
 * can transpile-check exactly what will be installed. */
export const EXTENSION_SOURCE_TEXT = EXTENSION_SOURCE;

export const EXTENSION_VERSION_PATTERN = /export const AIS_EXTENSION_VERSION = "([^"]+)";/;
export const EXTENSION_FILE_NAME = "ais-identity.ts";

/** The version embedded in this build's copy of the extension source. */
export function embeddedExtensionVersion(source: string = EXTENSION_SOURCE): string {
  const match = source.match(EXTENSION_VERSION_PATTERN);
  if (!match) throw new Error("embedded AIS pi extension source carries no AIS_EXTENSION_VERSION stamp");
  return match[1] as string;
}

export function installedExtensionPath(configDir: string): string {
  return join(configDir, "extensions", EXTENSION_FILE_NAME);
}

export interface PiExtensionInstallResult {
  /** Absolute path of the installed extension file. */
  path: string;
  /** "fresh" - written now; "current" - up-to-date copy already present;
   * "stale" - a different AIS_EXTENSION_VERSION was replaced. */
  outcome: "fresh" | "current" | "stale";
}

function installedVersion(text: string): string | undefined {
  return text.match(EXTENSION_VERSION_PATTERN)?.[1];
}

/**
 * Ensures the identity's Pi configDir carries the CURRENT AIS extension:
 * writes it when missing or version-stamped stale, leaves it untouched when
 * current. Never throws: a failed self-heal prints one stderr warning and
 * the launch proceeds without the extension (Pi runs fine without it).
 */
export async function installPiExtension(
  configDir: string,
  deps: { warn?: (message: string) => void } = {},
): Promise<PiExtensionInstallResult | undefined> {
  const warn = deps.warn ?? ((message: string) => console.error(message));
  const path = installedExtensionPath(configDir);
  try {
    const expected = embeddedExtensionVersion();
    let existing: string | undefined;
    try {
      existing = await Bun.file(path).text();
    } catch {
      existing = undefined;
    }
    const current = installedVersion(existing ?? "");
    if (existing !== undefined && current === expected) {
      return { path, outcome: "current" };
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o755 });
    await writeAtomic(path, EXTENSION_SOURCE);
    return { path, outcome: existing === undefined ? "fresh" : "stale" };
  } catch (error) {
    warn(
      `pi: could not install the AIS identity extension at ${path}: ` +
        `${error instanceof Error ? error.message : String(error)} (continuing without it)`,
    );
    return undefined;
  }
}

/** Temp file in the destination directory + rename, so a crash mid-write can
 * never leave a truncated extension that jiti would then fail to parse. */
async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.ais-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o644, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Resolves the configDir the extension install needs. Exported for the
 * entrypoint's thin wrapper. */
export function resolvePiExtensionTarget(configDir?: string): string {
  if (configDir !== undefined && configDir.length > 0) return configDir;
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".pi", "agent");
}
