import { appendFile, copyFile, mkdir, readdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseIdentitiesFile } from "../identities/store.ts";
import type { Identity, ToolConfig } from "../identities/types.ts";
import { CLAUDE_CONFIG, CODEX_CONFIG, GROK_CONFIG, KIMI_CONFIG } from "../identities/tool-configs.ts";
import { matchDirectory } from "../identities/match.ts";
import { aisRemoteCacheDir } from "../shared/ais-home.ts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_FILE_PATTERN = new RegExp(`^(${UUID})\\.jsonl$`, "i");
const UUID_IN_FILE_PATTERN = new RegExp(`(${UUID})(?=\\.jsonl$)`, "i");
const UUID_DIR_PATTERN = new RegExp(`^${UUID}$`, "i");
const KIMI_SESSION_DIR_PATTERN = new RegExp(`^session_(${UUID})$`, "i");

type DedupableToolName = "claude" | "codex" | "grok" | "kimi";

interface ToolLayout {
  cfg: ToolConfig;
  rootName: string;
  legacyRelative: string;
}

const TOOL_LAYOUTS: ToolLayout[] = [
  { cfg: CLAUDE_CONFIG, rootName: ".claude", legacyRelative: "projects" },
  { cfg: CODEX_CONFIG, rootName: ".codex", legacyRelative: "sessions" },
  { cfg: GROK_CONFIG, rootName: ".grok", legacyRelative: "sessions" },
  { cfg: KIMI_CONFIG, rootName: ".kimi-code", legacyRelative: "sessions" },
];

interface SessionCopy {
  toolName: DedupableToolName;
  sessionId: string;
  /** Main JSONL for file-backed tools; session directory for directory-backed tools. */
  path: string;
  sidecarDir?: string;
  identityName?: string;
  legacy: boolean;
  live: boolean;
  datasetRoot: string;
}

interface LoadedLayout extends ToolLayout {
  identities: Identity[];
  configDirs: Map<string, string>;
}

export interface DedupeResult {
  duplicateSessions: number;
  divergentSessions: number;
  mergedJsonlFiles: number;
  copiedFiles: number;
  archivedPaths: number;
  assignedLegacySessions: number;
  unresolvedLegacySessions: number;
  archiveRoot?: string;
}

export interface DedupeOptions {
  home?: string;
  /** Additional trees laid out relative to home, normally rsync conflict backups. */
  supplementalRoots?: string[];
  dryRun?: boolean;
  /** Merge supplemental/conflicting copies without pruning live paths yet. */
  archiveDuplicates?: boolean;
  archiveRoot?: string;
  now?: Date;
}

function slash(path: string): string {
  return path.split(sep).join("/");
}

function pathWithin(root: string, path: string): string | undefined {
  const rel = slash(relative(root, path));
  if (!rel || rel === ".." || rel.startsWith("../")) return undefined;
  return rel;
}

function expandForHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return resolve(home, path.slice(2));
  return resolve(path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function loadLayouts(home: string): Promise<LoadedLayout[]> {
  const layouts: LoadedLayout[] = [];
  for (const layout of TOOL_LAYOUTS) {
    const registryPath = join(home, layout.rootName, "identities.json");
    const file = Bun.file(registryPath);
    const parsed = (await file.exists())
      ? parseIdentitiesFile(await file.json())
      : { version: 1 as const, identities: [] };
    const configDirs = new Map<string, string>();
    for (const identity of parsed.identities) {
      configDirs.set(identity.name, expandForHome(identity.configDir, home));
    }
    layouts.push({ ...layout, identities: parsed.identities, configDirs });
  }
  return layouts;
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
  }
}

