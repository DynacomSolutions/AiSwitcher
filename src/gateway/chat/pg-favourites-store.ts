import { SQL } from "bun";
import { CHAT_PROVIDERS, favId, MAX_FAVOURITES, type ChatProvider, type FavChange } from "../../browser/chat-protocol.ts";
import { effectiveAt, type FavouriteApplied, type FavouriteList, type FavouriteStore } from "./favourites-store.ts";

type Row = Record<string, unknown>;

export interface PgFavouriteStoreOptions { sql?: SQL }

/** Postgres store of the starred models. The table comes from migration 0013_favourites. */
export class PgFavouriteStore implements FavouriteStore {
  private readonly sql: SQL;
  private readonly ownsSql: boolean;

  constructor(url: string, opts: PgFavouriteStoreOptions = {}) {
    this.ownsSql = !opts.sql;
    this.sql = opts.sql ?? new SQL(url);
  }

  async close(): Promise<void> {
    if (this.ownsSql) await this.sql.close();
  }

  async apply(changes: FavChange[], origin: string, nowMs: number): Promise<FavouriteApplied> {
    // One lock serialises writers of all replicas, so the read of a row and its write never race.
    return this.sql.begin(async (t) => {
      await t`SELECT pg_advisory_xact_lock(hashtextextended('gateway_favourites', 0))`;
      let changed = false;
      for (const c of changes) {
        const id = favId(c);
        const at = effectiveAt(c.at, nowMs);
        const present = c.op === "add";
        const cur = (await t.unsafe("SELECT present, at_ms FROM gateway_favourites WHERE id = $1", [id]))[0] as Row | undefined;
        if (cur && at < Number(cur.at_ms)) continue;
        if (cur && cur.present === present) {
          await t.unsafe("UPDATE gateway_favourites SET at_ms = $2::bigint, origin = $3 WHERE id = $1", [id, at, origin]);
          continue;
        }
        if (present) {
          const n = Number((await t.unsafe("SELECT count(*)::int AS n FROM gateway_favourites WHERE present"))[0]?.n ?? 0);
          if (n >= MAX_FAVOURITES) continue;
        }
        await t.unsafe(
          `INSERT INTO gateway_favourites (id, provider, identity, model, present, at_ms, seq, origin)
           VALUES ($1, $2, $3, $4, $5::boolean, $6::bigint, nextval('gateway_favourites_seq'), $7)
           ON CONFLICT (id) DO UPDATE SET present = excluded.present, at_ms = excluded.at_ms, seq = excluded.seq, origin = excluded.origin`,
          [id, c.provider, c.identity, c.model, present, at, origin],
        );
        changed = true;
      }
      const seq = Number((await t.unsafe("SELECT coalesce(max(seq), 0)::bigint AS seq FROM gateway_favourites"))[0]?.seq ?? 0);
      return { seq, changed };
    });
  }

  async list(): Promise<FavouriteList> {
    // The version is read first. A change between the two reads makes the items newer than `seq`, so a caller that waits on `seq` wakes again and reads the same list.
    const seq = Number((await this.sql.unsafe("SELECT coalesce(max(seq), 0)::bigint AS seq FROM gateway_favourites"))[0]?.seq ?? 0);
    const rows = await this.sql.unsafe("SELECT provider, identity, model, at_ms FROM gateway_favourites WHERE present ORDER BY at_ms, seq");
    const items = rows
      .filter((r: Row) => (CHAT_PROVIDERS as readonly unknown[]).includes(r.provider))
      .map((r: Row) => ({ provider: r.provider as ChatProvider, identity: String(r.identity), model: String(r.model), at: Number(r.at_ms) }));
    return { seq, items };
  }
}
