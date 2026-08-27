import { homedir } from "node:os";
import { dirname, relative, sep } from "node:path";
import {
  ALI_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GROK_CONFIG,
  KIMI_CONFIG,
  PI_CONFIG,
  OPENCODE_CONFIG,
  ZAI_CONFIG,
} from "../identities/tool-configs.ts";
import type { ToolConfig } from "../identities/types.ts";
import { REPRODUCIBLE_JUNK_DIR_NAMES } from "../shared/reproducible-paths.ts";
import type { SyncDirection, SyncScope } from "./types.ts";

export const SYNC_TOOL_CONFIGS = [CLAUDE_CONFIG, CODEX_CONFIG, GROK_CONFIG, KIMI_CONFIG, ZAI_CONFIG, ALI_CONFIG, PI_CONFIG, OPENCODE_CONFIG];

/** Every tool proxying the `crush` binary: zai and ali today. Sync code that
 * needs to treat "any crush-backed identity" uniformly (project-local
 * `.crush` data, machine-local `projects.json` exclusion, SQLite snapshot
 * discovery) filters on this instead of hardcoding `toolName === "zai"`, so a
 * future third crush-backed tool only needs adding to tool-configs.ts, not
 * re-deriving every one of these call sites. */
export const CRUSH_BACKED_TOOL_CONFIGS = SYNC_TOOL_CONFIGS.filter((cfg) => cfg.realBinaryName === "crush");

const SSH_TRANSPORT =
  "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 " +
  "-o ServerAliveInterval=15 -o ServerAliveCountMax=4 " +
  "-o ControlMaster=auto -o ControlPersist=300 -o ControlPath=~/.ssh/ais-sync-%C";

const TRANSIENT_EXCLUDES = [
  "*.lock",
  "*.sock",
  "*.pid",
  // Do not exclude "*.tmp" generically: Grok URL-encodes cwd buckets and a
  // legitimate project directory ending in .tmp contains the whole session
  // subtree. Atomic rsync staging already protects incomplete transfers.
  "*.sqlite-shm",
  "*.sqlite-wal",
  "*.sqlite-journal",
  "*.db-shm",
  "*.db-wal",
  "*.db-journal",
  "*.sqlite",
  "*.db",
  // Reproducible or machine-specific payloads: copying these makes every
  // launch scan gigabytes of browser/plugin caches and can install macOS
  // native artefacts on Linux. Their durable configuration remains synced.
  ...REPRODUCIBLE_JUNK_DIR_NAMES,
  "backups/",
  "logs_*.sqlite*",
  "state_*.sqlite*",
  "models_cache.json",
  "worktrees.db",
  "active_sessions.json",
];

function slash(path: string): string {
  return path.split(sep).join("/");
}

export function configHomeRoot(cfg: ToolConfig, home: string = homedir()): string {
  const root = slash(relative(home, dirname(cfg.identitiesJsonPath)));
  if (!root || root === ".." || root.startsWith("../")) {
    throw new Error(`${cfg.toolName}: identities registry is outside the home directory and cannot be SSH-synced`);
  }
  return root;
}

function addParentIncludes(filters: string[], relativePath: string): void {
  const segments = relativePath.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current += `/${segment}`;
    filters.push(`--include=${current}/`);
  }
}

export function buildSyncFilterArgs(
  scope: SyncScope,
  projectDataDirs: string[] = [],
  home: string = homedir(),
): string[] {
  const uniqueProjectDataDirs = [...new Set(projectDataDirs)].sort();
  // Live SQLite files are never copied by generic rsync. Crush databases are
  // serialised and merged separately through sqlite-merge.ts; copying a live
  // main file without its WAL previously corrupted a real remote database.
  const filters: string[] = [];
  filters.push(...TRANSIENT_EXCLUDES.map((pattern) => `--exclude=${pattern}`));
  // Crush's projects.json is a machine-local absolute-path index. The actual
  // project-local .crush data is synced separately through home-relative
  // include paths below; copying this index verbatim would install /Users
  // paths on Linux or /home paths on macOS. Applies to every crush-backed
  // tool (zai, ali), not just zai.
  for (const cfg of CRUSH_BACKED_TOOL_CONFIGS) {
    filters.push(`--exclude=/${configHomeRoot(cfg, home)}/identities/*/data/projects.json`);
  }

  const configs = scope.kind === "all" ? SYNC_TOOL_CONFIGS : [scope.cfg];
  for (const cfg of configs) {
    const root = configHomeRoot(cfg, home);
    filters.push(`--include=/${root}/`);
    filters.push(`--include=/${root}/identities.json`);
    filters.push(`--include=/${root}/identities/`);
    if (scope.kind === "identity") {
      filters.push(`--include=/${root}/identities/${scope.identityName}/`);
      filters.push(`--include=/${root}/identities/${scope.identityName}/***`);
    } else {
      filters.push(`--include=/${root}/identities/***`);
    }
  }

  if (scope.kind === "all") {
    // Hook definitions inside identities reference this canonical shared
    // tree. A provisioned host must never receive enabled hooks without the
    // executables they invoke.
    addParentIncludes(filters, ".ais/hooks");
    filters.push("--include=/.ais/hooks/***");

    // Legacy pre-AIS session roots participate in the stable-ID dedupe pass.
    // This preserves unique historical sessions while preventing copied
    // legacy stores from inflating every identity's usage report.
    for (const legacyRoot of [
      ".claude/projects",
      ".codex/sessions",
      ".grok/sessions",
      ".kimi-code/sessions",
    ]) {
      addParentIncludes(filters, legacyRoot);
      filters.push(`--include=/${legacyRoot}/***`);
    }
  }

  for (const projectDataDir of uniqueProjectDataDirs) {
    addParentIncludes(filters, projectDataDir);
    filters.push(`--include=/${projectDataDir}/***`);
  }
  filters.push("--exclude=*");
  return filters;
}

