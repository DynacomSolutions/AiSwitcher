import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fetchCodexLimits } from "../../cli/limits/codex-limits.ts";
import type { FetchedLimitResult } from "../../cli/limits/types.ts";
import { isBedrockIdentity } from "../aws-profile.ts";
import { codexAccountOf, codexAuthPath, codexRecency, hasCodexTokens, parseCodexAuth, readCodexAuthText, type CodexAuthFile } from "../codex-auth.ts";
import { withOauthRefreshLock } from "../claude-swap-lock.ts";
import { expandPath } from "../match.ts";
import { CODEX_CONFIG } from "../tool-configs.ts";
import type { Identity } from "../types.ts";
import type { PoolAdapter, PoolUsage, SwapResult, WriteBackOutcome } from "./adapter.ts";
import { writeFileAtomic } from "./fs.ts";
import type { LockOptions } from "./lock.ts";
import { SwapPoolError, type PoolIdentity } from "./swap-pool.ts";

/**
 * Codex pool adapter. The pool is one CODEX_HOME whose `auth.json` is swapped
 * between member identities (each member's own `auth.json` is its vault).
 *
 * Codex 0.145.0 reads `auth.json` once at startup and keeps the account in
 * memory (reload only on proactive refresh or a 401; a refresh against a file
 * holding another account fails permanently with "account mismatch"; its own
 * writes are truncate-in-place, not atomic, and take no cross-process lock).
 * So a running session cannot follow a swap: `liveSwap` is false, the swap
 * happens anyway (it only fires when the active account is at its limit and
 * those sessions are stuck regardless), new launches get the new account, and
 * `heal` repairs whatever a still-running session writes back afterwards.
 */

export const codexTuning = {
  /** Wait before re-reading a pool file that looks damaged (a writer may be mid-truncate). */
  healRetryMs: 200,
};

export type CodexMemberUsage = PoolUsage;

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Why an identity cannot be a Codex pool member, or undefined (ChatGPT login only). */
export function codexMemberProblem(member: Identity): string | undefined {
  if (isBedrockIdentity(member)) return `"${member.name}" is a Bedrock identity (pools need ChatGPT logins)`;
  const auth = parseCodexAuth(readSyncOrUndefined(codexAuthPath(member.configDir)));
  if (!hasCodexTokens(auth)) return `"${member.name}" has no ChatGPT login (API-key or logged-out; run "codex login" under that identity)`;
  // Same rule as heal: a member must carry tokens.account_id (agreeing with its JWT), never a JWT-only id.
  if (!codexAccountOf(auth).fileId || !codexAccountOf(auth).id) return `"${member.name}" has an inconsistent or missing account id in auth.json`;
  return undefined;
}

function readSyncOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The member whose vault holds `accountId`; the registry-active member wins a tie. */
async function ownerByAccount(members: Identity[], accountId: string, activeName: string | null): Promise<Identity | undefined> {
  const ordered = [...members].sort((a, b) => Number(b.name === activeName) - Number(a.name === activeName));
  for (const member of ordered) {
    if (codexAccountOf(parseCodexAuth(await readCodexAuthText(member.configDir))).id === accountId) return member;
  }
  return undefined;
}

/** Writes the pool's grant into the owning member's vault when it is newer. */
async function writeBackToOwner(owner: Identity, poolAuth: CodexAuthFile, lock?: LockOptions, alreadyLocked = false): Promise<WriteBackOutcome> {
  const poolId = codexAccountOf(poolAuth).id;
  const locked = <T>(fn: () => Promise<T>) => (alreadyLocked ? fn() : withOauthRefreshLock(owner.configDir, fn, lock));
  return locked(async (): Promise<WriteBackOutcome> => {
    // Read and compare under the owner's lock so a concurrent member refresh is never overwritten.
    const ownerAuth = parseCodexAuth(await readCodexAuthText(owner.configDir));
    if (hasCodexTokens(ownerAuth)) {
      if (codexAccountOf(ownerAuth).id !== poolId) return "none-account-mismatch";
      const o = ownerAuth!.tokens!;
      const p = poolAuth.tokens!;
      if (o.access_token === p.access_token && o.refresh_token === p.refresh_token) return "none-identical";
      if (codexRecency(poolAuth) <= codexRecency(ownerAuth)) return "none-member-newer";
    }
    // Merge so keys the pool copy lacks (account_id, id_token) survive in the vault.
    const next = { ...(ownerAuth ?? {}), tokens: { ...(ownerAuth?.tokens ?? {}), ...poolAuth.tokens }, ...(poolAuth.last_refresh !== undefined ? { last_refresh: poolAuth.last_refresh } : {}) };
    await writeFileAtomic(codexAuthPath(owner.configDir), json(next));
    return "written";
  });
}

