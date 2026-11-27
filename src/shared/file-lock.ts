import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

export async function trySharedFileLock(path: string): Promise<(() => Promise<void>) | undefined> {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(lockPath, "a", 0o600);
  try { chmodSync(lockPath, 0o600); } finally { closeSync(fd); }
  // Keep the lock file so that all processes use the same inode.
  // If the owner exits, the pipe closes and the helper releases the lock.
  const flock = Bun.which("flock", { PATH: process.env.PATH ?? "" });
  if (!flock) throw new Error("Shared file lock requires flock.");
  const child = Bun.spawn([flock, "-n", lockPath, "/bin/sh", "-c", "printf locked; cat >/dev/null"], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
  });
  try {
    const reader = child.stdout.getReader();
    const result = await Promise.race([reader.read(), child.exited.then(() => ({ done: true as const, value: undefined }))]);
    if (!result || result.done || new TextDecoder().decode(result.value) !== "locked") {
      child.stdin.end();
      await child.exited;
      return undefined;
    }
    return async () => {
      child.stdin.end();
      await child.exited;
    };
  } catch {
    child.stdin.end();
    await child.exited;
    return undefined;
  }
}
