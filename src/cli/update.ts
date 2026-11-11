import { homedir } from "node:os";
import { join } from "node:path";
import { open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { defaultExtensionDir, installHost } from "./browser/extension.ts";
import { runBackup } from "../../scripts/backup.ts";
import { createProgressTracker, type BackupProgress } from "../shared/backup-progress.ts";
import { downloadAssetAtomic, platformKey } from "../shared/release-assets.ts";
import { cyan, dim, green, yellow } from "./colors.ts";
import { describeProfileSyncServiceResult, installProfileSyncService, type ProfileSyncServiceResult } from "../sync/profile-sync-service.ts";

// Everything `ais update` knows how to refresh - "open" is darwin-only (see
// AGENTS.md's "Chrome profile per identity" section), the rest ship
// everywhere. Only binaries already present in ~/.local/bin get updated;
// installing something new that wasn't there before is install.ts/
// installer.ts's job, not this one's. aistui rides the same rule: the
// self-heal in shared/aistui-bin.ts owns the FIRST install, `ais update`
// only refreshes a copy that is already there.
const MANAGED_BINARIES = [
  "claude",
  "codex",
  "grok",
  "kimi",
  "zai",
  "ali",
  "pi",
  "opencode",
  ...(process.platform === "darwin" ? ["open"] : []),
  "ais",
  "aistui",
];

const HEARTBEAT_MS = 15_000;

export interface UpdateOptions {
  /** `--no-backup`: skip the safety-net snapshot of every tool config directory. */
  skipBackup?: boolean;
  backup?: (onProgress: (p: BackupProgress) => void) => Promise<string>;
  heartbeatMs?: number;
  shimDir?: string;
  /** Test seam for the release download. */
  fetchImpl?: typeof fetch;
  /** Test seam for the profile-sync user service step (Linux only). */
  installProfileSyncService?: (restartIfActive: boolean) => Promise<ProfileSyncServiceResult>;
  /** Test seam: registers the AIS Browser self-update helper; resolves with the Chrome manifests written. */
  installBrowserHost?: () => Promise<string[]>;
}

async function installedVersion(binary: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([binary, "version"], { stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out.trim() || undefined : undefined;
  } catch { return undefined; }
}

/** `ais` must run and print a version. The proxy shims would launch the real tool, so they only get a header check. */
async function verifyDownload(name: string, tmp: string): Promise<void> {
  if (name === "ais") {
    if (!(await installedVersion(tmp))) throw new Error(`the downloaded ais does not run ("ais version" failed); the installed ${name} was left unchanged`);
    return;
  }
  const handle = await open(tmp, "r");
  try {
    const head = Buffer.alloc(4);
    await handle.read(head, 0, 4, 0);
    const hex = head.toString("hex");
    if (!(hex === "7f454c46" || hex.startsWith("2321") || ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(hex))) {
      throw new Error(`the downloaded ${name} is not an executable; the installed ${name} was left unchanged`);
    }
  } finally { await handle.close(); }
}

async function fileHash(path: string): Promise<string | undefined> {
  try {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(await Bun.file(path).arrayBuffer());
    return hasher.digest("hex");
  } catch {
    return undefined;
  }
}

export async function runUpdate(options: UpdateOptions = {}): Promise<void> {
  const prefix = dim("ais update:");
  if (options.skipBackup) {
    console.log(`${prefix} ${yellow("skipping backup (--no-backup)")}`);
  } else {
    // A snapshot of tens of GB of tool state can take minutes; never go silent while it runs.
    console.log(`${prefix} backing up tool config directories first (can take minutes on large profiles; --no-backup skips it)`);
    const tracker = createProgressTracker();
    const timer = setInterval(
      () => console.log(`${prefix} ${tracker.line()}`),
      options.heartbeatMs ?? HEARTBEAT_MS,
    );
    try {
      console.log(`${prefix} backup complete: ${await (options.backup ?? ((onProgress) => runBackup(undefined, undefined, undefined, onProgress, { exitOnSignal: true })))(tracker.report)}`);
    } catch (error) {
      // Nothing was downloaded yet: say so, so a failed backup is never mistaken for an update.
      throw new Error(`backup failed, so NOTHING was updated: ${error instanceof Error ? error.message : String(error)}. Fix that, or run "ais update --no-backup" to update without a snapshot.`);
    } finally {
      clearInterval(timer);
    }
  }

  const shimDir = options.shimDir ?? join(homedir(), ".local", "bin");
  const platformSuffix = platformKey();

  const before = await installedVersion(join(shimDir, "ais"));
  let updated = 0;
  const aisHashBefore = await fileHash(join(shimDir, "ais"));
  for (const name of MANAGED_BINARIES) {
    const dest = join(shimDir, name);
    if (!(await Bun.file(dest).exists())) {
      console.log(`${prefix} ${yellow(`${dest} not installed, skipping`)}`);
      continue;
    }
    const assetName = `${name}-${platformSuffix}`;
    console.log(`${prefix} downloading ${cyan(assetName)} -> ${dest}`);
    // Verified before it replaces the installed file, so a bad download leaves the working binary in place.
    await downloadAssetAtomic(assetName, dest, { fetchImpl: options.fetchImpl, mode: 0o755, verify: (tmp) => verifyDownload(name, tmp) });
    updated++;
  }

  if (updated > 0 && (await Bun.file(join(shimDir, "ais")).exists())) {
    const after = await installedVersion(join(shimDir, "ais"));
    console.log(`${prefix} ais ${before && after && before !== after ? `${before} -> ${after}` : `${after ?? "?"} (already the latest release)`}`);
  }

  // A same-version download still replaces the file; restart the daemon only
  // when the installed ais bytes really changed.
  const aisUpdated = aisHashBefore !== (await fileHash(join(shimDir, "ais")));

  // The unit runs %h/.local/bin/ais, so only the default shim dir with an
  // installed ais gets it. Never fails the update: problems are warnings.
  const defaultShimDir = shimDir === join(homedir(), ".local", "bin");
  if (options.installProfileSyncService || (defaultShimDir && (await Bun.file(join(shimDir, "ais")).exists()))) {
    let result: ProfileSyncServiceResult;
    try {
      result = await (options.installProfileSyncService ?? ((restart) => installProfileSyncService({ restartIfActive: restart })))(
        aisUpdated,
      );
    } catch (error) {
      result = { status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
    const described = describeProfileSyncServiceResult(result);
    if (described) console.log(`${prefix} ${described.warn ? yellow(`warning: ${described.line}`) : described.line}`);
  }

  // The extension updates itself (side panel or automatically) through this helper; ais update never touches its files.
  if (options.installBrowserHost || (defaultShimDir && existsSync(defaultExtensionDir()))) {
    try {
      const written = await (options.installBrowserHost ?? (() => runInstallHost()))();
      if (written.length > 0) console.log(`${prefix} AIS Browser self-update registered with Chrome`);
    } catch (error) {
      console.log(`${prefix} ${yellow(`warning: AIS Browser self-update not registered: ${error instanceof Error ? error.message : String(error)}`)}`);
    }
  }

  console.log(
    updated > 0
      ? `${prefix} ${green(`done, updated ${updated} binar${updated === 1 ? "y" : "ies"}.`)}`
      : `${prefix} nothing installed in ~/.local/bin to update.`,
  );
}

function runInstallHost(): Promise<string[]> {
  return installHost({ extensionDir: defaultExtensionDir(), home: homedir(), platform: process.platform, out: () => {} });
}