async function scanProfile(
  toolName: DedupableToolName,
  profileDir: string,
  identityName: string | undefined,
  datasetRoot: string,
  live: boolean,
  legacy: boolean,
): Promise<SessionCopy[]> {
  const sessionRoot =
    toolName === "claude" ? join(profileDir, "projects") : join(profileDir, "sessions");
  const copies: SessionCopy[] = [];

  if (toolName === "claude") {
    for await (const path of walkFiles(sessionRoot)) {
      const match = basename(path).match(UUID_FILE_PATTERN);
      if (!match) continue;
      const sessionId = match[1]!.toLowerCase();
      const sidecarDir = join(dirname(path), sessionId);
      copies.push({
        toolName,
        sessionId,
        path,
        ...(await exists(sidecarDir) ? { sidecarDir } : {}),
        identityName,
        legacy,
        live,
        datasetRoot,
      });
    }
    return copies;
  }

  if (toolName === "codex") {
    for await (const path of walkFiles(sessionRoot)) {
      if (!path.endsWith(".jsonl")) continue;
      const match = basename(path).match(UUID_IN_FILE_PATTERN);
      if (!match) continue;
      copies.push({
        toolName,
        sessionId: match[1]!.toLowerCase(),
        path,
        identityName,
        legacy,
        live,
        datasetRoot,
      });
    }
    return copies;
  }

  const marker = toolName === "grok" ? "summary.json" : "state.json";
  for await (const path of walkFiles(sessionRoot)) {
    if (basename(path) !== marker) continue;
    const sessionDir = dirname(path);
    const dirName = basename(sessionDir);
    const match = toolName === "grok" ? dirName.match(UUID_DIR_PATTERN) : dirName.match(KIMI_SESSION_DIR_PATTERN);
    if (!match) continue;
    copies.push({
      toolName,
      sessionId: (toolName === "grok" ? dirName : match[1]!).toLowerCase(),
      path: sessionDir,
      identityName,
      legacy,
      live,
      datasetRoot,
    });
  }
  return copies;
}

async function collectCopies(home: string, supplementalRoots: string[], layouts: LoadedLayout[]): Promise<SessionCopy[]> {
  const datasets = [{ root: home, live: true }, ...supplementalRoots.map((root) => ({ root, live: false }))];
  const copies: SessionCopy[] = [];

  for (const dataset of datasets) {
    for (const layout of layouts) {
      const toolName = layout.cfg.toolName as DedupableToolName;
      for (const [identityName, liveConfigDir] of layout.configDirs) {
        const rel = pathWithin(home, liveConfigDir);
        if (!rel) continue;
        copies.push(
          ...(await scanProfile(
            toolName,
            join(dataset.root, rel),
            identityName,
            dataset.root,
            dataset.live,
            false,
          )),
        );
      }

      const legacyProfile = join(dataset.root, layout.rootName);
      copies.push(
        ...(await scanProfile(toolName, legacyProfile, undefined, dataset.root, dataset.live, true)),
      );
    }
  }
  return copies;
}

function copyOrder(home: string, a: SessionCopy, b: SessionCopy): number {
  if (a.live !== b.live) return a.live ? -1 : 1;
  if (a.legacy !== b.legacy) return a.legacy ? 1 : -1;
  const aIdentity = a.identityName ?? "~legacy";
  const bIdentity = b.identityName ?? "~legacy";
  const byIdentity = aIdentity.localeCompare(bIdentity);
  if (byIdentity !== 0) return byIdentity;
  return (pathWithin(home, a.path) ?? a.path).localeCompare(pathWithin(home, b.path) ?? b.path);
}

async function readLines(path: string): Promise<string[]> {
  const text = await Bun.file(path).text();
  if (!text) return [];
  const lines = text.split("\n");
  // Only complete newline-terminated records are safe to replicate. A live
  // writer may have emitted half a JSON object when rsync took its snapshot;
  // that source snapshot remains retained for recovery and the next exchange
  // will collect the completed record.
  lines.pop();
  return lines;
}

