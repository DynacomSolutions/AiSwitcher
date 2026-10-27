import type { Identity, IdentitiesFile } from "../types.ts";
import { isRetired } from "../retired.ts";
import { findIdentityByNameOrAlias } from "../store.ts";
import { expandPath } from "../match.ts";
import { resolve } from "node:path";

/**
 * Pure helpers for swap pools (Identity.swapPool). A pool is an ordinary
 * identity of the pool's tool with its own configDir; only identities that
 * carry `swapPool` ever take part in a credential swap. Members are other
 * identities of the same tool whose configDir holds the per-account vault
 * (claude: .credentials.json plus .claude.json oauthAccount; codex: auth.json).
 *
 * Legacy and sync-merged registries can hold two pool records sharing one
 * configDir (pool create rejects new collisions, but existing records are
 * never deleted). Such duplicates are canonicalised behaviourally: the FIRST
 * registry record for an expanded configDir is the canonical pool, and every
 * consumer (`poolsOf`, `requirePool`, `findPool`) sees only it. The duplicate
 * record stays in the registry untouched.
 */

export const DEFAULT_SWAP_THRESHOLD_PERCENT = 95;

/** The CLI spelling that manages a tool's pools (claude keeps its alias). */
export const swapCommandName = (tool: string): string => (tool === "claude" ? "ais claude-swap" : `ais swap ${tool}`);

export class SwapPoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapPoolError";
  }
}

export type PoolIdentity = Identity & { swapPool: NonNullable<Identity["swapPool"]> };

export function isSwapPool(identity: Identity): identity is PoolIdentity {
  return identity.swapPool !== undefined;
}

export function poolThreshold(pool: PoolIdentity): number {
  return pool.swapPool.thresholdPercent ?? DEFAULT_SWAP_THRESHOLD_PERCENT;
}

export function isAllowed(pool: PoolIdentity, account: string): boolean {
  return pool.swapPool.accounts.includes(account) && !(pool.swapPool.disallowed ?? []).includes(account);
}

export function allowedAccounts(pool: PoolIdentity): string[] {
  return pool.swapPool.accounts.filter((name) => isAllowed(pool, name));
}

/** The comparison key two pool records collide on: tilde-expanded, absolute
 * and normalised (resolve drops trailing slashes and "." segments). */
const poolDirKey = (pool: PoolIdentity): string => resolve(expandPath(pool.configDir));

/** The active pools, one per configDir: a duplicate record (legacy or
 * sync-merged) never becomes a second picker/scheduler/limits entry. */
export function poolsOf(file: IdentitiesFile): PoolIdentity[] {
  const seen = new Set<string>();
  const out: PoolIdentity[] = [];
  for (const identity of file.identities) {
    if (!isSwapPool(identity) || isRetired(identity)) continue;
    const key = poolDirKey(identity);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(identity);
  }
  return out;
}

/** The canonical record for `pool`'s configDir: `pool` itself, or the first
 * registry record sharing it when `pool` is a legacy/sync duplicate. */
export function canonicalPool(file: IdentitiesFile, pool: PoolIdentity): PoolIdentity {
  const key = poolDirKey(pool);
  return poolsOf(file).find((candidate) => poolDirKey(candidate) === key) ?? pool;
}

/** Look up an active pool by name or alias, redirecting a duplicate record to
 * the canonical one. Returns undefined when the key names no active pool. */
export function findPool(file: IdentitiesFile, key: string): PoolIdentity | undefined {
  const found = findIdentityByNameOrAlias(file.identities, key);
  if (!found || !isSwapPool(found) || isRetired(found)) return undefined;
  return canonicalPool(file, found);
}

/** The active pools that currently hold `member`'s grant in their configDir. */
export function poolsHoldingMember(file: IdentitiesFile, member: string): PoolIdentity[] {
  return poolsOf(file).filter((pool) => pool.swapPool.active === member);
}

/** Pick a pool by name/alias, or the only pool when none is named. A key that
 * names a legacy duplicate record resolves to the canonical pool for its
 * configDir; an unqualified lookup counts canonical pools only. */
export function requirePool(file: IdentitiesFile, key: string | undefined, tool: string = "claude"): PoolIdentity {
  if (key !== undefined) {
    const found = findIdentityByNameOrAlias(file.identities, key);
    if (!found) throw new SwapPoolError(`No identity named "${key}"`);
    if (!isSwapPool(found)) throw new SwapPoolError(`Identity "${found.name}" is not a swap pool`);
    if (isRetired(found)) throw new SwapPoolError(`Swap pool "${found.name}" is retired`);
    return canonicalPool(file, found);
  }
  const pools = poolsOf(file);
  if (pools.length === 1) return pools[0]!;
  if (pools.length === 0) throw new SwapPoolError(`No swap pool exists yet. Create one with "${swapCommandName(tool)} pool create <name> --accounts=a,b".`);
  throw new SwapPoolError(`More than one swap pool exists (${pools.map((p) => p.name).join(", ")}); pass --pool=<name>.`);
}

/** Resolve a member key (name or alias) to the member identity of `pool`. */
export function memberIdentity(file: IdentitiesFile, pool: PoolIdentity, key: string): Identity {
  const found = findIdentityByNameOrAlias(file.identities, key);
  if (!found || !pool.swapPool.accounts.includes(found.name)) {
    throw new SwapPoolError(`"${key}" is not a member of swap pool "${pool.name}" (members: ${pool.swapPool.accounts.join(", ")})`);
  }
  return found;
}

/** Why a candidate cannot be a pool member, or undefined when it can. */
export function memberProblem(file: IdentitiesFile, poolName: string, name: string, tool: string = "claude", extra?: (member: Identity) => string | undefined): string | undefined {
  const found = findIdentityByNameOrAlias(file.identities, name);
  if (!found) return `"${name}" is not an existing ${tool} identity`;
  if (found.name === poolName) return `a pool cannot contain itself`;
  if (isRetired(found)) return `"${found.name}" is retired`;
  if (isSwapPool(found)) return `"${found.name}" is itself a swap pool`;
  return extra?.(found);
}

/** Validates the whole member list against the tool's registry, returning
 * the canonical member names (aliases resolved) or throwing one error that
 * lists every problem. */
export function validateMembers(file: IdentitiesFile, poolName: string, requested: string[], tool: string = "claude", extra?: (member: Identity) => string | undefined): string[] {
  if (requested.length < 2) throw new SwapPoolError("A swap pool needs at least two accounts.");
  const names: string[] = [];
  const problems: string[] = [];
  for (const key of requested) {
    const problem = memberProblem(file, poolName, key, tool, extra);
    if (problem) {
      problems.push(problem);
      continue;
    }
    const canonical = findIdentityByNameOrAlias(file.identities, key)!.name;
    if (names.includes(canonical)) problems.push(`"${canonical}" is listed more than once`);
    else names.push(canonical);
  }
  if (problems.length > 0) throw new SwapPoolError(`Invalid swap pool accounts: ${problems.join("; ")}`);
  return names;
}
