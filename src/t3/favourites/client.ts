// The gateway side of the favourites sync: GET and POST /favourites on the admin API, with the admin bearer token.
import { favRefusal, parseChatToExt, type FavChange, type FavKey, type FavRefusal } from "../../browser/chat-protocol.ts";
import { StoreApi } from "../../gateway/home-store-http.ts";

/** `epoch` names the gateway store. It is absent on a gateway from before the epoch. */
export interface FavList {
  seq: number;
  epoch?: string;
  items: FavKey[];
  changed?: boolean;
  /** Set by a POST: the changes the gateway did not apply, each with its reason (`cap`: the list was full, `stale`: a newer change of the same model won). */
  refused?: FavRefusal[];
}

export interface FavouritesApi {
  /** The list. With `since` the gateway waits up to `waitMs` for a list version other than `since`. */
  get(since?: number, waitMs?: number, signal?: AbortSignal): Promise<FavList>;
  post(origin: string, changes: FavChange[]): Promise<FavList>;
}

const REQUEST_MS = 15_000;

/** The entries of `refused`. A bad entry is skipped: it must not hide the others. */
function parseRefused(v: unknown): FavRefusal[] {
  if (!Array.isArray(v)) return [];
  return v.map(favRefusal).filter((r): r is FavRefusal => r !== undefined);
}

function parse(status: number, json: Record<string, unknown>, what: string): FavList {
  if (status !== 200) throw new Error(`gateway favourites ${what} answered ${status}`);
  const v = parseChatToExt({ t: "chat.fav.list", seq: json.seq, epoch: json.epoch, items: json.items });
  if (!v || v.t !== "chat.fav.list") throw new Error(`gateway favourites ${what} answered with a list that is not valid`);
  return { seq: v.seq, ...(v.epoch !== undefined ? { epoch: v.epoch } : {}), items: v.items, ...(typeof json.changed === "boolean" ? { changed: json.changed } : {}), ...(json.refused !== undefined ? { refused: parseRefused(json.refused) } : {}) };
}

export function createFavouritesClient(opts: { url: string; token: string; fetch?: typeof fetch }): FavouritesApi {
  const api = new StoreApi({ url: opts.url, token: opts.token, ...(opts.fetch ? { fetch: opts.fetch } : {}), timeoutMs: REQUEST_MS });
  return {
    async get(since, waitMs = 0, signal) {
      const q = since === undefined ? "" : `?since=${since}&ms=${waitMs}`;
      const r = await api.call("GET", `/favourites${q}`, undefined, signal, REQUEST_MS + waitMs);
      return parse(r.status, r.json, "GET");
    },
    async post(origin, changes) {
      const r = await api.call("POST", "/favourites", { origin, changes });
      return parse(r.status, r.json, "POST");
    },
  };
}
