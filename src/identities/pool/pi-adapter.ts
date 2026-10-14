import { join } from "node:path";
import { fetchPiLimits } from "../../cli/limits/pi-limits.ts";
import type { ToolLimitResult } from "../../cli/limits/types.ts";
import { PI_CONFIG } from "../tool-configs.ts";
import type { Identity } from "../types.ts";
import { createGrantFileAdapter, usageFromLimits, type GrantFile } from "./grant-file-adapter.ts";
import { nonEmpty, pairIdentity } from "./token-account.ts";

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
  // "same": the pool file is the member's own, so every OAuth entry it rotated goes back (only providers
  // the member already holds). "capture": other providers carry no account claim to check and may belong
  // to another member, so only the account-bearing kimi-coding entry moves.
  newerInto: (owner, pool, mode) => {
    if (!owner) return pool;
    const next: GrantFile = { ...owner };
    let changed = false;
    for (const [key, p] of entries(pool)) {
      if (mode === "capture" && key !== KIMI_ENTRY) continue;
      const o = owner[key] as Entry | undefined;
      if (!o || !isOauth(o) || !isOauth(p)) continue;
      const newer = typeof p.expires === "number" && p.expires > (typeof o.expires === "number" ? o.expires : -1);
      if (newer && (p.access !== o.access || p.refresh !== o.refresh)) {
        next[key] = { ...o, ...p };
        changed = true;
      }
    }
    return changed ? next : undefined;
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
