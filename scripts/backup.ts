import { homedir } from "node:os";
import { join } from "node:path";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { aisBackupConfigPath, aisBackupLockPath, aisBackupsDir } from "../src/shared/ais-home.ts";
import { acquirePidLock } from "../src/shared/pid-lock.ts";
import { REPRODUCIBLE_JUNK_DIR_NAMES } from "../src/shared/reproducible-paths.ts";

// Grouped by which wrapped-tool proxy actually reads/writes each directory —
// install.ts backs up only the group(s) belonging to a proxy that's actually
// changing (see its BACKUP_GROUPS usage), rather than everything on every
// install regardless of which binary changed.
const BACKUP_GROUPS = {
  // The extra claude entries are the legacy top-level per-identity
  // directories scripts/migrate.ts moves into ~/.claude/identities/ — kept
  // here so a pre-migration backup still covers them. runBackup skips any
  // group entry that doesn't exist, so they're harmless post-migration.
  claude: [".claude", ".claude-personal", ".claude-identity-a"],
  codex: [".codex"],
  grok: [".grok"],
  kimi: [".kimi-code"],
  zai: [".zai"],
  ali: [".ali"],
  pi: [".pi"],
  opencode: [".opencode"],
} as const;

type BackupGroup = keyof typeof BACKUP_GROUPS;

export function isTolerableRsyncExitCode(exitCode: number): boolean {
  // 23: an individual file could not be transferred (commonly permissions).
  // 24: a source file vanished while rsync was scanning a live config tree.
  return exitCode === 23 || exitCode === 24;
}

// Meaningless (or actively harmful) to restore, on top of the reproducible
// junk shared with SSH sync — a stale lock/socket file "restored" into a
// live directory later would just confuse whatever's watching for one.
// Unlike SSH sync, SQLite/db files are deliberately NOT excluded here: this
// is a point-in-time safety-net copy, not a live merge target, so it wants
// the same full-fidelity content the old tar-based backup always included.
// "jobs/*/tmp/" (unanchored, so it matches at any depth): agent job scratch
// dirs hold throwaway checkouts that can carry their own .gitattributes.
const BACKUP_EXCLUDES = [...REPRODUCIBLE_JUNK_DIR_NAMES, "*.lock", "*.sock", "*.pid", "jobs/*/tmp/"];

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function pathKind(path: string): Promise<"missing" | "symlink" | "real"> {
  try {
    const stat = await lstat(path);
    return stat.isSymbolicLink() ? "symlink" : "real";
  } catch {
    return "missing";
  }
}

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// This repo must never use Git LFS, even when the user's global config ran
// `git lfs install`: no hooks (the LFS pre-push hook breaks plain remotes) and
// no required filter. The info/attributes file (ensureAttributes) covers filters.
const GIT_SAFETY_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "filter.lfs.required=false"];