async function swapCredentials(input: Parameters<PoolAdapter["swapCredentials"]>[0]): Promise<Omit<SwapResult, "reason">> {
  const { pool, members, target, lock } = input;
  const poolDir = pool.configDir;
  const poolPath = codexAuthPath(poolDir);
  const notes: string[] = [];

  // Lock order: pool, pool oauth, then the target vault, held until the pool write is verified.
  return withOauthRefreshLock(poolDir, () => withOauthRefreshLock(target.configDir, async () => {
    let targetText = await readCodexAuthText(target.configDir);
    let targetAuth = parseCodexAuth(targetText);
    if (targetText === undefined || !hasCodexTokens(targetAuth)) {
      throw new SwapPoolError(`Account "${target.name}" has no usable Codex login (no ChatGPT tokens in ${target.configDir}); run "codex login" under that identity first.`);
    }
    const targetAcct = codexAccountOf(targetAuth);
    if (!targetAcct.id) {
      throw new SwapPoolError(`Account "${target.name}" has an inconsistent account id in auth.json (tokens.account_id disagrees with its access token); log in again under that identity.`);
    }
    const activeName = pool.swapPool.active ?? null;
    const poolText = await readCodexAuthText(poolDir);
    const poolAuth = parseCodexAuth(poolText);
    const poolAcct = codexAccountOf(poolAuth);

    if (activeName === target.name && poolAcct.id === targetAcct.id && poolAuth?.tokens?.access_token === targetAuth!.tokens!.access_token) {
      return { pool: pool.name, from: activeName, to: target.name, noop: true, writeBack: "none-identical" as const, notes };
    }

    let writeBack: WriteBackOutcome;
    if (!hasCodexTokens(poolAuth)) {
      writeBack = "none-no-live-credentials";
    } else if (poolAcct.hybrid) {
      writeBack = "none-account-mismatch";
    } else {
      const owner = poolAcct.id ? await ownerByAccount(members, poolAcct.id, activeName) : undefined;
      if (!owner) {
        writeBack = "none-unknown-owner";
      } else {
        writeBack = await writeBackToOwner(owner, poolAuth!, lock, owner.configDir === target.configDir);
        if (activeName && owner.name !== activeName) notes.push(`pool held "${owner.name}"'s account, not the recorded active "${activeName}"; wrote it back to "${owner.name}"`);
      }
    }
    // A live grant we cannot attribute is never silently destroyed.
    if ((writeBack === "none-unknown-owner" || writeBack === "none-account-mismatch") && poolText !== undefined) {
      const backup = `${poolPath}.pre-swap.bak`;
      await writeFileAtomic(backup, poolText);
      notes.push(`live pool credentials could not be attributed to a member; kept a 0600 copy at ${backup}`);
    }

    // The write-back may have just updated the target's own vault (pool held the target's account): copy the vault as it is now.
    if (writeBack === "written") {
      const refreshedText = await readCodexAuthText(target.configDir);
      const refreshed = parseCodexAuth(refreshedText);
      if (refreshedText !== undefined && hasCodexTokens(refreshed) && codexAccountOf(refreshed).id === targetAcct.id) {
        targetText = refreshedText;
        targetAuth = refreshed;
      }
    }
    await writeFileAtomic(poolPath, targetText!);
    const after = codexAccountOf(parseCodexAuth(await readCodexAuthText(poolDir)));
    if (after.id !== targetAcct.id) {
      if (poolText !== undefined) await writeFileAtomic(poolPath, poolText).catch(() => undefined);
      throw new SwapPoolError(`could not verify ${poolPath} after the swap (account id mismatch); the previous file was restored`);
    }
    return { pool: pool.name, from: activeName, to: target.name, noop: false, writeBack, notes };
  }, lock), lock);
}

/**
 * Repairs the pool's auth.json when it no longer holds the active member's
 * account. Cases (after one delayed re-read, so a writer that is mid-truncate
 * is not mistaken for damage):
 *  - empty, partial, unparsable or token-less: restore from the active vault;
 *  - tokens of a different account than the active one (a running session
 *    refreshed or relogged after a swap): capture them into the member that
 *    owns that account when newer, else keep a `.pre-heal.bak`, then restore;
 *  - hybrid (account_id and the token JWT disagree): `.pre-heal.bak`, restore.
 * Caller holds the pool lock. Returns human notes for what it did.
 */
