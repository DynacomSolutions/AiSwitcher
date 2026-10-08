import type { Identity, IdentitiesFile } from "./types.ts";
import { isRetired } from "./retired.ts";
import { findIdentityByNameOrAlias } from "./store.ts";

/**
 * Pure helpers for claude swap pools (Identity.swapPool). A pool is an
 * ordinary claude identity with its own configDir; only identities that
 * carry `swapPool` ever take part in a credential swap. Members are other
 * claude identities whose configDir holds the per-account vault
 * (.credentials.json plus .claude.json oauthAccount).
 */

export const DEFAULT_SWAP_THRESHOLD_PERCENT = 95;

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

export function poolsOf(file: IdentitiesFile): PoolIdentity[] {
  return file.identities.filter((identity): identity is PoolIdentity => isSwapPool(identity) && !isRetired(identity));
}

/** The active pools that currently hold `member`'s grant in their configDir. */
export function poolsHoldingMember(file: IdentitiesFile, member: string): PoolIdentity[] {
  return poolsOf(file).filter((pool) => pool.swapPool.active === member);
}

/** Pick a pool by name/alias, or the only pool when none is named. */
export function requirePool(file: IdentitiesFile, key: string | undefined): PoolIdentity {
  if (key !== undefined) {
    const found = findIdentityByNameOrAlias(file.identities, key);
    if (!found) throw new SwapPoolError(`No identity named "${key}"`);
    if (!isSwapPool(found)) throw new SwapPoolError(`Identity "${found.name}" is not a swap pool`);
    if (isRetired(found)) throw new SwapPoolError(`Swap pool "${found.name}" is retired`);
    return found;
  }
  const pools = poolsOf(file);
  if (pools.length === 1) return pools[0]!;
  if (pools.length === 0) throw new SwapPoolError('No swap pool exists yet. Create one with "ais claude-swap pool create <name> --accounts=a,b".');
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
export function memberProblem(file: IdentitiesFile, poolName: string, name: string): string | undefined {
  const found = findIdentityByNameOrAlias(file.identities, name);
  if (!found) return `"${name}" is not an existing claude identity`;
  if (found.name === poolName) return `a pool cannot contain itself`;
  if (isRetired(found)) return `"${found.name}" is retired`;
  if (isSwapPool(found)) return `"${found.name}" is itself a swap pool`;
  return undefined;
}

/** Validates the whole member list against the claude registry, returning
 * the canonical member names (aliases resolved) or throwing one error that
 * lists every problem. */
export function validateMembers(file: IdentitiesFile, poolName: string, requested: string[]): string[] {
  if (requested.length < 2) throw new SwapPoolError("A swap pool needs at least two accounts.");
  const names: string[] = [];
  const problems: string[] = [];
  for (const key of requested) {
    const problem = memberProblem(file, poolName, key);
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
