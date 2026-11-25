// T3 Code names a model favourite by provider instance id and model slug. AIS names it by provider, identity (or pool) and model.
// This file maps one to the other. It is pure and needs no configuration: a pool instance maps to the reserved identity POOL_IDENTITY.
import { instanceIdsFor, parseInstanceId } from "../instances/plan.ts";
import { CHAT_PROVIDERS, favId, POOL_IDENTITY, selectable, type ChatProvider, type FavKey } from "../../browser/chat-protocol.ts";

/** One entry of `favorites` in T3 Code's settings.json. */
export interface T3Fav { provider: string; model: string }

export interface MapContext {
  /** Resolves an alias to the canonical identity name. Absent: the name is used as it is. */
  canonical?(provider: ChatProvider, name: string): string;
  /** The provider instance ids that exist in settings.json. A reverse map picks one of these. */
  instances: ReadonlySet<string>;
}

/**
 * The T3 provider instance ids AIS makes follow one pattern, defined in `src/t3/instances/plan.ts` (no id is listed here):
 * `<claude|codex>-pool` and `t3-<claude|codex>-<identity>`, `t3-<opencode>-<pool|identity>`, `t3-grok-<pool|identity>` with the ACP
 * twin `-acp`, `t3-<kimi|zai>-<pool|identity>-acp`.
 *
 * A pool instance maps to the same AIS identity on every host and pod, `POOL_IDENTITY`, whatever the pool is called. No pool name is read.
 *
 * Everything else has no AIS identity and is never mapped: T3's own `claudeAgent` and `codex` instances, the Claude homes that
 * route to Kimi or Z.ai models (`t3-claude-kimi-*`, `t3-claude-zai-*`), `t3-zcode-*`, and every usage-only instance (an id that ends in `-usage`).
 */
interface Parsed { provider: ChatProvider; name: string; pool: boolean }

// The id pattern lives in src/t3/instances/plan.ts, the one place that also makes the instances from the live gateway app list.
function parseInstance(id: string): Parsed | undefined {
  const p = parseInstanceId(id);
  if (!p) return undefined;
  return { provider: p.provider as ChatProvider, name: p.who === "pool" ? "" : p.who, pool: p.who === "pool" };
}

/** The AIS provider and identity of a T3 instance id, or undefined when the instance is not one AIS manages. */
export function instanceToAis(id: string, ctx: Pick<MapContext, "canonical"> = {}): { provider: ChatProvider; identity: string } | undefined {
  const p = parseInstance(id);
  // An instance id has no `@` (`ais gateway t3-instance` refuses it), so an identity never equals the pool identity. A hand-made id that does is not mapped.
  if (!p || (!p.pool && p.name === POOL_IDENTITY)) return undefined;
  return { provider: p.provider, identity: p.pool ? POOL_IDENTITY : (ctx.canonical?.(p.provider, p.name) ?? p.name) };
}

/** The AIS key of a T3 favourite, or undefined when its instance is not mapped or its names are not valid. */
export function favToKey(f: T3Fav, ctx: Pick<MapContext, "canonical"> = {}): FavKey | undefined {
  const a = instanceToAis(f.provider, ctx);
  // The gateway takes only names that pass `selectable`. A favourite with another name (T3 allows `opus[1m]`) stays in T3 as an unmapped one.
  if (!a || !(CHAT_PROVIDERS as readonly string[]).includes(a.provider) || !selectable(a.identity) || !selectable(f.model)) return undefined;
  return { provider: a.provider, identity: a.identity, model: f.model };
}

/** The instance ids that can hold a favourite of this provider and identity, best first. */
export function instanceCandidates(provider: ChatProvider, identity: string): string[] {
  return instanceIdsFor(provider, identity === POOL_IDENTITY ? "pool" : identity);
}

/** The T3 favourite for an AIS key: the first candidate instance that exists. Undefined when this T3 home has no such instance. */
export function keyToFav(k: FavKey, ctx: MapContext): T3Fav | undefined {
  const id = instanceCandidates(k.provider, k.identity).find((c) => ctx.instances.has(c) && parseInstance(c) !== undefined);
  return id === undefined ? undefined : { provider: id, model: k.model };
}

/** The AIS keys of the mapped favourites, in T3's order, each once. */
export function mappedKeys(favs: readonly T3Fav[], ctx: Pick<MapContext, "canonical"> = {}): FavKey[] {
  const seen = new Set<string>();
  const out: FavKey[] = [];
  for (const f of favs) {
    const k = favToKey(f, ctx);
    if (!k || seen.has(favId(k))) continue;
    seen.add(favId(k));
    out.push(k);
  }
  return out;
}
