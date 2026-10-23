import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rm, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../identities/pool/fs.ts";
import { aisRemoteCacheDir } from "../shared/ais-home.ts";
import { REPRODUCIBLE_JUNK_DIR_NAMES } from "../shared/reproducible-paths.ts";
import { configHomeRoot, SYNC_TOOL_CONFIGS } from "./rsync.ts";
import type { SyncScope } from "./types.ts";

/**
 * Tail-only transfer of append-only JSONL histories. A session history a tool is still appending to differs
 * from its copy on the other host on every run; staging it whole rewrote hundreds of MB each time. Instead the
 * receiver lists its histories (size + mtime), the sender hashes the first `size` bytes of each larger file and
 * ships only the bytes beyond it; the receiver verifies its own prefix hash before appending (see
 * mergeJsonlTail). Anything that does not verify falls back to the ordinary full staging and merge.
 */

/** Smaller histories are cheaper to stage whole than to negotiate. */
export const TAIL_MIN_BYTES = 1 << 20;
export const TAIL_PLAN_FILE = "tails.json";
/** Histories the bulk transfers leave out this run: unchanged at plan time, or changed under the sender mid-plan.
 * A live history the receiver appends to after planning would otherwise fail rsync's quick check and go whole. */
export const TAIL_DEFERRED_FILE = "deferred.json";
const LIVE_HISTORY_MS = 24 * 60 * 60 * 1000;

export interface HistoryInfo { size: number; mtimeMs: number }
export type HistoryManifest = Record<string, HistoryInfo>;
export interface TailEntry { offset: number; size: number; mtimeMs: number; prefix: string }
export type TailPlan = Record<string, TailEntry>;

const SKIPPED_DIRS = new Set([...REPRODUCIBLE_JUNK_DIR_NAMES.map((name) => name.slice(0, -1)), "backups"]);
// The directory excludes of TRANSIENT_EXCLUDES that are anchored below an identity.
const SKIPPED_PATHS = [/^\.claude\/identities\/[^/]+\/sessions$/, /^\.codex\/identities\/[^/]+\/skills\/\.system$/];
const LEGACY_ROOTS = [".claude/projects", ".codex/sessions", ".grok/sessions", ".kimi-code/sessions"];

/** The JSONL histories a profile sync would carry (the same trees buildSyncFilterArgs includes). */
export async function listHistories(home: string, scope: SyncScope, skip: ReadonlySet<string> = new Set(), minSize = 0): Promise<HistoryManifest> {
  const roots: string[] = [];
  for (const cfg of scope.kind === "all" ? SYNC_TOOL_CONFIGS : [scope.cfg]) {
    const root = configHomeRoot(cfg, home);
    roots.push(scope.kind === "all" ? `${root}/identities` : `${root}/identities/${scope.identityName}`);
  }
  if (scope.kind === "all") roots.push(...LEGACY_ROOTS);

  const manifest: HistoryManifest = {};
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(home, rel), { withFileTypes: true }).catch(() => [])) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !SKIPPED_PATHS.some((p) => p.test(child))) await walk(child);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && !skip.has(child)) {
        const info = await lstat(join(home, child)).catch(() => undefined);
        if (info?.isFile() && info.size >= minSize) manifest[child] = { size: info.size, mtimeMs: info.mtimeMs };
      }
    }
  };
  for (const root of new Set(roots)) await walk(root);
  return manifest;
}

const BLOCK = 1 << 18;
const WINDOW = 1 << 16;
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer | undefined> {
  const buffer = Buffer.allocUnsafe(length);
  for (let got = 0; got < length;) {
    const { bytesRead } = await handle.read(buffer, got, length - got, position + got);
    if (bytesRead === 0) return undefined;
    got += bytesRead;
  }
  return buffer;
}

/** Digests of the leading whole blocks of one file, valid while the file only grows. `window` is the hash of the
 * last WINDOW bytes the blocks cover; size and mtime are those of the file when the entry was written. */
