import { homedir } from "node:os";
import { join } from "node:path";
import { chmod } from "node:fs/promises";
import { runBackup } from "../../scripts/backup.ts";
import { downloadAssetAtomic, platformKey } from "../installer.ts";
import { cyan, dim, green, yellow } from "./colors.ts";

// Everything `ais update` knows how to refresh — "open" is darwin-only (see
// AGENTS.md's "Chrome profile per identity" section), the rest ship
// everywhere. Only binaries already present in ~/.local/bin get updated;
// installing something new that wasn't there before is install.ts/
// installer.ts's job, not this one's.
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
];

export async function runUpdate(): Promise<void> {
  const prefix = dim("ais update:");
  const backupDir = await runBackup();
  console.log(`${prefix} backup complete: ${backupDir}`);

  const shimDir = join(homedir(), ".local", "bin");
  const platformSuffix = platformKey();

  let updated = 0;
  for (const name of MANAGED_BINARIES) {
    const dest = join(shimDir, name);
    if (!(await Bun.file(dest).exists())) {
      console.log(`${prefix} ${yellow(`${dest} not installed, skipping`)}`);
      continue;
    }
    const assetName = `${name}-${platformSuffix}`;
    console.log(`${prefix} downloading ${cyan(assetName)} -> ${dest}`);
    await downloadAssetAtomic(assetName, dest);
    await chmod(dest, 0o755);
    updated++;
  }

  console.log(
    updated > 0
      ? `${prefix} ${green(`done, updated ${updated} binar${updated === 1 ? "y" : "ies"}.`)}`
      : `${prefix} nothing installed in ~/.local/bin to update.`,
  );
}
