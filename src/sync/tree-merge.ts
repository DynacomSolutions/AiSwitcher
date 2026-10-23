import { copyFile, mkdir, open, readdir, readFile, readlink, realpath, rename, stat, utimes, writeFile } from "node:fs/promises";
import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { isRetired } from "../identities/retired.ts";
import { credentialPathsForTool } from "../identities/credential-paths.ts";
import { expandPath } from "../identities/match.ts";
import {
  CRUSH_PROVIDER_FOR_TOOL,
  PI_PROVIDER_FOR_TOOL,
  piRegistryFor,
  purgeRetiredIdentityCredentials,
  removeFile,
  stripCrushApiKey,
  stripPiEntry,
  type PurgeOptions,
  type PurgeReport,
} from "../identities/retire-credentials.ts";
import { SwapLockError, withClaudeLocks } from "../identities/claude-swap-lock.ts";
import type { LockOptions } from "../identities/pool/lock.ts";
import { writeFileAtomic } from "../identities/pool/fs.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile } from "../identities/store.ts";
import type { ToolConfig } from "../identities/types.ts";
import { aisRemoteCacheDir } from "../shared/ais-home.ts";
import { mergeJsonlFiles, mergeJsonlTail } from "./dedupe.ts";
import { listHistories, PrefixCache, hashPrefix, TAIL_MIN_BYTES, TAIL_PLAN_FILE, type HistoryManifest, type TailPlan } from "./tail-sync.ts";
import { mergeRegistryConflict } from "./registry.ts";
import { isDeepStrictEqual } from "node:util";
import { SYNC_TOOL_CONFIGS } from "./rsync.ts";
import type { SyncScope } from "./types.ts";

export interface TreeMergeResult {
  mergedJsonlFiles: number;
  copiedFiles: number;
  preservedConflicts: number;
  preservedConflictPaths: string[];
  /** Logs skipped only because a native process owns them; not copied, re-staged next run. */
  busyPaths: string[];
  /** Paths this user cannot re-time or overwrite (root-owned); sync excludes them from later runs. */
  deniedPaths?: string[];
  /** Tail transfers whose prefix did not match: the sender must stage these histories whole. */
  needsFull?: string[];
}

export interface ArchiveRecoveryResult extends TreeMergeResult {
  archiveRoots: number;
}

interface ProfileMergeLock { readonly home: string }
const heldMergeLocks = new WeakSet<ProfileMergeLock>();

/** Serialise all receivers of one destination tree, including staging deletion.
 * Keep the lock file: unlinking it would let waiters lock different inodes. */
export async function withProfileMergeLock<T>(home: string, action: (lock: ProfileMergeLock) => Promise<T>): Promise<T> {
  const canonicalHome = await realpath(home);
  const state = aisRemoteCacheDir(canonicalHome);
  await mkdir(state, { recursive: true });
  const symbols = { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } } as const;
  const libraries = process.platform === "darwin"
    ? ["/usr/lib/libSystem.B.dylib"]
    : [["libc", "so", "6"].join("."), ["libc", "so"].join(".")];
  const load = () => {
    try { return dlopen(libraries[0]!, symbols); }
    catch (error) { if (!libraries[1]) throw error; return dlopen(libraries[1], symbols); }
  };
  const native = load();
  try {
    const handle = await open(join(state, "profile-merge.lock"), "a", 0o600);
    const lock = { home: canonicalHome };
    try {
      const deadline = Date.now() + 30_000;
      // LOCK_EX | LOCK_NB avoids blocking the event loop while another merge
      // in this process (or a separate receiver) is flushing its archives.
      while (native.symbols.flock(handle.fd, 2 | 4) !== 0) {
        if (Date.now() >= deadline) throw new Error("Timed out acquiring the profile merge lock");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      heldMergeLocks.add(lock);
      return await action(lock);
    } finally {
      heldMergeLocks.delete(lock);
      await handle.close(); // Closing releases flock even if the merge failed.
    }
  } finally { native.close(); }
}

function slash(path: string): string {
  return path.split(sep).join("/");
}

function pathWithin(root: string, path: string): string | undefined {
  const rel = slash(relative(root, path));
  if (!rel || rel === ".." || rel.startsWith("../")) return undefined;
  return rel;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function* walkFiles(root: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walkFiles(path);
    else if (entry.isFile()) yield path;
    // Symlinks from another machine are neither portable nor safe merge
    // targets. The incoming snapshot remains intact for manual recovery.
  }
}

const EQUAL_CHUNK = 1 << 20;

/** Chunked comparison: never holds a whole file in memory and stops at the first difference.
 * Same size and mtime counts as equal without reading (rsync's own quick check), unless trustMtime is off (JSONL tails). */
async function filesEqual(a: string, b: string, trustMtime = true): Promise<boolean> {
  const [aStat, bStat] = await Promise.all([stat(a), stat(b)]);
  if (aStat.size !== bStat.size) return false;
  if (trustMtime && aStat.mtimeMs === bStat.mtimeMs) return true;
  const [ha, hb] = [await open(a, "r"), await open(b, "r")];
  try {
    const [bufA, bufB] = [Buffer.allocUnsafe(EQUAL_CHUNK), Buffer.allocUnsafe(EQUAL_CHUNK)];
    for (let offset = 0; offset < aStat.size; offset += EQUAL_CHUNK) {
      const [ra, rb] = await Promise.all([ha.read(bufA, 0, EQUAL_CHUNK, offset), hb.read(bufB, 0, EQUAL_CHUNK, offset)]);
      if (ra.bytesRead !== rb.bytesRead || !bufA.subarray(0, ra.bytesRead).equals(bufB.subarray(0, rb.bytesRead))) return false;
      if (ra.bytesRead === 0) break;
    }
    return true;
  } finally { await Promise.all([ha.close(), hb.close()]); }
}