interface PrefixEntry { ino: number; size: number; mtimeMs: number; window: string; blocks: string[] }

async function windowOf(handle: FileHandle, covered: number): Promise<string | undefined> {
  const length = Math.min(covered, WINDOW);
  const bytes = length === 0 ? Buffer.alloc(0) : await readAt(handle, covered - length, length);
  return bytes && sha(bytes);
}

/** Persistent per-path block digests (`prefix-cache.json` beside steady-state.json). A history that only grew
 * is re-verified by one sampled window and hashed from its last whole block on, so reads follow the appended
 * bytes, not the file size. Without a home it is a throwaway in-memory cache.
 * shortcut: an in-place edit before the sampled window of a grown file goes unseen here; the peer's hash of
 * the same prefix still has to match, upgrade by sampling more windows. */
export class PrefixCache {
  private dirty = false;
  private readonly touched = new Set<string>();
  constructor(private readonly file?: string, private readonly entries: Record<string, PrefixEntry> = {}) {}

  static async load(home: string): Promise<PrefixCache> {
    const file = join(aisRemoteCacheDir(home), "prefix-cache.json");
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, PrefixEntry>;
      return new PrefixCache(file, raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {});
    } catch { return new PrefixCache(file); }
  }

  async save(): Promise<void> {
    if (!this.dirty || !this.file) return;
    for (const path of Object.keys(this.entries)) {
      if (!this.touched.has(path) && !(await lstat(path).catch(() => undefined))) delete this.entries[path];
    }
    await mkdir(dirname(this.file), { recursive: true });
    await writeFileAtomic(this.file, JSON.stringify(this.entries));
    this.dirty = false;
  }

  /** Hash of the first `length` bytes, or undefined when the file is shorter. */
  async prefix(handle: FileHandle, path: string, length: number): Promise<string | undefined> {
    const info = await handle.stat();
    if (length > info.size) return undefined;
    const need = Math.floor(length / BLOCK);
    const entry = this.entries[path];
    let known: string[] = [];
    if (entry && entry.ino === info.ino && entry.blocks.length * BLOCK <= info.size) {
      const same = entry.size === info.size && entry.mtimeMs === info.mtimeMs;
      if (same || (await windowOf(handle, entry.blocks.length * BLOCK)) === entry.window) known = entry.blocks;
    }
    let blocks = known.slice(0, need);
    if (need > known.length) {
      for (let i = known.length; i < need; i++) {
        const bytes = await readAt(handle, i * BLOCK, BLOCK);
        if (!bytes) return undefined;
        blocks.push(sha(bytes));
      }
      const window = await windowOf(handle, need * BLOCK);
      if (window === undefined) return undefined;
      this.entries[path] = { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, window, blocks };
    } else if (entry && known === entry.blocks) {
      Object.assign(entry, { size: info.size, mtimeMs: info.mtimeMs });
    }
    this.dirty = true;
    this.touched.add(path);
    const rest = await readAt(handle, need * BLOCK, length - need * BLOCK);
    if (!rest) return undefined;
    return sha(Buffer.from(`b1:${length}:${blocks.join("")}:${sha(rest)}`));
  }
}

/** Hash of the first `length` bytes, or undefined when the file is shorter. Reads blocks; never holds the file. */
export async function hashPrefix(path: string, length: number, cache: PrefixCache = new PrefixCache()): Promise<string | undefined> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return undefined;
  try { return await cache.prefix(handle, path, length); } finally { await handle.close(); }
}

async function copyRange(from: FileHandle, destination: string, start: number, end: number): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const to = await open(destination, "w", 0o600);
  try {
    const buffer = Buffer.allocUnsafe(1 << 22);
    for (let position = start; position < end;) {
      const { bytesRead } = await from.read(buffer, 0, Math.min(buffer.length, end - position), position);
      if (bytesRead === 0) break;
      await to.write(buffer, 0, bytesRead);
      position += bytesRead;
    }
  } finally { await to.close(); }
}

