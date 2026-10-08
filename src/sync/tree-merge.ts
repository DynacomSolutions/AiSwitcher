import { copyFile, mkdir, readdir, readlink, stat } from "node:fs/promises";
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
  for (const entry of entries) {
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

async function hasOpenOwner(path: string): Promise<boolean | undefined> {
  if (!(await exists(path))) return false;
  const lsof = Bun.which("lsof") ??
    (process.platform === "darwin" && existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : undefined);
  if (lsof) {
    const proc = Bun.spawn([lsof, "-t", path], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (stdout.trim()) return true;
    if (exitCode === 0 || exitCode === 1) return false;
  }
  if (process.platform !== "linux") return undefined;

  let processDirs: string[];
  try {
    processDirs = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  } catch {
    return undefined;
  }
  for (const pid of processDirs) {
    let fds: string[];
    try {
      fds = await readdir(join("/proc", pid, "fd"));
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if ((await readlink(join("/proc", pid, "fd", fd))).replace(/ \(deleted\)$/, "") === path) return true;
      } catch {
        // Processes and descriptors can disappear while /proc is read.
      }
    }
  }
  return false;
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
  options: { home?: string; conflictRoot?: string; purgeRetired?: RetiredPurge } = {},
): Promise<TreeMergeResult> {
  const home = options.home ?? homedir();
  const conflictRoot =
    options.conflictRoot ??
    join(aisRemoteCacheDir(home), "merge-conflicts", new Date().toISOString().replaceAll(":", "-"));
  const result: TreeMergeResult = { mergedJsonlFiles: 0, copiedFiles: 0, preservedConflicts: 0 };
  const registries = registryRelPaths(scope, home);

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
      // Even append-only writes must not interleave with a native tool's own
      // partial record. If ownership cannot be proved absent, retain the
      // incoming bytes and let the post-exit reconciliation retry them.
      if ((await hasOpenOwner(destination)) !== false) {
        await preserveFile(source, conflictRoot, "incoming", rel);
        result.preservedConflicts++;
        continue;
      }
      const sourceText = await Bun.file(source).text();
      if (sourceText.length > 0 && !sourceText.endsWith("\n")) {
        await preserveFile(source, conflictRoot, "incoming", rel);
        result.preservedConflicts++;
      }
      if (await mergeJsonlFiles([source], destination, false)) result.mergedJsonlFiles++;
      continue;
    }

    if (!(await exists(destination))) {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      result.copiedFiles++;
      continue;
    }
    if (await filesEqual(source, destination)) continue;

    const [sourceStat, destinationStat] = await Promise.all([stat(source), stat(destination)]);
    if (sourceStat.mtimeMs > destinationStat.mtimeMs) {
      await preserveFile(destination, conflictRoot, "local", rel);
      await copyFile(source, destination);
    } else {
      await preserveFile(source, conflictRoot, "incoming", rel);
    }
    result.preservedConflicts++;
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
  const result: ArchiveRecoveryResult = {
    archiveRoots: roots.length,
    mergedJsonlFiles: 0,
    copiedFiles: 0,
    preservedConflicts: 0,
  };

  for (const root of roots) {
    for await (const source of walkFiles(root)) {
      const rel = pathWithin(root, source);
      if (!rel || RECOVERY_SKIP_PATTERN.test(rel) || basename(rel) === "identities.json") continue;
      const destination = join(home, rel);
      if (source.endsWith(".jsonl")) {
        if (await mergeJsonlFiles([source], destination, dryRun)) result.mergedJsonlFiles++;
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
