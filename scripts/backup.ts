import { homedir } from "node:os";
import { join, sep } from "node:path";
import { access, constants, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
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
// Hooks, fsmonitor, a global/root excludes file and attributes (autocrlf,
// filters) must never act on a snapshot of $HOME: they could run arbitrary
// code from the user's global config or silently change what is stored.
const SAFE_GIT_CONFIG = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.excludesFile=/dev/null",
  "core.attributesFile=/dev/null",
  "core.autocrlf=false",
].flatMap((kv) => ["-c", kv]);

async function runGit(repoDir: string, home: string, args: string[], input?: string): Promise<GitResult> {
  const git = Bun.which("git");
  if (!git) throw new Error("backup: git is required for the git-managed backup repo but was not found on PATH");
  const proc = Bun.spawn([git, ...SAFE_GIT_CONFIG, `--git-dir=${join(repoDir, ".git")}`, `--work-tree=${home}`, ...args], {
    cwd: home,
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
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
    const proc = Bun.spawn([git, "init", "--template=", "--quiet", repoDir], { stdout: "pipe", stderr: "pipe" });
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
  // Bare in config so running plain git inside ~/.ais/backups does not see
  // $HOME-relative index paths as ~500k deletions; every backup command passes
  // --work-tree explicitly, which overrides this.
  await runGit(repoDir, home, ["config", "core.bare", "true"]);
  // The work tree is all of home, so untracked noise in `git status` is
  // meaningless and slow to compute.
  await runGit(repoDir, home, ["config", "status.showUntrackedFiles", "no"]);
  // Rewritten every run so a changed BACKUP_EXCLUDES takes effect. Trailing-slash
  // names match a directory of that name anywhere; globs match anywhere.
  await mkdir(join(repoDir, ".git", "info"), { recursive: true });
  await Bun.write(join(repoDir, ".git", "info", "exclude"), `${BACKUP_EXCLUDES.join("\n")}\n`);
}

// One-off cleanup of the old plain rsync mirrors (<backups>/<name>). Only the
// literal known group names are removed, only once history exists (HEAD
// resolves), and never if the backups dir resolves to $HOME or into one of
// the group dirs (a symlinked ~/.ais would otherwise delete live config).
async function removeLegacyMirrors(repoDir: string, home: string): Promise<void> {
  const names = Object.values(BACKUP_GROUPS).flat();
  const [realRepo, realHome] = await Promise.all([realpath(repoDir), realpath(home)]);
  if (realRepo === realHome || names.some((n) => realRepo === join(realHome, n) || realRepo.startsWith(join(realHome, n) + sep))) {
    console.error(`backup: ${repoDir} resolves to ${realRepo}, inside a backed-up location, not removing legacy mirrors`);
    return;
  }
  const head = await runGit(repoDir, home, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (head.exitCode !== 0) return;
  for (const name of names) {
    const legacy = join(repoDir, name);
    if (!(await pathExists(legacy))) continue;
    await rm(legacy, { recursive: true, force: true });
    console.error(`backup: removed legacy plain mirror ${legacy} (contents now live in git only)`);
  }
}

// git records a directory containing its own .git as a content-less gitlink
// (or skips it when it has no commits). Walk each group for such nested
// repos and return their non-.git files so they can be indexed directly.
// Junk dirs and lock/sock/pid files are filtered here because
// `update-index --add` bypasses the exclude file.
const JUNK_DIRS = new Set(REPRODUCIBLE_JUNK_DIR_NAMES.map((n) => n.replace(/\/$/, "")).filter((n) => n !== ".git"));
async function findNestedRepoFiles(home: string, name: string): Promise<{ repos: string[]; files: string[] }> {
  const repos: string[] = [];
  const files: string[] = [];
  const walk = async (rel: string, inRepo: boolean): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(home, rel), { withFileTypes: true });
    } catch {
      console.error(`backup: cannot read directory ${join(home, rel)}, skipping`);
      return;
    }
    if (entries.some((e) => e.name === ".git")) {
      repos.push(rel);
      inRepo = true;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!JUNK_DIRS.has(e.name)) await walk(child, inRepo);
      } else if (inRepo && (e.isFile() || e.isSymbolicLink()) && !/\.(lock|sock|pid)$/.test(e.name)) {
        if (e.isFile()) {
          try {
            await access(join(home, child), constants.R_OK);
          } catch {
            console.error(`backup: ${join(home, child)} is unreadable, skipping`);
            continue;
          }
        }
        files.push(child);
      }
    }
  };
  await walk(name, false);
  return { repos, files };
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
 * vanished files with a warning instead of failing. Restore by reading, not
 * by running plain git in ~/.ais/backups: `git --git-dir=$HOME/.ais/backups/.git
 * show HEAD:<path>`, or into a scratch dir with `git --git-dir=... 
 * --work-tree=<tempdir> checkout HEAD -- <path>`. Always spell out
 * `--work-tree`; never point it at the live $HOME unless you mean to overwrite.
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

  // A group dir (or anything above it) matched by a .gitignore outside our
  // control, e.g. `*` in ~/.gitignore, would make `git add` store nothing and
  // still look successful. That file cannot be disabled by config, so fail loudly.
  for (const name of mirrored) {
    const ignored = await runGit(repoDir, home, ["check-ignore", "-v", "--no-index", "--", name]);
    if (ignored.exitCode === 0) {
      throw new Error(`backup: ${join(home, name)} is ignored by a gitignore rule, nothing would be backed up: ${ignored.stdout.trim()}`);
    }
  }

  // Already-tracked files that now match BACKUP_EXCLUDES leave the index.
  const excluded = await runGit(repoDir, home, ["ls-files", "-ci", `--exclude-from=${join(repoDir, ".git", "info", "exclude")}`, "-z", "--", ...mirrored]);
  if (excluded.exitCode === 0 && excluded.stdout.length > 0) {
    await runGit(repoDir, home, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], excluded.stdout);
  }

  // Nested repos: swap content-less gitlinks for their real files.
  const nestedFiles: string[] = [];
  for (const name of mirrored) {
    const nested = await findNestedRepoFiles(home, name);
    if (nested.repos.length === 0) continue;
    const links = await runGit(repoDir, home, ["ls-files", "-s", "-z", "--", name]);
    const gitlinks = links.stdout.split("\0").filter((l) => l.startsWith("160000 ")).map((l) => l.slice(l.indexOf("\t") + 1));
    if (gitlinks.length > 0) {
      await runGit(repoDir, home, ["rm", "-q", "-f", "--cached", "--pathspec-from-file=-", "--pathspec-file-nul"], gitlinks.join("\0") + "\0");
    }
    nestedFiles.push(...nested.files);
  }
  if (nestedFiles.length > 0) {
    const upd = await runGit(repoDir, home, ["update-index", "--add", "-z", "--stdin"], nestedFiles.join("\0") + "\0");
    if (upd.exitCode !== 0) throw new Error(`backup: git update-index failed in ${repoDir}: ${upd.stderr.trim()}`);
  }

  // Exit 1 is --ignore-errors reporting files it skipped (permission-denied,
  // vanished mid-scan); anything else (e.g. 128, a stale index.lock) is fatal.
  const add = await runGit(repoDir, home, ["add", "-A", "--ignore-errors", "--", ...mirrored]);
  if (add.exitCode === 1) {
    console.error(`backup: git add skipped unreadable or vanished files in ${repoDir}: ${add.stderr.trim()}`);
  } else if (add.exitCode !== 0) {
    throw new Error(`backup: git add failed in ${repoDir}: ${add.stderr.trim() || `exit ${add.exitCode}`}`);
  }

  // A source directory with nothing trackable (empty, or everything under it
  // excluded) has nothing for git to know about; filter on the CURRENT INDEX
  // (`ls-files`) so the diff check below only sees groups git knows.
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

  // Plain commit of the index as built by the scoped `git add` above. A
  // pathspec commit would re-read the live $HOME: an unreadable tracked file
  // would make it throw, and an unreadable tracked dir would commit deletions.
  const commit = await runGit(repoDir, home, [
    "commit",
    "--quiet",
    "-m",
    `backup: ${timestamp()} (${trackable.join(", ")})`,
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
