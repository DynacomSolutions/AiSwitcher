import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { expandPath } from "../identities/match.ts";
import { loadIdentitiesFile } from "../identities/store.ts";
import type { ToolConfig } from "../identities/types.ts";
import { AIS_REMOTE_CACHE_REL, aisRemoteCacheDir } from "../shared/ais-home.ts";
import { acquirePidLock } from "../shared/pid-lock.ts";
import { loadSyncConfig } from "./config.ts";
import { makeRegistryPortable } from "./registry.ts";
import { makeProfileHookConfigsPortable, makeSharedHookScriptsPortable } from "./portable-config.ts";
import {
  buildCrushSnapshotFilterArgs,
  buildSyncFilterArgs,
  runRsync,
  CRUSH_BACKED_TOOL_CONFIGS,
  REMOTE_LOW_PRIORITY,
  SYNC_TOOL_CONFIGS,
} from "./rsync.ts";
import { formatIo, ioPhase, ioSnapshot, ioTraceEnabled, isPhaseList, stagedSummary, type PhaseIo } from "./io-trace.ts";
import { pruneStaging } from "./staging.ts";
import { crushFingerprint, ignoredPathFilters, loadSteadyState, saveSteadyState, type SteadyState } from "./steady-state.ts";
import {
  createCrushSnapshotTree,
  loadCrushSnapshotManifest,
  mergeCrushSnapshotTree,
} from "./sqlite-merge.ts";
import { listHistories, planTails, TAIL_MIN_BYTES, TAIL_PLAN_FILE, tailExcludeFilters, type HistoryManifest, type TailPlan } from "./tail-sync.ts";
import { mergeIncomingProfileTree, type TreeMergeResult } from "./tree-merge.ts";
import type { SyncRunOptions, SyncRunResult, SyncScope } from "./types.ts";

const LOCK_RETRY_MS = 100;
/** A foreground `sync now` queues behind a running sync (often a hook's background run) for this long. */
export const LOCK_WAIT_MS = 10 * 60_000;
const REMOTE_AIS = "$HOME/.local/bin/ais";
const SSH_ARGS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=4",
  "-o",
  "ControlMaster=auto",
  "-o",
  "ControlPersist=300",
  "-o",
  "ControlPath=~/.ssh/ais-sync-%C",
];

function slash(path: string): string {
  return path.split(sep).join("/");
}

function syncLockPath(home: string = homedir()): string {
  return join(aisRemoteCacheDir(home), "sync.lock");
}

/** Try once; when a foreground caller must wait, say who holds the lock, then keep waiting. */
export async function acquireSyncLock(
  wait: boolean,
  home: string = homedir(),
  waitMs: number = Number(process.env.AIS_SYNC_LOCK_WAIT_MS) || LOCK_WAIT_MS,
): Promise<(() => Promise<void>) | undefined> {
  const path = syncLockPath(home);
  const first = await acquirePidLock(path, { waitMs: 0, retryMs: LOCK_RETRY_MS });
  if (first || !wait) return first;
  const holder = await Bun.file(path).json().then((v: { pid?: number; startedAt?: string }) => v, () => undefined);
  console.error(
    `AIS sync: another sync${holder?.pid ? ` (pid ${holder.pid}${holder.startedAt ? `, started ${holder.startedAt}` : ""})` : ""} is running; waiting up to ${Math.round(waitMs / 60_000)} min for it, then this one runs.`,
  );
  return acquirePidLock(path, { waitMs, retryMs: LOCK_RETRY_MS });
}

interface CrushProjectsFile {
  projects?: Array<{ path?: string; data_dir?: string }>;
}

function homeRelative(path: string, home: string): string | undefined {
  const rel = slash(relative(home, path));
  if (!rel || rel === ".." || rel.startsWith("../")) return undefined;
  return rel;
}

/** Generalized from a zai-only implementation once ali (the second
 * crush-backed tool) was added: scans every crush-backed registry
 * (CRUSH_BACKED_TOOL_CONFIGS: zai, ali) rather than hardcoding ZAI_CONFIG,
 * so a scope narrowed to `identity`/ali also gets its project data dirs
 * collected instead of silently returning nothing. */
function isCrushBacked(cfg: ToolConfig): boolean {
  return cfg.realBinaryName === "crush";
}