async function endsWithNewlineOrEmpty(path: string, size: number): Promise<boolean> {
  if (size === 0) return true;
  const handle = await open(path, "r");
  try {
    const byte = Buffer.alloc(1);
    await handle.read(byte, 0, 1, size - 1);
    return byte[0] === 0x0a;
  } finally { await handle.close(); }
}

interface FsOps {
  utimes: typeof utimes;
  copyFile: typeof copyFile;
}
const nativeFsOps: FsOps = { utimes, copyFile };
let fsOps = nativeFsOps;
/** Test hook: inject filesystem failures such as EPERM on root-owned files. */
export function setFsOps(ops?: Partial<FsOps>): void { fsOps = { ...nativeFsOps, ...ops }; }

/** Root-owned (or otherwise read-only to this user) files cannot be re-timed or overwritten.
 * Warn per file and carry on: failing the whole sync would re-stage everything next run. */
async function tolerateDenied(rel: string, action: () => Promise<void>, denied?: string[]): Promise<boolean> {
  try { await action(); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EACCES") throw error;
    denied?.push(rel);
    console.warn(`AIS sync skipped ${rel}: ${code} (not writable by this user, e.g. root-owned); left unchanged.`);
    return false;
  }
}

/** Byte-identical files must also agree on mtime, or rsync's size+mtime quick
 * check re-stages them every run. Only the mtime moves, never the contents. */
async function convergeMtime(source: string, destination: string, rel: string, denied?: string[]): Promise<void> {
  const [sourceStat, destinationStat] = await Promise.all([stat(source), stat(destination)]);
  if (sourceStat.mtimeMs > destinationStat.mtimeMs) {
    await tolerateDenied(rel, () => fsOps.utimes(destination, destinationStat.atime, sourceStat.mtime), denied);
  }
}

/** copyFile stamps "now" on the copy. The sender then differs from the receiver in rsync's
 * size+mtime quick check, so every copied file was staged and compared again on the next run. */
async function copyKeepingMtime(source: string, destination: string): Promise<void> {
  await fsOps.copyFile(source, destination);
  const info = await stat(source);
  // rsync's quick check compares whole seconds: a same-size rewrite within the source's second would never resync.
  await fsOps.utimes(destination, info.atime, Date.now() - info.mtimeMs >= 2000 ? info.mtime : new Date());
}

/** After a JSONL merge both hosts hold the same set of lines, but a different order or append time:
 * same size, different mtime, so the file was re-staged and re-read on every run. Equal size after a
 * merge that added nothing missing means equal content, so adopting the sender's mtime is safe. */
async function alignMergedMtime(source: string, destination: string, rel: string, denied?: string[]): Promise<void> {
  const [sourceStat, destinationStat] = await Promise.all([stat(source), stat(destination)]);
  if (sourceStat.size !== destinationStat.size || Math.floor(sourceStat.mtimeMs / 1000) === Math.floor(destinationStat.mtimeMs / 1000)) return;
  await tolerateDenied(rel, () => fsOps.utimes(destination, destinationStat.atime, sourceStat.mtime), denied);
}

/** Equal mtimes with different content (for example files provisioned with preserved timestamps) used to
 * keep each host's own version and preserve the other, forever. Both hosts must pick the same winner:
 * the larger file, then the greater digest. */
async function sourceWinsTie(source: string, destination: string): Promise<boolean> {
  const [a, b] = await Promise.all([stat(source), stat(destination)]);
  if (a.size !== b.size) return a.size > b.size;
  const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
  return (await digest(source)) > (await digest(destination));
}

/** Machine-local, regenerated state: the newest copy wins and nothing is preserved or counted as a conflict.
 * Credentials are in it deliberately: every host refreshes its own OAuth tokens, and an archived stale token is a
 * liability rather than a recovery aid. */
const VOLATILE_STATE = /(?:^|\/)(?:\.last-cleanup|\.last-update-result\.json|settings_cache\.json|[^/]+\.(?:signature|stamp)\.json|[^/]+\.synced-at|\.grok\/identities\/[^/]+\/sessions\/.+\/summary\.json)$|(?:^|\/)identities\/[^/]+\/(?:\.credentials\.json|credentials\.json|auth\.(?:json|toml)|credentials\/kimi-code\.json|(?:data\/)?opencode\/auth\.json)$/;

/** Content digests already archived per path, so a conflict whose losing copy was preserved before is neither
 * archived nor counted again. Without it a file both hosts keep rewriting reports itself on every run. */
class ConflictLedger {
  private dirty = false;
  private constructor(private readonly file: string, private readonly seen: Record<string, string[]>) {}
  static async load(home: string): Promise<ConflictLedger> {
    const file = join(aisRemoteCacheDir(home), "merge-conflict-seen.json");
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, string[]>;
      return new ConflictLedger(file, raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {});
    } catch { return new ConflictLedger(file, {}); }
  }
  /** True when this loser content is new for `rel`; it is recorded. */
  async isNew(rel: string, loser: string): Promise<boolean> {
    const digest = createHash("sha256").update(await readFile(loser)).digest("hex");
    const list = this.seen[rel] ?? [];
    if (list.includes(digest)) return false;
    this.seen[rel] = [...list, digest].slice(-8);
    this.dirty = true;
    return true;
  }
  async save(): Promise<void> {
    if (!this.dirty) return;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFileAtomic(this.file, JSON.stringify(this.seen));
    this.dirty = false;
  }
}

