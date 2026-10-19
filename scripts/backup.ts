import { homedir } from "node:os";
import { join, sep } from "node:path";
import { access, constants, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
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

// Meaningless (or actively harmful) to restore, on top of the reproducible
// junk shared with SSH sync — a stale lock/socket file "restored" into a
// live directory later would just confuse whatever's watching for one.
// Unlike SSH sync, SQLite/db files are deliberately NOT excluded here: this
// is a point-in-time safety-net copy, not a live merge target, so it wants
// the same full-fidelity content the old tar-based backup always included.
// "**/jobs/*/tmp/": agent job scratch dirs hold throwaway checkouts that can
// carry their own .gitattributes. The leading "**/" is what makes it match at
// any depth in gitignore syntax (rsync matched unanchored).
// ".caveman-sessions/": transient per-session scratch state that churns while the backup runs.
const BACKUP_EXCLUDES = [...REPRODUCIBLE_JUNK_DIR_NAMES, "*.lock", "*.sock", "*.pid", "**/jobs/*/tmp/", ".caveman-sessions/"];

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
  // Never Git LFS, even if the user ran `git lfs install` globally.
  "filter.lfs.required=false",
].flatMap((kv) => ["-c", kv]);

async function runGit(repoDir: string, home: string, args: string[], stdin?: string, env?: Record<string, string>): Promise<GitResult> {
  const git = Bun.which("git");
  if (!git) throw new Error("backup: git is required for the git-managed backup repo but was not found on PATH");
  const proc = Bun.spawn([git, ...SAFE_GIT_CONFIG, `--git-dir=${join(repoDir, ".git")}`, `--work-tree=${home}`, ...args], {
    cwd: home,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    ...(env ? { env: { ...process.env, ...env } } : {}),
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

const VANISHED_RE = /unable to stat '[^']*': No such file or directory/;

/** Runs a `git add` attempt, retrying (max 3 tries) when git exits 128 because a
 * file vanished between listing and staging; `--ignore-errors` does not cover that
 * lstat failure. Each retry re-lists, so the gone file is no longer seen. Any other
 * failure is returned unchanged for the caller to treat as fatal. */
export async function addRetryingVanished(repoDir: string, attempt: () => Promise<GitResult>): Promise<GitResult> {
  let result = await attempt();
  for (let n = 1; n < 3 && result.exitCode === 128 && VANISHED_RE.test(result.stderr); n++) {
    console.error(`backup: git add skipped unreadable or vanished files in ${repoDir}: ${result.stderr.trim()}`);
    result = await attempt();
  }
  return result;
}

async function ensureRepo(repoDir: string, home: string): Promise<string[]> {
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
  return ensureAttributes(repoDir, home);
}

// info/attributes has the highest attribute precedence, so it beats any
// .gitattributes mirrored in from a config tree AND the root $HOME/.gitattributes
// that now applies because the work tree is $HOME.
const BACKUP_ATTRIBUTES =
  "# Backups store raw bytes: neutralise filters (LFS) from any .gitattributes in the work tree.\n" +
  "* -filter -text -ident -working-tree-encoding\n";

/** Tracked paths whose attributes currently resolve to the LFS filter. */
async function trackedLfsPaths(repoDir: string, home: string): Promise<string[]> {
  const files = await runGit(repoDir, home, ["ls-files", "-z"]);
  if (files.exitCode !== 0 || files.stdout === "") return [];
  const attrs = await runGit(repoDir, home, ["check-attr", "-z", "--stdin", "filter"], files.stdout);
  if (attrs.exitCode !== 0) throw new Error(`backup: git check-attr failed in ${repoDir}: ${attrs.stderr.trim()}`);
  // Output is NUL-separated <path>, <attribute>, <value> triples.
  const parts = attrs.stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i + 2] === "lfs") paths.push(parts[i]!);
  return paths;
}

