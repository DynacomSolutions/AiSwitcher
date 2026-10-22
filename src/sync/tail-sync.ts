import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, rm, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
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

async function hashHandlePrefix(handle: FileHandle, length: number): Promise<string | undefined> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1 << 22);
  for (let position = 0; position < length;) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, length - position), position);
    if (bytesRead === 0) return undefined;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

/** SHA-256 of the first `length` bytes, or undefined when the file is shorter. Streams; never holds the file. */
export async function hashPrefix(path: string, length: number): Promise<string | undefined> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return undefined;
  try { return await hashHandlePrefix(handle, length); } finally { await handle.close(); }
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
): Promise<TailPlan> {
  const plan: TailPlan = {};
  const mine = listing ?? await listHistories(home, scope, skip);
  for (const [rel, theirs] of Object.entries(receiver)) {
    if (!mine[rel]) continue;
    const path = join(home, rel);
    const handle = await open(path, "r").catch(() => undefined);
    if (!handle) continue;
    try {
      const info = await handle.stat();
      if (info.size < TAIL_MIN_BYTES) continue;
      if (info.size === theirs.size && Math.floor(info.mtimeMs / 1000) === Math.floor(theirs.mtimeMs / 1000)) continue;
      // A receiver that is already ahead needs no bytes at all: proving our whole file is its prefix is enough.
      const offset = Math.min(info.size, theirs.size);
      const prefix = await hashHandlePrefix(handle, offset);
      if (!prefix) continue;
      await beforeTailCopy?.(rel);
      await copyRange(handle, join(outDir, rel), offset, info.size);
      const [again, now] = await Promise.all([handle.stat(), lstat(path).catch(() => undefined)]);
      // Appends only grow the file; a different inode or a shorter file means the bytes read are not one snapshot.
      if (!now || now.ino !== info.ino || again.size < info.size) { await rm(join(outDir, rel), { force: true }); continue; }
      plan[rel] = { offset, size: info.size, mtimeMs: info.mtimeMs, prefix };
    } finally { await handle.close(); }
  }
  if (Object.keys(plan).length > 0) await writeFile(join(outDir, TAIL_PLAN_FILE), JSON.stringify(plan));
  return plan;
}

/** Paths a peer asked to be sent whole, limited to the ones we negotiated: a peer must not widen a `--files-from` list. */
export function restrictTo(requested: readonly string[] | undefined, allowed: Iterable<string>): string[] {
  const ok = new Set(allowed);
  return (requested ?? []).filter((rel) => ok.has(rel));
}

/** Rsync exclude filters that keep planned histories out of the bulk transfer. */
export function tailExcludeFilters(plan: TailPlan): string[] {
  return Object.keys(plan).map((rel) => `--exclude=/${rel.replace(/[*?[\\]/g, "\\$&")}`);
}