/** Keys Claude Code rewrites by itself on every host (counters, tips, cached flags): merged key by key, newest first. */
const SELF_CHANGING_CLAUDE_KEYS = /^(?:numStartups|tipsHistory|lastReleaseNotesSeen|promptQueueUseCount|firstStartTime|pluginUsage|changelogLastFetched|cached.*|.*Cache.*)$/;

let claudeLockOptions: LockOptions = {};
/** Test hook: shorten the `.claude.json` lock wait (no argument restores the default). */
export function setClaudeLockOptions(options: LockOptions = {}): void { claudeLockOptions = options; }

/** Claude Code stamps `last*` figures (cost, duration, session id, token counts) into every project entry of
 * `.claude.json` at the end of each session; two hosts running sessions always differ there. */
function withoutSessionStats(key: string, value: unknown): unknown {
  if (key !== "projects" || typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([path, entry]) => [path,
    typeof entry === "object" && entry !== null && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).filter(([k]) => !/^last[A-Z]/.test(k))) : entry]));
}

/** A per-identity `.claude.json` is rewritten constantly by every running Claude Code on every host. Self-changing
 * keys merge key by key; every other key follows the newest file whole (deletions included) and, when the older
 * file held a different value, that file is preserved and counted as a conflict. */
async function mergeClaudeJson(source: string, destination: string, rel: string, conflictRoot: string, result: TreeMergeResult, ledger: ConflictLedger): Promise<boolean> {
  const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const read = async (path: string): Promise<Record<string, unknown> | undefined> => {
    try { const v = JSON.parse(await readFile(path, "utf8")); return plain(v) ? v : undefined; } catch { return undefined; }
  };
  if (!(await read(source)) || !(await read(destination))) return false;
  await tolerateDenied(rel, () => withClaudeLocks(dirname(destination), async () => {
    // Re-read under the lock: Claude Code may have rewritten the live file meanwhile.
    const [incoming, live] = await Promise.all([read(source), read(destination)]);
    if (!incoming || !live) return;
    const [sourceStat, destinationStat] = await Promise.all([stat(source), stat(destination)]);
    const sourceWins = sourceStat.mtimeMs !== destinationStat.mtimeMs ? sourceStat.mtimeMs > destinationStat.mtimeMs : await sourceWinsTie(source, destination);
    const [winner, loser] = sourceWins ? [incoming, live] : [live, incoming];
    const merged: Record<string, unknown> = { ...winner };
    const differing: string[] = [];
    for (const [key, value] of Object.entries(loser)) {
      if (SELF_CHANGING_CLAUDE_KEYS.test(key)) { if (!(key in winner)) merged[key] = value; }
      else if (!isDeepStrictEqual(withoutSessionStats(key, value), withoutSessionStats(key, winner[key]))) differing.push(key);
    }
    if (differing.length > 0) {
      console.warn(`AIS sync ${rel} differs in: ${differing.join(", ")}`);
      const loserPath = sourceWins ? destination : source;
      if (await ledger.isNew(rel, loserPath)) {
        await preserveFile(loserPath, conflictRoot, sourceWins ? "local" : "incoming", rel);
        result.preservedConflicts++;
        result.preservedConflictPaths.push(rel);
      }
    }
    if (sourceWins && isDeepStrictEqual(merged, incoming)) await copyKeepingMtime(source, destination);
    else if (isDeepStrictEqual(merged, live)) return;
    else {
      await writeFileAtomic(destination, `${JSON.stringify(merged, null, 2)}\n`);
      await fsOps.utimes(destination, destinationStat.atime, new Date(Math.max(sourceStat.mtimeMs, destinationStat.mtimeMs)));
    }
  }, claudeLockOptions).catch((error) => {
    // A busy Claude Code session must not abort the sync: leave the file alone and merge next time.
    if (!(error instanceof SwapLockError && error.timedOut)) throw error;
    console.warn(`.claude.json for ${basename(dirname(rel))} busy; will merge next sync`);
  }), result.deniedPaths);
  return true;
}

// A hung lsof is killed; the lookup then falls back to /proc or reports unknown (callers treat unknown as open).
const LSOF_TIMEOUT_MS = 5000;
// Per-file checks are cheapest for small merges; past this many lookups in one
// pass a single snapshot of all open files wins (a lookup can cost ~1.4s on a busy host,
// so 32 per-file lsof runs blew a 30s budget).
const PER_FILE_LOOKUPS = 4;
interface OpenPathSnapshot { paths: Set<string> }
type OpenPaths = Set<string> | OpenPathSnapshot;
export type OpenPathsScanner = (signal: AbortSignal) => Promise<OpenPaths | undefined>;
let openScanner: OpenPathsScanner = scanOpenPaths;
let openScanTimeoutMs = LSOF_TIMEOUT_MS;
/** Test hook: swap the snapshot scanner (no argument restores the real one). */
export function setOpenScanner(scanner?: OpenPathsScanner, timeoutMs = LSOF_TIMEOUT_MS): void {
  openScanner = scanner ?? scanOpenPaths;
  openScanTimeoutMs = timeoutMs;
}

function lsofBinary(): string | undefined {
  return Bun.which("lsof", { PATH: process.env.PATH ?? "" }) ?? (process.platform === "darwin" && existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : undefined);
}

interface ProcReader {
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string>;
  readFile(path: string): Promise<string>;
}
const nativeProcReader: ProcReader = { readdir, readlink, readFile: (path) => readFile(path, "utf8") };
let procReader = nativeProcReader;
/** Test hook: inject filesystem observations while retaining the real /proc scan. */
export function setProcReader(reader?: ProcReader): void { procReader = reader ?? nativeProcReader; }

