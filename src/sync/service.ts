import { open, mkdir, readFile, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { expandPath } from "../identities/match.ts";
import { loadIdentitiesFile } from "../identities/store.ts";
import type { ToolConfig } from "../identities/types.ts";
import { AIS_REMOTE_CACHE_REL, aisRemoteCacheDir } from "../shared/ais-home.ts";
import { loadSyncConfig } from "./config.ts";
import { makeRegistryPortable } from "./registry.ts";
import { makeProfileHookConfigsPortable, makeSharedHookScriptsPortable } from "./portable-config.ts";
import {
  buildCrushSnapshotFilterArgs,
  buildSyncFilterArgs,
  runRsync,
  CRUSH_BACKED_TOOL_CONFIGS,
  SYNC_TOOL_CONFIGS,
} from "./rsync.ts";
import {
  createCrushSnapshotTree,
  loadCrushSnapshotManifest,
  mergeCrushSnapshotTree,
} from "./sqlite-merge.ts";
import { mergeIncomingProfileTree } from "./tree-merge.ts";
import type { SyncRunOptions, SyncRunResult, SyncScope } from "./types.ts";

const LOCK_RETRY_MS = 100;
const LOCK_WAIT_MS = 30_000;
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

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireSyncLock(wait: boolean, home: string = homedir()): Promise<(() => Promise<void>) | undefined> {
  const path = syncLockPath(home);
  await mkdir(dirname(path), { recursive: true });
  const token = `${process.pid}:${crypto.randomUUID()}`;
  const deadline = Date.now() + (wait ? LOCK_WAIT_MS : 0);

  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`);
      await handle.close();
      return async () => {
        try {
          const current = JSON.parse(await readFile(path, "utf8")) as { token?: string };
          if (current.token === token) await unlink(path);
        } catch {
          // Already removed or replaced by a newer owner.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const current = JSON.parse(await readFile(path, "utf8")) as { pid?: number };
        if (typeof current.pid !== "number" || !(await processIsAlive(current.pid))) {
          await unlink(path);
          continue;
        }
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
      if (!wait || Date.now() >= deadline) return undefined;
      await Bun.sleep(LOCK_RETRY_MS);
    }
  }
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

async function runRemoteAis(host: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["ssh", ...SSH_ARGS, host, REMOTE_AIS, ...args], {
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
  if (typeof rec.snapshotId !== "string" || !Array.isArray(rec.databases) || rec.databases.some((p) => typeof p !== "string")) {
    throw new Error(`remote AIS snapshot on ${host} is invalid`);
  }
  return { snapshotId: rec.snapshotId, databases: rec.databases as string[] };
}

async function pullCrushSnapshots(host: string, home: string): Promise<void> {
  const remote = parseRemoteSnapshot(await runRemoteAis(host, ["sync", "snapshot-zai"]), host);
  const localRoot = join(aisRemoteCacheDir(home), "sqlite-incoming", `${safeHostSegment(host)}-${remote.snapshotId}`);
  await mkdir(localRoot, { recursive: true });
  const pulled = await runRsync(host, "pull", buildCrushSnapshotFilterArgs(remote.databases), home, {
    localRoot,
    remoteRoot: `${AIS_REMOTE_CACHE_REL}/sqlite-snapshots/${remote.snapshotId}`,
  });
  if (pulled.exitCode !== 0) throw syncError(host, "pull", pulled.stderr, pulled.exitCode);
  const manifest = await loadCrushSnapshotManifest(localRoot);
  await mergeCrushSnapshotTree(manifest, home);
}

async function pushCrushSnapshots(host: string, home: string): Promise<void> {
  const snapshotId = crypto.randomUUID();
  const localRoot = join(aisRemoteCacheDir(home), "sqlite-snapshots", snapshotId);
  const manifest = await createCrushSnapshotTree(localRoot, home);
  const pushed = await runRsync(host, "push", buildCrushSnapshotFilterArgs(manifest.databases), home, {
    localRoot,
    remoteRoot: `${AIS_REMOTE_CACHE_REL}/sqlite-incoming/${snapshotId}`,
  });
  if (pushed.exitCode !== 0) throw syncError(host, "push", pushed.stderr, pushed.exitCode);
  await runRemoteAis(host, ["sync", "merge-zai-snapshot", snapshotId]);
}

function scopeArgs(scope: SyncScope): string[] {
  if (scope.kind === "all") return [];
  return [`--tool=${scope.cfg.toolName}`, `--identity=${scope.identityName}`];
}

async function pushProfileSnapshot(host: string, filters: string[], scope: SyncScope, home: string): Promise<void> {
  const snapshotId = crypto.randomUUID();
  const remoteRoot = `${AIS_REMOTE_CACHE_REL}/profile-incoming/${snapshotId}`;
  const pushed = await runRsync(host, "push", filters, home, {
    remoteRoot,
    // The incoming root is ~/.ais/remote-cache/profile-incoming/<uuid>. Omit
    // files byte-identical to the receiver's live home so staging is sparse
    // rather than another multi-gigabyte profile copy.
    compareDest: "../../../..",
  });
  if (pushed.exitCode !== 0) throw syncError(host, "push", pushed.stderr, pushed.exitCode);
  await runRemoteAis(host, ["sync", "merge-profile-snapshot", snapshotId, ...scopeArgs(scope)]);
}

/** Pull from every configured SSH host, merge by stable session ID and
 * semantic registry contents, then push the converged state back out. */
export async function syncConfiguredProfiles(options: SyncRunOptions = {}): Promise<SyncRunResult> {
  const direction = options.direction ?? "both";
  const scope = options.scope ?? { kind: "all" as const };
  const includeDatabases = options.includeDatabases ?? true;
  const home = homedir();
  const config = await loadSyncConfig();
  const result: SyncRunResult = { remotes: config.remotes, pulled: [], pushed: [], skipped: false };
  if (config.remotes.length === 0) return result;

  const release = await acquireSyncLock(options.waitForLock ?? false);
  if (!release) return { ...result, skipped: true };

  const errors: Error[] = [];
  try {
    // Portability is a transport invariant, not a one-off migration. Run it
    // before either direction so no host can export an absolute username.
    await makeSyncStatePortable(scope, home);

    const extraDataDirs = [
      ...(await collectProfileDataDirs(scope)),
      ...(await collectProjectDataDirs(scope)),
    ];
    const filters = buildSyncFilterArgs(scope, extraDataDirs);

    if (direction === "pull" || direction === "both") {
      for (const host of config.remotes) {
        const incomingDir = join(
          aisRemoteCacheDir(home),
          "profile-incoming",
          `${new Date().toISOString().replaceAll(":", "-")}-${safeHostSegment(host)}-${crypto.randomUUID()}`,
        );
        try {
          if (includeDatabases && syncsCrush(scope)) await pullCrushSnapshots(host, home);

          // Pull into an isolated snapshot, never over a live native profile.
          // The previous implementation replaced live JSONL first and tried
          // to reconstruct it from an rsync backup afterwards; a failed or
          // concurrent merge could leave the shorter remote copy active.
          await mkdir(incomingDir, { recursive: true });
          const pulled = await runRsync(host, "pull", filters, home, {
            localRoot: incomingDir,
            compareDest: "../../../..",
          });
          if (pulled.exitCode !== 0) throw syncError(host, "pull", pulled.stderr, pulled.exitCode);

          await mergeIncomingProfileTree(incomingDir, scope, {
            home,
            conflictRoot: join(
              aisRemoteCacheDir(home),
              "merge-conflicts",
              `${new Date().toISOString().replaceAll(":", "-")}-${safeHostSegment(host)}-${crypto.randomUUID()}`,
            ),
          });
          for (const cfg of scope.kind === "all" ? SYNC_TOOL_CONFIGS : [scope.cfg]) {
            await makeRegistryPortable(cfg, home);
          }
          await makeSyncStatePortable(scope, home);
          await rm(incomingDir, { recursive: true, force: true });
          result.pulled.push(host);
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }

    // A pulled registry may contain /home/name while this host uses
    // /Users/name. Standard profile and directory paths become ~/... before
    // resolution reads them or they are pushed to another host.
    try {
      await makeSyncStatePortable(scope, home);
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }

    if (direction === "push" || direction === "both") {
      for (const host of config.remotes) {
        try {
          // Push to a remote snapshot and ask remote AIS to merge it. No
          // transport direction writes over a live history any more.
          await pushProfileSnapshot(host, filters, scope, home);
          if (includeDatabases && syncsCrush(scope)) await pushCrushSnapshots(host, home);
          result.pushed.push(host);
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
  } finally {
    await release();
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
