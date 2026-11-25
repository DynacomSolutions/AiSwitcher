/**
 * Registry tombstones: `deleted: [{name, at}]` records that an identity was removed on purpose (`ais identities delete`, the console),
 * so the gateway store registry drops it instead of merging it back. An identity carries `addedAt` (ms) from the day it was created:
 * an add newer than the tombstone beats the delete, and creating an identity clears its name's tombstone. The old form
 * `deleted: [names]` still reads, as tombstones at time 0.
 */
export interface Tombstone {
  name: string;
  at: number;
}

/** Tombstones of a parsed registry value (`deleted`), the old name-only form included. Invalid entries are ignored. */
export function parseTombstones(raw: unknown): Tombstone[] {
  if (!Array.isArray(raw)) return [];
  const out: Tombstone[] = [];
  for (const t of raw) {
    if (typeof t === "string" && t) out.push({ name: t, at: 0 });
    else if (typeof t === "object" && t !== null && typeof (t as Tombstone).name === "string" && (t as Tombstone).name) {
      const at = (t as Tombstone).at;
      out.push({ name: (t as Tombstone).name, at: typeof at === "number" && Number.isFinite(at) ? at : 0 });
    }
  }
  return out;
}

/** One tombstone per name, the latest time. */
export function mergeTombstones(...lists: Tombstone[][]): Tombstone[] {
  const best = new Map<string, number>();
  for (const l of lists) for (const t of l) best.set(t.name, Math.max(best.get(t.name) ?? 0, t.at));
  return [...best].map(([name, at]) => ({ name, at }));
}

/** When the identity was created (ms), or undefined for an entry that predates the field. */
export const addedAtOf = (identity: unknown): number | undefined => {
  const at = typeof identity === "object" && identity !== null ? (identity as { addedAt?: unknown }).addedAt : undefined;
  return typeof at === "number" && Number.isFinite(at) ? at : undefined;
};

/** True when the tombstone removes this identity: the entry has no add time, or was added no later than the delete. */
export const tombstoneCovers = (tombstone: Tombstone | undefined, identity: unknown): boolean => {
  if (!tombstone) return false;
  const added = addedAtOf(identity);
  return added === undefined || added <= tombstone.at;
};

/** Stamps a new identity with its add time and clears its name's tombstone: a name created again is no longer deleted. */
export function markAdded(file: { deleted?: Array<{ name: string; at: number }> }, identity: { name: string; addedAt?: number }): void {
  identity.addedAt = Date.now();
  if (file.deleted) file.deleted = file.deleted.filter((t) => t.name !== identity.name);
}