async function procOpenPaths(signal: AbortSignal, ownDescriptor?: number): Promise<OpenPathSnapshot | undefined> {
  const reader = procReader;
  let processDirs: string[];
  try {
    processDirs = (await reader.readdir("/proc")).filter((name) => /^\d+$/.test(name));
  } catch {
    return undefined;
  }
  const paths = new Set<string>();
  for (const pid of processDirs) {
    if (signal.aborted) return undefined;
    let fds: string[];
    try {
      fds = await reader.readdir(join("/proc", pid, "fd"));
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      // An unreadable fd directory belongs to another user or a privileged process. Our tools run as us and are
      // readable, so it cannot own our files; letting it turn the whole answer into "unknown" deferred every history.
      if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      return undefined;
    }
    for (const fd of fds) {
      if (signal.aborted) return undefined;
      if (pid === String(process.pid) && fd === String(ownDescriptor)) continue;
      try {
        paths.add((await reader.readlink(join("/proc", pid, "fd", fd))).replace(/ \(deleted\)$/, ""));
      } catch (error) {
        // Processes and descriptors can disappear while /proc is read.
        if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
      }
    }
  }
  return { paths };
}

async function snapshotHasOwner(snapshot: OpenPaths | undefined, path: string): Promise<boolean | undefined> {
  if (!snapshot) return undefined;
  if (snapshot instanceof Set) return snapshot.has(path);
  if (snapshot.paths.has(path)) return true;
  return false;
}

async function lsofOpenPaths(signal: AbortSignal): Promise<Set<string> | undefined> {
  const lsof = lsofBinary();
  if (!lsof) return undefined;
  const proc = Bun.spawn([lsof, "-Fn"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: LSOF_TIMEOUT_MS, signal });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  // lsof exits non-zero on unreadable processes yet still lists the rest;
  // empty output (a live host always has open files) means it failed.
  if (signal.aborted || (exitCode !== 0 && exitCode !== 1) || !stdout.trim()) return undefined;
  const paths = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (line.startsWith("n/")) paths.add(line.slice(1).replace(/ \(deleted\)$/, ""));
  }
  return paths;
}

// /proc is several times faster than lsof on a host with thousands of processes.
async function scanOpenPaths(signal: AbortSignal): Promise<OpenPaths | undefined> {
  return process.platform === "linux" ? procOpenPaths(signal) : lsofOpenPaths(signal);
}

async function boundedOpenScan(scanner: OpenPathsScanner = openScanner): Promise<OpenPaths | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => scanner(controller.signal)),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(undefined); }, openScanTimeoutMs);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

type DirectOwnerProbe = (path: string, ownDescriptor?: number) => Promise<boolean | undefined>;
let directOwnerProbe: DirectOwnerProbe | undefined;
/** Test hook: replace the per-file lsof or /proc lookup (no argument restores it). */
export function setDirectOwnerProbe(probe?: DirectOwnerProbe): void { directOwnerProbe = probe; }

async function hasOpenOwnerDirect(path: string, ownDescriptor?: number): Promise<boolean | undefined> {
  if (directOwnerProbe) return directOwnerProbe(path, ownDescriptor);
  const lsof = lsofBinary();
  if (lsof) {
    const proc = Bun.spawn([lsof, "-Fpf", path], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: LSOF_TIMEOUT_MS });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    let pid: number | undefined;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      // Ignore only this merge's descriptor, never the whole process: another
      // descriptor in the same process may belong to a native writer.
      if (line.startsWith("f") && (pid !== process.pid || line.slice(1) !== String(ownDescriptor))) return true;
    }
    if (exitCode === 0 || exitCode === 1) return false;
  }
  if (process.platform !== "linux") return undefined;
  const paths = await boundedOpenScan((signal) => procOpenPaths(signal, ownDescriptor));
  return snapshotHasOwner(paths, path);
}

/** The final write guard must be fresh even when the pass used its snapshot.
 * Only actual appends pay for this extra lookup, excluding our own handle. */
export async function hasOpenOwnerBeforeWrite(path: string, ownDescriptor: number): Promise<boolean | undefined> {
  try { return await hasOpenOwnerDirect(await realpath(path), ownDescriptor); }
  catch { return undefined; }
}

/** Per-merge-pass lookup state: the first lookups are per-file, later ones use one snapshot. */
export interface OpenOwnerPass {
  lookups: number;
  snapshot?: Promise<OpenPaths | undefined>;
  /** Answers already settled for this pass by prefetchOpenOwners (real path -> open by some process). */
  known?: Map<string, boolean>;
}

export async function hasOpenOwner(path: string, pass: OpenOwnerPass = { lookups: PER_FILE_LOOKUPS }): Promise<boolean | undefined> {
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : undefined;
  }
  const settled = pass.known?.get(real);
  if (settled !== undefined) return settled;
  if (pass.lookups++ < PER_FILE_LOOKUPS) return hasOpenOwnerDirect(real);
  // Each pass gets one fresh, bounded snapshot after its per-file budget.
  // A successful scan can distinguish closed files from busy ones; failure
  // remains unknown. Never carry a previous pass's misses into a new merge.
  pass.snapshot ??= boundedOpenScan();
  return snapshotHasOwner(await pass.snapshot, real);
}

const PREFETCH_TIMEOUT_MS = 60_000;
const PREFETCH_CHUNK = 400;

