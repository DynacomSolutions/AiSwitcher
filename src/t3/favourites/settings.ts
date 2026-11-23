// Reads and writes the `favorites` key of T3 Code's settings.json. Nothing else in the file changes.
import { randomBytes } from "node:crypto";
import { chmod, chown, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { T3Fav } from "./mapping.ts";

export const settingsPathOf = (t3Home: string): string => join(t3Home, "userdata", "settings.json");

export interface T3Settings {
  path: string;
  /** The file that `path` leads to (`path` itself unless it is a symlink). The write goes there. */
  target: string;
  /** Size, inode and modification time of `target` at the read. The write checks them again just before the rename. */
  stamp: { size: bigint; ino: bigint; mtimeNs: bigint };
  /** The file as it was read. The write checks that it is still this text. */
  text: string;
  /** When the file was last written (epoch ms), from the same handle as `text`. A change found in this read is dated with it. */
  mtimeMs: number;
  favorites: T3Fav[];
  /** The provider instance ids of settings.json. */
  instances: Set<string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The settings of one T3 home, or undefined when it has no settings file. Throws when the file or its `favorites` key has a shape this code does not know, so that nothing is written over it. */
export async function readT3Settings(t3Home: string): Promise<T3Settings | undefined> {
  const path = settingsPathOf(t3Home);
  let text: string;
  let mtimeMs: number;
  let target: string;
  let stamp: T3Settings["stamp"];
  try {
    target = await realpath(path);
    const fh = await open(target, "r");
    try {
      mtimeMs = Math.floor((await fh.stat()).mtimeMs);
      const b = await fh.stat({ bigint: true });
      stamp = { size: b.size, ino: b.ino, mtimeNs: b.mtimeNs };
      text = await fh.readFile("utf8");
    } finally {
      await fh.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const parsed: unknown = JSON.parse(text);
  if (!isObj(parsed)) throw new Error(`${path} is not a JSON object`);
  const raw = parsed.favorites;
  if (raw !== undefined && !Array.isArray(raw)) throw new Error(`${path}: favorites is not a list`);
  const favorites: T3Fav[] = [];
  for (const f of raw ?? []) {
    if (!isObj(f) || typeof f.provider !== "string" || typeof f.model !== "string") throw new Error(`${path}: a favorites entry has an unknown shape`);
    favorites.push(f as unknown as T3Fav);
  }
  const instances = new Set(isObj(parsed.providerInstances) ? Object.keys(parsed.providerInstances) : []);
  return { path, target, stamp, text, mtimeMs, favorites, instances };
}

/**
 * The same indent and final newline as the file had.
 *
 * The file goes through `JSON.parse` and `JSON.stringify`. That normalises CRLF line ends, escapes (`\u00e9` becomes `é`), the key order
 * of integer-like keys (they move first) and number forms, and the temp-file rename replaces a hard link. T3 Code writes settings.json
 * with `JSON.stringify` itself, so its files carry none of these in practice. This code does not try to keep them.
 * A symlink is the exception: the write goes to the file the link leads to, and the link stays.
 */
function render(before: string, parsed: Record<string, unknown>): string {
  const indent: string | number = /^\{\r?\n([ \t]+)"/.exec(before)?.[1] ?? (before.includes("\n") ? 2 : 0);
  return `${JSON.stringify(parsed, null, indent)}${before.endsWith("\n") ? "\n" : ""}`;
}

/**
 * Replaces `favorites` and keeps every other key, the indent and the mode and owner of the file. The new file is written next to
 * the old one (next to the target, when `path` is a symlink) and renamed over it. When the file changed since `settings` was read
 * (T3 Code wrote it too), nothing is replaced and the result is "changed": the caller reads again.
 *
 * The check is the text, then the size, inode and modification time, both just before the rename. A write by T3 Code in the few
 * microseconds between the last check and the rename is still lost: a rename cannot be made conditional on the old file. T3 Code
 * writes a few times a day and reads the file back on its own watch, and the round that follows a lost write sends the star again.
 */
export async function writeT3Favourites(settings: T3Settings, favorites: readonly T3Fav[]): Promise<"written" | "unchanged" | "changed"> {
  const parsed = JSON.parse(settings.text) as Record<string, unknown>;
  parsed.favorites = favorites;
  const text = render(settings.text, parsed);
  if (text === settings.text) return "unchanged";
  const target = settings.target;
  const before = await stat(target);
  const temp = join(dirname(target), `.settings.json.ais-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(temp, text, { mode: before.mode & 0o777 });
    await chmod(temp, before.mode & 0o777);
    // Another owner (the file was made by another user): keep it. Only root can change the owner, and a same-user write needs nothing.
    if (process.getuid?.() !== before.uid || process.getgid?.() !== before.gid) await chown(temp, before.uid, before.gid).catch(() => undefined);
    if ((await readFile(target, "utf8")) !== settings.text) return "changed";
    const now = await stat(target, { bigint: true });
    if (now.size !== settings.stamp.size || now.ino !== settings.stamp.ino || now.mtimeNs !== settings.stamp.mtimeNs) return "changed";
    await rename(temp, target);
    return "written";
  } finally {
    await rm(temp, { force: true });
  }
}
