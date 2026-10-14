import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LimitWindow } from "../../cli/limits/types.ts";
import { withOauthRefreshLock } from "../claude-swap-lock.ts";
import { expandPath } from "../match.ts";
import type { Identity, ToolConfig } from "../types.ts";
import type { PoolAdapter, PoolUsage, SwapResult, WriteBackOutcome } from "./adapter.ts";
import { writeFileAtomic } from "./fs.ts";
import type { LockOptions } from "./lock.ts";
import { SwapPoolError, type PoolIdentity } from "./swap-pool.ts";
import type { GrantIdentity } from "./token-account.ts";

/**
 * Pool adapter factory for tools whose per-identity credentials are one JSON
 * file with rotating OAuth tokens (Kimi, Pi). The pool is one config dir
 * whose credential file is swapped between member identities; each member's
 * own file is its vault. The rules are the Codex ones:
 *  - the pool's grant is written back to the member that owns it, under the
 *    pool lock, only when strictly newer (newer refresh wins);
 *  - AIS never refreshes the pool identity itself (refreshes go to the
 *    member and are written through);
 *  - heal repairs empty/partial, foreign-account, hybrid and lagging pool
 *    files, keeping a 0600 `.pre-heal.bak` of anything it cannot attribute.
 * What differs per tool is supplied by a `GrantFileSpec`.
 */

export type GrantFile = Record<string, unknown>;

export const grantFileTuning = {
  /** Wait before re-reading a pool file that looks damaged (a writer may be mid-write). */
  healRetryMs: 200,
  /** How long to wait for the tool's own credential lock before giving up. */
  toolLockWaitMs: 3_000,
};

export interface GrantFileSpec {
  tool: ToolConfig["toolName"];
  config: ToolConfig;
  liveSwap: boolean;
  label: string;
  loginHint: string;
  /** Credential file relative to a config dir. */
  relPath: string[];
  /** The file carries a usable login. */
  usable(g: GrantFile | undefined): boolean;
  identity(g: GrantFile | undefined): GrantIdentity;
  /** Not partial or truncated (heal restores incomplete files). */
  complete(g: GrantFile | undefined): boolean;
  /** Equal fingerprints mean identical token material. */
  fingerprint(g: GrantFile): string;
  /** The owner's content after taking whatever in `pool` is strictly newer,
   * or undefined when nothing is. Keys the pool copy lacks survive. */
  newerInto(owner: GrantFile | undefined, pool: GrantFile): GrantFile | undefined;
  /** The lock directory the tool itself takes around its own refreshes. */
  toolLock(configDir: string): { path: string; staleMs: number };
  fetchUsage(member: Identity, deps?: unknown): Promise<PoolUsage>;
}

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export function parseGrantFile(text: string | undefined): GrantFile | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as GrantFile) : undefined;
  } catch {
    return undefined;
  }
}

/** Maps the limits windows of one or more fetches onto a pool usage reading. */
export function usageFromLimits(results: Array<{ status: string; windows: LimitWindow[]; error?: string }>, error?: string): PoolUsage {
  const capturedAt = new Date().toISOString();
  const live = results.filter((r) => r.status !== "unavailable");
  const windows = live.flatMap((r) => r.windows);
  if (windows.length === 0) {
    const reason = error ?? results.find((r) => r.error)?.error;
    return { status: "unavailable", ...(reason ? { error: reason } : {}), capturedAt };
  }
  const maxUtilization = Math.max(...windows.map((w) => w.usedPercent));
  return {
    status: maxUtilization >= 100 ? "rate-limited" : "live",
    maxUtilization,
    windows: windows.map((w) => ({
      label: w.label,
      utilization: w.usedPercent,
      ...(w.resetsAtMs !== undefined ? { resetsAt: new Date(w.resetsAtMs).toISOString() } : {}),
    })),
    capturedAt,
  };
}

