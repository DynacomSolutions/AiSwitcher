import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTolerableRsyncExitCode, loadBackupConfig, runBackup } from "../scripts/backup.ts";
import { acquirePidLock } from "../src/shared/pid-lock.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "ais-backup-home-"));
  tempDirs.push(home);
  return home;
}

async function write(path: string, contents: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, contents);
}

async function gitLog(repoDir: string): Promise<string[]> {
  const proc = Bun.spawn(["git", "-C", repoDir, "log", "--format=%s"], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim().split("\n").filter(Boolean);
}

test("runBackup tolerates only rsync's partial-file and live-tree-race exit codes", () => {
  expect(isTolerableRsyncExitCode(23)).toBe(true);
  expect(isTolerableRsyncExitCode(24)).toBe(true);
  expect(isTolerableRsyncExitCode(12)).toBe(false);
});

const describeWithRsync = Bun.which("rsync") ? describe : describe.skip;
describeWithRsync("runBackup integration", () => {
  test("mirrors a config directory into a git repo under ~/.ais/backups and commits it", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "identities.json"), '{"version":1,"identities":[]}\n');
    await write(join(home, ".codex", "identities", "personal", "config.toml"), "x = 1\n");

    const repoDir = await runBackup(["codex"], home);

    expect(repoDir).toBe(join(home, ".ais", "backups"));
    expect(await Bun.file(join(repoDir, ".git", "HEAD")).exists()).toBe(true);
    expect(await Bun.file(join(repoDir, ".codex", "identities.json")).text()).toBe('{"version":1,"identities":[]}\n');
    expect(await Bun.file(join(repoDir, ".codex", "identities", "personal", "config.toml")).text()).toBe("x = 1\n");
    expect(await gitLog(repoDir)).toHaveLength(1);
  });

  test("a second run with no changes does not create an empty commit", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "identities.json"), "{}\n");

    const repoDir = await runBackup(["codex"], home);
    expect(await gitLog(repoDir)).toHaveLength(1);

    await runBackup(["codex"], home);
    expect(await gitLog(repoDir)).toHaveLength(1);
  });

  test("a changed file produces a second commit", async () => {
    const home = await makeHome();
    const file = join(home, ".codex", "identities.json");
    await write(file, "{}\n");
    const repoDir = await runBackup(["codex"], home);
    expect(await gitLog(repoDir)).toHaveLength(1);

    await write(file, '{"changed":true}\n');
    await runBackup(["codex"], home);

    expect(await gitLog(repoDir)).toHaveLength(2);
    expect(await Bun.file(join(repoDir, ".codex", "identities.json")).text()).toBe('{"changed":true}\n');
  });

  test("a file deleted from the live source is removed from the next backup", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "identities.json"), "{}\n");
    const stale = join(home, ".codex", "stale.txt");
    await write(stale, "gone soon\n");
    const repoDir = await runBackup(["codex"], home);
    expect(await Bun.file(join(repoDir, ".codex", "stale.txt")).exists()).toBe(true);

    await rm(stale);
    await runBackup(["codex"], home);

    expect(await Bun.file(join(repoDir, ".codex", "stale.txt")).exists()).toBe(false);
  });

  test("excludes reproducible junk (node_modules, caches) from the mirrored tree", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "identities.json"), "{}\n");
    await write(join(home, ".codex", "node_modules", "pkg", "index.js"), "module.exports = {};\n");
    await write(join(home, ".codex", "cache", "big.bin"), "junk\n");

    const repoDir = await runBackup(["codex"], home);

    expect(await Bun.file(join(repoDir, ".codex", "node_modules", "pkg", "index.js")).exists()).toBe(false);
    expect(await Bun.file(join(repoDir, ".codex", "cache", "big.bin")).exists()).toBe(false);
    expect(await Bun.file(join(repoDir, ".codex", "identities.json")).exists()).toBe(true);
  });

  test("still includes SQLite databases, unlike SSH sync's own exclude list", async () => {
    const home = await makeHome();
    await write(join(home, ".zai", "identities.json"), "{}\n");
    await write(join(home, ".zai", "identities", "identity-a", "data", "session.db"), "not really sqlite bytes");

    const repoDir = await runBackup(["zai"], home);

    expect(await Bun.file(join(repoDir, ".zai", "identities", "identity-a", "data", "session.db")).exists()).toBe(true);
  });

  test("has a backup group for ali (the second crush-backed tool), mirroring zai's shape", async () => {
    const home = await makeHome();
    await write(join(home, ".ali", "identities.json"), "{}\n");
    await write(join(home, ".ali", "identities", "identity-a", "data", "session.db"), "not really sqlite bytes");

    const repoDir = await runBackup(["ali"], home);

    expect(await Bun.file(join(repoDir, ".ali", "identities", "identity-a", "data", "session.db")).exists()).toBe(true);
  });

  test("has a backup group for pi", async () => {
    const home = await makeHome();
    await write(join(home, ".pi", "identities.json"), "{}\n");
    await write(join(home, ".pi", "identities", "all", "auth.json"), "{}\n");

    const repoDir = await runBackup(["pi"], home);

    expect(await Bun.file(join(repoDir, ".pi", "identities", "all", "auth.json")).exists()).toBe(true);
  });

  test("tolerates an individual unreadable file (rsync exit 23) instead of aborting the whole mirror", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "identities.json"), "{}\n");
    const unreadable = join(home, ".codex", "no-read.txt");
    await write(unreadable, "secret\n");
    await chmod(unreadable, 0o000);

    try {
      const repoDir = await runBackup(["codex"], home);
      expect(await Bun.file(join(repoDir, ".codex", "identities.json")).exists()).toBe(true);
    } finally {
      await chmod(unreadable, 0o644);
    }
  });

  test("skips a top-level directory that is a symlink (post-migration compatibility shim)", async () => {
    const home = await makeHome();
    await write(join(home, "real-codex", "identities.json"), "{}\n");
    await symlink(join(home, "real-codex"), join(home, ".codex"));

    const repoDir = await runBackup(["codex"], home);

    expect(await Bun.file(join(repoDir, ".codex")).exists()).toBe(false);
  });

  test("an empty (but real, non-missing, non-symlink) directory in the group doesn't break the commit for the others", async () => {
    // Reproduces a real breakage: an empty ~/.claude-personal (root-owned,
    // 0 files) sits alongside a real ~/.claude — mirrorInto produces an
    // empty destination dir for it, which `git add -A` silently no-ops for,
    // but a plain `git commit -- .claude .claude-personal` used to fail
    // outright because `.claude-personal` matched nothing in the index —
    // see runBackup's `trackable` filtering.
    const home = await makeHome();
    await write(join(home, ".claude", "identities.json"), "{}\n");
    await mkdir(join(home, ".claude-personal"), { recursive: true }); // real dir, zero files

    const repoDir = await runBackup(["claude"], home);

    expect(await Bun.file(join(repoDir, ".claude", "identities.json")).exists()).toBe(true);
    expect(await gitLog(repoDir)).toHaveLength(1);
  });

  test("reuses the same repo across independently-scoped runs instead of creating a new one each time", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "identities.json"), "{}\n");
    await write(join(home, ".grok", "identities.json"), "{}\n");

    const first = await runBackup(["codex"], home);
    const second = await runBackup(["grok"], home);

    expect(first).toBe(second);
    expect(await Bun.file(join(first, ".codex", "identities.json")).exists()).toBe(true);
    expect(await Bun.file(join(first, ".grok", "identities.json")).exists()).toBe(true);
    expect(await gitLog(first)).toHaveLength(2);
  });
});

