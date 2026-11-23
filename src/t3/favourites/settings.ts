// Reads and writes the `favorites` key of T3 Code's settings.json. Nothing else in the file changes.
import { randomBytes } from "node:crypto";
import { chmod, chown, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { T3Fav } from "./mapping.ts";

export const settingsPathOf = (t3Home: string): string => join(t3Home, "userdata", "settings.json");

export interface T3Settings {
  path: string;
  /** The file as it was read. The write checks that it is still this text. */
  text: string;
  favorites: T3Fav[];
  /** The provider instance ids of settings.json. */
  instances: Set<string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The settings of one T3 home, or undefined when it has no settings file. Throws when the file or its `favorites` key has a shape this code does not know, so that nothing is written over it. */
export async function readT3Settings(t3Home: string): Promise<T3Settings | undefined> {
  const path = settingsPathOf(t3Home);
  let text: string;
  try {
    text = await readFile(path, "utf8");
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
  return { path, text, favorites, instances };
}

/** The same indent and final newline as the file had. */
function render(before: string, parsed: Record<string, unknown>): string {
  const indent: string | number = /^\{\r?\n([ \t]+)"/.exec(before)?.[1] ?? (before.includes("\n") ? 2 : 0);
  return `${JSON.stringify(parsed, null, indent)}${before.endsWith("\n") ? "\n" : ""}`;
}

/**
 * Replaces `favorites` and keeps every other key, the indent and the mode and owner of the file. The new file is written next to
 * the old one and renamed over it. When the file changed since `settings` was read (T3 Code wrote it too), nothing is replaced and
 * the result is "changed": the caller reads again.
 */
export async function writeT3Favourites(settings: T3Settings, favorites: readonly T3Fav[]): Promise<"written" | "unchanged" | "changed"> {
  const parsed = JSON.parse(settings.text) as Record<string, unknown>;
  parsed.favorites = favorites;
  const text = render(settings.text, parsed);
  if (text === settings.text) return "unchanged";
  const before = await stat(settings.path);
  const temp = join(dirname(settings.path), `.settings.json.ais-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(temp, text, { mode: before.mode & 0o777 });
    await chmod(temp, before.mode & 0o777);
    // Another owner (the file was made by another user): keep it. Only root can change the owner, and a same-user write needs nothing.
    if (process.getuid?.() !== before.uid || process.getgid?.() !== before.gid) await chown(temp, before.uid, before.gid).catch(() => undefined);
    if ((await readFile(settings.path, "utf8")) !== settings.text) return "changed";
    await rename(temp, settings.path);
    return "written";
  } finally {
    await rm(temp, { force: true });
  }
}