async function runGit(repoDir: string, args: string[], env?: Record<string, string>, stdin?: string): Promise<GitResult> {
  const git = Bun.which("git");
  if (!git) throw new Error("backup: git is required for the git-managed backup repo but was not found on PATH");
  const proc = Bun.spawn([git, "-C", repoDir, ...GIT_SAFETY_ARGS, ...args], {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function ensureRepo(repoDir: string): Promise<void> {
  await mkdir(repoDir, { recursive: true });
  if (await pathExists(join(repoDir, ".git"))) return;
  const init = await runGit(repoDir, ["init", "--quiet"]);
  if (init.exitCode !== 0) throw new Error(`backup: git init failed in ${repoDir}: ${init.stderr.trim()}`);
  // Local-only identity, scoped to this one repo — never touches the user's
  // global gitconfig, and never depends on it being set at all. This repo is
  // a storage engine for automated snapshots, not a place for human commits,
  // so gpg-signing (which could hang an automated `install`/`update` run on
  // a passphrase prompt if the user's global config demands it) is disabled
  // locally too.
  await runGit(repoDir, ["config", "user.name", "AiProfileSwitcher"]);
  await runGit(repoDir, ["config", "user.email", "ai-profile-switcher@localhost"]);
  await runGit(repoDir, ["config", "commit.gpgsign", "false"]);
  console.error(`backup: initialised git repo at ${repoDir}`);
}

// info/attributes has the highest attribute precedence, so it beats any
// .gitattributes mirrored in from a config tree.
const BACKUP_ATTRIBUTES =
  "# Backups store raw bytes: neutralise filters (LFS) from mirrored .gitattributes files.\n" +
  "* -filter -text -ident -working-tree-encoding\n";

/** Tracked paths whose attributes currently resolve to the LFS filter. */
async function trackedLfsPaths(repoDir: string): Promise<string[]> {
  const files = await runGit(repoDir, ["ls-files", "-z"]);
  if (files.exitCode !== 0 || files.stdout === "") return [];
  const attrs = await runGit(repoDir, ["check-attr", "-z", "--stdin", "filter"], undefined, files.stdout);
  if (attrs.exitCode !== 0) throw new Error(`backup: git check-attr failed in ${repoDir}: ${attrs.stderr.trim()}`);
  // Output is NUL-separated <path>, <attribute>, <value> triples.
  const parts = attrs.stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i + 2] === "lfs") paths.push(parts[i]!);
  return paths;
}

/** Writes the neutralising attributes; returns tracked paths still stored through the LFS filter. */
async function ensureAttributes(repoDir: string): Promise<string[]> {
  const attributesPath = join(repoDir, ".git", "info", "attributes");
  let current: string | undefined;
  try {
    current = await readFile(attributesPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (current === BACKUP_ATTRIBUTES) return [];

  // Before the new attributes take effect, find blobs already stored through
  // the LFS filter (pointers instead of content) so they can be replaced.
  const polluted = await trackedLfsPaths(repoDir);

  await mkdir(join(repoDir, ".git", "info"), { recursive: true });
  const tmpPath = `${attributesPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, BACKUP_ATTRIBUTES);
  await rename(tmpPath, attributesPath);

  return polluted;
}

/** Replaces LFS pointers in the index with real content. Runs AFTER the mirror:
 * paths the mirror deleted or excluded (e.g. multi-GB jobs/<id>/tmp/ assets)
 * are skipped here so the normal `git add -A` just drops them, never hashing them. */
async function renormalise(repoDir: string, polluted: readonly string[]): Promise<void> {
  const present: string[] = [];
  for (const path of polluted) if (await pathExists(join(repoDir, path))) present.push(path);
  if (present.length > 0) {
    const listPath = join(repoDir, ".git", `ais-renormalize.${process.pid}.tmp`);
    await writeFile(listPath, present.join("\0") + "\0");
    try {
      // Literal pathspecs: tracked names may contain glob characters.
      const add = await runGit(
        repoDir,
        ["add", "--renormalize", `--pathspec-from-file=${listPath}`, "--pathspec-file-nul"],
        { GIT_LITERAL_PATHSPECS: "1" },
      );
      if (add.exitCode !== 0) throw new Error(`backup: git add --renormalize failed in ${repoDir}: ${add.stderr.trim()}`);
    } finally {
      await rm(listPath, { force: true });
    }
  }
  console.error(
    `backup: RENORMALISED ${present.length} tracked path(s) that were stored through the LFS filter ` +
      `(${polluted.length - present.length} more no longer exist and are dropped); real content replaces the pointers in this run's commit`,
  );
}

async function mirrorInto(sourcePath: string, destPath: string): Promise<void> {
  const rsync = Bun.which("rsync");
  if (!rsync) throw new Error("backup: rsync is required to mirror config directories into the git-managed backup repo");
  await mkdir(destPath, { recursive: true });
  const args = [
    "-a",
    "--delete",
    "--delete-excluded",
    ...BACKUP_EXCLUDES.map((pattern) => `--exclude=${pattern}`),
    `${sourcePath}/`,
    `${destPath}/`,
  ];
  const proc = Bun.spawn([rsync, ...args], { stdio: ["ignore", "inherit", "inherit"] });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    // rsync exits 23 ("partial transfer due to error") when it skips an
    // individual unreadable file (e.g. root-owned or otherwise
    // permission-denied) but still transfers everything else — the same
    // "some files skipped, not a hard failure" shape the old tar-based
    // backup explicitly tolerated (BSD tar's own non-zero-but-still-
    // produced-an-archive exit). Confirmed live: this real machine has a
    // pre-existing permission-denied file under ~/.codex/backups/, and a
    // hard failure here would make backup.ts strictly LESS tolerant of
    // real-world unreadable files than the design it replaced. Any other
    // Exit 24 is the corresponding benign live-tree race: a process removed
    // a cache/session file after rsync enumerated it but before it could copy
    // it. The next backup reconciles the final state. Any other exit code
    // (rsync missing, destination unwritable, etc.) stays fatal.
    if (isTolerableRsyncExitCode(exitCode)) {
      console.error(
        `backup: rsync exited ${exitCode} for ${sourcePath} -> ${destPath} ` +
          `(an individual file was unreadable or vanished during the live scan) — ` +
          `mirror was still produced, continuing`,
      );
    } else {
      throw new Error(`backup: rsync failed mirroring ${sourcePath} -> ${destPath} (exit ${exitCode})`);
    }
  }
}

async function mirrorAndCommit(groups: readonly BackupGroup[], home: string): Promise<string> {
  const repoDir = aisBackupsDir(home);
  await ensureRepo(repoDir);
  const polluted = await ensureAttributes(repoDir);

  const mirrored: string[] = [];
  for (const name of groups.flatMap((g) => BACKUP_GROUPS[g])) {
    const sourcePath = join(home, name);
    const kind = await pathKind(sourcePath);
    if (kind === "missing") {
      console.error(`backup: ${sourcePath} does not exist, skipping`);
      continue;
    }
    if (kind === "symlink") {
      console.error(`backup: ${sourcePath} is a symlink (compatibility shim), skipping — its target is backed up separately`);
      continue;
    }

    await mirrorInto(sourcePath, join(repoDir, name));
    mirrored.push(name);
    console.error(`backup: mirrored ${sourcePath} -> ${join(repoDir, name)}`);
  }

  if (mirrored.length === 0) {
    console.error(`backup: nothing to mirror, see ${repoDir}`);
    return repoDir;
  }

  if (polluted.length > 0) await renormalise(repoDir, polluted);

  const add = await runGit(repoDir, ["add", "-A", "--", ...mirrored]);
  if (add.exitCode !== 0) throw new Error(`backup: git add failed in ${repoDir}: ${add.stderr.trim()}`);

  // A source directory that mirrored zero files (empty, or everything under
  // it matched BACKUP_EXCLUDES) has nothing for git to know about — `git add
  // -A` silently no-ops for it, but `git commit -- <pathspec>` is stricter
  // and fails outright the moment ANY of its pathspecs matches nothing at
  // all, in the index OR in history (confirmed live, 2026-07-31: an empty,
  // root-owned ~/.claude-personal broke the whole backup this way). `git
  // ls-files` reports the CURRENT INDEX content for a path regardless of
  // whether it's newly staged or already committed unchanged, so filtering
  // on it — rather than reusing `mirrored` directly — is what actually
  // predicts whether `commit -- <path>` will accept that pathspec.
  const trackable: string[] = [];
  for (const name of mirrored) {
    const lsFiles = await runGit(repoDir, ["ls-files", "--", name]);
    if (lsFiles.stdout.trim().length > 0) trackable.push(name);
    else console.error(`backup: ${join(repoDir, name)} has no trackable content (source is empty or fully excluded), skipping`);
  }
  if (trackable.length === 0) {
    console.error(`backup: nothing new to commit, see ${repoDir}`);
    return repoDir;
  }

  const diff = await runGit(repoDir, ["diff", "--cached", "--quiet", "--", ...trackable]);
  if (diff.exitCode === 0) {
    console.error(`backup: no changes since the last backup, see ${repoDir}`);
    return repoDir;
  }

  // Scoped to `trackable`, same as the add/diff above: a bare `git commit`
  // commits the WHOLE index, which would silently sweep in stale staged
  // content from an earlier, interrupted run that touched OTHER groups this
  // run never re-mirrored. `git commit -- <pathspec>` instead commits only
  // the matching changes and leaves the rest staged for a future run.
  const commit = await runGit(repoDir, [
    "commit",
    "--quiet",
    "-m",
    `backup: ${timestamp()} (${trackable.join(", ")})`,
    "--",
    ...trackable,
  ]);
  if (commit.exitCode !== 0) {
    throw new Error(`backup: git commit failed in ${repoDir}: ${commit.stderr.trim() || `exit ${commit.exitCode}`}`);
  }
  const rev = await runGit(repoDir, ["rev-parse", "--short", "HEAD"]);
  console.error(`backup: committed ${rev.stdout.trim()} in ${repoDir}`);

  await runGit(repoDir, ["gc", "--auto", "--quiet"]);

  console.error(`backup: complete, see ${repoDir}`);
  return repoDir;
}

const LOCK_WAIT_MS = 600_000;
const LOCK_RETRY_MS = 200;

// BatchMode: never prompt; the timeouts bound a dead or silent host so a
// backup (often run inside install/update) cannot hang on the network.
const SSH_COMMAND =
  "ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=2 -o StrictHostKeyChecking=yes";
const GIT_REMOTE_ENV = { GIT_TERMINAL_PROMPT: "0" };

export interface BackupConfig {
  remote?: string;
  localRetentionDays?: number;
}

/** Reads the optional off-host config. Never throws: a bad file is reported
 * loudly and treated as "no remote", so it can never fail the local backup. */
export async function loadBackupConfig(path: string): Promise<BackupConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    console.error(`backup: cannot read ${path} (${(err as Error).message}), off-host push disabled`);
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`backup: ${path} is not valid JSON (${(err as Error).message}), off-host push disabled`);
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error(`backup: ${path} must be a JSON object, off-host push disabled`);
    return {};
  }
  const { remote, localRetentionDays } = parsed as Record<string, unknown>;
  const config: BackupConfig = {};
  // A leading "-" would be parsed by git as an option, not a destination.
  if (typeof remote === "string" && remote.trim() !== "" && !remote.trim().startsWith("-")) config.remote = remote.trim();
  else if (remote !== undefined) console.error(`backup: ${path}: "remote" must be a non-empty string, off-host push disabled`);
  if (localRetentionDays !== undefined) {
    if (typeof localRetentionDays !== "number" || !Number.isInteger(localRetentionDays) || localRetentionDays < 1) {
      console.error(`backup: ${path}: "localRetentionDays" must be a positive integer, ignoring it`);
    } else if (!config.remote) {
      console.error(`backup: ${path}: "localRetentionDays" needs a "remote", ignoring it`);
    } else {
      config.localRetentionDays = localRetentionDays;
    }
  }
  return config;
}