async function git(dir: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr}`);
  return stdout.trim();
}

async function makeBareRemote(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-backup-remote-"));
  tempDirs.push(dir);
  await git(dir, ["init", "--bare", "--quiet"]);
  return dir;
}

async function writeConfig(home: string, config: unknown): Promise<string> {
  const path = join(home, "backup.json");
  await Bun.write(path, typeof config === "string" ? config : JSON.stringify(config));
  return path;
}

const count = async (dir: string) => Number(await git(dir, ["rev-list", "--count", "HEAD"]));
const branchOf = (repo: string) => git(repo, ["symbolic-ref", "--short", "HEAD"]);

/** Pre-seeds the backup repo with commits dated N days ago, so the next runBackup lands on top of old history. */
async function seedOldHistory(home: string, daysAgo: number[]): Promise<string> {
  const repo = join(home, ".ais", "backups");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "--quiet"]);
  await git(repo, ["config", "user.name", "t"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  for (const days of daysAgo) {
    const date = new Date(Date.now() - days * 86_400_000).toISOString();
    await write(join(repo, ".codex", "seed.txt"), `seed ${days}\n`);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "--quiet", "-m", `old ${days}`], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  }
  return repo;
}

describe("loadBackupConfig", () => {
  test("missing file means no remote and is silent", async () => {
    const home = await makeHome();
    expect(await loadBackupConfig(join(home, "nope.json"))).toEqual({});
  });

  test("bad JSON, wrong types and retention without a remote never throw", async () => {
    const home = await makeHome();
    expect(await loadBackupConfig(await writeConfig(home, "{ not json"))).toEqual({});
    expect(await loadBackupConfig(await writeConfig(home, { remote: 5 }))).toEqual({});
    expect(await loadBackupConfig(await writeConfig(home, { remote: "--upload-pack=x" }))).toEqual({});
    expect(await loadBackupConfig(await writeConfig(home, { localRetentionDays: 7 }))).toEqual({});
    expect(await loadBackupConfig(await writeConfig(home, { remote: "/r", localRetentionDays: 0 }))).toEqual({ remote: "/r" });
    expect(await loadBackupConfig(await writeConfig(home, { remote: "/r", localRetentionDays: 1.5 }))).toEqual({ remote: "/r" });
    expect(await loadBackupConfig(await writeConfig(home, { remote: "backup@backup.example:/srv/ais-backups.git", localRetentionDays: 14 }))).toEqual({
      remote: "backup@backup.example:/srv/ais-backups.git",
      localRetentionDays: 14,
    });
  });
});

describe("pid lock", () => {
  test("a live holder blocks, release frees, a dead holder is taken over", async () => {
    const home = await makeHome();
    const path = join(home, "x.lock");
    const release = await acquirePidLock(path, { waitMs: 0, retryMs: 10 });
    expect(release).toBeDefined();
    expect(await acquirePidLock(path, { waitMs: 50, retryMs: 10 })).toBeUndefined();
    await release!();
    expect(existsSync(path)).toBe(false);

    const dead = Bun.spawn(["true"]);
    await dead.exited;
    await Bun.write(path, JSON.stringify({ pid: dead.pid, token: "stale" }));
    const taken = await acquirePidLock(path, { waitMs: 0, retryMs: 10 });
    expect(taken).toBeDefined();
    await taken!();
  });
});

describeWithRsync("runBackup off-host push", () => {
  test("no backup.json: no remote, no shallow file, no lock left behind", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "identities.json"), "{}\n");

    const repo = await runBackup(["codex"], home, join(home, "absent.json"));

    expect(await gitLog(repo)).toHaveLength(1);
    expect(await Bun.file(join(repo, ".git", "config")).text()).not.toContain("[remote");
    expect(existsSync(join(repo, ".git", "shallow"))).toBe(false);
    expect(existsSync(join(home, ".ais", "backups.lock"))).toBe(false);
  });

  test("pushes the current branch to the remote", async () => {
    const home = await makeHome();
    const remote = await makeBareRemote();
    await write(join(home, ".codex", "identities.json"), "{}\n");

    const repo = await runBackup(["codex"], home, await writeConfig(home, { remote }));

    expect(await git(remote, ["rev-parse", `refs/heads/${await branchOf(repo)}`])).toBe(await git(repo, ["rev-parse", "HEAD"]));
    expect(await Bun.file(join(repo, ".git", "config")).text()).not.toContain("[remote");
  });

  test("an unreachable remote does not throw and the local commit is still made", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "identities.json"), "{}\n");

    const repo = await runBackup(["codex"], home, await writeConfig(home, { remote: join(home, "missing.git") }));

    expect(await gitLog(repo)).toHaveLength(1);
  });

  test("catch-up: a later run with no source changes pushes the earlier commit", async () => {
    const home = await makeHome();
    const remote = await makeBareRemote();
    await write(join(home, ".codex", "identities.json"), "{}\n");

    const repo = await runBackup(["codex"], home, await writeConfig(home, { remote: join(home, "missing.git") }));
    const branch = await branchOf(repo);
    expect(Bun.spawnSync(["git", "-C", remote, "rev-parse", `refs/heads/${branch}`]).exitCode).not.toBe(0);

    await runBackup(["codex"], home, await writeConfig(home, { remote }));

    expect(await gitLog(repo)).toHaveLength(1);
    expect(await git(remote, ["rev-parse", `refs/heads/${branch}`])).toBe(await git(repo, ["rev-parse", "HEAD"]));
  });

  test("no trim while the remote is unreachable or not at local HEAD", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "identities.json"), "{}\n");
    const repo = await seedOldHistory(home, [40, 30, 20]);

    await runBackup(["codex"], home, await writeConfig(home, { remote: join(home, "missing.git"), localRetentionDays: 25 }));
    expect(await count(repo)).toBe(4);
    expect(existsSync(join(repo, ".git", "shallow"))).toBe(false);

    // Remote holds unrelated history on the same branch: the push is rejected (never forced), so no trim.
    const remote = await makeBareRemote();
    const other = await mkdtemp(join(tmpdir(), "ais-backup-other-"));
    tempDirs.push(other);
    await git(other, ["init", "--quiet"]);
    await git(other, ["config", "user.name", "t"]);
    await git(other, ["config", "user.email", "t@example.com"]);
    await Bun.write(join(other, "f"), "x");
    await git(other, ["add", "-A"]);
    await git(other, ["commit", "--quiet", "-m", "other"]);
    await git(other, ["push", "--quiet", remote, `HEAD:refs/heads/${await branchOf(repo)}`]);

    await runBackup(["codex"], home, await writeConfig(home, { remote, localRetentionDays: 25 }));
    expect(await count(repo)).toBe(4);
    expect(existsSync(join(repo, ".git", "shallow"))).toBe(false);
    expect(await git(remote, ["rev-parse", `refs/heads/${await branchOf(repo)}`])).not.toBe(await git(repo, ["rev-parse", "HEAD"]));
  });

  test("trims after the remote is confirmed, and a later push needs no force and keeps full remote history", async () => {
    const home = await makeHome();
    const remote = await makeBareRemote();
    const file = join(home, ".codex", "identities.json");
    await write(file, "{}\n");
    const repo = await seedOldHistory(home, [40, 30, 20]);
    const configPath = await writeConfig(home, { remote, localRetentionDays: 25 });
    const branch = await branchOf(repo);

    await runBackup(["codex"], home, configPath);

    expect(existsSync(join(repo, ".git", "shallow"))).toBe(true);
    expect(await count(repo)).toBe(2);
    expect(Number(await git(remote, ["rev-list", "--count", `refs/heads/${branch}`]))).toBe(4);

    await write(file, '{"changed":true}\n');
    await runBackup(["codex"], home, configPath);

    expect(await git(remote, ["rev-parse", `refs/heads/${branch}`])).toBe(await git(repo, ["rev-parse", "HEAD"]));
    expect(Number(await git(remote, ["rev-list", "--count", `refs/heads/${branch}`]))).toBe(5);
    await git(remote, ["fsck", "--strict"]);
  });

  test("concurrent runs serialise on the lock and leave a consistent repo", async () => {
    const home = await makeHome();
    const remote = await makeBareRemote();
    await write(join(home, ".codex", "identities.json"), "{}\n");
    const configPath = await writeConfig(home, { remote });

    const [a, b] = await Promise.all([runBackup(["codex"], home, configPath), runBackup(["codex"], home, configPath)]);

    expect(a).toBe(b);
    expect(await gitLog(a)).toHaveLength(1);
    expect(await git(a, ["status", "--porcelain"])).toBe("");
    expect(await git(remote, ["rev-parse", `refs/heads/${await branchOf(a)}`])).toBe(await git(a, ["rev-parse", "HEAD"]));
    expect(existsSync(join(home, ".ais", "backups.lock"))).toBe(false);
  });
});