async function collectProjectDataDirs(scope: SyncScope, home: string = homedir()): Promise<string[]> {
  if (scope.kind === "identity" && !isCrushBacked(scope.cfg)) return [];
  const configs = scope.kind === "identity" ? [scope.cfg] : CRUSH_BACKED_TOOL_CONFIGS;
  const dirs = new Set<string>();

  for (const cfg of configs) {
    const file = await loadIdentitiesFile(cfg.identitiesJsonPath);
    const identities =
      scope.kind === "identity" ? file.identities.filter((identity) => identity.name === scope.identityName) : file.identities;

    for (const identity of identities) {
      try {
        const projects = (await Bun.file(join(expandPath(identity.configDir), "data", "projects.json")).json()) as CrushProjectsFile;
        for (const project of projects.projects ?? []) {
          if (!project.data_dir) continue;
          const rel = homeRelative(project.data_dir, home);
          if (rel) dirs.add(rel);
        }
      } catch {
        // A new crush-backed identity has no projects index yet.
      }
    }
  }

  if (scope.kind === "identity" && isCrushBacked(scope.cfg) && scope.cwd) {
    const rel = homeRelative(join(scope.cwd, ".crush"), home);
    if (rel) dirs.add(rel);
  }
  return [...dirs];
}

async function collectProfileDataDirs(scope: SyncScope, home: string = homedir()): Promise<string[]> {
  const configs = scope.kind === "all" ? SYNC_TOOL_CONFIGS : [scope.cfg];
  const dirs = new Set<string>();
  for (const cfg of configs) {
    const file = await loadIdentitiesFile(cfg.identitiesJsonPath);
    const identities =
      scope.kind === "identity" ? file.identities.filter((identity) => identity.name === scope.identityName) : file.identities;
    for (const identity of identities) {
      const expanded = expandPath(identity.configDir);
      const rel = homeRelative(expanded, home);
      if (!rel) {
        throw new Error(
          `${cfg.toolName}/${identity.name}: configDir "${identity.configDir}" is outside the home directory and cannot be SSH-synced`,
        );
      }
      dirs.add(rel);
    }
  }
  return [...dirs];
}

function syncError(host: string, direction: "pull" | "push", stderr: string, exitCode: number): Error {
  const detail = stderr.trim().split("\n").slice(-2).join(" ") || `rsync exited ${exitCode}`;
  return new Error(`${direction} ${host} failed: ${detail}`);
}

function safeHostSegment(host: string): string {
  return host.replace(/[^A-Za-z0-9._@-]/g, "_");
}

