import { copyFile, mkdir, readdir, readlink, realpath, rename, stat, utimes } from "node:fs/promises";
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
import { findIdentityByNameOrAlias, loadIdentitiesFile } from "../identities/store.ts";
import type { ToolConfig } from "../identities/types.ts";
import { aisRemoteCacheDir } from "../shared/ais-home.ts";
import { mergeJsonlFiles } from "./dedupe.ts";
import { mergeRegistryConflict } from "./registry.ts";
import { SYNC_TOOL_CONFIGS } from "./rsync.ts";
import type { SyncScope } from "./types.ts";

export interface TreeMergeResult {
  mergedJsonlFiles: number;
  copiedFiles: number;
  preservedConflicts: number;
  preservedConflictPaths: string[];
  /** Logs skipped only because a native process owns them; not copied, re-staged next run. */
  busyPaths: string[];
}

export interface ArchiveRecoveryResult extends TreeMergeResult {
  archiveRoots: number;
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

async function filesEqual(a: string, b: string): Promise<boolean> {
  const [aStat, bStat] = await Promise.all([stat(a), stat(b)]);
  if (aStat.size !== bStat.size) return false;
  return Buffer.from(await Bun.file(a).arrayBuffer()).equals(Buffer.from(await Bun.file(b).arrayBuffer()));
}

/** Byte-identical files must also agree on mtime, or rsync's size+mtime quick
 * check re-stages them every run. Only the mtime moves, never the contents. */
async function convergeMtime(source: string, destination: string): Promise<void> {
  const [sourceStat, destinationStat] = await Promise.all([stat(source), stat(destination)]);
  if (sourceStat.mtimeMs > destinationStat.mtimeMs) await utimes(destination, destinationStat.atime, sourceStat.mtime);
}

// A hung lsof is killed; the lookup then falls back to /proc or reports unknown (callers treat unknown as open).
const LSOF_TIMEOUT_MS = 5000;
// Per-file checks are cheapest for small merges; past this many lookups in one
// pass a single snapshot of all open files wins (a lookup can cost ~1.4s on a busy host,
// so 32 per-file lsof runs blew a 30s budget).
const PER_FILE_LOOKUPS = 4;
export type OpenPathsScanner = (signal: AbortSignal) => Promise<Set<string> | undefined>;
let openScanner: OpenPathsScanner = scanOpenPaths;
let openScanTimeoutMs = LSOF_TIMEOUT_MS;
/** Test hook: swap the snapshot scanner (no argument restores the real one). */
export function setOpenScanner(scanner?: OpenPathsScanner, timeoutMs = LSOF_TIMEOUT_MS): void {
  openScanner = scanner ?? scanOpenPaths;
  openScanTimeoutMs = timeoutMs;
}

function lsofBinary(): string | undefined {
  return Bun.which("lsof") ?? (process.platform === "darwin" && existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : undefined);
}

async function procOpenPaths(signal: AbortSignal, ownDescriptor?: number): Promise<Set<string> | undefined> {
  let processDirs: string[];
  try {
    processDirs = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  } catch {
    return undefined;
  }
  const paths = new Set<string>();
  for (const pid of processDirs) {
    if (signal.aborted) return undefined;
    let fds: string[];
    try {
      fds = await readdir(join("/proc", pid, "fd"));
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      return undefined;
    }
    for (const fd of fds) {
      if (signal.aborted) return undefined;
      if (pid === String(process.pid) && fd === String(ownDescriptor)) continue;
      try {
        paths.add((await readlink(join("/proc", pid, "fd", fd))).replace(/ \(deleted\)$/, ""));
      } catch (error) {
        // Processes and descriptors can disappear while /proc is read.
        if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
      }
    }
  }
  return paths;
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
async function scanOpenPaths(signal: AbortSignal): Promise<Set<string> | undefined> {
  return process.platform === "linux" ? procOpenPaths(signal) : lsofOpenPaths(signal);
}

async function boundedOpenScan(scanner: OpenPathsScanner = openScanner): Promise<Set<string> | undefined> {
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
  return paths && paths.has(path);
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
  snapshot?: Promise<Set<string> | undefined>;
}

export async function hasOpenOwner(path: string, pass: OpenOwnerPass = { lookups: PER_FILE_LOOKUPS }): Promise<boolean | undefined> {
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : undefined;
  }
  if (pass.lookups++ < PER_FILE_LOOKUPS) return hasOpenOwnerDirect(real);
  // Each pass gets one fresh, bounded snapshot after its per-file budget.
  // A successful scan can distinguish closed files from busy ones; failure
  // remains unknown. Never carry a previous pass's misses into a new merge.
  pass.snapshot ??= boundedOpenScan();
  return (await pass.snapshot)?.has(real);
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

async function preserveDeferredFile(source: string, home: string, rel: string): Promise<void> {
  const root = join(aisRemoteCacheDir(home), "merge-conflicts");
  const destination = join(root, "deferred", "incoming", rel);
  const incoming = Buffer.from(await Bun.file(source).arrayBuffer());
  if (await exists(destination)) {
    const previous = Buffer.from(await Bun.file(destination).arrayBuffer());
    if (incoming.equals(previous)) return;
    // Latin-1 preserves each byte for comparison, including malformed UTF-8.
    if (!subsumesJsonl(incoming.toString("latin1"), previous.toString("latin1"))) {
      // Divergent records and incomplete tails remain recoverable. Identical
      // unresolved copies share a content hash rather than accumulating UUIDs.
      const hash = createHash("sha256").update(previous).digest("hex");
      const unresolved = join(root, "unresolved", hash, "incoming", rel);
      await mkdir(dirname(unresolved), { recursive: true });
      await Bun.write(unresolved, previous, { mode: 0o600 });
    }
  }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporary, incoming, { mode: 0o600 });
  await rename(temporary, destination);
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
  options: { home?: string; conflictRoot?: string; purgeRetired?: RetiredPurge; ownerPass?: OpenOwnerPass } = {},
): Promise<TreeMergeResult> {
  const home = options.home ?? homedir();
  const conflictRoot =
    options.conflictRoot ??
    join(aisRemoteCacheDir(home), "merge-conflicts", new Date().toISOString().replaceAll(":", "-"));
  const result: TreeMergeResult = { mergedJsonlFiles: 0, copiedFiles: 0, preservedConflicts: 0, preservedConflictPaths: [], busyPaths: [] };
  const registries = registryRelPaths(scope, home);
  const ownerPass = options.ownerPass ?? { lookups: 0 };

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

  for await (const source of walkFiles(incomingRoot)) {
    const rel = pathWithin(incomingRoot, source);
    if (!rel || registries.has(rel)) continue;
    const destination = join(home, rel);

    if (source.endsWith(".jsonl")) {
      // mergeJsonlFiles checks ownership only when there is an actual append
      // to make, so an unchanged replay does not become a false conflict.
      const sourceText = await Bun.file(source).text();
      const incompleteSource = sourceText.length > 0 && !sourceText.endsWith("\n");
      if (incompleteSource) {
        await preserveDeferredFile(source, home, rel);
        result.preservedConflicts++;
        result.preservedConflictPaths.push(rel);
      }
      const mergeResult = await mergeJsonlFiles([source], destination, false, ownerPass);
      if (mergeResult === "merged") result.mergedJsonlFiles++;
      else if (mergeResult === "busy") result.busyPaths.push(rel);
      else if (mergeResult === "deferred" && !incompleteSource) {
        await preserveDeferredFile(source, home, rel);
        result.preservedConflicts++;
        result.preservedConflictPaths.push(rel);
      }
      if ((await exists(destination)) && (await filesEqual(source, destination))) await convergeMtime(source, destination);
      continue;
    }

    if (!(await exists(destination))) {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      result.copiedFiles++;
      continue;
    }
    if (await filesEqual(source, destination)) {
      await convergeMtime(source, destination);
      continue;
    }

    const [sourceStat, destinationStat] = await Promise.all([stat(source), stat(destination)]);
    if (sourceStat.mtimeMs > destinationStat.mtimeMs) {
      await preserveFile(destination, conflictRoot, "local", rel);
      await copyFile(source, destination);
    } else {
      await preserveFile(source, conflictRoot, "incoming", rel);
    }
    result.preservedConflicts++;
    result.preservedConflictPaths.push(rel);
  }

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
