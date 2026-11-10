import { randomBytes } from "node:crypto";
import { chmod, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Atomic 0600 write: temp file next to the target, then rename over it. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(temp, content, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

/** Flushes a folder's entries (a rename or a new file in it) to disk. Best effort where folders cannot be opened. */
export async function fsyncDir(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, "r");
  } catch {
    return;
  }
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
}

/** Writes and flushes a 0600 file. `exclusive` fails with EEXIST instead of replacing an existing file. */
async function writeSynced(path: string, content: string, exclusive: boolean): Promise<void> {
  const handle = await open(path, exclusive ? "wx" : "w", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verify(path: string, content: string): Promise<void> {
  if ((await readFile(path, "utf8")) !== content) throw Object.assign(new Error(`${path}: read back differs from what was written`), { code: "EVERIFY" });
}

/**
 * Durable atomic 0600 write for a file that must survive a crash: temp file flushed to disk, renamed over the target,
 * the folder flushed, then the target read back and compared. Throws (code EVERIFY) when the read-back differs.
 */
export async function writeFileDurable(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeSynced(temp, content, false);
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
  await fsyncDir(dirname(path));
  await verify(path, content);
}

/** Durable exclusive create (fails with EEXIST when the file exists): written, flushed, folder flushed, read back. */
export async function createFileDurable(path: string, content: string): Promise<void> {
  await writeSynced(path, content, true);
  await fsyncDir(dirname(path));
  await verify(path, content);
}
