import { join } from "node:path";
import { fetchPiLimits } from "../../cli/limits/pi-limits.ts";
import type { ToolLimitResult } from "../../cli/limits/types.ts";
import { PI_CONFIG } from "../tool-configs.ts";
import type { Identity } from "../types.ts";
import { createGrantFileAdapter, usageFromLimits, type GrantFile } from "./grant-file-adapter.ts";
import { nonEmpty, pairIdentity, tokenAccount } from "./token-account.ts";

/**
 * Pi pool adapter. The pool is one PI_CODING_AGENT_DIR whose `auth.json`
 * (every provider's credential) is swapped whole between member identities.
 * A member's account is its `kimi-coding` OAuth entry (the one OAuth
 * provider with a limits endpoint and a stable account claim); members
 * without one are rejected.
 *
 * `liveSwap: true`. Pi 0.x `AuthStorage.readLatestData()` compares the file
 * revision (dev, ino, size, mtime, ctime) on every read and reloads on
 * change, so an atomic swap is picked up by a running session on its next
 * request. Pi's refresh runs inside `withLockAsync` on `auth.json.lock`
 * (proper-lockfile, stale 30s) and writes `{...snapshot, [provider]: next}`,
 * so a refresh in flight during a swap would write the old account back; the
 * swap and heal take that same lock, and heal captures anything that still
 * lands. The rotating-refresh-token rule is the Codex one: the pool copy is
 * written back to the member that owns it, newer `expires` only: every OAuth
 * entry when the pool file is that member's own, only the `kimi-coding` entry
 * (the one with an account claim) when the pool holds the member's account next
 * to parts that may be another member's; a newer entry that cannot move is
 * backed up instead. AIS never refreshes the pool itself.
 */

const KIMI_ENTRY = "kimi-coding";

type Entry = Record<string, unknown>;
const entries = (g: GrantFile): Array<[string, Entry]> =>
  Object.entries(g).filter((kv): kv is [string, Entry] => typeof kv[1] === "object" && kv[1] !== null && !Array.isArray(kv[1]));
const isOauth = (e: Entry) => e.type === "oauth";
const kimiEntry = (g: GrantFile | undefined): Entry | undefined => {
  const e = g?.[KIMI_ENTRY];
  return typeof e === "object" && e !== null && isOauth(e as Entry) ? (e as Entry) : undefined;
};

/** Pi's own validity rule for one credential (auth-storage.js ReadOnlyAuthStorage.load). */
function validEntry(e: Entry): boolean {
  if (e.type === "api_key") return e.key === undefined || typeof e.key === "string";
  return isOauth(e) && typeof e.access === "string" && typeof e.refresh === "string" && typeof e.expires === "number" && Number.isFinite(e.expires);
}

export const piAdapter = createGrantFileAdapter({
  tool: "pi",
  config: PI_CONFIG,
  liveSwap: true,
  label: "Pi",
  loginHint: 'run "pi" and /login to Kimi under that identity',
  relPath: ["auth.json"],
  usable: (g) => nonEmpty(kimiEntry(g)?.access),
  identity: (g) => pairIdentity(kimiEntry(g)?.access, kimiEntry(g)?.refresh),
  complete: (g) => g !== undefined && Object.values(g).every((e) => typeof e === "object" && e !== null && !Array.isArray(e) && validEntry(e as Entry)),
  fingerprint: (g) => JSON.stringify(entries(g).filter(([, e]) => isOauth(e)).map(([k, e]) => [k, e.access, e.refresh]).sort()),
  // "same": the pool file is the member's own, so the OAuth entries it rotated go back (only providers the
  // member already holds), each one checked: a different account claim, or tokens equal to another member's
  // entry (a copy of their rotating chain), are backed up and skipped; a merge first keeps the entry it
  // replaces. "capture": other providers may belong to another member, so only kimi-coding moves.
  newerInto: (owner, pool, mode, others) => {
    if (!owner) return { next: pool };
    const next: GrantFile = { ...owner };
    const backup: Record<string, unknown> = {};
    let changed = false;
    for (const [key, p] of entries(pool)) {
      if (mode === "capture" && key !== KIMI_ENTRY) continue;
      const o = owner[key] as Entry | undefined;
      if (!o || !isOauth(o) || !isOauth(p)) continue;
      const newer = typeof p.expires === "number" && p.expires > (typeof o.expires === "number" ? o.expires : -1);
      if (!newer || (p.access === o.access && p.refresh === o.refresh)) continue;
      if (key !== KIMI_ENTRY) {
        const mine = tokenAccount(o.access) ?? tokenAccount(o.refresh);
        const theirs = tokenAccount(p.access) ?? tokenAccount(p.refresh);
        const foreignClaim = theirs !== undefined && (mine === undefined || mine.key !== theirs.key || mine.value !== theirs.value);
        const sharedChain = others.some((g) => {
          const e = g[key] as Entry | undefined;
          return e !== undefined && isOauth(e) && (e.access === p.access || e.refresh === p.refresh || e.access === p.refresh || e.refresh === p.access);
        });
        if (foreignClaim || sharedChain) {
          backup[`skipped:${key}`] = p;
          continue;
        }
        backup[`replaced:${key}`] = o;
      }
      next[key] = { ...o, ...p };
      changed = true;
    }
    if (!changed && Object.keys(backup).length === 0) return undefined;
    return { ...(changed ? { next } : {}), ...(Object.keys(backup).length > 0 ? { backup } : {}) };
  },
  hasPoolOnlyContent: (pool, vault) =>
    entries(pool).some(([key, e]) => {
      const v = vault?.[key] as Entry | undefined;
      if (v === undefined) return true;
      if (!isOauth(e)) return JSON.stringify(v) !== JSON.stringify(e);
      // Other providers' OAuth entries are never copied between vaults: a newer one would be lost, so keep a copy.
      return key !== KIMI_ENTRY && isOauth(v) && typeof e.expires === "number" && e.expires > (typeof v.expires === "number" ? v.expires : -1) && (e.access !== v.access || e.refresh !== v.refresh);
    }),
  toolLock: (dir) => ({ path: join(dir, "auth.json.lock"), staleMs: 30_000 }),
  fetchUsage: async (member, deps) => {
    const fetcher = (deps as { fetchPiLimits?: (identity: Identity) => Promise<ToolLimitResult[]> } | undefined)?.fetchPiLimits ?? ((m: Identity) => fetchPiLimits(m, true));
    return usageFromLimits(await fetcher(member));
  },
});