async function heal(pool: PoolIdentity, members: Identity[], lock?: LockOptions): Promise<string[]> {
  const activeName = pool.swapPool.active;
  const active = members.find((m) => m.name === activeName);
  if (!activeName || !active) return [];
  const vaultText = await readCodexAuthText(active.configDir);
  const vaultAuth = parseCodexAuth(vaultText);
  const vaultAcct = codexAccountOf(vaultAuth);
  if (vaultText === undefined || !hasCodexTokens(vaultAuth) || !vaultAcct.id) return [`cannot heal ${pool.name}: active account "${activeName}" has no usable login in its vault`];

  const poolPath = codexAuthPath(pool.configDir);
  const classify = async () => {
    const text = await readCodexAuthText(pool.configDir);
    const auth = parseCodexAuth(text);
    const acct = codexAccountOf(auth);
    const complete = hasCodexTokens(auth) && typeof auth?.tokens?.id_token === "string" && auth.tokens.id_token !== "";
    const newer = complete && auth!.tokens!.refresh_token !== vaultAuth!.tokens!.refresh_token && codexRecency(auth) > codexRecency(vaultAuth);
    const kind = !complete ? "damaged" : acct.hybrid ? "hybrid" : acct.id === vaultAcct.id ? (newer ? "same" : "ok") : acct.id ? "foreign" : "damaged";
    return { text, auth, acct, kind } as const;
  };
  let state = await classify();
  if (state.kind !== "ok") {
    await sleep(codexTuning.healRetryMs);
    state = await classify();
  }
  if (state.kind === "ok") return [];

  const notes: string[] = [];
  return withOauthRefreshLock(pool.configDir, async () => {
    // Decide on the file as it is under the lock, not as it was before waiting for it.
    let now = await classify();
    if (now.kind === "damaged") {
      await sleep(codexTuning.healRetryMs);
      now = await classify();
    }
    if (now.kind === "ok") return [];
    if (now.kind === "same") {
      // Same account as the active vault: never restore over it, keep the newer tokens in the vault.
      const outcome = await writeBackToOwner(active, now.auth!, lock);
      return [`pool ${pool.name} held newer tokens for "${activeName}"; vault write-back: ${outcome}`];
    }
    if (now.kind === "foreign") {
      const owner = await ownerByAccount(members, now.acct.id!, activeName);
      if (owner) {
        const outcome = await writeBackToOwner(owner, now.auth!, lock);
        notes.push(`pool ${pool.name} held "${owner.name}"'s account instead of "${activeName}"; ${outcome === "written" ? `captured it into "${owner.name}"` : `left "${owner.name}" as it was (${outcome})`}`);
      } else {
        await writeFileAtomic(`${poolPath}.pre-heal.bak`, now.text!);
        notes.push(`pool ${pool.name} held an account that is not a member; kept a 0600 copy at ${poolPath}.pre-heal.bak`);
      }
    } else if (now.kind === "hybrid") {
      await writeFileAtomic(`${poolPath}.pre-heal.bak`, now.text!);
      notes.push(`pool ${pool.name} auth.json was hybrid (account_id disagrees with its token); kept a 0600 copy at ${poolPath}.pre-heal.bak`);
    } else {
      notes.push(`pool ${pool.name} auth.json was empty or partial`);
    }
    await writeFileAtomic(poolPath, vaultText);
    notes.push(`restored "${activeName}" into ${pool.name}`);
    return notes;
  }, lock);
}

/** Running codex processes (owned by this user) whose CODEX_HOME is `configDir`. Linux /proc only; best effort. */
export async function countCodexSessions(configDir: string, procRoot = "/proc"): Promise<number> {
  const want = resolve(expandPath(configDir));
  const uid = process.getuid?.();
  let count = 0;
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      if (uid !== undefined && (await stat(`${procRoot}/${entry}`)).uid !== uid) continue;
      const argv = (await readFile(`${procRoot}/${entry}/cmdline`, "utf8")).split("\0");
      if (basename(argv[0] ?? "") !== "codex" && basename(argv[1] ?? "") !== "codex") continue;
      const home = (await readFile(`${procRoot}/${entry}/environ`, "utf8")).split("\0").find((kv) => kv.startsWith("CODEX_HOME="));
      if (home && resolve(expandPath(home.slice("CODEX_HOME=".length))) === want) count++;
    } catch {
      // gone, or not ours to read
    }
  }
  return count;
}

export const codexAdapter: PoolAdapter<CodexMemberUsage> = {
  tool: "codex",
  config: CODEX_CONFIG,
  liveSwap: false,
  memberProblem: codexMemberProblem,
  hasCredentials: (configDir) => hasCodexTokens(parseCodexAuth(readSyncOrUndefined(codexAuthPath(configDir)))),
  swapCredentials,
  heal,
  fetchUsage: async (member, deps) => {
    const fetcher = (deps as { fetchCodexLimits?: (identity: Identity) => Promise<FetchedLimitResult> } | undefined)?.fetchCodexLimits ?? fetchCodexLimits;
    const capturedAt = new Date().toISOString();
    try {
      const result = await fetcher(member);
      if (result.status === "unavailable" || result.windows.length === 0) {
        return { status: "unavailable", ...(result.error ? { error: result.error } : {}), capturedAt };
      }
      const maxUtilization = Math.max(...result.windows.map((w) => w.usedPercent));
      return {
        status: maxUtilization >= 100 ? "rate-limited" : "live",
        maxUtilization,
        windows: result.windows.map((w) => ({ label: w.label, utilization: w.usedPercent, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) })),
        capturedAt,
      };
    } catch (err) {
      return { status: "unavailable", error: err instanceof Error ? err.message : String(err), capturedAt };
    }
  },
  notifySwapped: async (pool, from, to) => {
    const sessions = await countCodexSessions(pool.configDir);
    if (sessions > 0) console.error(`codex-swap: account swapped to ${to}${from ? ` (from ${from})` : ""}; relaunch or "codex resume" in ${sessions} running session${sessions === 1 ? "" : "s"}`);
    return { sessions };
  },
};
