import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { addedAtOf, mergeTombstones, parseTombstones, tombstoneCovers } from "../identities/tombstones.ts";
import { aisStateDir } from "../shared/ais-home.ts";

/**
 * Registry rows (`.claude/identities.json` and its siblings) on a host that mirrors the store with a file store.
 *
 * The host file is the truth for a change made on the host, and the store row is the truth for a change made in the store
 * (the web console adds identities there). To tell the two apart the host remembers, per registry path, the version and
 * content hash at which the host file and the store row were last in step. The record lives in the ais state directory, so a
 * daemon restart keeps it. Both the host mirror (home-mirror.ts) and the periodic import (home-import.ts) read it:
 * - host file equals the record: only the store moved, so the row is written to the host;
 * - row equals the record: only the host moved, so the host file is pushed (host deletions work);
 * - neither equals the record, or there is no record: both moved. The two are merged per identity name and the merge is
 *   pushed, so neither side loses a new identity.
 */

export interface RegistryBase {
  version: number;
  sha: string;
}

export const registryBasesPath = (home: string): string => join(aisStateDir(home), "gateway-registry-bases.json");

/** One writer at a time inside the process: the mirror pass and the import both update the file. */
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
};

async function readAll(home: string): Promise<Record<string, RegistryBase>> {
  try {
    const raw = JSON.parse(await readFile(registryBasesPath(home), "utf8")) as { bases?: Record<string, unknown> };
    const out: Record<string, RegistryBase> = {};
    for (const [path, b] of Object.entries(raw.bases ?? {})) {
      const rec = b as Partial<RegistryBase> | null;
      if (rec && typeof rec.sha === "string" && typeof rec.version === "number") out[path] = { sha: rec.sha, version: rec.version };
    }
    return out;
  } catch {
    // Missing or unreadable record: no base, so the first pass merges.
    return {};
  }
}

/** The recorded base of a registry path, or undefined. */
export const readRegistryBase = async (home: string, rel: string): Promise<RegistryBase | undefined> => (await readAll(home))[rel];

/** Records the version and hash at which the host file and the store row are in step. Throws on a write problem. */
export const writeRegistryBase = (home: string, rel: string, base: RegistryBase): Promise<void> =>
  serial(async () => {
    const all = await readAll(home);
    if (all[rel]?.sha === base.sha && all[rel]?.version === base.version) return;
    all[rel] = base;
    const file = registryBasesPath(home);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}-${Date.now().toString(36)}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ version: 1, bases: all }, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, file);
  });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Merges a host registry and a store registry per identity name. An identity on one side only is kept. An identity on both
 * sides takes the host entry, with the union of the two swapPool `accounts` lists (host order first). Other top-level keys
 * take the host value. Tombstones (`deleted`, identities/tombstones.ts) of both sides apply: an identity a tombstone covers is
 * dropped from the result, whichever side lists it, unless the entry was added after the delete. A tombstone stays only while the
 * store registry still lists its name. Undefined when either text is not a registry object with an `identities` array.
 */
export function mergeRegistries(host: string, store: string): Buffer | undefined {
  let h: unknown;
  let s: unknown;
  try {
    h = JSON.parse(host);
    s = JSON.parse(store);
  } catch {
    return undefined;
  }
  if (!isObject(h) || !isObject(s) || !Array.isArray(h.identities) || !Array.isArray(s.identities)) return undefined;
  const named = (list: unknown[]): Map<string, Record<string, unknown>> => {
    const m = new Map<string, Record<string, unknown>>();
    for (const i of list) if (isObject(i) && typeof i.name === "string") m.set(i.name, i);
    return m;
  };
  const theirs = named(s.identities);
  const tombs = new Map(mergeTombstones(parseTombstones(h.deleted), parseTombstones(s.deleted)).map((t) => [t.name, t]));
  const covered = (i: Record<string, unknown>): boolean => tombstoneCovers(tombs.get(i.name as string), i);
  const identities: unknown[] = [];
  const seen = new Set<string>();
  for (const i of h.identities) {
    if (!isObject(i) || typeof i.name !== "string") {
      identities.push(i);
      continue;
    }
    seen.add(i.name);
    const other = theirs.get(i.name);
    // The newer add wins when the two sides hold different creations of one name.
    const entry = other && (addedAtOf(other) ?? 0) > (addedAtOf(i) ?? 0) ? other : i;
    if (covered(entry)) continue;
    const pool = entry.swapPool;
    const otherPool = (entry === i ? other : i)?.swapPool;
    if (isObject(pool) && Array.isArray(pool.accounts) && isObject(otherPool) && Array.isArray(otherPool.accounts)) {
      const accounts = [...new Set([...(pool.accounts as unknown[]), ...(otherPool.accounts as unknown[])])];
      identities.push({ ...entry, swapPool: { ...pool, accounts } });
    } else identities.push(entry);
  }
  for (const i of s.identities) if (!(isObject(i) && typeof i.name === "string" && (seen.has(i.name) || covered(i)))) identities.push(i);
  const { deleted: _hd, ...hostRest } = h;
  const { deleted: _sd, ...storeRest } = s;
  const keep = [...tombs.values()].filter((t) => theirs.has(t.name));
  return Buffer.from(`${JSON.stringify({ ...storeRest, ...hostRest, identities, ...(keep.length > 0 ? { deleted: keep } : {}) }, null, 2)}\n`);
}

const namesOf = (list: unknown[]): Set<string> => new Set(list.flatMap((i) => (isObject(i) && typeof i.name === "string" ? [i.name] : [])));

/**
 * Names of the identities that `current` (the store registry) holds and `next` (a pushed registry) lacks. Removal goes through
 * `retire` (the entry stays, flagged) or a tombstone (`deleted`, written by `ais identities delete`) that covers the store's entry,
 * so a push that drops any other name is a mistake: a host file rewritten empty must not take the gateway's identities and their
 * logins with it. Text that is not a registry counts as dropping every name of a populated registry.
 */
export function droppedIdentities(next: string, current: string): string[] {
  let c: unknown;
  try {
    c = JSON.parse(current);
  } catch {
    return [];
  }
  if (!isObject(c) || !Array.isArray(c.identities)) return [];
  const held = c.identities.filter((i): i is Record<string, unknown> => isObject(i) && typeof i.name === "string");
  if (held.length === 0) return [];
  let n: unknown;
  try {
    n = JSON.parse(next);
  } catch {
    return held.map((i) => i.name as string);
  }
  if (!isObject(n) || !Array.isArray(n.identities)) return held.map((i) => i.name as string);
  const kept = namesOf(n.identities);
  const tombs = new Map(parseTombstones(n.deleted).map((t) => [t.name, t]));
  return held.filter((i) => !kept.has(i.name as string) && !tombstoneCovers(tombs.get(i.name as string), i)).map((i) => i.name as string);
}
