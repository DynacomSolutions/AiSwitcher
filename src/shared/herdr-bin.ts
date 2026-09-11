import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolution of the third-party herdr binary for every AIS caller (the
 * metadata bridge, `ais herdr`'s wrapper, `ais upgrade`'s herdr row).
 *
 * herdr is NEVER bundled, vendored, or installed by ais: updates must stay
 * independent, so this only ever LOCATES a herdr the user already has.
 * `AIS_HERDR_BIN` is an explicit power-user override for non-standard
 * installs; when set it must point at a real file or the result is
 * "not installed" (a silent PATH fallback behind an explicit override would
 * hide the misconfiguration from whoever set it).
 */
export function resolveHerdrBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.AIS_HERDR_BIN?.trim();
  if (override) {
    try {
      return statSync(override).isFile() ? override : undefined;
    } catch {
      return undefined;
    }
  }
  const which = Bun.which("herdr");
  if (which) return which;
  const fallback = join(homedir(), ".local", "bin", "herdr");
  try {
    if (statSync(fallback).isFile()) return fallback;
  } catch {
    // not installed
  }
  return undefined;
}
