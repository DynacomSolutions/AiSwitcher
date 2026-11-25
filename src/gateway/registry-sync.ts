import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
 * take the host value. Undefined when either text is not a registry object with an `identities` array.
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
  const identities: unknown[] = [];
  const seen = new Set<string>();
  for (const i of h.identities) {
    if (!isObject(i) || typeof i.name !== "string") {
      identities.push(i);
      continue;
    }
    seen.add(i.name);
    const other = theirs.get(i.name);
    const pool = i.swapPool;
    const otherPool = other?.swapPool;
    if (isObject(pool) && Array.isArray(pool.accounts) && isObject(otherPool) && Array.isArray(otherPool.accounts)) {
      const accounts = [...new Set([...(pool.accounts as unknown[]), ...(otherPool.accounts as unknown[])])];
      identities.push({ ...i, swapPool: { ...pool, accounts } });
    } else identities.push(i);
  }
  for (const i of s.identities) if (!(isObject(i) && typeof i.name === "string" && seen.has(i.name))) identities.push(i);
  return Buffer.from(`${JSON.stringify({ ...s, ...h, identities }, null, 2)}\n`);
}

/**
 * Names of the identities that `current` (the store registry) holds and `next` (a pushed registry) lacks. Empty when either text
 * is not a registry. Removal goes through `retire` (the entry stays, flagged), never through deletion of the entry, so a push
 * that drops a name is a mistake: a host file rewritten empty must not take the gateway's identities and their logins with it.
 */
export function droppedIdentities(next: string, current: string): string[] {
  let n: unknown;
  let c: unknown;
  try {
    n = JSON.parse(next);
    c = JSON.parse(current);
  } catch {
    return [];
  }
  if (!isObject(n) || !isObject(c) || !Array.isArray(n.identities) || !Array.isArray(c.identities)) return [];
  const names = (list: unknown[]): Set<string> => new Set(list.flatMap((i) => (isObject(i) && typeof i.name === "string" ? [i.name] : [])));
  const kept = names(n.identities);
  return [...names(c.identities)].filter((name) => !kept.has(name));
}
