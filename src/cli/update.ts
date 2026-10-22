import { homedir } from "node:os";
import { join } from "node:path";
import { chmod } from "node:fs/promises";
import { runBackup } from "../../scripts/backup.ts";
import { downloadAssetAtomic, platformKey } from "../shared/release-assets.ts";
import { cyan, dim, green, yellow } from "./colors.ts";

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
  backup?: () => Promise<string>;
  heartbeatMs?: number;
  shimDir?: string;
  /** Test seam for the release download. */
  fetchImpl?: typeof fetch;
}

async function installedVersion(binary: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([binary, "version"], { stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out.trim() || undefined : undefined;
  } catch { return undefined; }
}

export async function runUpdate(options: UpdateOptions = {}): Promise<void> {
  const prefix = dim("ais update:");
  if (options.skipBackup) {
    console.log(`${prefix} ${yellow("skipping backup (--no-backup)")}`);
  } else {
    // A snapshot of tens of GB of tool state can take minutes; never go silent while it runs.
    console.log(`${prefix} backing up tool config directories first (can take minutes on large profiles; --no-backup skips it)`);
    const started = Date.now();
    const timer = setInterval(
      () => console.log(`${prefix} still backing up (${Math.round((Date.now() - started) / 1000)}s)`),
      options.heartbeatMs ?? HEARTBEAT_MS,
    );
    try {
      console.log(`${prefix} backup complete: ${await (options.backup ?? runBackup)()}`);
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
  for (const name of MANAGED_BINARIES) {
    const dest = join(shimDir, name);
    if (!(await Bun.file(dest).exists())) {
      console.log(`${prefix} ${yellow(`${dest} not installed, skipping`)}`);
      continue;
    }
    const assetName = `${name}-${platformSuffix}`;
    console.log(`${prefix} downloading ${cyan(assetName)} -> ${dest}`);
    await downloadAssetAtomic(assetName, dest, { fetchImpl: options.fetchImpl });
    await chmod(dest, 0o755);
    updated++;
  }

  // The shim that was just written must run; a corrupt or wrong-platform download fails here, not at next use.
  if (updated > 0 && (await Bun.file(join(shimDir, "ais")).exists())) {
    const after = await installedVersion(join(shimDir, "ais"));
    if (!after) throw new Error(`the downloaded ${join(shimDir, "ais")} does not run ("ais version" failed); the previous version${before ? ` ${before}` : ""} was replaced, reinstall it`);
    console.log(`${prefix} ais ${before && before !== after ? `${before} -> ${after}` : `${after} (already the latest release)`}`);
  }

  console.log(
    updated > 0
      ? `${prefix} ${green(`done, updated ${updated} binar${updated === 1 ? "y" : "ies"}.`)}`
      : `${prefix} nothing installed in ~/.local/bin to update.`,
  );
}
