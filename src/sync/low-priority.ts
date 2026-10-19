import { setPriority } from "node:os";

/** Best effort: run this worker, and so the rsync/ssh children it spawns, at
 * the lowest CPU and (Linux) idle I/O priority. */
export function lowerProcessPriority(): void {
  try {
    setPriority(19);
  } catch {
    // Not permitted or unsupported: carry on at normal priority.
  }
  if (process.platform !== "linux") return;
  const ionice = Bun.which("ionice");
  if (!ionice) return;
  try {
    Bun.spawnSync([ionice, "-c3", "-p", String(process.pid)], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // Best effort.
  }
}
