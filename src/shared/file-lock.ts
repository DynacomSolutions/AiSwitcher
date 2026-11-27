import { closeSync, fchmodSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

export async function trySharedFileLock(path: string): Promise<(() => Promise<void>) | undefined> {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const flock = Bun.which("flock", { PATH: process.env.PATH ?? "" });
  if (!flock) throw new Error("Shared file lock requires flock.");

  // Keep the lock file so that all processes use the same inode.
  const fd = openSync(lockPath, "a", 0o600);
  let held = false;
  try {
    fchmodSync(fd, 0o600);
    // The child locks the shared open file description and exits.
    // The parent keeps the lock until it closes the descriptor or exits.
    const result = Bun.spawnSync([flock, "-n", "0"], {
      stdin: fd,
      stdout: "ignore",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return undefined;
    held = true;
    return async () => {
      if (!held) return;
      held = false;
      closeSync(fd);
    };
  } finally {
    if (!held) closeSync(fd);
  }
}