/** Trimmed git stderr with the remote (which may embed credentials) redacted. */
function failureText(result: GitResult, remote: string): string {
  const text = (result.stderr.trim() || result.stdout.trim()).split(remote).join("<remote>");
  return `exit ${result.exitCode}${text ? `: ${text.slice(-500)}` : ""}`;
}

async function runRemoteGit(repoDir: string, args: string[]): Promise<GitResult> {
  return runGit(repoDir, ["-c", `core.sshCommand=${SSH_COMMAND}`, ...args], GIT_REMOTE_ENV);
}

/** Pushes the current branch (never forced), then optionally trims local
 * history. Failures are loud but never thrown: the local backup already
 * succeeded and the next run retries (the push always sends the whole branch). */
async function pushAndTrim(repoDir: string, remote: string, retentionDays: number | undefined): Promise<void> {
  try {
    const head = await runGit(repoDir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (head.exitCode !== 0) {
      console.error(`backup: no commits yet, nothing to push to the off-host remote`);
      return;
    }
    const headSha = head.stdout.trim();
    const branchResult = await runGit(repoDir, ["symbolic-ref", "--short", "HEAD"]);
    const branch = branchResult.stdout.trim();
    if (branchResult.exitCode !== 0 || !branch) {
      console.error(`backup: off-host push skipped, HEAD is not on a branch`);
      return;
    }

    const push = await runRemoteGit(repoDir, ["push", "--quiet", remote, `HEAD:refs/heads/${branch}`]);
    if (push.exitCode !== 0) {
      console.error(`backup: off-host push FAILED (${failureText(push, remote)}); local backup is intact, next run retries`);
      if (retentionDays) console.error("backup: local trim skipped, the push did not succeed");
      return;
    }
    console.error(`backup: pushed ${headSha.slice(0, 7)} to the off-host remote (${branch})`);

    if (retentionDays) await trimLocalHistory(repoDir, remote, branch, headSha, retentionDays);
  } catch (err) {
    console.error(`backup: off-host step FAILED (${(err as Error).message.split(remote).join("<remote>")}); local backup is intact`);
  }
}

async function trimLocalHistory(
  repoDir: string,
  remote: string,
  branch: string,
  headSha: string,
  days: number,
): Promise<void> {
  const ls = await runRemoteGit(repoDir, ["ls-remote", remote, `refs/heads/${branch}`]);
  if (ls.exitCode !== 0) {
    console.error(`backup: local trim skipped, remote unreachable (${failureText(ls, remote)})`);
    return;
  }
  const remoteSha = ls.stdout.trim().split(/\s+/)[0] ?? "";
  if (remoteSha !== headSha) {
    console.error(
      `backup: local trim skipped, remote ${remoteSha ? "differs from or is behind local HEAD" : "has no such branch"}`,
    );
    return;
  }

  const since = await runGit(repoDir, ["rev-list", "--first-parent", `--since=${days} days ago`, "HEAD"]);
  if (since.exitCode !== 0) {
    console.error(`backup: local trim skipped, rev-list failed (${failureText(since, remote)})`);
    return;
  }
  const recent = since.stdout.trim().split("\n").filter(Boolean);
  const boundary = recent.length > 0 ? recent[recent.length - 1]! : headSha;
  // Already a root or already the shallow boundary: nothing older to drop.
  const parent = await runGit(repoDir, ["rev-parse", "--verify", "--quiet", `${boundary}^`]);
  if (parent.exitCode !== 0) return;

  const before = (await runGit(repoDir, ["rev-list", "--count", "HEAD"])).stdout.trim();
  // History is linear, so the new boundary is always newer than any existing one: replace.
  const shallowPath = join(repoDir, ".git", "shallow");
  const tmpPath = `${shallowPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${boundary}\n`);
  await rename(tmpPath, shallowPath);
  const expire = await runGit(repoDir, ["reflog", "expire", "--expire=now", "--all"]);
  const gc = await runGit(repoDir, ["gc", "--prune=now", "--quiet"]);
  if (expire.exitCode !== 0 || gc.exitCode !== 0) {
    console.error(`backup: local trim set the boundary but cleanup failed (${failureText(expire.exitCode !== 0 ? expire : gc, remote)})`);
    return;
  }
  const after = (await runGit(repoDir, ["rev-list", "--count", "HEAD"])).stdout.trim();
  console.error(
    `backup: trimmed local history older than ${days} days (${before} -> ${after} commits, boundary ${boundary.slice(0, 7)}); the off-host remote keeps the full history`,
  );
}

