import type { Hono } from "hono";
import { CHAT_PROVIDERS, MAX_FAVOURITES, selectable, type FavChange } from "../browser/chat-protocol.ts";
import { FavouritesBusyError, type FavouritesService } from "./chat/favourites.ts";
import type { GatewayMetrics } from "./metrics.ts";

/**
 * Admin routes of the starred models: a host daemon follows the list and sends the stars that a person made in T3 Code.
 * They sit behind the admin bearer token (admin.ts), like the credential store routes, and answer 404 until the chat stack
 * (which holds the store and the bus) is up.
 *
 * - GET  /favourites?since=N&ms=M   The list: `{seq, epoch, changed, items: [{provider, identity, model}]}`. Without `since` it answers at once.
 *                                   With `since` it answers at once when the list version differs, else when the list changes or after M ms (at most 25 s).
 * - GET answers 429 (with `Retry-After`) when this gateway already holds its most long polls (32), counted as `rate_limited`.
 * - POST /favourites                `{origin, changes: [{provider, identity, model, op: "add" | "remove", at?}]}` applies the changes
 *                                   (the newest change of a model wins) and answers with the list and the changes the store refused (`{seq, epoch, items, refused: [{provider, identity, model}]}`:
 *                                   a change that lost to a newer change of the same model, or an add when the list is full).
 */

/** Longest a long poll waits. It is under the idle limit of the clients and proxies in front of the gateway. */
export const FAVOURITES_WAIT_MAX_MS = 25_000;
const ORIGIN = /^[A-Za-z0-9._:@+-]{1,64}$/;

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The valid changes of a body, or a message that names the problem. */
export function parseFavouriteChanges(raw: unknown): FavChange[] | string {
  if (!Array.isArray(raw) || raw.length > MAX_FAVOURITES) return `changes must be a list of at most ${MAX_FAVOURITES}`;
  const out: FavChange[] = [];
  for (const c of raw) {
    if (!isRec(c) || !(CHAT_PROVIDERS as readonly unknown[]).includes(c.provider) || typeof c.identity !== "string" || typeof c.model !== "string" || !selectable(c.identity) || !selectable(c.model)) return "each change needs a provider, an identity and a model";
    if (c.op !== "add" && c.op !== "remove") return "op must be add or remove";
    if (c.at !== undefined && !(typeof c.at === "number" && Number.isSafeInteger(c.at) && c.at >= 0)) return "at must be a time in milliseconds";
    out.push({ provider: c.provider as FavChange["provider"], identity: c.identity, model: c.model, op: c.op, ...(c.at !== undefined ? { at: c.at as number } : {}) });
  }
  return out;
}

export function registerFavouritesAdmin(
  hono: Hono,
  getService: (() => FavouritesService | undefined) | undefined,
  err: (status: 400 | 404 | 429 | 503, message: string) => Response,
  metrics?: Pick<GatewayMetrics, "favourite">,
): void {
  const service = (): FavouritesService | undefined => getService?.();
  const body = (l: { seq: number; epoch?: string; items: Array<{ provider: string; identity: string; model: string }> }, changed?: boolean) => ({
    seq: l.seq,
    ...(l.epoch ? { epoch: l.epoch } : {}),
    ...(changed !== undefined ? { changed } : {}),
    items: l.items.map(({ provider, identity, model }) => ({ provider, identity, model })),
  });

  hono.get("/favourites", async (c) => {
    const svc = service();
    if (!svc) return err(404, "favourites are not available");
    const sinceRaw = c.req.query("since");
    const since = sinceRaw === undefined ? undefined : Number(sinceRaw);
    const ms = Math.min(Number(c.req.query("ms") ?? "0"), FAVOURITES_WAIT_MAX_MS);
    if ((since !== undefined && !(Number.isInteger(since) && since >= 0)) || !Number.isFinite(ms) || ms < 0) return err(400, "since and ms must be non-negative numbers");
    metrics?.favourite?.("http_get");
    try {
      const r = await svc.wait(since, ms, c.req.raw.signal);
      return c.json(body(r, r.changed));
    } catch (e) {
      if (e instanceof FavouritesBusyError) return err(429, "too many waiting favourites requests: ask again in a few seconds");
      metrics?.favourite?.("error");
      return err(503, "the favourites store is unavailable");
    }
  });

  hono.post("/favourites", async (c) => {
    const svc = service();
    if (!svc) return err(404, "favourites are not available");
    const raw = (await c.req.json().catch(() => undefined)) as unknown;
    if (!isRec(raw)) return err(400, "body must be a JSON object");
    const origin = raw.origin === undefined ? "daemon" : raw.origin;
    if (typeof origin !== "string" || !ORIGIN.test(origin)) return err(400, "origin must be a short label");
    const changes = parseFavouriteChanges(raw.changes);
    if (typeof changes === "string") return err(400, changes);
    metrics?.favourite?.("http_post");
    try {
      const r = await svc.apply(changes, origin);
      return c.json({ ...body(r), refused: r.refused.map(({ provider, identity, model }) => ({ provider, identity, model })) });
    } catch {
      metrics?.favourite?.("error");
      return err(503, "the favourites store is unavailable");
    }
  });
}