/** Takes a proper-lockfile style lock (a directory next to the file) around
 * the tool's own refresh critical section, so a swap never lands mid-refresh. */
async function withToolLock<T>(spec: GrantFileSpec, configDir: string, fn: () => Promise<T>): Promise<T> {
  const { path, staleMs } = spec.toolLock(expandPath(configDir));
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + grantFileTuning.toolLockWaitMs;
  for (;;) {
    try {
      await mkdir(path);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const age = await stat(path).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > staleMs) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new SwapPoolError(`${spec.label} is refreshing its credentials in ${configDir} (lock ${path} busy); try again shortly`);
      await sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

export function createGrantFileAdapter(spec: GrantFileSpec): PoolAdapter {
  const fileOf = (dir: string): string => join(expandPath(dir), ...spec.relPath);
  const readText = (dir: string): Promise<string | undefined> => readFile(fileOf(dir), "utf8").then((t) => t, () => undefined);
  const writeText = async (dir: string, text: string): Promise<void> => {
    await mkdir(dirname(fileOf(dir)), { recursive: true, mode: 0o700 });
    await writeFileAtomic(fileOf(dir), text);
  };
  const load = async (dir: string) => {
    const text = await readText(dir);
    const grant = parseGrantFile(text);
    return { text, grant, who: spec.identity(grant) };
  };

  async function ownerByAccount(members: Identity[], accountId: string, activeName: string | null): Promise<Identity | undefined> {
    const ordered = [...members].sort((a, b) => Number(b.name === activeName) - Number(a.name === activeName));
    for (const member of ordered) if ((await load(member.configDir)).who.id === accountId) return member;
    return undefined;
  }

  /** Writes the pool's grant into the owning member's vault when it is newer. */
  async function writeBackToOwner(owner: Identity, poolGrant: GrantFile, lock?: LockOptions, alreadyLocked = false): Promise<WriteBackOutcome> {
    const poolId = spec.identity(poolGrant).id;
    const locked = <T>(fn: () => Promise<T>) => (alreadyLocked ? fn() : withOauthRefreshLock(owner.configDir, fn, lock));
    // Read and compare under the owner's locks so a concurrent member refresh is never overwritten.
    return locked(() => withToolLock(spec, owner.configDir, async (): Promise<WriteBackOutcome> => {
      const { grant: ownerGrant, who } = await load(owner.configDir);
      if (spec.usable(ownerGrant)) {
        if (who.id !== poolId) return "none-account-mismatch";
        if (spec.fingerprint(ownerGrant!) === spec.fingerprint(poolGrant)) return "none-identical";
      }
      const next = spec.newerInto(spec.usable(ownerGrant) ? ownerGrant : undefined, poolGrant);
      if (!next) return "none-member-newer";
      await writeText(owner.configDir, json(next));
      return "written";
    }));
  }

  async function swapCredentials(input: Parameters<PoolAdapter["swapCredentials"]>[0]): Promise<Omit<SwapResult, "reason">> {
    const { pool, members, target, lock } = input;
    const poolDir = pool.configDir;
    const poolPath = fileOf(poolDir);
    const notes: string[] = [];

    // Lock order: pool, pool oauth, then the target vault, held until the pool write is verified.
    return withOauthRefreshLock(poolDir, () => withOauthRefreshLock(target.configDir, () => withToolLock(spec, poolDir, async () => {
      let target_ = await load(target.configDir);
      if (target_.text === undefined || !spec.usable(target_.grant)) {
        throw new SwapPoolError(`Account "${target.name}" has no usable ${spec.label} login (no OAuth tokens in ${target.configDir}); ${spec.loginHint} first.`);
      }
      if (!target_.who.id) {
        throw new SwapPoolError(`Account "${target.name}" has an inconsistent or unattributable account id in its ${spec.label} credentials; log in again under that identity.`);
      }
      const activeName = pool.swapPool.active ?? null;
      const live = await load(poolDir);

      if (activeName === target.name && live.who.id === target_.who.id && spec.usable(live.grant) && spec.fingerprint(live.grant!) === spec.fingerprint(target_.grant!)) {
        return { pool: pool.name, from: activeName, to: target.name, noop: true, writeBack: "none-identical" as const, notes };
      }

      let writeBack: WriteBackOutcome;
      if (!spec.usable(live.grant)) {
        writeBack = "none-no-live-credentials";
      } else if (live.who.hybrid) {
        writeBack = "none-account-mismatch";
      } else {
        const owner = live.who.id ? await ownerByAccount(members, live.who.id, activeName) : undefined;
        if (!owner) {
          writeBack = "none-unknown-owner";
        } else {
          writeBack = await writeBackToOwner(owner, live.grant!, lock, owner.configDir === target.configDir);
          if (activeName && owner.name !== activeName) notes.push(`pool held "${owner.name}"'s account, not the recorded active "${activeName}"; wrote it back to "${owner.name}"`);
        }
      }
      // A live grant we cannot attribute is never silently destroyed.
      if ((writeBack === "none-unknown-owner" || writeBack === "none-account-mismatch") && live.text !== undefined) {
        const backup = `${poolPath}.pre-swap.bak`;
        await writeFileAtomic(backup, live.text);
        notes.push(`live pool credentials could not be attributed to a member; kept a 0600 copy at ${backup}`);
      }

      // The write-back may have just updated the target's own vault (pool held the target's account): copy the vault as it is now.
      if (writeBack === "written") {
        const refreshed = await load(target.configDir);
        if (refreshed.text !== undefined && spec.usable(refreshed.grant) && refreshed.who.id === target_.who.id) target_ = refreshed;
      }
      await writeText(poolDir, target_.text!);
      const after = (await load(poolDir)).who;
      if (after.id !== target_.who.id) {
        if (live.text !== undefined) await writeText(poolDir, live.text).catch(() => undefined);
        throw new SwapPoolError(`could not verify ${poolPath} after the swap (account id mismatch); the previous file was restored`);
      }
      return { pool: pool.name, from: activeName, to: target.name, noop: false, writeBack, notes };
    }), lock), lock);
  }

  /**
   * Repairs the pool's credential file when it no longer matches the active
   * member's vault. Cases (after one delayed re-read, so a writer that is
   * mid-write is not mistaken for damage):
   *  - empty, partial, unparsable or token-less: restore from the active vault;
   *  - tokens of a different account (a running session refreshed or relogged
   *    after a swap): capture them into the member that owns that account
   *    when newer, else keep a `.pre-heal.bak`, then restore;
   *  - hybrid (parts of the grant name different accounts): `.pre-heal.bak`, restore;
   *  - same account, pool newer: write the newer tokens back to the vault;
   *  - same account, vault newer (a member refresh that missed the pool): copy the vault in.
   * Caller holds the pool lock. Returns human notes for what it did.
   */
  async function heal(pool: PoolIdentity, members: Identity[], lock?: LockOptions): Promise<string[]> {
    const activeName = pool.swapPool.active;
    const active = members.find((m) => m.name === activeName);
    if (!activeName || !active) return [];
    const vault = await load(active.configDir);
    if (vault.text === undefined || !spec.usable(vault.grant) || !vault.who.id) return [`cannot heal ${pool.name}: active account "${activeName}" has no usable login in its vault`];
    const vaultGrant = vault.grant!;

    const poolPath = fileOf(pool.configDir);
    const classify = async () => {
      const cur = await load(pool.configDir);
      const grant = cur.grant;
      const complete = grant !== undefined && spec.usable(grant) && spec.complete(grant);
      let kind: "damaged" | "hybrid" | "foreign" | "same" | "behind" | "ok";
      if (!complete) kind = "damaged";
      else if (cur.who.hybrid) kind = "hybrid";
      else if (!cur.who.id) kind = "damaged";
      else if (cur.who.id !== vault.who.id) kind = "foreign";
      else if (spec.fingerprint(grant!) === spec.fingerprint(vaultGrant)) kind = "ok";
      else if (spec.newerInto(vaultGrant, grant!)) kind = "same";
      else if (spec.newerInto(grant!, vaultGrant)) kind = "behind";
      else kind = "ok";
      return { ...cur, kind } as const;
    };
    let state = await classify();
    if (state.kind !== "ok") {
      await sleep(grantFileTuning.healRetryMs);
      state = await classify();
    }
    if (state.kind === "ok") return [];

    const notes: string[] = [];
    return withOauthRefreshLock(pool.configDir, () => withToolLock(spec, pool.configDir, async () => {
      // Decide on the file as it is under the lock, not as it was before waiting for it.
      let now = await classify();
      if (now.kind === "damaged") {
        await sleep(grantFileTuning.healRetryMs);
        now = await classify();
      }
      if (now.kind === "ok") return [];
      if (now.kind === "same") {
        // Same account as the active vault: never restore over it, keep the newer tokens in the vault.
        const outcome = await writeBackToOwner(active, now.grant!, lock);
        return [`pool ${pool.name} held newer tokens for "${activeName}"; vault write-back: ${outcome}`];
      }
      if (now.kind === "foreign") {
        const owner = await ownerByAccount(members, now.who.id!, activeName);
        if (owner) {
          const outcome = await writeBackToOwner(owner, now.grant!, lock);
          notes.push(`pool ${pool.name} held "${owner.name}"'s account instead of "${activeName}"; ${outcome === "written" ? `captured it into "${owner.name}"` : `left "${owner.name}" as it was (${outcome})`}`);
        } else {
          await writeFileAtomic(`${poolPath}.pre-heal.bak`, now.text!);
          notes.push(`pool ${pool.name} held an account that is not a member; kept a 0600 copy at ${poolPath}.pre-heal.bak`);
        }
      } else if (now.kind === "hybrid") {
        await writeFileAtomic(`${poolPath}.pre-heal.bak`, now.text!);
        notes.push(`pool ${pool.name} credentials were hybrid (parts disagree on the account); kept a 0600 copy at ${poolPath}.pre-heal.bak`);
      } else if (now.kind === "behind") {
        notes.push(`pool ${pool.name} was behind the vault of "${activeName}" (a member refresh missed it)`);
      } else {
        notes.push(`pool ${pool.name} credentials were empty or partial`);
      }
      // Re-read the vault under the pool lock: a write-back above may have merged newer tokens into it.
      const restoreText = (await readText(active.configDir)) ?? vault.text!;
      await writeText(pool.configDir, restoreText);
      notes.push(`restored "${activeName}" into ${pool.name}`);
      return notes;
    }), lock);
  }

  return {
    tool: spec.tool,
    config: spec.config,
    liveSwap: spec.liveSwap,
    hasCredentials: (configDir) => {
      try {
        return spec.usable(parseGrantFile(readFileSync(fileOf(configDir), "utf8")));
      } catch {
        return false;
      }
    },
    swapCredentials,
    heal,
    memberProblem: (member) => {
      let text: string | undefined;
      try {
        text = readFileSync(fileOf(member.configDir), "utf8");
      } catch {
        text = undefined;
      }
      const grant = parseGrantFile(text);
      if (!spec.usable(grant)) return `"${member.name}" has no ${spec.label} OAuth login (${spec.loginHint})`;
      if (!spec.identity(grant).id) return `"${member.name}" has an inconsistent or unattributable account id in its ${spec.label} credentials`;
      return undefined;
    },
    fetchUsage: async (member, deps) => {
      try {
        return await spec.fetchUsage(member, deps);
      } catch (err) {
        return { status: "unavailable", error: err instanceof Error ? err.message : String(err), capturedAt: new Date().toISOString() };
      }
    },
  };
}