/**
 * Mirrors the given config-directory group(s) (default: every group) into a
 * single, persistent git repository at ~/.ais/backups and commits whatever
 * changed since the last backup. Replaces the old per-run tar.gz snapshot
 * design (~/.ai-switcher-backups/<timestamp>/*.tar.gz — one full archive
 * tree per invocation, nothing ever pruned) — that grew without bound, and
 * every run paid for a full copy even when almost nothing had changed since
 * the last one. Git's content-addressable object store instead stores each
 * distinct blob once no matter how many commits reference it, so two
 * backups taken minutes apart (the common case around an install/update)
 * cost close to nothing beyond the first; `git gc --auto` after each commit
 * keeps loose objects packed and delta-compressed rather than accumulating
 * unbounded. Reproducible/machine-local junk (node_modules, marketplace and
 * browser caches, logs, worktrees, ...) is excluded via rsync — see
 * reproducible-paths.ts, shared with SSH sync's own exclude list — since
 * none of it has restore value and it's what drove most of the old design's
 * size growth. SQLite/session databases are still mirrored in full (unlike
 * SSH sync, which excludes live databases in favour of its own
 * VACUUM-based merge protocol): this is a point-in-time safety net taken
 * synchronously before install/update/migrate touch anything, not a live
 * merge target, so a plain file copy carries the same small, accepted risk
 * of catching a database mid-write that the old tar-based backup always
 * had — no worse than before. Symlinks (post-migration compatibility
 * shims) are skipped at the top level, same as before — their target is
 * already covered by the container directory's own mirror.
 */
export async function runBackup(
  groups: readonly BackupGroup[] = Object.keys(BACKUP_GROUPS) as BackupGroup[],
  home: string = homedir(),
  configPath: string = aisBackupConfigPath(process.env, home),
): Promise<string> {
  const release = await acquirePidLock(aisBackupLockPath(home), { waitMs: LOCK_WAIT_MS, retryMs: LOCK_RETRY_MS });
  if (!release) throw new Error(`backup: another backup still holds ${aisBackupLockPath(home)} after 10 minutes`);
  try {
    const repoDir = await mirrorAndCommit(groups, home);
    const config = await loadBackupConfig(configPath);
    if (config.remote) await pushAndTrim(repoDir, config.remote, config.localRetentionDays);
    return repoDir;
  } finally {
    await release();
  }
}

if (import.meta.main) {
  await runBackup();
}