/** Settle ownership of many files with a few lsof runs, one per chunk of names. Asking per file costs a full
 * process scan each (seconds on a busy host), and a /proc snapshot can time out or be blocked by unreadable
 * processes; either left every file after the first few "busy" on every run. Failure leaves `pass` untouched. */
export async function prefetchOpenOwners(paths: string[], pass: OpenOwnerPass): Promise<void> {
  const lsof = lsofBinary();
  // A handful of files is cheaper through the per-file lookups.
  if (!lsof || paths.length <= PER_FILE_LOOKUPS) return;
  const reals = new Set<string>();
  for (const path of paths) { try { reals.add(await realpath(path)); } catch { /* gone: asked again, answered false */ } }
  const list = [...reals];
  const known = new Map(pass.known);
  for (let i = 0; i < list.length; i += PREFETCH_CHUNK) {
    const chunk = list.slice(i, i + PREFETCH_CHUNK);
    const proc = Bun.spawn([lsof, "-Fn", "--", ...chunk], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: PREFETCH_TIMEOUT_MS });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    // 0: some are open; 1: none are (lsof also exits 1 when it could not read some processes). Anything else is a failure.
    if (exitCode !== 0 && exitCode !== 1) return;
    const open = new Set(stdout.split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1).replace(/ \(deleted\)$/, "")));
    for (const real of chunk) known.set(real, open.has(real));
  }
  pass.known = known;
}

function configsForScope(scope: SyncScope): ToolConfig[] {
  return scope.kind === "all" ? SYNC_TOOL_CONFIGS : [scope.cfg];
}

function registryRelPaths(scope: SyncScope, home: string): Set<string> {
  const paths = new Set<string>();
  for (const cfg of configsForScope(scope)) {
    const rel = pathWithin(home, rerooted(cfg.identitiesJsonPath, home));
    if (rel) paths.add(rel);
  }
  return paths;
}

export type RetiredPurge = (opts: PurgeOptions) => Promise<PurgeReport>;

function rerooted(path: string, home: string): string {
  const real = homedir();
  return path.startsWith(`${real}/`) ? join(home, path.slice(real.length + 1)) : path;
}

/** Re-delete the credentials of every retired identity in the given
 * registries. rsync never propagates deletions and the merge copies absent
 * files in from the other host, so a retirement would otherwise be undone by
 * the next sync. Idempotent; a failing registry never aborts the sync. */
export async function purgeRetiredCredentialsAfterSync(
  configs: ToolConfig[],
  home: string,
  purge: RetiredPurge = purgeRetiredIdentityCredentials,
): Promise<void> {
  for (const cfg of configs) {
    let identities;
    try {
      identities = (await loadIdentitiesFile(rerooted(cfg.identitiesJsonPath, home))).identities;
    } catch {
      continue;
    }
    for (const identity of identities.filter(isRetired)) {
      try {
        await purge({
          toolName: cfg.toolName,
          identity,
          home,
          // systemd units belong to the real home; never touch them for a relocated one.
          ...(home === homedir() ? {} : { removeAliTimer: async () => false }),
        });
      } catch {
        // Best effort: the next sync retries.
      }
    }
  }
}

type SecretCopy = { kind: "delete" } | { kind: "crush"; provider: string } | { kind: "pi"; provider: string };

/** The merge preserves the losing side of every conflicting file under
 * conflictRoot, and a retired identity's credential files are no exception:
 * the post-merge purge deletes the live copies but not these. Walk the
 * preserved copies and apply the same removal (whole credential files
 * deleted; crush.json and a same-named pi auth.json lose only the secret
 * key, so their non-secret parts are kept). Best effort, like the purge. */
async function scrubRetiredConflictCopies(configs: ToolConfig[], home: string, conflictRoot: string): Promise<void> {
  const targets = new Map<string, SecretCopy>();
  for (const cfg of configs) {
    let identities;
    try {
      identities = (await loadIdentitiesFile(rerooted(cfg.identitiesJsonPath, home))).identities;
    } catch {
      continue;
    }
    let piIdentities;
    for (const identity of identities.filter(isRetired)) {
      const configDir = rerooted(expandPath(identity.configDir), home);
      const add = (path: string, copy: SecretCopy) => {
        const rel = pathWithin(home, path);
        if (rel) targets.set(rel, copy);
      };
      for (const path of credentialPathsForTool(cfg.toolName, configDir)) add(path, { kind: "delete" });
      if (cfg.toolName === "ali") add(join(configDir, "console-cookie.txt"), { kind: "delete" });
      const crush = CRUSH_PROVIDER_FOR_TOOL[cfg.toolName];
      if (crush) add(join(configDir, "crush.json"), { kind: "crush", provider: crush });
      const pi = PI_PROVIDER_FOR_TOOL[cfg.toolName];
      if (pi) {
        try {
          piIdentities ??= (await loadIdentitiesFile(piRegistryFor(home))).identities;
          const match = findIdentityByNameOrAlias(piIdentities, identity.name);
          if (match) add(join(rerooted(expandPath(match.configDir), home), "auth.json"), { kind: "pi", provider: pi });
        } catch {
          // No pi registry: no pi copy to scrub.
        }
      }
    }
  }
  if (targets.size === 0) return;
  const report: PurgeReport = { removed: [], warnings: [] };
  for (const side of ["local", "incoming"] as const) {
    const sideRoot = join(conflictRoot, side);
    for await (const file of walkFiles(sideRoot)) {
      const rel = pathWithin(sideRoot, file);
      // Duplicate copies carry a ".<uuid>" suffix (see preserveFile).
      const target = rel ? targets.get(rel.replace(/\.[0-9a-f]{8}-[0-9a-f-]{27}$/, "")) : undefined;
      if (!target) continue;
      try {
        if (target.kind === "delete") await removeFile(file, report);
        else if (target.kind === "crush") await stripCrushApiKey(file, target.provider, report);
        else await stripPiEntry(file, target.provider, report);
      } catch {
        // Best effort: the next sync retries.
      }
    }
  }
}

