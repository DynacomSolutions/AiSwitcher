import { randomBytes } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { aisClaudeSwapLedgerPath } from "../shared/ais-home.ts";
import { withClaudeLocks, withOauthRefreshLock, type LockOptions } from "./claude-swap-lock.ts";
import { grantFingerprint, nativeStorePathFor, readProviderGrantCopy, type OAuthGrant } from "./oauth-reconcile.ts";
import { isRetired } from "./retired.ts";
import { loadIdentitiesFile, saveIdentitiesFile } from "./store.ts";
import { CLAUDE_CONFIG } from "./tool-configs.ts";
import { allowedAccounts, isAllowed, memberIdentity, requirePool, SwapPoolError, type PoolIdentity } from "./swap-pool.ts";
import type { Identity } from "./types.ts";

/**
 * Credential swap for a claude swap pool (see identities/swap-pool.ts).
 *
 * The pool identity owns ONE Claude folder (settings, history, skills,
 * plugins). Each member identity's own configDir is the per-account vault:
 * `.credentials.json` holds its OAuth grant and `.claude.json` its
 * `oauthAccount`. A swap makes the pool's `.credentials.json` and
 * `.claude.json` `oauthAccount` equal the target member's, under Claude
 * Code's own lock dirs, after writing the pool's possibly-rotated live grant
 * back to the member that owned it (refresh tokens rotate, so an
 * unsynchronised copy would die).
 *
 * Live-verified on Linux (Claude Code 2.1.293): a running session re-reads
 * .credentials.json every turn, so a swap applies on the next message with no
 * restart; a new launch always picks it up too.
 */

export type SwapReason = "manual" | "auto" | "launch";

export interface SwapEvent {
  ts: string;
  pool: string;
  from: string | null;
  to: string;
  reason: SwapReason;
}

export type WriteBackOutcome =
  | "written"
  | "none-no-live-credentials"
  | "none-identical"
  | "none-member-newer"
  | "none-unknown-owner"
  | "none-account-mismatch";

export interface SwapResult {
  pool: string;
  from: string | null;
  to: string;
  reason: SwapReason;
  /** True when the target was already active and credentials were in place. */
  noop: boolean;
  writeBack: WriteBackOutcome;
  notes: string[];
}

/* ------------------------------ ledger ------------------------------------ */

