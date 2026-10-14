import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { LimitWindow } from "../../cli/limits/types.ts";
import { lockOrder, withOauthRefreshLock } from "../claude-swap-lock.ts";
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
 *    files, keeping a 0600 `.pre-heal.<stamp>.bak` of anything it cannot attribute.
 * What differs per tool is supplied by a `GrantFileSpec`.
 */

export type GrantFile = Record<string, unknown>;

/** "same": the pool file belongs to the member it is written back to (every part of it is that
 * member's), so everything newer goes back. "capture": the pool holds that member's account next
 * to parts that may belong to another one, so only the account-bearing part may move. */
export type WriteBackMode = "same" | "capture";

const BACKUPS_KEPT = 10;

/** Writes `text` to a new `<file>.pre-<kind>.<stamp>.bak` (0600) and keeps the newest few per kind. */
async function writeBackup(file: string, kind: "swap" | "heal", text: string): Promise<string> {
  const stamp = `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomBytes(2).toString("hex")}`;
  const path = `${file}.pre-${kind}.${stamp}.bak`;
  await writeFileAtomic(path, text);
  const prefix = `${basename(file)}.pre-${kind}.`;
  const old = (await readdir(dirname(file)).catch(() => [] as string[])).filter((n) => n.startsWith(prefix) && n.endsWith(".bak")).sort();
  for (const name of old.slice(0, Math.max(0, old.length - BACKUPS_KEPT))) await rm(join(dirname(file), name), { force: true });
  return path;
}

export const grantFileTuning = {
  /** Wait before re-reading a pool file that looks damaged (a writer may be mid-write). */
  healRetryMs: 200,
  /** How long to wait for the tool's own credential lock before giving up. */
  toolLockWaitMs: 3_000,
  /** How often a held tool lock's mtime is refreshed; default half its stale time, at most 5s. */
  toolLockUpdateMs: undefined as number | undefined,
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
  newerInto(owner: GrantFile | undefined, pool: GrantFile, mode: WriteBackMode): GrantFile | undefined;
  /** The pool holds content the vault lacks that a restore or swap would
   * drop and no write-back carries over (logins made inside the pool, edited
   * static keys). Optional: a single-grant file has none. */
  hasPoolOnlyContent?(pool: GrantFile, vault: GrantFile | undefined): boolean;
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

/** Takes a proper-lockfile style lock (a directory) around a critical
 * section. Like proper-lockfile, the holder keeps the lock's mtime fresh (the
 * tool breaks locks older than its stale time). Ownership is an owner token
 * (pid plus random) written inside the directory: on release only a lock that
 * still carries our token is removed, so a lock the tool broke and re-took is
 * left alone. */
export async function withLockDir<T>(path: string, staleMs: number, label: string, fn: () => Promise<T>): Promise<T> {
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
      if (Date.now() >= deadline) throw new SwapPoolError(`${label} (lock ${path} busy); try again shortly`);
      await sleep(50);
    }
  }
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const tokenPath = `${path}.owner`; // beside the lock dir: the tool's own cleanup of the dir must stay a plain rmdir
  await writeFile(tokenPath, token).catch(() => undefined);
  // Ownership = our token AND the very directory we created (inode plus birth time): a lock the tool broke
  // and re-took is a different directory even though our sibling token file is still there.
  const identOf = async () => stat(path).then((s) => `${s.ino}:${s.birthtimeMs}`, () => "");
  const ident = await identOf();
  const owned = async () => (await readFile(tokenPath, "utf8").then((t) => t === token, () => false)) && (await identOf()) === ident;
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void owned().then((ok) => (ok ? utimes(path, new Date(), new Date()).catch(() => undefined) : undefined)).finally(() => { busy = false; });
  }, grantFileTuning.toolLockUpdateMs ?? Math.min(staleMs / 2, 5_000));
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    while (busy) await sleep(5);
    if (await owned()) await Promise.all([rm(path, { recursive: true, force: true }), rm(tokenPath, { force: true })]);
  }
}

