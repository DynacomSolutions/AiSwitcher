import { decodeJwtPayload } from "../oauth-reconcile.ts";

/** Account identity of an OAuth access/refresh pair, shared by the Kimi and
 * Pi pool adapters and the kimi store's pool write-through. */

export interface GrantIdentity {
  /** The trustworthy account id; undefined when hybrid or nothing is recorded. */
  id?: string;
  /** Two parts of the grant claim different accounts. */
  hybrid: boolean;
}

/** Stable account id of an OAuth token when it is a JWT carrying one. */
export function tokenAccount(token: unknown): { key: string; value: string } | undefined {
  const claims = typeof token === "string" ? decodeJwtPayload(token) : undefined;
  if (!claims) return undefined;
  for (const key of ["user_id", "sub", "uid"]) {
    const value = claims[key];
    if (typeof value === "string" && value.trim()) return { key, value };
  }
  return undefined;
}

/** The account of an access/refresh pair: hybrid when both claim different accounts under the same claim. */
export function pairIdentity(access: unknown, refresh: unknown): GrantIdentity {
  const a = tokenAccount(access);
  const r = tokenAccount(refresh);
  const hybrid = a !== undefined && r !== undefined && a.key === r.key && a.value !== r.value;
  const id = hybrid ? undefined : (a ?? r)?.value;
  return { hybrid, ...(id ? { id } : {}) };
}

export const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

