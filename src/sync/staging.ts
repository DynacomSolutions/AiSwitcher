import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { aisRemoteCacheDir } from "../shared/ais-home.ts";

const HOUR_MS = 3_600_000;
export const STAGING_MAX_AGE_MS = 6 * HOUR_MS;
export const CONFLICT_MAX_AGE_MS = 30 * 24 * HOUR_MS;

const PRUNED: Array<{ dir: string; maxAgeMs: number }> = [
  { dir: "profile-incoming", maxAgeMs: STAGING_MAX_AGE_MS },
  { dir: "sqlite-incoming", maxAgeMs: STAGING_MAX_AGE_MS },
  { dir: "sqlite-snapshots", maxAgeMs: STAGING_MAX_AGE_MS },
  { dir: "tail-incoming", maxAgeMs: STAGING_MAX_AGE_MS },
  { dir: "tail-outgoing", maxAgeMs: STAGING_MAX_AGE_MS },
  { dir: "merge-conflicts", maxAgeMs: CONFLICT_MAX_AGE_MS },
];

/** ctime, not mtime: rsync -a copies the sender's old dir mtime onto fresh roots.
 * Remove stale staging entries (and old merge-conflicts). dedupe-backups is
 * never touched. `keep` skips a snapshot id currently being merged. */
export async function pruneStaging(
  options: { home?: string; now?: number; keep?: string } = {},
): Promise<string[]> {
  const root = aisRemoteCacheDir(options.home ?? homedir());
  const now = options.now ?? Date.now();
  const removed: string[] = [];
  for (const { dir, maxAgeMs } of PRUNED) {
    let names: string[];
    try {
      names = await readdir(join(root, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === options.keep) continue;
      const path = join(root, dir, name);
      try {
        if (now - (await stat(path)).ctimeMs <= maxAgeMs) continue;
        await rm(path, { recursive: true, force: true });
        removed.push(`${dir}/${name}`);
      } catch {
        // Best effort: a concurrent run may own or already have removed it.
      }
    }
  }
  return removed;
}