async function preserveFile(source: string, root: string, side: "local" | "incoming", rel: string): Promise<void> {
  let destination = join(root, side, rel);
  if (await exists(destination)) destination = `${destination}.${crypto.randomUUID()}`;
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

/** Apply the tail transfers staged in `dir`: append each verified suffix to its live history.
 * The plan is untrusted input from the other host: only histories in `expected` (the manifest this side sent,
 * or its own current listing) are touched, at an offset that manifest allows. Everything else, and every tail
 * that does not verify or cannot be applied now, is returned in `needsFull` for the ordinary full transfer. */
async function applyTails(dir: string, home: string, expected: HistoryManifest, strict: boolean, ownerPass: OpenOwnerPass, result: TreeMergeResult, cache: PrefixCache): Promise<void> {
  const full = (rel: string) => { (result.needsFull ??= []).push(rel); };
  let plan: TailPlan;
  try { plan = JSON.parse(await readFile(join(dir, TAIL_PLAN_FILE), "utf8")) as TailPlan; }
  catch { for (const rel of Object.keys(expected)) full(rel); return; }
  await prefetchOpenOwners(Object.keys(plan).filter((rel) => expected[rel]).map((rel) => join(home, rel)), ownerPass);
  for (const [rel, entry] of Object.entries(plan)) {
    const known = expected[rel];
    const offsetOk = known !== undefined && (strict ? entry.offset === Math.min(entry.size, known.size) : entry.offset <= Math.min(entry.size, known.size));
    if (!rel.endsWith(".jsonl") || rel.startsWith("/") || rel.split("/").includes("..") || !offsetOk) { full(rel); continue; }
    const destination = join(home, rel);
    const tail = await readFile(join(dir, rel)).catch(() => undefined);
    if (!tail || tail.length !== entry.size - entry.offset) { full(rel); continue; }
    const outcome = await mergeJsonlTail(destination, entry.offset, entry.prefix, tail, ownerPass, cache);
    if (outcome === "diverged" || outcome === "deferred") { full(rel); continue; }
    if (outcome === "busy") { result.busyPaths.push(rel); continue; }
    if (outcome === "merged") result.mergedJsonlFiles++;
    const terminated = tail.length === 0 || tail[tail.length - 1] === 10;
    if (!terminated) {
      // The sender's last line is unfinished: it was not copied, exactly like an incomplete staged history.
      result.preservedConflicts++;
      result.preservedConflictPaths.push(rel);
    }
    // Same size as the sender and a complete tail: same content, so adopt its mtime and the next quick check sees equality.
    const info = await stat(destination).catch(() => undefined);
    if (terminated && info && info.size === entry.size && Math.floor(info.mtimeMs / 1000) !== Math.floor(entry.mtimeMs / 1000)) {
      await tolerateDenied(rel, () => fsOps.utimes(destination, info.atime, new Date(entry.mtimeMs)), result.deniedPaths);
    }
  }
}

/** A newer snapshot supersedes an older one only when it retains every byte
 * of an incomplete tail, or every occurrence of each complete record. */
function subsumesJsonl(newer: string, older: string): boolean {
  if (newer.startsWith(older)) return true;
  if (!older.endsWith("\n")) return false;
  const counts = new Map<string, number>();
  for (const line of newer.split("\n").slice(0, -1)) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of older.split("\n").slice(0, -1)) {
    const count = counts.get(line) ?? 0;
    if (!count) return false;
    counts.set(line, count - 1);
  }
  return true;
}

async function syncArchiveDirectories(destination: string, home: string): Promise<void> {
  // Flush the rename and any newly created archive directories before the
  // receiver may delete staging. A failure leaves staging available to retry.
  for (let directory = dirname(destination); ; directory = dirname(directory)) {
    const handle = await open(directory, "r");
    try { await handle.sync(); }
    finally { await handle.close(); }
    if (directory === home || dirname(directory) === directory) break;
  }
}

async function writeDurableArchive(destination: string, bytes: Buffer, home: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, destination);
  await syncArchiveDirectories(destination, home);
}

/** Archives the incoming copy durably. False when an identical copy was already archived (nothing new to report). */
async function preserveDeferredFile(source: string, home: string, rel: string): Promise<boolean> {
  const root = join(aisRemoteCacheDir(home), "merge-conflicts");
  const destination = join(root, "deferred", "incoming", rel);
  const incoming = Buffer.from(await Bun.file(source).arrayBuffer());
  if (await exists(destination)) {
    const previous = Buffer.from(await Bun.file(destination).arrayBuffer());
    if (incoming.equals(previous)) {
      // A previous attempt may have renamed successfully but failed to flush
      // a directory. Reconfirm durability before allowing staging deletion.
      const handle = await open(destination, "r");
      try { await handle.sync(); }
      finally { await handle.close(); }
      await syncArchiveDirectories(destination, home);
      return false;
    }
    // Latin-1 preserves each byte for comparison, including malformed UTF-8.
    if (!subsumesJsonl(incoming.toString("latin1"), previous.toString("latin1"))) {
      // Divergent records and incomplete tails remain recoverable. Identical
      // unresolved copies share a content hash rather than accumulating UUIDs.
      const hash = createHash("sha256").update(previous).digest("hex");
      const unresolved = join(root, "unresolved", hash, "incoming", rel);
      await writeDurableArchive(unresolved, previous, home);
    }
  }
  await writeDurableArchive(destination, incoming, home);
  return true;
}