function multiset(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/** A multiset union preserves every occurrence present in the most complete
 * copy without counting a copied session twice. The longest source keeps its
 * native ordering; genuinely divergent events are appended in source order. */
export function mergeJsonlLineSets(sources: string[][]): string[] {
  if (sources.length === 0) return [];
  const base = [...sources].sort((a, b) => b.length - a.length)[0]!;
  return mergeJsonlLineSetsOnto(base, sources);
}

/** Add every missing occurrence to an existing destination without ever
 * removing or rewriting one of its lines. This is deliberately separate from
 * mergeJsonlLineSets(): a live agent may append to the destination while a
 * detached sync is running, so choosing another copy as the base and replacing
 * the file can lose an event written between the read and the rewrite. */
function mergeJsonlLineSetsOnto(base: string[], sources: string[][]): string[] {
  const desired = new Map<string, number>();
  for (const lines of sources) {
    const counts = multiset(lines);
    for (const [line, count] of counts) desired.set(line, Math.max(desired.get(line) ?? 0, count));
  }

  const merged = [...base];
  const present = multiset(merged);
  for (const lines of sources) {
    const seenInSource = new Map<string, number>();
    for (const line of lines) {
      const occurrence = (seenInSource.get(line) ?? 0) + 1;
      seenInSource.set(line, occurrence);
      if (occurrence <= (present.get(line) ?? 0)) continue;
      if ((present.get(line) ?? 0) >= (desired.get(line) ?? 0)) continue;
      merged.push(line);
      present.set(line, (present.get(line) ?? 0) + 1);
    }
  }
  return merged;
}

async function filesEqual(paths: string[]): Promise<boolean> {
  if (paths.length < 2) return true;
  const sizes = await Promise.all(paths.map(async (path) => (await stat(path)).size));
  if (sizes.some((size) => size !== sizes[0])) return false;
  const reference = Buffer.from(await Bun.file(paths[0]!).arrayBuffer());
  for (const path of paths.slice(1)) {
    if (!reference.equals(Buffer.from(await Bun.file(path).arrayBuffer()))) return false;
  }
  return true;
}

export async function mergeJsonlFiles(paths: string[], destination: string, dryRun: boolean): Promise<boolean> {
  const uniquePaths = [...new Set(paths)];
  if (uniquePaths.length === 0) return false;
  const destinationExists = await exists(destination);

  const sources = await Promise.all(uniquePaths.map(readLines));
  if (!destinationExists) {
    const merged = mergeJsonlLineSets(sources);
    const output = merged.length > 0 ? `${merged.join("\n")}\n` : "";
    if (!dryRun) {
      await mkdir(dirname(destination), { recursive: true });
      await Bun.write(destination, output);
    }
    return true;
  }

  // Re-read the destination last. appendFile() cannot erase a concurrent
  // writer's bytes; the old whole-file Bun.write() could and did. Do not
  // append behind an incomplete final record while the native tool is still
  // writing it — the next reconciliation will retry once the newline lands.
  const destinationText = await Bun.file(destination).text();
  if (destinationText.length > 0 && !destinationText.endsWith("\n")) return false;
  const destinationLines = destinationText.length > 0 ? destinationText.slice(0, -1).split("\n") : [];
  const merged = mergeJsonlLineSetsOnto(destinationLines, sources);
  const additions = merged.slice(destinationLines.length);
  if (additions.length === 0) return false;
  if (!dryRun) await appendFile(destination, `${additions.join("\n")}\n`);
  return true;
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for await (const path of walkFiles(root)) {
    const rel = pathWithin(root, path);
    if (rel) files.push(rel);
  }
  return files;
}

async function mergeDirectories(
  sourceDirs: string[],
  destination: string,
  dryRun: boolean,
  result: DedupeResult,
): Promise<void> {
  const byRelativePath = new Map<string, string[]>();
  for (const sourceDir of [...new Set(sourceDirs)]) {
    for (const rel of await listRelativeFiles(sourceDir)) {
      const paths = byRelativePath.get(rel) ?? [];
      paths.push(join(sourceDir, rel));
      byRelativePath.set(rel, paths);
    }
  }

  for (const [rel, paths] of byRelativePath) {
    const target = join(destination, rel);
    if (rel.endsWith(".jsonl")) {
      if (await mergeJsonlFiles(paths, target, dryRun)) result.mergedJsonlFiles++;
      continue;
    }
    const candidates = await Promise.all(
      paths.map(async (path) => ({ path, info: await stat(path) })),
    );
    candidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs || b.info.size - a.info.size || a.path.localeCompare(b.path));
    const chosen = candidates[0]!.path;
    if ((await exists(target)) && (await filesEqual([target, chosen]))) continue;
    if (!dryRun) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(chosen, target);
    }
    result.copiedFiles++;
  }
}

