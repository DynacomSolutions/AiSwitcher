// The merge rules of the favourites sync. Pure: the inputs are lists, the outputs are lists.
import { favId, MAX_FAVOURITES, type FavChange, type FavKey } from "../../browser/chat-protocol.ts";
import { favToKey, keyToFav, mappedKeys, type MapContext, type T3Fav } from "./mapping.ts";

/**
 * What this host sends up. T3 is compared with the keys of the last sync:
 * - a key in T3 that was not in the last sync and is not at the gateway is a new star: add;
 * - a key that was in the last sync and is no longer in T3 was removed in T3: remove (only when the gateway still has it).
 * The first run has no last sync: T3 stars the gateway lacks go up, and nothing is removed.
 * `at` is the time of the change, for the gateway's newest-wins rule. T3 does not date its stars: the caller passes the time the settings
 * file was written, which is the latest time a change in it can have been made.
 */
export function localChanges(t3: readonly T3Fav[], ctx: Pick<MapContext, "canonical">, lastSynced: readonly FavKey[] | undefined, gateway: readonly FavKey[], at?: number): FavChange[] {
  const local = mappedKeys(t3, ctx);
  const localIds = new Set(local.map(favId));
  const gatewayIds = new Set(gateway.map(favId));
  const lastIds = new Set((lastSynced ?? []).map(favId));
  const changes: FavChange[] = [];
  for (const k of local) if (!lastIds.has(favId(k)) && !gatewayIds.has(favId(k))) changes.push({ ...k, op: "add", ...(at !== undefined ? { at } : {}) });
  for (const k of lastSynced ?? []) if (!localIds.has(favId(k)) && gatewayIds.has(favId(k))) changes.push({ ...k, op: "remove", ...(at !== undefined ? { at } : {}) });
  return changes.slice(0, MAX_FAVOURITES);
}

export interface Applied {
  /** `favorites` for settings.json. The same array content as the input when nothing changes. */
  next: T3Fav[];
  /** The mapped keys of `next`: the state to remember for the next run. */
  synced: FavKey[];
}

/**
 * Makes the mapped favourites of T3 equal to the gateway list.
 * - A favourite whose instance is not mapped stays where it is, untouched.
 * - A mapped favourite that the gateway does not list is dropped, unless its id is in `keep`. T3's order of the others is kept.
 *   `keep` holds the stars this host just sent that the gateway refused because its list is full: the next round sends them again,
 *   so they are not dropped and not recorded in `synced`.
 * - A gateway star that T3 does not hold is added at the end, in the instance of this home that fits it. A star with no fitting instance is left out.
 */
export function applyGateway(t3: readonly T3Fav[], ctx: MapContext, gateway: readonly FavKey[], keep: ReadonlySet<string> = new Set()): Applied {
  const want = new Set(gateway.map(favId));
  const held = new Set<string>();
  const next: T3Fav[] = [];
  for (const f of t3) {
    const k = favToKey(f, ctx);
    if (!k) {
      next.push(f);
      continue;
    }
    const id = favId(k);
    if (!want.has(id) && !keep.has(id)) continue;
    // Two instances of one identity (a grok instance and its ACP twin) may both hold the model: both stay.
    held.add(id);
    next.push(f);
  }
  for (const k of gateway) {
    if (held.has(favId(k))) continue;
    const f = keyToFav(k, ctx);
    if (!f) continue;
    held.add(favId(k));
    next.push(f);
  }
  return { next, synced: mappedKeys(next, ctx).filter((k) => !keep.has(favId(k)) || want.has(favId(k))) };
}

/** True when two favourite lists are the same, in the same order. */
export function sameFavs(a: readonly T3Fav[], b: readonly T3Fav[]): boolean {
  return a.length === b.length && a.every((f, i) => f.provider === b[i]!.provider && f.model === b[i]!.model);
}