/**
 * Merge a remote profile snapshot into the live home without ever replacing a
 * JSONL history. Existing JSONL files are append-only multiset unions, so a
 * native agent writing concurrently cannot have its just-written tail erased.
 * Non-mergeable files still use newest-mtime selection, but the losing bytes
 * are copied into conflictRoot first.
 */
export async function mergeIncomingProfileTree(
  incomingRoot: string,
  scope: SyncScope,
  options: { home?: string; conflictRoot?: string; purgeRetired?: RetiredPurge; ownerPass?: OpenOwnerPass; lock?: ProfileMergeLock; tailsDir?: string; tailsManifest?: HistoryManifest } = {},
): Promise<TreeMergeResult> {
  const home = options.home ?? homedir();
  if (!options.lock || !heldMergeLocks.has(options.lock) || options.lock.home !== await realpath(home)) {
    return withProfileMergeLock(home, (lock) => mergeIncomingProfileTree(incomingRoot, scope, { ...options, lock }));
  }
  const conflictRoot =
    options.conflictRoot ??
    join(aisRemoteCacheDir(home), "merge-conflicts", new Date().toISOString().replaceAll(":", "-"));
  const result: TreeMergeResult = { mergedJsonlFiles: 0, copiedFiles: 0, preservedConflicts: 0, preservedConflictPaths: [], busyPaths: [], deniedPaths: [] };
  const registries = registryRelPaths(scope, home);
  const ownerPass = options.ownerPass ?? { lookups: 0 };
  const cache = await PrefixCache.load(home);
  const ledger = await ConflictLedger.load(home);

  // Registries have their own semantic union. Merge these first so profiles
  // first seen on the incoming host have a valid local registry entry.
  for (const cfg of configsForScope(scope)) {
    const livePath = rerooted(cfg.identitiesJsonPath, home);
    const rel = pathWithin(home, livePath);
    if (!rel) continue;
    const incoming = join(incomingRoot, rel);
    if (!(await exists(incoming))) continue;
    if (await exists(livePath)) {
      await mergeRegistryConflict(livePath, incoming);
    } else {
      await mkdir(dirname(livePath), { recursive: true });
      await copyFile(incoming, livePath);
      result.copiedFiles++;
    }
  }

  if (options.tailsDir) {
    // The pulling side checks against the manifest it sent; the pushed-to side against what it holds now.
    const strict = options.tailsManifest !== undefined;
    await applyTails(options.tailsDir, home, options.tailsManifest ?? await listHistories(home, scope), strict, ownerPass, result, cache);
  }

  // One lsof run per few hundred staged histories instead of a process scan (or a deferral) per file.
  const stagedHistories: string[] = [];
  for await (const source of walkFiles(incomingRoot)) {
    const rel = pathWithin(incomingRoot, source);
    if (rel && source.endsWith(".jsonl") && !registries.has(rel)) stagedHistories.push(join(home, rel));
  }
  await prefetchOpenOwners(stagedHistories, ownerPass);

  for await (const source of walkFiles(incomingRoot)) {
    const rel = pathWithin(incomingRoot, source);
    if (!rel || registries.has(rel)) continue;
    const destination = join(home, rel);

    if (source.endsWith(".jsonl")) {
      // Identical history (even with the same unterminated tail on both hosts): nothing to merge.
      if ((await exists(destination)) && (await filesEqual(source, destination, false))) {
        await convergeMtime(source, destination, rel, result.deniedPaths);
        continue;
      }
      // mergeJsonlFiles checks ownership only when there is an actual append
      // to make, so an unchanged replay does not become a false conflict.
      const sourceSize = (await stat(source)).size;
      const incompleteSource = !(await endsWithNewlineOrEmpty(source, sourceSize));
      // A big destination that the staged copy extends is merged as a tail: the cache vouches for its prefix
      // without reading it. Anything else (unverified, busy, deferred) takes the ordinary whole-file merge below.
      const liveSize = incompleteSource ? 0 : (await stat(destination).catch(() => undefined))?.size ?? 0;
      if (liveSize >= TAIL_MIN_BYTES && liveSize <= sourceSize) {
        const prefix = await hashPrefix(source, liveSize);
        const handle = await open(source, "r");
        const tail = Buffer.alloc(sourceSize - liveSize);
        try { await handle.read(tail, 0, tail.length, liveSize); } finally { await handle.close(); }
        const outcome = prefix ? await mergeJsonlTail(destination, liveSize, prefix, tail, ownerPass, cache) : "diverged";
        if (outcome === "merged" || outcome === "unchanged") {
          if (outcome === "merged") result.mergedJsonlFiles++;
          await alignMergedMtime(source, destination, rel, result.deniedPaths);
          continue;
        }
        if (outcome === "busy") { result.busyPaths.push(rel); continue; }
      }
      if (incompleteSource && (await preserveDeferredFile(source, home, rel))) {
        // A live writer's unfinished line stays archived; only a changed copy is news, so the count converges.
        result.preservedConflicts++;
        result.preservedConflictPaths.push(rel);
      }
      const mergeResult = await mergeJsonlFiles([source], destination, false, ownerPass);
      if (mergeResult === "merged") result.mergedJsonlFiles++;
      else if (mergeResult === "busy") result.busyPaths.push(rel);
      else if (mergeResult === "deferred" && !incompleteSource && (await preserveDeferredFile(source, home, rel))) {
        // Only a copy not archived before is news: a destination that stays unmergeable must not recount every run.
        result.preservedConflicts++;
        result.preservedConflictPaths.push(rel);
      }
      if (!incompleteSource && (mergeResult === "merged" || mergeResult === "unchanged")) await alignMergedMtime(source, destination, rel, result.deniedPaths);
      continue;
    }

    if (!(await exists(destination))) {
      await mkdir(dirname(destination), { recursive: true });
      if (await tolerateDenied(rel, () => copyKeepingMtime(source, destination), result.deniedPaths)) result.copiedFiles++;
      continue;
    }
    if (await filesEqual(source, destination)) {
      await convergeMtime(source, destination, rel, result.deniedPaths);
      continue;
    }
    if (basename(rel) === ".claude.json" && (await mergeClaudeJson(source, destination, rel, conflictRoot, result, ledger))) continue;

    const [sourceStat, destinationStat] = await Promise.all([stat(source), stat(destination)]);
    const volatile = VOLATILE_STATE.test(rel);
    const sourceWins = sourceStat.mtimeMs !== destinationStat.mtimeMs ? sourceStat.mtimeMs > destinationStat.mtimeMs : await sourceWinsTie(source, destination);
    const fresh = !volatile && (await ledger.isNew(rel, sourceWins ? destination : source));
    if (sourceWins) {
      if (fresh) await preserveFile(destination, conflictRoot, "local", rel);
      if (!(await tolerateDenied(rel, () => copyKeepingMtime(source, destination), result.deniedPaths))) continue;
    } else if (fresh) {
      await preserveFile(source, conflictRoot, "incoming", rel);
    }
    if (!fresh) continue;
    result.preservedConflicts++;
    result.preservedConflictPaths.push(rel);
  }

  await cache.save();
  await ledger.save();
  await purgeRetiredCredentialsAfterSync(configsForScope(scope), home, options.purgeRetired);
  await scrubRetiredConflictCopies(configsForScope(scope), home, conflictRoot);
  return result;
}