/** The tool's own refresh lock around a critical section, so a swap never lands mid-refresh. */
export function withToolLock<T>(spec: GrantFileSpec, configDir: string, fn: () => Promise<T>): Promise<T> {
  const { path, staleMs } = spec.toolLock(expandPath(configDir));
  return withLockDir(path, staleMs, `${spec.label} is refreshing its credentials in ${configDir}`, fn);
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

  /** Writes the pool's grant into the owning member's vault when it is newer.
   * The caller holds the owner's oauth and tool locks (see `withHeldLocks`), so the read
   * and compare below can never overwrite a concurrent member refresh. */
  async function writeBackToOwner(owner: Identity, poolGrant: GrantFile, mode: WriteBackMode): Promise<WriteBackOutcome> {
    const poolId = spec.identity(poolGrant).id;
    const { grant: ownerGrant, who } = await load(owner.configDir);
    if (spec.usable(ownerGrant)) {
      if (who.id !== poolId) return "none-account-mismatch";
      if (spec.fingerprint(ownerGrant!) === spec.fingerprint(poolGrant)) return "none-identical";
    }
    const next = spec.newerInto(spec.usable(ownerGrant) ? ownerGrant : undefined, poolGrant, mode);
    if (!next) return "none-member-newer";
    await writeText(owner.configDir, json(next));
    return "written";
  }

  /** Two-tier lock order, as refresh: the pool dir first, then the member set in `lockOrder`.
   * Each dir's tool lock is taken right after its own oauth lock, by this outer layer only. */
  function withHeldLocks<T>(poolDir: string, held: Set<string>, lock: LockOptions | undefined, fn: () => Promise<T>): Promise<T> {
    const poolKey = resolve(expandPath(poolDir));
    const dirs = lockOrder([...held]).filter((d) => d !== poolKey);
    const layer = <R>(dir: string, inner: () => Promise<R>) => withOauthRefreshLock(dir, () => withToolLock(spec, dir, inner), lock);
    const nest = (rest: string[]): Promise<T> => (rest.length === 0 ? fn() : layer(rest[0]!, () => nest(rest.slice(1))));
    return layer(poolDir, () => nest(dirs));
  }

  async function swapCredentials(input: Parameters<PoolAdapter["swapCredentials"]>[0]): Promise<Omit<SwapResult, "reason">> {
    const { pool, members, target, lock } = input;
    const poolDir = pool.configDir;
    const poolPath = fileOf(poolDir);
    const notes: string[] = [];

    // Two-tier order, same as refresh: the pool dir first, then target vault and write-back owner in
    // `lockOrder`, held until the pool write is verified. The owner is only known under the lock: if it is
    // outside the held set, release, widen the member set and go again (nothing is written before that point).
    const wanted = [target.configDir];
    const activeMember = members.find((m) => m.name === pool.swapPool.active);
    if (activeMember) wanted.push(activeMember.configDir);
    for (;;) {
      const held = new Set(lockOrder([poolDir, ...wanted]));
      const result = await swapHeld(held);
      if ("needLock" in result) { wanted.push(result.needLock); continue; }
      return result;
    }

    async function swapHeld(held: Set<string>): Promise<Omit<SwapResult, "reason"> | { needLock: string }> {
    return withHeldLocks(poolDir, held, lock, async () => {
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
        if (owner && !held.has(resolve(expandPath(owner.configDir)))) return { needLock: owner.configDir };
        if (!owner) {
          writeBack = "none-unknown-owner";
        } else {
          writeBack = await writeBackToOwner(owner, live.grant!, owner.name === activeName ? "same" : "capture");
          if (activeName && owner.name !== activeName) notes.push(`pool held "${owner.name}"'s account, not the recorded active "${activeName}"; wrote it back to "${owner.name}"`);
        }
      }
      // A live grant we cannot attribute, or pool-only content no write-back carries over, is never silently destroyed.
      let poolOnly = false;
      if (spec.hasPoolOnlyContent && live.grant && live.who.id && !live.who.hybrid) {
        const owner = members.find((m) => m.name === (activeName ?? target.name));
        const vault = owner ? (await load(owner.configDir)).grant : undefined;
        poolOnly = spec.hasPoolOnlyContent(live.grant, vault);
      }
      if ((poolOnly || writeBack === "none-unknown-owner" || writeBack === "none-account-mismatch") && live.text !== undefined) {
        const backup = await writeBackup(poolPath, "swap", live.text);
        notes.push(`live pool credentials ${poolOnly ? "hold entries the member lacks" : "could not be attributed to a member"}; kept a 0600 copy at ${backup}`);
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
    });
    }
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
    let vault = await load(active.configDir);
    if (vault.text === undefined || !spec.usable(vault.grant) || !vault.who.id) return [`cannot heal ${pool.name}: active account "${activeName}" has no usable login in its vault`];
    if (!spec.complete(vault.grant)) return [`cannot heal ${pool.name}: active account "${activeName}" has an incomplete login in its vault (not restoring from it)`];

    const poolPath = fileOf(pool.configDir);
    const classify = async () => {
      const cur = await load(pool.configDir);
      const grant = cur.grant;
      const vaultGrant = vault.grant!;
      const complete = grant !== undefined && spec.usable(grant) && spec.complete(grant);
      let kind: "damaged" | "hybrid" | "foreign" | "same" | "behind" | "ok";
      if (!complete) kind = "damaged";
      else if (cur.who.hybrid) kind = "hybrid";
      else if (!cur.who.id) kind = "damaged";
      else if (cur.who.id !== vault.who.id) kind = "foreign";
      else if (spec.fingerprint(grant!) === spec.fingerprint(vaultGrant)) kind = "ok";
      else if (spec.newerInto(vaultGrant, grant!, "same")) kind = "same";
      else if (spec.newerInto(grant!, vaultGrant, "same")) kind = "behind";
      else kind = "ok";
      return { ...cur, kind } as const;
    };
    let state = await classify();
    if (state.kind !== "ok") {
      await sleep(grantFileTuning.healRetryMs);
      state = await classify();
    }
    if (state.kind === "ok") return [];

    // Two-tier order, same as refresh: the pool dir first, then the active vault and a foreign capture
    // owner in `lockOrder`; an owner outside the held set is only known under the lock, so release,
    // widen the member set and go again (nothing written yet).
    const wanted = [active.configDir];
    for (;;) {
      const held = new Set(lockOrder([pool.configDir, ...wanted]));
      const result = await healHeld(held);
      if (!Array.isArray(result)) { wanted.push(result.needLock); continue; }
      return result;
    }

    async function healHeld(held: Set<string>): Promise<string[] | { needLock: string }> {
    const notes: string[] = [];
    let backedUp = false;
    return withHeldLocks(pool.configDir, held, lock, async () => {
      // Decide on the files as they are under the locks, not as they were before waiting for them.
      vault = await load(active!.configDir);
      if (vault.text === undefined || !spec.usable(vault.grant) || !vault.who.id) return [`cannot heal ${pool.name}: active account "${activeName}" has no usable login in its vault`];
      if (!spec.complete(vault.grant)) return [`cannot heal ${pool.name}: active account "${activeName}" has an incomplete login in its vault (not restoring from it)`];
      let now = await classify();
      if (now.kind === "damaged") {
        await sleep(grantFileTuning.healRetryMs);
        now = await classify();
      }
      if (now.kind === "ok") return [];
      if (now.kind === "same") {
        // Same account as the active vault: never restore over it, keep the newer tokens in the vault.
        const outcome = await writeBackToOwner(active!, now.grant!, "same");
        return [`pool ${pool.name} held newer tokens for "${activeName}"; vault write-back: ${outcome}`];
      }
      if (now.kind === "foreign") {
        const owner = await ownerByAccount(members, now.who.id!, activeName!);
        if (owner && !held.has(resolve(expandPath(owner.configDir)))) return { needLock: owner.configDir };
        if (owner) {
          const outcome = await writeBackToOwner(owner, now.grant!, "capture");
          notes.push(`pool ${pool.name} held "${owner.name}"'s account instead of "${activeName}"; ${outcome === "written" ? `captured it into "${owner.name}"` : `left "${owner.name}" as it was (${outcome})`}`);
        } else {
          backedUp = true;
          notes.push(`pool ${pool.name} held an account that is not a member; kept a 0600 copy at ${await writeBackup(poolPath, "heal", now.text!)}`);
        }
      } else if (now.kind === "hybrid") {
        backedUp = true;
        notes.push(`pool ${pool.name} credentials were hybrid (parts disagree on the account); kept a 0600 copy at ${await writeBackup(poolPath, "heal", now.text!)}`);
      } else if (now.kind === "behind") {
        notes.push(`pool ${pool.name} was behind the vault of "${activeName}" (a member refresh missed it)`);
      } else {
        notes.push(`pool ${pool.name} credentials were empty or partial`);
      }
      // Anything a restore would drop and no write-back kept (damaged but non-empty, pool-only entries) gets a backup first.
      const dropsContent = now.kind === "damaged" ? now.text !== undefined && now.text.trim() !== "" : now.grant !== undefined && spec.hasPoolOnlyContent?.(now.grant, vault.grant) === true;
      if (!backedUp && dropsContent) {
        notes.push(`pool ${pool.name} credentials held content the vault lacks; kept a 0600 copy at ${await writeBackup(poolPath, "heal", now.text!)}`);
      }
      // Re-read the vault: a write-back above may have merged newer tokens into it.
      const restoreText = (await readText(active!.configDir)) ?? vault.text!;
      await writeText(pool.configDir, restoreText);
      notes.push(`restored "${activeName}" into ${pool.name}`);
      return notes;
    });
    }
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
