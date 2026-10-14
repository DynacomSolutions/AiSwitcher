import { randomBytes } from "node:crypto";
import { chmod, rename, writeFile } from "node:fs/promises";

/** Atomic 0600 write: temp file next to the target, then rename over it. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(temp, content, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}