async function moveToArchive(path: string, home: string, archiveRoot: string): Promise<boolean> {
  if (!(await exists(path))) return false;
  const rel = pathWithin(home, path);
  if (!rel) throw new Error(`Refusing to archive deduplicated path outside home: ${path}`);
  let destination = join(archiveRoot, rel);
  if (await exists(destination)) destination = `${destination}.${crypto.randomUUID()}`;
  await mkdir(dirname(destination), { recursive: true });
  await rename(path, destination);
  return true;
}

async function recordedCwd(copy: SessionCopy): Promise<string | undefined> {
  try {
    if (copy.toolName === "grok") {
      const summary = (await Bun.file(join(copy.path, "summary.json")).json()) as { info?: { cwd?: string } };
      return summary.info?.cwd;
    }
    if (copy.toolName === "kimi") {
      const state = (await Bun.file(join(copy.path, "state.json")).json()) as { workDir?: string };
      return state.workDir;
    }
    for (const line of (await Bun.file(copy.path).text()).split("\n").slice(0, 100)) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { cwd?: string; payload?: { cwd?: string } };
      const cwd = entry.cwd ?? entry.payload?.cwd;
      if (cwd) return cwd;
    }
  } catch {
    // An unreadable legacy session remains in place rather than being guessed.
  }
  return undefined;
}

async function identityForLegacy(copy: SessionCopy, layout: LoadedLayout): Promise<string | undefined> {
  let identityName: string | undefined;
  const cwd = await recordedCwd(copy);
  if (cwd) {
    const matched = matchDirectory(cwd, layout.identities);
    if (matched && !("ambiguous" in matched)) identityName = matched.identity.name;
  }
  if (!identityName && layout.identities.length === 1) identityName = layout.identities[0]!.name;
  return identityName;
}

async function destinationForLegacy(copy: SessionCopy, layout: LoadedLayout): Promise<SessionCopy | undefined> {
  const identityName = copy.identityName ?? (await identityForLegacy(copy, layout));
  if (!identityName) return undefined;
  const configDir = layout.configDirs.get(identityName);
  if (!configDir) return undefined;
  const legacyRoot = join(copy.datasetRoot, layout.rootName, layout.legacyRelative);
  const rel = pathWithin(legacyRoot, copy.path);
  if (!rel) return undefined;
  const sessionRoot = copy.toolName === "claude" ? join(configDir, "projects") : join(configDir, "sessions");
  const path = join(sessionRoot, rel);
  return {
    ...copy,
    path,
    ...(copy.sidecarDir ? { sidecarDir: join(dirname(path), copy.sessionId) } : {}),
    identityName,
    legacy: false,
    live: true,
    datasetRoot: dirname(configDir),
  };
}

function destinationForSupplemental(copy: SessionCopy, home: string): SessionCopy | undefined {
  const rel = pathWithin(copy.datasetRoot, copy.path);
  if (!rel) return undefined;
  const path = join(home, rel);
  return {
    ...copy,
    path,
    ...(copy.sidecarDir ? { sidecarDir: join(dirname(path), copy.sessionId) } : {}),
    live: true,
    datasetRoot: home,
  };
}

