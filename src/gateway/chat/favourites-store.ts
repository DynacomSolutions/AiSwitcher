// Starred models of the gateway owner. One list, last writer wins per model.
import { favId, MAX_FAVOURITES, type FavChange, type FavKey, type FavRefusal } from "../../browser/chat-protocol.ts";

export interface FavouriteItem extends FavKey { at: number }
/** `epoch` is a random id made once with the store. A store that was reset or rebuilt has another one, so a client can tell "the list is new" from "the list is the same but changed". */
export interface FavouriteList { epoch: string; seq: number; items: FavouriteItem[] }
/**
 * `refused` names the changes the store did not apply, each with its reason.
 * `stale`: the change lost to a newer one of the same model that asks for another state. It is dead: the newer change wins everywhere, so nobody may send it again.
 * `cap`: an add when the list is full. The caller may keep it and try again after a removal.
 */
export interface FavouriteApplied { seq: number; changed: boolean; refused: FavRefusal[] }

/** Stars of the owner. A change names its time; the newest change of a model decides whether it is starred. */
export interface FavouriteStore {
  /** Applies the changes in order. `changed` is true when at least one model flipped. `seq` is the list version after the call. */
  apply(changes: FavChange[], origin: string, nowMs: number): Promise<FavouriteApplied>;
  /** The starred models, oldest star first, and the list version. */
  list(): Promise<FavouriteList>;
}

/** A sender clock may run ahead or behind. A time up to a minute ahead is kept as it is (clock skew). A time more than a minute ahead of the gateway, or older than a week, reads as "now". */
const FUTURE_SLACK_MS = 60_000;
const PAST_LIMIT_MS = 7 * 24 * 3600_000;
export function effectiveAt(at: number | undefined, nowMs: number): number {
  return at !== undefined && at <= nowMs + FUTURE_SLACK_MS && at >= nowMs - PAST_LIMIT_MS ? at : nowMs;
}

interface Row extends FavKey { present: boolean; at: number; seq: number; origin: string }

/** In-memory store for tests and single-process use. It has the same rules as the Postgres store. */
export class MemoryFavouriteStore implements FavouriteStore {
  private readonly rows = new Map<string, Row>();
  private counter = 0;
  private readonly epoch = crypto.randomUUID();

  async apply(changes: FavChange[], origin: string, nowMs: number): Promise<FavouriteApplied> {
    let changed = false;
    const refused: FavRefusal[] = [];
    for (const c of changes) {
      const id = favId(c);
      const at = effectiveAt(c.at, nowMs);
      const present = c.op === "add";
      const cur = this.rows.get(id);
      const k: FavKey = { provider: c.provider, identity: c.identity, model: c.model };
      // A removal of a model with no row has nothing to remove: no row, no new version, no wake-up.
      if (!present && !cur) continue;
      if (cur && at < cur.at) {
        if (cur.present !== present) refused.push({ ...k, reason: "stale" });
        continue;
      }
      if (cur && cur.present === present) {
        cur.at = at;
        cur.origin = origin;
        continue;
      }
      if (present && [...this.rows.values()].filter((r) => r.present).length >= MAX_FAVOURITES) {
        refused.push({ ...k, reason: "cap" });
        continue;
      }
      this.counter += 1;
      this.rows.set(id, { provider: c.provider, identity: c.identity, model: c.model, present, at, seq: this.counter, origin });
      changed = true;
    }
    return { seq: this.counter, changed, refused };
  }

  async list(): Promise<FavouriteList> {
    const items = [...this.rows.values()].filter((r) => r.present).sort((a, b) => a.at - b.at || a.seq - b.seq).map((r) => ({ provider: r.provider, identity: r.identity, model: r.model, at: r.at }));
    return { epoch: this.epoch, seq: this.counter, items };
  }
}