/** Writes the neutralising attributes; returns tracked paths still stored through the LFS filter. */
async function ensureAttributes(repoDir: string, home: string): Promise<string[]> {
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
  const polluted = await trackedLfsPaths(repoDir, home);

  const tmpPath = `${attributesPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, BACKUP_ATTRIBUTES);
  await rename(tmpPath, attributesPath);
  return polluted;
}

/** Replaces LFS pointers in the index with real content. Index only: nothing
 * is written to $HOME. Runs AFTER the exclude pass, so paths that are no longer
 * tracked (e.g. multi-GB jobs/<id>/tmp/ assets) or no longer exist are skipped
 * and never hashed. */
async function renormalise(repoDir: string, home: string, polluted: readonly string[]): Promise<void> {
  const tracked = new Set((await runGit(repoDir, home, ["ls-files", "-z"])).stdout.split("\0"));
  const present: string[] = [];
  for (const path of polluted) if (tracked.has(path) && (await pathExists(join(home, path)))) present.push(path);
  if (present.length > 0) {
    // Literal pathspecs: tracked names may contain glob characters.
    const add = await addRetryingVanished(repoDir, () =>
      runGit(
        repoDir,
        home,
        ["add", "--renormalize", "--ignore-errors", "--pathspec-from-file=-", "--pathspec-file-nul"],
        present.join("\0") + "\0",
        { GIT_LITERAL_PATHSPECS: "1" },
      ),
    );
    if (add.exitCode > 1) throw new Error(`backup: git add --renormalize failed in ${repoDir}: ${add.stderr.trim()}`);
  }
  console.error(
    `backup: RENORMALISED ${present.length} tracked path(s) that were stored through the LFS filter ` +
      `(${polluted.length - present.length} more no longer exist or are excluded and are dropped); real content replaces the pointers in this run's commit`,
  );
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
const JUNK_DIRS = new Set([...REPRODUCIBLE_JUNK_DIR_NAMES, ".caveman-sessions/"].map((n) => n.replace(/\/$/, "")).filter((n) => n !== ".git"));
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
        if (!JUNK_DIRS.has(e.name) && !/(^|\/)jobs\/[^/]+\/tmp$/.test(child)) await walk(child, inRepo);
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