async function mergeGroup(
  group: SessionCopy[],
  home: string,
  layouts: LoadedLayout[],
  dryRun: boolean,
  archiveDuplicates: boolean,
  archiveRoot: string,
  result: DedupeResult,
): Promise<void> {
  const liveCopies = group.filter((copy) => copy.live);
  let canonical =
    liveCopies.length > 0
      ? [...liveCopies].sort((a, b) => copyOrder(home, a, b))[0]!
      : destinationForSupplemental([...group].sort((a, b) => copyOrder(home, a, b))[0]!, home);
  if (!canonical) return;

  if (canonical.legacy && group.every((copy) => copy.legacy)) {
    const canonicalToolName = canonical.toolName;
    const layout = layouts.find((candidate) => candidate.cfg.toolName === canonicalToolName)!;
    const assigned = await destinationForLegacy(canonical, layout);
    if (assigned) {
      canonical = assigned;
      result.assignedLegacySessions++;
    } else {
      result.unresolvedLegacySessions++;
    }
  }

  const duplicateLiveCopies = liveCopies.filter((copy) => copy.path !== canonical.path);
  if (duplicateLiveCopies.length > 0) result.duplicateSessions++;

  if (canonical.toolName === "claude" || canonical.toolName === "codex") {
    const paths = [canonical.path, ...group.map((copy) => copy.path)].filter(
      (path, index, all) => all.indexOf(path) === index && group.some((copy) => copy.path === path),
    );
    if (!(await filesEqual(paths))) result.divergentSessions++;
    if (await mergeJsonlFiles(paths, canonical.path, dryRun)) result.mergedJsonlFiles++;
    if (canonical.toolName === "claude") {
      const sidecars = group.map((copy) => copy.sidecarDir).filter((path): path is string => Boolean(path));
      if (sidecars.length > 0) {
        await mergeDirectories(sidecars, canonical.sidecarDir ?? join(dirname(canonical.path), canonical.sessionId), dryRun, result);
      }
    }
  } else {
    await mergeDirectories(group.map((copy) => copy.path), canonical.path, dryRun, result);
  }

  if (dryRun) {
    result.archivedPaths += duplicateLiveCopies.reduce(
      (count, copy) => count + 1 + (copy.sidecarDir ? 1 : 0),
      0,
    );
    return;
  }

  if (!archiveDuplicates) return;

  for (const copy of duplicateLiveCopies) {
    if (await moveToArchive(copy.path, home, archiveRoot)) result.archivedPaths++;
    if (copy.sidecarDir && (await moveToArchive(copy.sidecarDir, home, archiveRoot))) result.archivedPaths++;
  }
}

/**
 * Deduplicate native usage/session stores by each tool's stable session ID.
 * Copies within the same identity, legacy top-level roots, machine-specific
 * cwd buckets, and retained conflict snapshots are unioned before an explicit
 * dedupe may move redundant live paths into a recoverable cache archive.
 */
export async function deduplicateUsageData(options: DedupeOptions = {}): Promise<DedupeResult> {
  const home = options.home ?? homedir();
  const supplementalRoots = options.supplementalRoots ?? [];
  const dryRun = options.dryRun ?? false;
  const archiveDuplicates = options.archiveDuplicates ?? true;
  const archiveRoot =
    options.archiveRoot ??
    join(aisRemoteCacheDir(home), "dedupe-backups", (options.now ?? new Date()).toISOString().replaceAll(":", "-"));
  const result: DedupeResult = {
    duplicateSessions: 0,
    divergentSessions: 0,
    mergedJsonlFiles: 0,
    copiedFiles: 0,
    archivedPaths: 0,
    assignedLegacySessions: 0,
    unresolvedLegacySessions: 0,
  };

  const layouts = await loadLayouts(home);
  const copies = await collectCopies(home, supplementalRoots, layouts);

  // A stable session ID is only a dedupe key inside one identity. The old
  // global key silently moved a valid session out of one identity whenever a
  // copy existed under another. Legacy top-level copies are associated with a
  // sole existing identity for that ID where possible, otherwise by their
  // recorded cwd/directory rules; ambiguous archives remain in the legacy
  // store instead of being guessed or hidden.
  const identitiesBySession = new Map<string, Set<string>>();
  for (const copy of copies) {
    if (copy.legacy || !copy.identityName) continue;
    const key = `${copy.toolName}:${copy.sessionId}`;
    const identities = identitiesBySession.get(key) ?? new Set<string>();
    identities.add(copy.identityName);
    identitiesBySession.set(key, identities);
  }
  for (const copy of copies) {
    if (!copy.legacy) continue;
    const identities = identitiesBySession.get(`${copy.toolName}:${copy.sessionId}`);
    if (identities?.size === 1) {
      copy.identityName = [...identities][0];
      continue;
    }
    const layout = layouts.find((candidate) => candidate.cfg.toolName === copy.toolName)!;
    copy.identityName = await identityForLegacy(copy, layout);
  }

  const groups = new Map<string, SessionCopy[]>();
  for (const copy of copies) {
    const key = `${copy.toolName}:${copy.identityName ?? "~legacy"}:${copy.sessionId}`;
    const group = groups.get(key) ?? [];
    group.push(copy);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.length === 1 && group[0]!.live && !group[0]!.legacy) continue;
    await mergeGroup(group, home, layouts, dryRun, archiveDuplicates, archiveRoot, result);
  }

  if (!dryRun && result.archivedPaths > 0) result.archiveRoot = archiveRoot;
  return result;
}
