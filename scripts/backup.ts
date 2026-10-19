import { homedir } from "node:os";
import { join } from "node:path";
import { lstat, mkdir, rm } from "node:fs/promises";
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
  opencode: [".opencode"],
} as const;

type BackupGroup = keyof typeof BACKUP_GROUPS;

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

// Every backup git command runs with the git dir at <backups>/.git and the
// work tree at the real home, so files are snapshotted in place and stored
// exactly once (as git objects). Index paths stay `.claude/...` relative to
// home, identical to the earlier plain-mirror layout, so history stays valid.
async function runGit(repoDir: string, home: string, args: string[]): Promise<GitResult> {
  const git = Bun.which("git");
  if (!git) throw new Error("backup: git is required for the git-managed backup repo but was not found on PATH");
  const proc = Bun.spawn([git, `--git-dir=${join(repoDir, ".git")}`, `--work-tree=${home}`, ...args], {
    cwd: home,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function ensureRepo(repoDir: string, home: string): Promise<void> {
  await mkdir(repoDir, { recursive: true });
  if (!(await pathExists(join(repoDir, ".git")))) {
    // Plain init (no --work-tree): the work tree is passed per command instead.
    const git = Bun.which("git");
    if (!git) throw new Error("backup: git is required for the git-managed backup repo but was not found on PATH");
    const proc = Bun.spawn([git, "init", "--quiet", repoDir], { stdout: "pipe", stderr: "pipe" });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (exitCode !== 0) throw new Error(`backup: git init failed in ${repoDir}: ${stderr.trim()}`);
    // Local-only identity, scoped to this one repo — never touches the user's
    // global gitconfig, and never depends on it being set at all. This repo is
    // a storage engine for automated snapshots, not a place for human commits,
    // so gpg-signing (which could hang an automated `install`/`update` run on
    // a passphrase prompt if the user's global config demands it) is disabled
    // locally too.
    await runGit(repoDir, home, ["config", "user.name", "AiProfileSwitcher"]);
    await runGit(repoDir, home, ["config", "user.email", "ai-profile-switcher@localhost"]);
    await runGit(repoDir, home, ["config", "commit.gpgsign", "false"]);
    console.error(`backup: initialised git repo at ${repoDir}`);
  }
  // The work tree is all of home, so untracked noise in `git status` is
  // meaningless and slow to compute.
  await runGit(repoDir, home, ["config", "status.showUntrackedFiles", "no"]);
  // Rewritten every run so a changed BACKUP_EXCLUDES takes effect. Trailing-slash
  // names match a directory of that name anywhere; globs match anywhere.
  await mkdir(join(repoDir, ".git", "info"), { recursive: true });
  await Bun.write(join(repoDir, ".git", "info", "exclude"), `${BACKUP_EXCLUDES.join("\n")}\n`);
}

// One-off cleanup of the old plain rsync mirrors (<backups>/<name>). Only the
// literal known group names are removed, and only once the git dir is valid,
// so history is never at risk.
async function removeLegacyMirrors(repoDir: string, home: string): Promise<void> {
  const valid = await runGit(repoDir, home, ["rev-parse", "--git-dir"]);
  if (valid.exitCode !== 0) return;
  for (const name of Object.values(BACKUP_GROUPS).flat()) {
    const legacy = join(repoDir, name);
    if (!(await pathExists(legacy))) continue;
    await rm(legacy, { recursive: true, force: true });
    console.error(`backup: removed legacy plain mirror ${legacy} (contents now live in git only)`);
  }
}

/**
 * Snapshots the given config-directory group(s) (default: every group) into a
 * single, persistent, git-only repository whose git dir is ~/.ais/backups/.git
 * and whose work tree is the home directory itself (`--git-dir` plus
 * `--work-tree=<home>` on every command). Nothing is copied: git reads the
 * live files and stores each distinct blob once as an object, so there is no
 * second plain-file mirror (the earlier rsync-into-~/.ais/backups/<name>
 * design stored every file twice). Index paths are `.claude/...`,
 * `.codex/...` relative to home. Replaces the older per-run tar.gz snapshots
 * (~/.ai-switcher-backups/<timestamp>/*.tar.gz, never pruned); `git gc
 * --auto` after each commit keeps loose objects packed and delta-compressed.
 * Reproducible/machine-local junk (node_modules, marketplace and browser
 * caches, logs, worktrees, ...) is excluded through <gitdir>/info/exclude,
 * rewritten every run from BACKUP_EXCLUDES — see reproducible-paths.ts,
 * shared with SSH sync's own exclude list — since none of it has restore
 * value. SQLite/session databases are still stored in full (unlike SSH sync):
 * this is a point-in-time safety net taken synchronously before
 * install/update/migrate touch anything, so it carries the same small,
 * accepted risk of catching a database mid-write that every earlier design
 * had. `git add --ignore-errors` skips unreadable (permission-denied) or
 * vanished files with a warning instead of failing. Restore with
 * `git --git-dir=~/.ais/backups/.git show HEAD:<path>` or `checkout`.
 * Symlinks (post-migration compatibility shims) are skipped at the top level
 * — their target is already covered by the container directory. On the first
 * run after upgrading, leftover plain mirror directories from the old design
 * are deleted (history is untouched).
 */
export async function runBackup(
  groups: readonly BackupGroup[] = Object.keys(BACKUP_GROUPS) as BackupGroup[],
  home: string = homedir(),
): Promise<string> {
  const repoDir = aisBackupsDir(home);
  await ensureRepo(repoDir, home);
  await removeLegacyMirrors(repoDir, home);

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
    mirrored.push(name);
  }

  if (mirrored.length === 0) {
    console.error(`backup: nothing to back up, see ${repoDir}`);
    return repoDir;
  }

  const add = await runGit(repoDir, home, ["add", "-A", "--ignore-errors", "--", ...mirrored]);
  if (add.exitCode !== 0) {
    // --ignore-errors stages everything it can read and still exits non-zero
    // for the skipped files (permission-denied, vanished mid-scan).
    console.error(`backup: git add skipped unreadable or vanished files in ${repoDir}: ${add.stderr.trim()}`);
  }

  // A source directory with nothing trackable (empty, or everything under
  // it excluded) has nothing for git to know about — `git add -A` silently
  // no-ops for it, but `git commit -- <pathspec>` is stricter
  // and fails outright the moment ANY of its pathspecs matches nothing at
  // all, in the index OR in history (confirmed live, 2026-07-31: an empty,
  // root-owned ~/.claude-personal broke the whole backup this way). `git
  // ls-files` reports the CURRENT INDEX content for a path regardless of
  // whether it's newly staged or already committed unchanged, so filtering
  // on it — rather than reusing `mirrored` directly — is what actually
  // predicts whether `commit -- <path>` will accept that pathspec.
  const trackable: string[] = [];
  for (const name of mirrored) {
    const lsFiles = await runGit(repoDir, home, ["ls-files", "--", name]);
    if (lsFiles.stdout.trim().length > 0) trackable.push(name);
    else console.error(`backup: ${join(home, name)} has no trackable content (source is empty or fully excluded), skipping`);
  }
  if (trackable.length === 0) {
    console.error(`backup: nothing new to commit, see ${repoDir}`);
    return repoDir;
  }

  const diff = await runGit(repoDir, home, ["diff", "--cached", "--quiet", "--", ...trackable]);
  if (diff.exitCode === 0) {
    console.error(`backup: no changes since the last backup, see ${repoDir}`);
    return repoDir;
  }

  // Scoped to `trackable`, same as the add/diff above: a bare `git commit`
  // commits the WHOLE index, which would silently sweep in stale staged
  // content from an earlier, interrupted run that touched OTHER groups this
  // run never re-mirrored. `git commit -- <pathspec>` instead commits only
  // the matching changes and leaves the rest staged for a future run.
  const commit = await runGit(repoDir, home, [
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
  const rev = await runGit(repoDir, home, ["rev-parse", "--short", "HEAD"]);
  console.error(`backup: committed ${rev.stdout.trim()} in ${repoDir}`);

  await runGit(repoDir, home, ["gc", "--auto", "--quiet"]);

  console.error(`backup: complete, see ${repoDir}`);
  return repoDir;
}

if (import.meta.main) {
  await runBackup();
}