async function runRemoteAis(host: string, args: string[], input?: string): Promise<string> {
  const remoteAis = ioTraceEnabled() ? `env AIS_SYNC_IO_TRACE=1 ${REMOTE_AIS}` : REMOTE_AIS;
  const proc = Bun.spawn(["ssh", ...SSH_ARGS, host, `${REMOTE_LOW_PRIORITY} ${remoteAis}`, ...args], {
    ...(input === undefined ? {} : { stdin: new Blob([input]) }),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`remote AIS command on ${host} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return stdout.trim();
}

function syncsCrush(scope: SyncScope): boolean {
  return scope.kind === "all" || isCrushBacked(scope.cfg);
}

async function makeSyncStatePortable(scope: SyncScope, home: string): Promise<void> {
  const registryConfigs = scope.kind === "all" ? SYNC_TOOL_CONFIGS : [scope.cfg];
  for (const cfg of registryConfigs) await makeRegistryPortable(cfg, home);
  await makeProfileHookConfigsPortable(scope, home);
  if (scope.kind === "all") await makeSharedHookScriptsPortable(home);
}

interface RemoteSnapshotResponse {
  snapshotId: string;
  databases: string[];
  /** The remote databases match the token we sent: nothing to snapshot, copy or merge. */
  unchanged?: boolean;
  token?: string;
}

function parseRemoteSnapshot(raw: string, host: string): RemoteSnapshotResponse {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`remote AIS snapshot on ${host} returned invalid JSON`);
  }
  if (typeof value !== "object" || value === null) throw new Error(`remote AIS snapshot on ${host} is invalid`);
  const rec = value as Record<string, unknown>;
  const token = typeof rec.token === "string" ? rec.token : undefined;
  if (rec.unchanged === true) return { snapshotId: "", databases: [], unchanged: true, token };
  if (typeof rec.snapshotId !== "string" || !Array.isArray(rec.databases) || rec.databases.some((p) => typeof p !== "string")) {
    throw new Error(`remote AIS snapshot on ${host} is invalid`);
  }
  return { snapshotId: rec.snapshotId, databases: rec.databases as string[], token };
}

async function pullCrushSnapshots(host: string, home: string, state: SteadyState): Promise<void> {
  // An unchanged remote costs one tiny command instead of a VACUUM INTO, a full rsync and an ATTACH merge.
  const known = state.crush[host]?.remote;
  const rawSnapshot = await runRemoteAis(host, ["sync", "snapshot-zai", ...(known ? [`--if-changed=${known}`] : [])]);
  noteRemoteIo(host, rawSnapshot);
  const remote = parseRemoteSnapshot(rawSnapshot, host);
  if (remote.unchanged) return;
  const localRoot = join(aisRemoteCacheDir(home), "sqlite-incoming", `${safeHostSegment(host)}-${remote.snapshotId}`);
  try {
    await mkdir(localRoot, { recursive: true });
    const pulled = await runRsync(host, "pull", buildCrushSnapshotFilterArgs(remote.databases), home, {
      localRoot,
      remoteRoot: `${AIS_REMOTE_CACHE_REL}/sqlite-snapshots/${remote.snapshotId}`,
    });
    if (pulled.exitCode !== 0) throw syncError(host, "pull", pulled.stderr, pulled.exitCode);
    const manifest = await loadCrushSnapshotManifest(localRoot);
    await mergeCrushSnapshotTree(manifest, home);
    state.crush[host] = { ...state.crush[host], remote: remote.token };
  } finally {
    await rm(localRoot, { recursive: true, force: true });
    // Best effort: the remote also prunes stale staging on every profile merge.
    await runRemoteAis(host, ["sync", "drop-zai-snapshot", remote.snapshotId]).catch(() => undefined);
  }
}

async function pushCrushSnapshots(host: string, home: string, state: SteadyState): Promise<void> {
  const token = await crushFingerprint(home);
  // No token means no local Crush database: there is nothing to snapshot, push or ask the remote to merge.
  if (!token || state.crush[host]?.local === token) return;
  const snapshotId = crypto.randomUUID();
  const localRoot = join(aisRemoteCacheDir(home), "sqlite-snapshots", snapshotId);
  try {
    const manifest = await createCrushSnapshotTree(localRoot, home);
    const pushed = await runRsync(host, "push", buildCrushSnapshotFilterArgs(manifest.databases), home, {
      localRoot,
      remoteRoot: `${AIS_REMOTE_CACHE_REL}/sqlite-incoming/${snapshotId}`,
    });
    if (pushed.exitCode !== 0) throw syncError(host, "push", pushed.stderr, pushed.exitCode);
    const merged = await runRemoteAis(host, ["sync", "merge-zai-snapshot", snapshotId]);
    noteRemoteIo(host, merged);
    state.crush[host] = { local: token, remote: parseJson(merged)?.token };
  } finally {
    await rm(localRoot, { recursive: true, force: true });
  }
}

function parseJson(raw: string): { token?: string; deniedPaths?: string[]; io?: unknown; planned?: number; needsFull?: string[]; manifest?: HistoryManifest } | undefined {
  try {
    const value = JSON.parse(raw.trim().split("\n").at(-1) ?? "");
    return typeof value === "object" && value !== null ? value : undefined;
  } catch { return undefined; }
}

/** Remote-side phases arrive in the JSON of an AIS_SYNC_IO_TRACE=1 command. */
const remoteIo: PhaseIo[] = [];
function noteRemoteIo(host: string, raw: string): void {
  const io = parseJson(raw)?.io;
  if (isPhaseList(io)) remoteIo.push(...io.map((p) => ({ ...p, phase: `${host}:${p.phase}` })));
}

function scopeArgs(scope: SyncScope): string[] {
  if (scope.kind === "all") return [];
  return [`--tool=${scope.cfg.toolName}`, `--identity=${scope.identityName}`];
}

/** Everything the local side prepared for one tail-only exchange of append-only histories. */
interface PushTails { id: string; outDir: string; plan: TailPlan }

/** Ask the remote which histories it holds, then ship only the bytes it lacks. Undefined when there is nothing to
 * ship or the remote predates this command (the bulk transfer then carries those histories whole, as before). */
async function pushTails(host: string, scope: SyncScope, home: string, state: SteadyState): Promise<PushTails | undefined> {
  // No large local history, nothing worth a round trip.
  if (Object.keys(await listHistories(home, scope, new Set(state.ignored), TAIL_MIN_BYTES)).length === 0) return undefined;
  const raw = await runRemoteAis(host, ["sync", "tail-manifest", ...scopeArgs(scope)]).catch(() => undefined);
  const manifest = raw ? parseJson(raw)?.manifest : undefined;
  if (!manifest || Object.keys(manifest).length === 0) return undefined;
  noteRemoteIo(host, raw!);
  const id = crypto.randomUUID();
  const outDir = join(aisRemoteCacheDir(home), "tail-outgoing", id);
  try {
    const plan = await planTails(home, scope, manifest, outDir, new Set(state.ignored));
    if (Object.keys(plan).length === 0) { await rm(outDir, { recursive: true, force: true }); return undefined; }
    const pushed = await runRsync(host, "push", [], home, { localRoot: outDir, remoteRoot: `${AIS_REMOTE_CACHE_REL}/tail-incoming/${id}` });
    if (pushed.exitCode !== 0) throw syncError(host, "push", pushed.stderr, pushed.exitCode);
    return { id, outDir, plan };
  } catch (error) {
    await rm(outDir, { recursive: true, force: true });
    throw error;
  }
}

/** One staged push plus the remote merge. `tailsId` names tail files already shipped for the same merge. */
async function pushSnapshot(host: string, filters: string[], scope: SyncScope, home: string, state: SteadyState, tailsId?: string): Promise<string[]> {
  const snapshotId = crypto.randomUUID();
  const remoteRoot = `${AIS_REMOTE_CACHE_REL}/profile-incoming/${snapshotId}`;
  const pushed = await ioPhase("push-rsync", () => runRsync(host, "push", filters, home, {
    remoteRoot,
    // The incoming root is ~/.ais/remote-cache/profile-incoming/<uuid>. Omit
    // files byte-identical to the receiver's live home so staging is sparse
    // rather than another multi-gigabyte profile copy.
    compareDest: "../../../..",
  }));
  if (pushed.exitCode !== 0) throw syncError(host, "push", pushed.stderr, pushed.exitCode);
  const merged = await runRemoteAis(host, ["sync", "merge-profile-snapshot", snapshotId, ...scopeArgs(scope), ...(tailsId ? [`--tails=${tailsId}`] : [])]);
  noteRemoteIo(host, merged);
  const parsed = parseJson(merged);
  noteDenied(state, parsed?.deniedPaths);
  return parsed?.needsFull ?? [];
}

/** rsync `--files-from` list naming exactly these home-relative paths. */
async function writeFileList(home: string, rels: string[]): Promise<string> {
  const path = join(aisRemoteCacheDir(home), "tail-incoming", `${crypto.randomUUID()}.full-list`);
  await mkdir(join(aisRemoteCacheDir(home), "tail-incoming"), { recursive: true });
  await writeFile(path, `${rels.join("\n")}\n`);
  return path;
}

async function pushProfileSnapshot(host: string, filters: string[], scope: SyncScope, home: string, state: SteadyState): Promise<void> {
  const tails = await ioPhase("push-tails", () => pushTails(host, scope, home, state));
  try {
    const needsFull = await pushSnapshot(host, [...tailExcludeFilters(tails?.plan ?? {}), ...filters], scope, home, state, tails?.id);
    // A tail whose prefix did not verify on the remote is staged whole and merged the ordinary way.
    if (needsFull.length > 0) {
      const list = await writeFileList(home, needsFull);
      try { await pushSnapshot(host, [`--files-from=${list}`], scope, home, state); }
      finally { await rm(list, { force: true }); }
    }
  } finally {
    if (tails) await rm(tails.outDir, { recursive: true, force: true });
  }
}

/** Fetch the bytes this host lacks of histories it already holds. Undefined when there are none or the remote
 * cannot plan them (an older version): the bulk transfer then stages those histories whole, as before. */
async function pullTails(host: string, scope: SyncScope, home: string, state: SteadyState): Promise<{ dir: string; plan: TailPlan } | undefined> {
  const manifest = await listHistories(home, scope, new Set(state.ignored), TAIL_MIN_BYTES);
  if (Object.keys(manifest).length === 0) return undefined;
  const id = crypto.randomUUID();
  const dir = join(aisRemoteCacheDir(home), "tail-incoming", id);
  try {
    const planned = await runRemoteAis(host, ["sync", "tail-plan", id, ...scopeArgs(scope)], JSON.stringify(manifest)).catch(() => undefined);
    if (!planned || !parseJson(planned)?.planned) return undefined;
    noteRemoteIo(host, planned);
    await mkdir(dir, { recursive: true });
    const pulled = await runRsync(host, "pull", [], home, { localRoot: dir, remoteRoot: `${AIS_REMOTE_CACHE_REL}/tail-outgoing/${id}` });
    if (pulled.exitCode !== 0) throw syncError(host, "pull", pulled.stderr, pulled.exitCode);
    const plan = JSON.parse(await readFile(join(dir, TAIL_PLAN_FILE), "utf8")) as TailPlan;
    return { dir, plan };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    if (error instanceof SyntaxError) return undefined;
    throw error;
  } finally {
    await runRemoteAis(host, ["sync", "drop-tail-plan", id]).catch(() => undefined);
  }
}

function noteDenied(state: SteadyState, paths: string[] | undefined): void {
  for (const rel of paths ?? []) if (!state.ignored.includes(rel)) state.ignored.push(rel);
}

/** Pull from every configured SSH host, merge by stable session ID and
 * semantic registry contents, then push the converged state back out. */
export async function syncConfiguredProfiles(options: SyncRunOptions = {}): Promise<SyncRunResult> {
  const direction = options.direction ?? "both";
  const scope = options.scope ?? { kind: "all" as const };
  const includeDatabases = options.includeDatabases ?? true;
  const home = homedir();
  const config = await loadSyncConfig();
  const result: SyncRunResult = {
    remotes: config.remotes, pulled: [], pushed: [], skipped: false,
    preservedConflicts: 0, preservedConflictPaths: [], busyPaths: [],
  };
  if (config.remotes.length === 0) return result;

  const release = await acquireSyncLock(options.waitForLock ?? false);
  if (!release) return { ...result, skipped: true };

  const errors: Error[] = [];
  const state = await loadSteadyState(home);
  try {
    await ioPhase("prune-staging", () => pruneStaging({ home }));
    // Portability is a transport invariant, not a one-off migration. Run it
    // before either direction so no host can export an absolute username.
    await ioPhase("portable-pre", () => makeSyncStatePortable(scope, home));

    const extraDataDirs = await ioPhase("collect-dirs", async () => [
      ...(await collectProfileDataDirs(scope)),
      ...(await collectProjectDataDirs(scope)),
    ]);
    const filters = [...ignoredPathFilters(state), ...buildSyncFilterArgs(scope, extraDataDirs)];

    if (direction === "pull" || direction === "both") {
      for (const host of config.remotes) {
        const incomingDir = join(
          aisRemoteCacheDir(home),
          "profile-incoming",
          `${new Date().toISOString().replaceAll(":", "-")}-${safeHostSegment(host)}-${crypto.randomUUID()}`,
        );
        let tails: { dir: string; plan: TailPlan } | undefined;
        let fullDir: string | undefined;
        try {
          if (includeDatabases && syncsCrush(scope)) await ioPhase("pull-crush", () => pullCrushSnapshots(host, home, state));

          // Pull into an isolated snapshot, never over a live native profile.
          // The previous implementation replaced live JSONL first and tried
          // to reconstruct it from an rsync backup afterwards; a failed or
          // concurrent merge could leave the shorter remote copy active.
          // Append-only histories this host already holds come as tails; the bulk pull leaves them out.
          tails = await ioPhase("pull-tails", () => pullTails(host, scope, home, state));
          await mkdir(incomingDir, { recursive: true });
          const pulled = await ioPhase("pull-rsync", () => runRsync(host, "pull", [...tailExcludeFilters(tails?.plan ?? {}), ...filters], home, {
            localRoot: incomingDir,
            compareDest: "../../../..",
          }), () => stagedSummary(incomingDir));
          if (pulled.exitCode !== 0) throw syncError(host, "pull", pulled.stderr, pulled.exitCode);

          const merge = (root: string, tailsDir?: string) => mergeIncomingProfileTree(root, scope, {
            home,
            tailsDir,
            conflictRoot: join(
              aisRemoteCacheDir(home),
              "merge-conflicts",
              `${new Date().toISOString().replaceAll(":", "-")}-${safeHostSegment(host)}-${crypto.randomUUID()}`,
            ),
          });
          const absorb = (merged: TreeMergeResult) => {
            noteDenied(state, merged.deniedPaths);
            result.preservedConflicts += merged.preservedConflicts;
            result.preservedConflictPaths = [...new Set([...result.preservedConflictPaths, ...merged.preservedConflictPaths])];
            result.busyPaths = [...new Set([...result.busyPaths, ...merged.busyPaths])];
            if (merged.busyPaths.length > 0 && !options.quiet) {
              console.warn(`AIS sync deferred ${merged.busyPaths.length} log(s) still open in a running tool: ${merged.busyPaths.join(", ")}. They sync on the next run.`);
            }
            if (merged.preservedConflicts > 0 && !options.quiet) {
              console.warn(`AIS sync preserved ${merged.preservedConflicts} conflict(s), including deferred imports: ${merged.preservedConflictPaths.join(", ")}. Run ais sync recover to retry retained histories.`);
            }
          };
          const merged = await ioPhase("pull-merge", () => merge(incomingDir, tails?.dir));
          absorb(merged);
          // A tail whose prefix did not verify here is staged whole and merged the ordinary way.
          if (merged.needsFull?.length) {
            const list = await writeFileList(home, merged.needsFull);
            fullDir = `${incomingDir}-full`;
            try {
              await mkdir(fullDir, { recursive: true });
              const full = await ioPhase("pull-rsync-full", () => runRsync(host, "pull", [`--files-from=${list}`], home, { localRoot: fullDir, compareDest: "../../../.." }), () => stagedSummary(fullDir!));
              if (full.exitCode !== 0) throw syncError(host, "pull", full.stderr, full.exitCode);
              absorb(await ioPhase("pull-merge-full", () => merge(fullDir!)));
            } finally { await rm(list, { force: true }); }
          }
          await ioPhase("portable-post-pull", async () => {
            for (const cfg of scope.kind === "all" ? SYNC_TOOL_CONFIGS : [scope.cfg]) {
              await makeRegistryPortable(cfg, home);
            }
            await makeSyncStatePortable(scope, home);
          });
          result.pulled.push(host);
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        } finally {
          await rm(incomingDir, { recursive: true, force: true });
          if (fullDir) await rm(fullDir, { recursive: true, force: true });
          if (tails) await rm(tails.dir, { recursive: true, force: true });
        }
      }
    }

    // A pulled registry may contain /home/name while this host uses
    // /Users/name. Standard profile and directory paths become ~/... before
    // resolution reads them or they are pushed to another host.
    try {
      await ioPhase("portable-mid", () => makeSyncStatePortable(scope, home));
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }

    if (direction === "push" || direction === "both") {
      for (const host of config.remotes) {
        try {
          // Push to a remote snapshot and ask remote AIS to merge it. No
          // transport direction writes over a live history any more.
          await pushProfileSnapshot(host, filters, scope, home, state);
          if (includeDatabases && syncsCrush(scope)) await ioPhase("push-crush", () => pushCrushSnapshots(host, home, state));
          result.pushed.push(host);
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
  } finally {
    await saveSteadyState(state, home).catch(() => undefined);
    await release();
    if (ioTraceEnabled()) for (const line of [...formatIo("local", ioSnapshot()), ...formatIo("remote", remoteIo)]) console.error(line);
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
  }
  return result;
}

export async function automaticSync(options: SyncRunOptions = {}): Promise<SyncRunResult | undefined> {
  try {
    return await syncConfiguredProfiles({
      ...options,
      quiet: true,
      waitForLock: options.waitForLock ?? false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`ais sync: ${message} (continuing without blocking the CLI)`);
    return undefined;
  }
}
