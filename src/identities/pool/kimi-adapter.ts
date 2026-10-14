import { join } from "node:path";
import { fetchKimiLimits } from "../../cli/limits/kimi-limits.ts";
import type { FetchedLimitResult } from "../../cli/limits/types.ts";
import { KIMI_CONFIG } from "../tool-configs.ts";
import type { Identity } from "../types.ts";
import { createGrantFileAdapter, usageFromLimits, type GrantFile } from "./grant-file-adapter.ts";
import { nonEmpty, pairIdentity } from "./token-account.ts";

/**
 * Kimi pool adapter. The pool is one KIMI_CODE_HOME whose
 * `credentials/kimi-code.json` is swapped between member identities (each
 * member's own file is its vault).
 *
 * `liveSwap: true`. kimi-code 2.1.1 (bundled `dist/main.mjs`): every request
 * calls `OAuthManager.ensureFresh()`, which reloads the token file from disk
 * (`FileTokenStorage.load` is a plain readFileSync, no in-memory cache), and
 * it saves with temp file plus rename, so an atomic swap of the file is
 * picked up on the next request. The refresh rotates the token under
 * `<home>/oauth/kimi-code.lock` (proper-lockfile, stale 5s), which the swap
 * and heal take too. The one hazard is a refresh in flight during a swap
 * (it would save the old account's rotated tokens over the new account); the
 * lock closes that window and heal captures anything that still lands.
 */

type Fetch = (identity: Identity) => Promise<FetchedLimitResult>;

export const kimiAdapter = createGrantFileAdapter({
  tool: "kimi",
  config: KIMI_CONFIG,
  liveSwap: true,
  label: "Kimi",
  loginHint: 'run "kimi" and log in under that identity',
  relPath: ["credentials", "kimi-code.json"],
  usable: (g) => nonEmpty(g?.access_token),
  identity: (g) => pairIdentity(g?.access_token, g?.refresh_token),
  complete: (g) => nonEmpty(g?.access_token) && nonEmpty(g?.refresh_token) && typeof g?.expires_at === "number",
  fingerprint: (g) => `${String(g.access_token)}|${String(g.refresh_token)}`,
  newerInto: (owner, pool) => {
    if (!owner) return { next: pool };
    const expiry = (g: GrantFile) => (typeof g.expires_at === "number" ? g.expires_at : -1);
    const identical = owner.access_token === pool.access_token && owner.refresh_token === pool.refresh_token;
    return !identical && expiry(pool) > expiry(owner) ? { next: { ...owner, ...pool } } : undefined;
  },
  toolLock: (dir) => ({ path: join(dir, "oauth", "kimi-code.lock"), staleMs: 5_000 }),
  fetchUsage: async (member, deps) => {
    const fetcher = (deps as { fetchKimiLimits?: Fetch } | undefined)?.fetchKimiLimits ?? fetchKimiLimits;
    return usageFromLimits([await fetcher(member)]);
  },
});
