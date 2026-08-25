import { homedir } from "node:os";
import { join } from "node:path";
import { lstat, mkdir } from "node:fs/promises";
import { aisBackupsDir } from "../src/shared/ais-home.ts";
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
const BACKUP_EXCLUDES = [...REPRODUCIBLE_JUNK_DIR_NAMES, "*.lock", "*.sock", "*.pid"];

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

async function runGit(repoDir: string, args: string[]): Promise<GitResult> {
  const git = Bun.which("git");
  if (!git) throw new Error("backup: git is required for the git-managed backup repo but was not found on PATH");
  const proc = Bun.spawn([git, "-C", repoDir, ...args], { stdout: "pipe", stderr: "pipe" });
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
): Promise<string> {
  const repoDir = aisBackupsDir(home);
  await ensureRepo(repoDir);

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

if (import.meta.main) {
  await runBackup();
}