async function backupAndCommit(groups: readonly BackupGroup[], home: string): Promise<string> {
  const repoDir = aisBackupsDir(home);
  const polluted = await ensureRepo(repoDir, home);
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
    // -q decides (exit 0 = ignored, honours negations); -v only words the error,
    // since it also exits 0 when a negation rule matched.
    const ignoredQ = await runGit(repoDir, home, ["check-ignore", "-q", "--no-index", "--", name]);
    if (ignoredQ.exitCode === 0) {
      const ignored = await runGit(repoDir, home, ["check-ignore", "-v", "--no-index", "--", name]);
      throw new Error(`backup: ${join(home, name)} is ignored by a gitignore rule, nothing would be backed up: ${ignored.stdout.trim()}`);
    }
  }

  // Already-tracked files that now match BACKUP_EXCLUDES leave the index.
  const excluded = await runGit(repoDir, home, ["ls-files", "-ci", `--exclude-from=${join(repoDir, ".git", "info", "exclude")}`, "-z", "--", ...mirrored]);
  if (excluded.exitCode === 0 && excluded.stdout.length > 0) {
    await runGit(repoDir, home, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], excluded.stdout);
  }

  if (polluted.length > 0) await renormalise(repoDir, home, polluted);

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
    const upd = await runGit(repoDir, home, ["update-index", "--add", "--remove", "--replace", "-z", "--stdin"], nestedFiles.join("\0") + "\0");
    if (upd.exitCode !== 0) throw new Error(`backup: git update-index failed in ${repoDir}: ${upd.stderr.trim()}`);
  }

  // Exit 1 is --ignore-errors reporting files it skipped (permission-denied,
  // vanished mid-scan); anything else (e.g. 128, a stale index.lock) is fatal.
  const add = await addRetryingVanished(repoDir, () => runGit(repoDir, home, ["add", "-A", "--ignore-errors", "--", ...mirrored]));
  if (add.exitCode === 1) {
    console.error(`backup: git add skipped unreadable or vanished files in ${repoDir}: ${add.stderr.trim()}`);
  } else if (add.exitCode !== 0) {
    throw new Error(`backup: git add failed in ${repoDir}: ${add.stderr.trim() || `exit ${add.exitCode}`}`);
  }

  // Partial .gitignore rules outside our control silently skip files; warn, never force-add.
  // Only the root ~/.gitignore is outside our control; per-directory ones
  // inside a group were obeyed by the old rsync design too. Junk we exclude
  // anyway is dropped from the report.
  const skippedPaths: string[] = [];
  if (await pathExists(join(home, ".gitignore"))) {
    const skipped = await runGit(repoDir, home, ["ls-files", "-z", "-o", "-i", "--directory", `--exclude-from=${join(home, ".gitignore")}`, "--", ...mirrored]);
    for (const p of skipped.stdout.split("\0").filter(Boolean)) {
      const parts = p.split("/").filter(Boolean);
      if (parts.some((seg) => JUNK_DIRS.has(seg)) || /(^|\/)jobs\/[^/]+\/tmp(\/|$)/.test(p) || /\.(lock|sock|pid)\/?$/.test(p)) continue;
      skippedPaths.push(p);
    }
  }
  if (skippedPaths.length > 0) {
    console.error(`backup: ${skippedPaths.length} file(s) skipped because a .gitignore rule matches them, e.g. ${skippedPaths.slice(0, 3).join(", ")}`);
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

async function runRemoteGit(repoDir: string, home: string, args: string[]): Promise<GitResult> {
  return runGit(repoDir, home, ["-c", `core.sshCommand=${SSH_COMMAND}`, ...args], undefined, GIT_REMOTE_ENV);
}

/** Pushes the current branch (never forced), then optionally trims local
 * history. Failures are loud but never thrown: the local backup already
 * succeeded and the next run retries (the push always sends the whole branch). */
async function pushAndTrim(repoDir: string, home: string, remote: string, retentionDays: number | undefined): Promise<void> {
  try {
    const head = await runGit(repoDir, home, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (head.exitCode !== 0) {
      console.error(`backup: no commits yet, nothing to push to the off-host remote`);
      return;
    }
    const headSha = head.stdout.trim();
    const branchResult = await runGit(repoDir, home, ["symbolic-ref", "--short", "HEAD"]);
    const branch = branchResult.stdout.trim();
    if (branchResult.exitCode !== 0 || !branch) {
      console.error(`backup: off-host push skipped, HEAD is not on a branch`);
      return;
    }

    const push = await runRemoteGit(repoDir, home, ["push", "--quiet", remote, `HEAD:refs/heads/${branch}`]);
    if (push.exitCode !== 0) {
      console.error(`backup: off-host push FAILED (${failureText(push, remote)}); local backup is intact, next run retries`);
      if (push.stderr.includes("shallow update not allowed")) {
        console.error(
          "backup: the remote refuses pushes from this shallow backup repo (localRetentionDays trim); run `git config receive.shallowUpdate true` inside the bare remote repository, then the next run will succeed",
        );
      }
      if (retentionDays) console.error("backup: local trim skipped, the push did not succeed");
      return;
    }
    console.error(`backup: pushed ${headSha.slice(0, 7)} to the off-host remote (${branch})`);

    if (retentionDays) await trimLocalHistory(repoDir, home, remote, branch, headSha, retentionDays);
  } catch (err) {
    console.error(`backup: off-host step FAILED (${(err as Error).message.split(remote).join("<remote>")}); local backup is intact`);
  }
}

async function trimLocalHistory(
  repoDir: string,
  home: string,
  remote: string,
  branch: string,
  headSha: string,
  days: number,
): Promise<void> {
  const ls = await runRemoteGit(repoDir, home, ["ls-remote", remote, `refs/heads/${branch}`]);
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

  const since = await runGit(repoDir, home, ["rev-list", "--first-parent", `--since=${days} days ago`, "HEAD"]);
  if (since.exitCode !== 0) {
    console.error(`backup: local trim skipped, rev-list failed (${failureText(since, remote)})`);
    return;
  }
  const recent = since.stdout.trim().split("\n").filter(Boolean);
  const boundary = recent.length > 0 ? recent[recent.length - 1]! : headSha;
  // Already a root or already the shallow boundary: nothing older to drop.
  const parent = await runGit(repoDir, home, ["rev-parse", "--verify", "--quiet", `${boundary}^`]);
  if (parent.exitCode !== 0) return;

  const before = (await runGit(repoDir, home, ["rev-list", "--count", "HEAD"])).stdout.trim();
  // History is linear, so the new boundary is always newer than any existing one: replace.
  const shallowPath = join(repoDir, ".git", "shallow");
  const tmpPath = `${shallowPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${boundary}\n`);
  await rename(tmpPath, shallowPath);
  const expire = await runGit(repoDir, home, ["reflog", "expire", "--expire=now", "--all"]);
  const gc = await runGit(repoDir, home, ["gc", "--prune=now", "--quiet"]);
  if (expire.exitCode !== 0 || gc.exitCode !== 0) {
    console.error(`backup: local trim set the boundary but cleanup failed (${failureText(expire.exitCode !== 0 ? expire : gc, remote)})`);
    return;
  }
  const after = (await runGit(repoDir, home, ["rev-list", "--count", "HEAD"])).stdout.trim();
  console.error(
    `backup: trimmed local history older than ${days} days (${before} -> ${after} commits, boundary ${boundary.slice(0, 7)}); the off-host remote keeps the full history`,
  );
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
  configPath: string = aisBackupConfigPath(process.env, home),
): Promise<string> {
  // The lock covers everything, including legacy-mirror deletion and the trim.
  const release = await acquirePidLock(aisBackupLockPath(home), { waitMs: LOCK_WAIT_MS, retryMs: LOCK_RETRY_MS });
  if (!release) throw new Error(`backup: another backup still holds ${aisBackupLockPath(home)} after 10 minutes`);
  try {
    const repoDir = await backupAndCommit(groups, home);
    const config = await loadBackupConfig(configPath);
    if (config.remote) await pushAndTrim(repoDir, home, config.remote, config.localRetentionDays);
    return repoDir;
  } finally {
    await release();
  }
}

if (import.meta.main) {
  await runBackup();
}