let beforeTailCopy: ((rel: string) => Promise<void>) | undefined;
/** Test hook: runs between hashing and copying one history, to swap the file under the sender. */
export function setBeforeTailCopyHook(hook?: (rel: string) => Promise<void>): void { beforeTailCopy = hook; }

/** Sender side. For every history the receiver also has that is not already equal by size and
 * whole-second mtime, write the missing bytes to `outDir/<rel>` and record the prefix hash in
 * `outDir/tails.json`. Returns the plan; its paths are exactly the ones the bulk transfer must leave out.
 * Hash and copy read one open handle, and a file replaced or truncated meanwhile is left to the bulk transfer. */
export async function planTails(
  home: string,
  scope: SyncScope,
  receiver: HistoryManifest,
  outDir: string,
  skip: ReadonlySet<string> = new Set(),
  /** Test seam: the histories to consider instead of walking the tool trees. */
  listing?: HistoryManifest,
  /** Receives histories the bulk transfer must not carry whole: equal at plan time, or changed mid-plan. */
  deferred: string[] = [],
): Promise<TailPlan> {
  const plan: TailPlan = {};
  const cache = await PrefixCache.load(home);
  const mine = listing ?? await listHistories(home, scope, skip);
  for (const [rel, theirs] of Object.entries(receiver)) {
    if (!mine[rel]) continue;
    const path = join(home, rel);
    const handle = await open(path, "r").catch(() => undefined);
    if (!handle) { deferred.push(rel); continue; }
    try {
      const info = await handle.stat();
      if (info.size < TAIL_MIN_BYTES) continue;
      if (info.size === theirs.size && Math.floor(info.mtimeMs / 1000) === Math.floor(theirs.mtimeMs / 1000)) {
        // Only recently written histories can grow before the bulk transfer; holding back every idle one
        // costs rsync one exclude rule per file checked against every path (thousands of rules, minutes).
        if (Date.now() - info.mtimeMs < LIVE_HISTORY_MS) deferred.push(rel);
        continue;
      }
      // A receiver that is already ahead needs no bytes at all: proving our whole file is its prefix is enough.
      const offset = Math.min(info.size, theirs.size);
      const prefix = await cache.prefix(handle, path, offset);
      if (!prefix) { deferred.push(rel); continue; }
      await beforeTailCopy?.(rel);
      await copyRange(handle, join(outDir, rel), offset, info.size);
      const [again, now] = await Promise.all([handle.stat(), lstat(path).catch(() => undefined)]);
      // Appends only grow the file; a different inode or a shorter file means the bytes read are not one snapshot.
      if (!now || now.ino !== info.ino || again.size < info.size) { await rm(join(outDir, rel), { force: true }); deferred.push(rel); continue; }
      plan[rel] = { offset, size: info.size, mtimeMs: info.mtimeMs, prefix };
    } finally { await handle.close(); }
  }
  await cache.save();
  if (Object.keys(plan).length > 0 || deferred.length > 0) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, TAIL_PLAN_FILE), JSON.stringify(plan));
    if (deferred.length > 0) await writeFile(join(outDir, TAIL_DEFERRED_FILE), JSON.stringify(deferred));
  }
  return plan;
}

/** Paths a peer asked to be sent whole, limited to the ones we negotiated: a peer must not widen a `--files-from` list. */
export function restrictTo(requested: readonly string[] | undefined, allowed: Iterable<string>): string[] {
  const ok = new Set(allowed);
  return (requested ?? []).filter((rel) => ok.has(rel));
}

/** Rsync exclude filters that keep planned histories out of the bulk transfer. */
export function tailExcludeFilters(plan: TailPlan, deferred: readonly string[] = []): string[] {
  return [...Object.keys(plan), ...deferred].map((rel) => `--exclude=/${rel.replace(/[*?[\\]/g, "\\$&")}`);
}