export interface RsyncResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RsyncPathOptions {
  /** Conflict backups are receiver-local and only valid for pull. */
  backupDir?: string;
  /** Override the local source/destination tree; defaults to the user's home. */
  localRoot?: string;
  /** Override the remote source/destination tree; defaults to the SSH user's home. */
  remoteRoot?: string;
  /** Receiver-side basis tree used to omit byte-identical live files from an
   * isolated incoming snapshot. Relative paths are resolved from that
   * snapshot's destination directory by rsync. */
  compareDest?: string;
}

export function buildCrushSnapshotFilterArgs(databasePaths: string[]): string[] {
  const filters = ["--include=/.ais-crush-snapshot.json"];
  for (const raw of [...new Set(databasePaths)].sort()) {
    const path = slash(raw).replace(/^\/+/, "");
    addParentIncludes(filters, path);
    filters.push(`--include=/${path}`);
  }
  filters.push("--exclude=*");
  return filters;
}

export function buildRsyncArgs(
  host: string,
  direction: Exclude<SyncDirection, "both">,
  filters: string[],
  home: string = homedir(),
  options: RsyncPathOptions = {},
): string[] {
  const conflictMode = direction === "pull" && options.backupDir;
  const common = [
    "--archive",
    // Profile trees move between different users and operating systems. A
    // privileged remote receiver must never apply the sender's numeric UID,
    // GID, or home-directory mode to its own home (doing so can make sshd's
    // StrictModes reject the very key used for sync). New paths still receive
    // the source mode masked by the remote user's umask.
    "--no-owner",
    "--no-group",
    "--no-perms",
    ...(conflictMode ? ["--backup", `--backup-dir=${options.backupDir}`] : ["--update"]),
    ...(options.compareDest ? ["--checksum", `--compare-dest=${options.compareDest}`] : []),
    "--compress",
    "--delay-updates",
    "--partial",
    "--mkpath",
    "--protect-args",
    "--prune-empty-dirs",
    "--timeout=300",
    "-e",
    SSH_TRANSPORT,
    ...filters,
  ];
  const local = `${(options.localRoot ?? home).replace(/\/$/, "")}/`;
  const remoteRoot = options.remoteRoot ?? ".";
  const remote = `${host}:${remoteRoot.replace(/\/$/, "")}/`;
  return direction === "pull" ? [...common, remote, local] : [...common, local, remote];
}

export async function runRsync(
  host: string,
  direction: Exclude<SyncDirection, "both">,
  filters: string[],
  home: string = homedir(),
  options: RsyncPathOptions = {},
): Promise<RsyncResult> {
  const rsync = Bun.which("rsync");
  if (!rsync) throw new Error("rsync is required for AIS profile sync but was not found on PATH");
  let last: RsyncResult | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const proc = Bun.spawn([rsync, ...buildRsyncArgs(host, direction, filters, home, options)], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    last = { stdout, stderr, exitCode };
    // Exit 24 means a source path changed or disappeared during the scan,
    // which is normal for a live session/profile tree. Retry once to collect
    // its replacement. If it vanishes again, no source file remains to copy;
    // deletes are deliberately not propagated, so this is a safe warning.
    if (exitCode !== 24) return last;
  }
  return { ...last!, exitCode: 0 };
}