export async function appendSwapEvent(event: SwapEvent, ledgerPath: string = aisClaudeSwapLedgerPath()): Promise<void> {
  await mkdir(dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

/** All ledger events, oldest first. Torn or foreign lines are skipped. */
export async function readSwapEvents(ledgerPath: string = aisClaudeSwapLedgerPath()): Promise<SwapEvent[]> {
  let text: string;
  try {
    text = await readFile(ledgerPath, "utf8");
  } catch {
    return [];
  }
  const events: SwapEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Partial<SwapEvent>;
      if (typeof e.ts === "string" && typeof e.pool === "string" && typeof e.to === "string" && Number.isFinite(Date.parse(e.ts))) {
        events.push({ ts: e.ts, pool: e.pool, from: typeof e.from === "string" ? e.from : null, to: e.to, reason: (e.reason ?? "manual") as SwapReason });
      }
    } catch {
      // torn line
    }
  }
  return events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** The member active in `pool` at `atMs`, per the ledger (undefined before
 * the first recorded swap). */
export function activeMemberAt(events: SwapEvent[], pool: string, atMs: number): string | undefined {
  let active: string | undefined;
  for (const e of events) {
    if (e.pool !== pool) continue;
    if (Date.parse(e.ts) > atMs) break;
    active = e.to;
  }
  return active;
}

/* --------------------------- atomic file helpers --------------------------- */

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(temp, content, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function parseObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function accountUuid(claudeJson: Record<string, unknown> | undefined): string | undefined {
  const acct = claudeJson?.oauthAccount;
  if (typeof acct === "object" && acct !== null) {
    const uuid = (acct as Record<string, unknown>).accountUuid;
    if (typeof uuid === "string" && uuid) return uuid;
  }
  return undefined;
}

const claudeJsonPath = (configDir: string) => join(configDir, ".claude.json");

/* ----------------------------- write-back ---------------------------------- */

/** Pure decision: should the pool's live grant be written back to the member
 * that owns it? Newer = later access-token expiry. Both account uuids, when
 * known, must agree (a /login to a different account inside the pool is
 * never attributed to the active member). */
export function decideWriteBack(input: {
  pool?: OAuthGrant;
  member?: OAuthGrant;
  poolAccountUuid?: string;
  memberAccountUuid?: string;
}): WriteBackOutcome {
  const { pool, member } = input;
  if (!pool) return "none-no-live-credentials";
  if (input.poolAccountUuid && input.memberAccountUuid && input.poolAccountUuid !== input.memberAccountUuid) {
    return "none-account-mismatch";
  }
  if (!member) return "written";
  if (pool.access_token === member.access_token && pool.refresh_token === member.refresh_token) return "none-identical";
  const poolExp = pool.expires_at ?? -1;
  const memberExp = member.expires_at ?? -1;
  return poolExp > memberExp ? "written" : "none-member-newer";
}

/** Which member's grant sits in the pool right now, found by refresh-token
 * fingerprint (then account uuid) when the registry has no `active`. */
async function inferOwner(pool: PoolIdentity, members: Identity[], poolGrant: OAuthGrant | undefined, poolUuid: string | undefined): Promise<string | undefined> {
  if (!poolGrant) return undefined;
  const fp = grantFingerprint(poolGrant);
  for (const member of members) {
    const copy = await readProviderGrantCopy("claude", member.configDir);
    if (copy && grantFingerprint(copy.grant) === fp) return member.name;
  }
  if (poolUuid) {
    for (const member of members) {
      const uuid = accountUuid(parseObject(await readText(claudeJsonPath(member.configDir))));
      if (uuid === poolUuid) return member.name;
    }
  }
  return undefined;
}

/* ------------------------------ the swap ----------------------------------- */

export interface SwapFsInput {
  pool: PoolIdentity;
  members: Identity[];
  target: Identity;
  reason: SwapReason;
  lock?: LockOptions;
}

/** The filesystem half: write-back, credential copy, oauthAccount replace.
 * Does not touch the registry or ledger. */
export async function swapCredentialFiles(input: SwapFsInput): Promise<Omit<SwapResult, "reason">> {
  const { pool, members, target } = input;
  const poolDir = pool.configDir;
  const poolCredPath = nativeStorePathFor("claude", poolDir);
  const targetCredPath = nativeStorePathFor("claude", target.configDir);
  const notes: string[] = [];

  const targetCredText = await readText(targetCredPath);
  const targetGrant = (await readProviderGrantCopy("claude", target.configDir))?.grant;
  if (targetCredText === undefined || !targetGrant) {
    throw new SwapPoolError(`Account "${target.name}" has no usable Claude login (no credentials in ${target.configDir}); run "claude /login" under that identity first.`);
  }
  const targetClaudeJson = parseObject(await readText(claudeJsonPath(target.configDir)));
  const targetAccount = targetClaudeJson?.oauthAccount;

  return withClaudeLocks(poolDir, async () => {
    const activeName = pool.swapPool.active ?? null;
    const poolCredText = await readText(poolCredPath);
    const poolGrant = (await readProviderGrantCopy("claude", poolDir))?.grant;
    const poolClaudeJsonText = await readText(claudeJsonPath(poolDir));
    const poolClaudeJson = parseObject(poolClaudeJsonText) ?? {};
    const poolUuid = accountUuid(poolClaudeJson);

    const credsInPlace =
      poolGrant !== undefined &&
      grantFingerprint(poolGrant) === grantFingerprint(targetGrant) &&
      poolGrant.access_token === targetGrant.access_token;
    if (activeName === target.name && credsInPlace) {
      return { pool: pool.name, from: activeName, to: target.name, noop: true, writeBack: "none-identical" as const, notes };
    }

    // (b) write-back first
    let owner: Identity | undefined = activeName ? members.find((m) => m.name === activeName) : undefined;
    if (!owner && poolGrant) {
      const inferred = await inferOwner(pool, members, poolGrant, poolUuid);
      owner = members.find((m) => m.name === inferred);
      if (inferred) notes.push(`pool had no recorded active account; live credentials matched "${inferred}"`);
    }
    let writeBack: WriteBackOutcome;
    if (!owner) {
      writeBack = poolGrant ? "none-unknown-owner" : "none-no-live-credentials";
    } else {
      const ownerGrant = (await readProviderGrantCopy("claude", owner.configDir))?.grant;
      const ownerUuid = accountUuid(parseObject(await readText(claudeJsonPath(owner.configDir))));
      writeBack = decideWriteBack({ pool: poolGrant, member: ownerGrant, poolAccountUuid: poolUuid, memberAccountUuid: ownerUuid });
      if (writeBack === "written" && poolCredText !== undefined) {
        const ownerCredPath = nativeStorePathFor("claude", owner.configDir);
        await withOauthRefreshLock(owner.configDir, () => writeFileAtomic(ownerCredPath, poolCredText), input.lock);
      }
    }
    // A live grant we cannot attribute is never silently destroyed.
    if ((writeBack === "none-unknown-owner" || writeBack === "none-account-mismatch") && poolCredText !== undefined) {
      const backup = `${poolCredPath}.pre-swap.bak`;
      await writeFileAtomic(backup, poolCredText);
      notes.push(`live pool credentials could not be attributed to a member; kept a 0600 copy at ${backup}`);
    }

    // (c) credentials, (d) oauthAccount; roll (c) back if (d) fails
    await mkdir(poolDir, { recursive: true });
    await writeFileAtomic(poolCredPath, targetCredText);
    try {
      if (targetAccount !== undefined) {
        await writeFileAtomic(claudeJsonPath(poolDir), `${JSON.stringify({ ...poolClaudeJson, oauthAccount: targetAccount }, null, 2)}\n`);
      } else {
        // Never leave the previous account's oauthAccount next to the target's credentials.
        const { oauthAccount: _previous, ...withoutAccount } = poolClaudeJson;
        await writeFileAtomic(claudeJsonPath(poolDir), `${JSON.stringify(withoutAccount, null, 2)}\n`);
        notes.push(`account "${target.name}" has no oauthAccount in its .claude.json; the pool's previous oauthAccount was removed`);
      }
    } catch (err) {
      if (poolCredText !== undefined) await writeFileAtomic(poolCredPath, poolCredText).catch(() => undefined);
      throw new SwapPoolError(`could not update ${claudeJsonPath(poolDir)}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { pool: pool.name, from: activeName, to: target.name, noop: false, writeBack, notes };
  }, input.lock);
}

export interface PerformSwapOptions {
  registryPath?: string;
  /** Pool name; omitted when exactly one pool exists. */
  pool?: string;
  /** Member name or alias. */
  target: string;
  reason: SwapReason;
  /** Manual swaps may override the allowed set. */
  force?: boolean;
  ledgerPath?: string;
  lock?: LockOptions;
  now?: () => Date;
}

/** Full swap: validate, swap files, persist `swapPool.active`, append the
 * ledger event. */
export async function performSwap(options: PerformSwapOptions): Promise<SwapResult> {
  const registryPath = options.registryPath ?? CLAUDE_CONFIG.identitiesJsonPath;
  const file = await loadIdentitiesFile(registryPath);
  const pool = requirePool(file, options.pool);
  const target = memberIdentity(file, pool, options.target);
  if (isRetired(target)) throw new SwapPoolError(`Account "${target.name}" is retired`);
  if (!options.force && !isAllowed(pool, target.name)) {
    throw new SwapPoolError(`Account "${target.name}" is not allowed in pool "${pool.name}" (run "ais claude-swap allow ${target.name}" or pass --force).`);
  }
  const members = pool.swapPool.accounts
    .map((name) => file.identities.find((i) => i.name === name))
    .filter((i): i is Identity => i !== undefined && !isRetired(i));
  const fsResult = await swapCredentialFiles({ pool, members, target, reason: options.reason, ...(options.lock ? { lock: options.lock } : {}) });

  // Re-read so a registry edit made while we waited for the locks survives.
  const fresh = await loadIdentitiesFile(registryPath);
  const freshPool = fresh.identities.find((i) => i.name === pool.name);
  if (freshPool?.swapPool && freshPool.swapPool.active !== target.name) {
    freshPool.swapPool.active = target.name;
    await saveIdentitiesFile(registryPath, fresh);
  }
  if (!fsResult.noop) {
    await appendSwapEvent(
      { ts: (options.now?.() ?? new Date()).toISOString(), pool: pool.name, from: fsResult.from, to: target.name, reason: options.reason },
      options.ledgerPath,
    );
  }
  return { ...fsResult, reason: options.reason };
}

/** Pool accounts the daemon / `next` may choose from. */
export function candidateAccounts(pool: PoolIdentity, exclude?: string): string[] {
  return allowedAccounts(pool).filter((name) => name !== exclude);
}
