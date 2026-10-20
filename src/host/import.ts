import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseBundleTar } from "../live/bundle.ts";
import { SYNC_TOOL_CONFIGS, isTransientSyncPath } from "../sync/rsync.ts";
import { mergeIncomingProfileTree } from "../sync/tree-merge.ts";
import { aisCacheDir } from "../shared/ais-home.ts";
import { readHostFileBounded } from "./export.ts";

export interface ImportLogsResult { applied: number; skipped: number; conflicts: string[]; }

async function validateDestination(home: string, relPath: string): Promise<string> {
  const root = resolve(home);
  const target = resolve(root, ...relPath.split("/"));
  const rel = relative(root, target);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("unsafe host log path");
  const parts = rel.split(sep);
  let cursor = root;
  for (const [index, part] of parts.entries()) {
    cursor = resolve(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error("host log target contains a symlink");
      if (index < parts.length - 1 && !info.isDirectory()) throw new Error("host log target has a non-directory parent");
      if (index === parts.length - 1 && !info.isFile()) throw new Error("host log target is not a regular file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
  const realRoot = await realpath(root);
  let existing = target;
  while (true) {
    try { await stat(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw new Error("host log path has no existing parent");
      existing = parent;
    }
  }
  const realExisting = await realpath(existing);
  const realRel = relative(realRoot, realExisting);
  if (realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw new Error("host log target escapes home");
  return target;
}

async function validateCachePath(home: string): Promise<string> {
  const root = resolve(home);
  const target = resolve(aisCacheDir(home));
  const conflictTarget = resolve(target, "host-import-conflicts");
  const rel = relative(root, conflictTarget);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("host cache is outside home");
  let cursor = root;
  for (const component of rel.split(sep)) {
    cursor = resolve(cursor, component);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("host cache path is unsafe");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; break; }
  }
  const realRoot = await realpath(root);
  let existing = conflictTarget;
  while (true) {
    try { await stat(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw new Error("host cache has no existing parent");
      existing = parent;
    }
  }
  const realExisting = await realpath(existing);
  const realRel = relative(realRoot, realExisting);
  if (realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw new Error("host cache escapes home");
  return target;
}

function conflictRelativePath(relPath: string, bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `.ais/cache/host-import-conflicts/${relPath}.${digest}`;
}

async function preserveConflict(home: string, destination: string, relPath: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
  checkCancelled(signal);
  const checked = await validateDestination(home, relPath);
  if (checked !== destination) throw new Error("host conflict target changed");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await validateDestination(home, relPath);
  checkCancelled(signal);
  try { await writeFile(destination, bytes, { mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("host request cancelled");
}

export async function importLogs(tar: Uint8Array, home = homedir(), signal?: AbortSignal): Promise<ImportLogsResult> {
  checkCancelled(signal);
  const bundle = parseBundleTar(tar, "outbox");
  const root = resolve(home);
  const rootReal = await realpath(root);
  const selected = bundle.manifest.entries.filter((entry) => entry.class === "logs" && bundle.files.has(entry.path));
  const stageParent = await validateCachePath(home);
  const destinations = new Map<string, string>();
  const conflictDestinations = new Map<string, string>();
  // Validate every path before creating staging or conflict directories.
  for (const entry of selected) {
    checkCancelled(signal);
    if (isTransientSyncPath(entry.path)) throw new Error("transient data is not importable host log content");
    destinations.set(entry.path, await validateDestination(home, entry.path));
    const conflictPath = conflictRelativePath(entry.path, bundle.files.get(entry.path)!);
    conflictDestinations.set(entry.path, await validateDestination(home, conflictPath));
  }
  await mkdir(stageParent, { recursive: true, mode: 0o700 });
  await validateCachePath(home);
  const stage = await mkdtemp(resolve(stageParent, "host-logs-"));
  try {
    const conflicts: string[] = [];
    const toStage: typeof selected = [];
    let directlyApplied = 0;
    for (const entry of selected) {
      checkCancelled(signal);
      const target = destinations.get(entry.path)!;
      const bytes = bundle.files.get(entry.path)!;
      let current = false;
      try { await lstat(target); current = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (current && !entry.path.endsWith(".jsonl")) {
        const info = await lstat(target);
        if (info.size === bytes.byteLength) {
          const existing = await readHostFileBounded(target, bytes.byteLength);
          if (existing && existing.every((byte, index) => byte === bytes[index])) continue;
        }
        await preserveConflict(home, conflictDestinations.get(entry.path)!, conflictRelativePath(entry.path, bytes), bytes, signal);
        conflicts.push(entry.path);
        continue;
      }
      if (entry.path.endsWith(".jsonl") && bytes[bytes.byteLength - 1] !== 10) {
        await preserveConflict(home, conflictDestinations.get(entry.path)!, conflictRelativePath(entry.path, bytes), bytes, signal);
        conflicts.push(entry.path);
        continue;
      }
      if (entry.path.endsWith(".jsonl")) toStage.push(entry);
      else {
        try {
          checkCancelled(signal);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          checkCancelled(signal);
          await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
          directlyApplied++;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          await preserveConflict(home, conflictDestinations.get(entry.path)!, conflictRelativePath(entry.path, bytes), bytes, signal);
          conflicts.push(entry.path);
        }
      }
    }
    for (const entry of toStage) {
      checkCancelled(signal);
      const destination = resolve(stage, ...entry.path.split("/"));
      const rel = relative(stage, destination);
      if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("unsafe host log path");
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bundle.files.get(entry.path)!, { mode: 0o600, flag: "wx" });
    }
    // Shared merge provides JSONL union, identity-independent log handling,
    // and durable copies of incomplete-line conflicts. Logs never carry identity registries.
    const cfg = SYNC_TOOL_CONFIGS[0]!;
    // The shared tree merge is a multi-file mutation without an abort hook.
    // Honour cancellation immediately before entering that non-atomic boundary.
    checkCancelled(signal);
    const conflictRoot = resolve(stageParent, "host-import-conflicts", randomUUID());
    const result = toStage.length ? await mergeIncomingProfileTree(stage, { kind: "identity", cfg, identityName: "host-import" }, {
      home,
      conflictRoot,
      purgeRetired: async () => ({ removed: [], failures: [], warnings: [] }),
    }) : { mergedJsonlFiles: 0, copiedFiles: 0, preservedConflicts: 0, preservedConflictPaths: [], busyPaths: [] };
    const stageReal = await realpath(stage);
    const stageRel = relative(rootReal, stageReal);
    if (stageRel.startsWith(`..${sep}`) || isAbsolute(stageRel)) throw new Error("host import staging escaped its home");
    const applied = directlyApplied + result.mergedJsonlFiles + result.copiedFiles;
    conflicts.push(...result.preservedConflictPaths);
    // The staging copy is deleted below, so a log still open in a native tool
    // must be kept durably rather than left for a later sync to retry.
    for (const rel of result.busyPaths) {
      checkCancelled(signal);
      const kept = resolve(conflictRoot, "incoming", ...rel.split("/"));
      await mkdir(dirname(kept), { recursive: true, mode: 0o700 });
      await writeFile(kept, bundle.files.get(rel)!, { mode: 0o600 });
      conflicts.push(rel);
    }
    return { applied, skipped: new Set(conflicts).size, conflicts: [...new Set(conflicts)] };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
