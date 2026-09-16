import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { downloadAssetAtomic, platformKey } from "./release-assets.ts";

/**
 * Resolution + one-shot self-heal for the aistui binary (the Rust console
 * TUI under apps/tui: the tabbed dashboard, the --overview panel, and the
 * native `ais herdr` wrapper in `aistui herdr` mode). aistui IS shipped in
 * releases (aistui-<platform>, built by release.yml's build-tui job), so a
 * machine that never ran a local cargo build can still get it: when plain
 * resolution finds nothing, ensureAistuiBinary downloads the asset matching
 * the RUNNING ais's own version from the GitHub release, installs it
 * atomically to ~/.local/bin/aistui and hands back the path. Shared by
 * `ais tui` and `ais herdr`.
 */

/** Where the self-heal installs to (and the second resolution candidate). */
export function tuiDest(): string {
  return join(homedir(), ".local", "bin", "aistui");
}

/** Resolves the aistui binary: AIS_TUI_BIN, ~/.local/bin/aistui, then this
 * checkout's cargo target dir. */
export function resolveTuiBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [
    env.AIS_TUI_BIN,
    tuiDest(),
    // Dev checkout: <repo>/apps/tui/target/release/aistui derived from this
    // file's location (src/shared -> ../../apps/tui).
    join(import.meta.dir, "..", "..", "apps", "tui", "target", "release", "aistui"),
    join(import.meta.dir, "..", "..", "..", "apps", "tui", "target", "release", "aistui"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // keep probing
    }
  }
  return undefined;
}

/** The release asset convention: aistui-<platform>, exactly like every
 * other shipped binary (claude-darwin-arm64, ais-linux-x64, ...). */
export function aistuiAssetName(platformSuffix: string): string {
  return `aistui-${platformSuffix}`;
}

export interface EnsureAistuiDeps {
  /** Existing resolution (AIS_TUI_BIN > ~/.local/bin/aistui > dev
   * checkout); a hit short-circuits the download entirely. */
  resolveTuiBinary(): string | undefined;
  /** The RUNNING ais's own version (package.json, embedded in compiled
   * binaries); the release tag tried first is v<version>. */
  version(): string;
  /** Release platform suffix ("<os>-<cpu>"). */
  platformSuffix(): string;
  /** Atomic download + install of a release asset into the aistui
   * destination; tag undefined means the latest release. */
  downloadAndInstall(assetName: string, tag: string | undefined): Promise<void>;
  log(message: string): void;
}

export function realEnsureAistuiDeps(): EnsureAistuiDeps {
  return {
    resolveTuiBinary,
    version: () => pkg.version,
    platformSuffix: () => platformKey(),
    downloadAndInstall: (assetName, tag) => downloadAssetAtomic(assetName, tuiDest(), { tag, mode: 0o755 }),
    log: (message) => console.error(message),
  };
}

/**
 * Resolution first, download only if nothing resolves. The download is
 * attempted ONCE against the release matching the running ais (v<pkg.version>)
 * and, when that release predates aistui or is unreachable, ONCE more
 * against the latest release. Never a retry loop: a machine that cannot
 * reach the release fails honestly and the caller keeps its normal
 * not-found error. Throws with both reasons when both attempts fail.
 */
export async function ensureAistuiBinary(deps: EnsureAistuiDeps = realEnsureAistuiDeps()): Promise<string> {
  const found = deps.resolveTuiBinary();
  if (found) return found;

  const dest = tuiDest();
  const assetName = aistuiAssetName(deps.platformSuffix());
  const tag = `v${deps.version()}`;

  deps.log(`aistui: not found, downloading ${assetName} from the ${tag} release`);
  let pinnedError: string;
  try {
    await deps.downloadAndInstall(assetName, tag);
    return dest;
  } catch (err) {
    pinnedError = err instanceof Error ? err.message : String(err);
  }

  deps.log(`aistui: ${tag} has no usable ${assetName} (${pinnedError}); trying the latest release`);
  try {
    await deps.downloadAndInstall(assetName, undefined);
    return dest;
  } catch (err) {
    const latestError = err instanceof Error ? err.message : String(err);
    throw new Error(
      `aistui auto-install failed: ${tag} has no usable ${assetName} (${pinnedError}), and the latest-release fallback failed too (${latestError})`,
    );
  }
}
