// T3 Code names a model favourite by provider instance id and model slug. AIS names it by provider, identity (or pool) and model.
// This file maps one to the other. It is pure: the pool name comes in through the context.
import { CHAT_PROVIDERS, favId, selectable, type ChatProvider, type FavKey } from "../../browser/chat-protocol.ts";

/** One entry of `favorites` in T3 Code's settings.json. */
export interface T3Fav { provider: string; model: string }

export interface MapContext {
  /** The name AIS gives the pool of a provider (the swap pool identity). */
  poolName(provider: ChatProvider): string;
  /** Resolves an alias to the canonical identity name. Absent: the name is used as it is. */
  canonical?(provider: ChatProvider, name: string): string;
  /** The provider instance ids that exist in settings.json. A reverse map picks one of these. */
  instances: ReadonlySet<string>;
}

/**
 * The T3 provider instance ids AIS makes (`ais gateway t3-instance` and the T3 setup), by provider:
 *
 * | instance id                                  | AIS provider | identity     |
 * | -------------------------------------------- | ------------ | ------------ |
 * | <claude\|codex>-pool                          | claude, codex | the pool     |
 * | t3-claude-<identity>                         | claude       | <identity>   |
 * | t3-codex-<identity>                          | codex        | <identity>   |
 * | t3-kimi-<identity>-acp, t3-kimi-pool-acp     | kimi         | <identity>, the pool |
 * | t3-grok-<identity>, t3-grok-<identity>-acp   | grok         | <identity>   |
 * | t3-grok-pool                                 | grok         | the pool     |
 * | t3-zai-<identity>-acp                        | zai          | <identity>   |
 * | t3-opencode-<identity>, t3-opencode-pool     | opencode     | <identity>, the pool |
 *
 * Everything else has no AIS identity and is never mapped: T3's own `claudeAgent` and `codex` instances, the Claude homes that
 * route to Kimi or Z.ai models (`t3-claude-kimi-*`, `t3-claude-zai-*`), and `t3-zcode-*`.
 */
/** The Claude and Codex pool instances are named `<provider>-pool`. */
const poolId = (p: "claude" | "codex"): string => `${p}-pool`;
const POOL_IDS: Record<string, ChatProvider> = { [poolId("claude")]: "claude", [poolId("codex")]: "codex" };

interface Parsed { provider: ChatProvider; name: string; pool: boolean }

function parseInstance(id: string): Parsed | undefined {
  const pool = POOL_IDS[id];
  if (pool) return { provider: pool, name: "", pool: true };
  if (/^t3-claude-(?:kimi|zai)(?:-|$)/.test(id)) return undefined;
  let m = /^t3-(claude|codex|opencode)-(.+)$/.exec(id);
  if (m) return m[2] === "pool" ? { provider: m[1] as ChatProvider, name: "", pool: true } : { provider: m[1] as ChatProvider, name: m[2]!, pool: false };
  m = /^t3-(kimi|zai)-(.+)-acp$/.exec(id);
  if (m) return m[2] === "pool" ? { provider: m[1] as ChatProvider, name: "", pool: true } : { provider: m[1] as ChatProvider, name: m[2]!, pool: false };
  m = /^t3-grok-(.+?)(-acp)?$/.exec(id);
  if (m) return m[1] === "pool" ? { provider: "grok", name: "", pool: true } : { provider: "grok", name: m[1]!, pool: false };
  return undefined;
}

/** The AIS provider and identity of a T3 instance id, or undefined when the instance is not one AIS manages. */
export function instanceToAis(id: string, ctx: Pick<MapContext, "poolName" | "canonical">): { provider: ChatProvider; identity: string } | undefined {
  const p = parseInstance(id);
  if (!p) return undefined;
  const identity = p.pool ? ctx.poolName(p.provider) : (ctx.canonical?.(p.provider, p.name) ?? p.name);
  return { provider: p.provider, identity };
}

/** The AIS key of a T3 favourite, or undefined when its instance is not mapped or its names are not valid. */
export function favToKey(f: T3Fav, ctx: Pick<MapContext, "poolName" | "canonical">): FavKey | undefined {
  const a = instanceToAis(f.provider, ctx);
  // The gateway takes only names that pass `selectable`. A favourite with another name (T3 allows `opus[1m]`) stays in T3 as an unmapped one.
  if (!a || !(CHAT_PROVIDERS as readonly string[]).includes(a.provider) || !selectable(a.identity) || !selectable(f.model)) return undefined;
  return { provider: a.provider, identity: a.identity, model: f.model };
}

/** The instance ids that can hold a favourite of this provider and identity, best first. */
export function instanceCandidates(provider: ChatProvider, identity: string, ctx: Pick<MapContext, "poolName">): string[] {
  const pool = identity === ctx.poolName(provider);
  switch (provider) {
    case "claude": return pool ? [poolId("claude")] : [`t3-claude-${identity}`];
    case "codex": return pool ? [poolId("codex")] : [`t3-codex-${identity}`];
    case "kimi": return [`t3-kimi-${pool ? "pool" : identity}-acp`];
    case "zai": return [`t3-zai-${pool ? "pool" : identity}-acp`];
    case "grok": return pool ? ["t3-grok-pool", "t3-grok-pool-acp"] : [`t3-grok-${identity}`, `t3-grok-${identity}-acp`];
    case "opencode": return [`t3-opencode-${pool ? "pool" : identity}`];
  }
}

/** The T3 favourite for an AIS key: the first candidate instance that exists. Undefined when this T3 home has no such instance. */
export function keyToFav(k: FavKey, ctx: MapContext): T3Fav | undefined {
  const id = instanceCandidates(k.provider, k.identity, ctx).find((c) => ctx.instances.has(c) && parseInstance(c) !== undefined);
  return id === undefined ? undefined : { provider: id, model: k.model };
}

/** The AIS keys of the mapped favourites, in T3's order, each once. */
export function mappedKeys(favs: readonly T3Fav[], ctx: Pick<MapContext, "poolName" | "canonical">): FavKey[] {
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