const RECOVERY_SKIP_PATTERN = /(?:^|\/)(?:identities\.json|[^/]+\.(?:sqlite|db)(?:-(?:shm|wal|journal))?|[^/]+\.(?:lock|sock|pid))(?:$|\/)/i;

async function archiveRoots(home: string): Promise<string[]> {
  const roots: string[] = [];
  for (const parent of [join(aisRemoteCacheDir(home), "sync-conflicts"), join(aisRemoteCacheDir(home), "dedupe-backups")]) {
    let entries;
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) if (entry.isDirectory()) roots.push(join(parent, entry.name));
  }
  const conflicts = join(aisRemoteCacheDir(home), "merge-conflicts");
  const runs = await readdir(conflicts, { withFileTypes: true }).catch(() => []);
  for (const run of runs) {
    if (!run.isDirectory()) continue;
    const runRoot = join(conflicts, run.name);
    const candidates = run.name === "unresolved"
      ? (await readdir(runRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(runRoot, entry.name))
      : [runRoot];
    for (const candidate of candidates) {
      for (const side of ["local", "incoming"]) {
        const sideRoot = join(candidate, side);
        if (await exists(sideRoot)) roots.push(sideRoot);
      }
    }
  }
  return roots;
}

/** Restore historical cache copies additively. JSONL histories are unioned;
 * any other file is copied only when its original path is currently absent.
 * Archives are deliberately retained after recovery. */
export async function recoverProfileArchives(
  options: { home?: string; dryRun?: boolean; purgeRetired?: RetiredPurge } = {},
): Promise<ArchiveRecoveryResult> {
  const home = options.home ?? homedir();
  const dryRun = options.dryRun ?? false;
  const roots = await archiveRoots(home);
  const ownerPass: OpenOwnerPass = { lookups: 0 };
  const result: ArchiveRecoveryResult = {
    archiveRoots: roots.length,
    mergedJsonlFiles: 0,
    copiedFiles: 0,
    preservedConflicts: 0,
    preservedConflictPaths: [],
    busyPaths: [],
  };

  for (const root of roots) {
    for await (const source of walkFiles(root)) {
      // An interrupted atomic deferral write is not a separate live sidecar.
      if (/\.jsonl\.[0-9a-f]{8}-[0-9a-f-]{27}\.tmp$/.test(source)) continue;
      // Earlier conflict copies used UUID suffixes on repeated preservation.
      const rel = pathWithin(root, source)?.replace(/(\.jsonl)\.[0-9a-f]{8}-[0-9a-f-]{27}$/, "$1");
      if (!rel || RECOVERY_SKIP_PATTERN.test(rel) || basename(rel) === "identities.json") continue;
      const destination = join(home, rel);
      if (rel.endsWith(".jsonl")) {
        const mergeResult = await mergeJsonlFiles([source], destination, dryRun, ownerPass);
        if (mergeResult === "merged") result.mergedJsonlFiles++;
        else if (mergeResult === "busy") result.busyPaths.push(rel);
        else if (mergeResult === "deferred") {
          // Archives remain untouched; the recovery pass will retry once the
          // destination is stable and closed.
          result.preservedConflicts++;
          result.preservedConflictPaths.push(rel);
        }
      } else if (!(await exists(destination))) {
        if (!dryRun) {
          await mkdir(dirname(destination), { recursive: true });
          await copyFile(source, destination);
        }
        result.copiedFiles++;
      }
    }
  }
  if (!dryRun) await purgeRetiredCredentialsAfterSync(SYNC_TOOL_CONFIGS, home, options.purgeRetired);
  return result;
}
