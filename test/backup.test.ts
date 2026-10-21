import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, symlink, realpath, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRetryingVanished, loadBackupConfig, runBackup } from "../scripts/backup.ts";
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

async function gitShow(repoDir: string, path: string): Promise<string | null> {
  const proc = Bun.spawn(["git", `--git-dir=${join(repoDir, ".git")}`, "show", `HEAD:${path}`], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? stdout : null;
}

async function gitOut(repoDir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", `--git-dir=${join(repoDir, ".git")}`, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}
const gitLs = async (repoDir: string): Promise<string[]> => (await gitOut(repoDir, ["ls-tree", "-r", "--name-only", "HEAD"])).split("\n").filter(Boolean);
const gitStage = (repoDir: string): Promise<string> => gitOut(repoDir, ["ls-files", "-s"]);

async function gitLog(repoDir: string): Promise<string[]> {
  const proc = Bun.spawn(["git", `--git-dir=${join(repoDir, ".git")}`, "log", "--format=%s"], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim().split("\n").filter(Boolean);
}

describe("runBackup integration", () => {
  test("commits a config directory into the git-only repo under ~/.ais/backups with no plain copy", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "identities.json"), '{"version":1,"identities":[]}\n');
    await write(join(home, ".codex", "identities", "personal", "config.toml"), "x = 1\n");

    const repoDir = await runBackup(["codex"], home);

    expect(repoDir).toBe(join(home, ".ais", "backups"));
    expect(await Bun.file(join(repoDir, ".git", "HEAD")).exists()).toBe(true);
    expect(await gitShow(repoDir, ".codex/identities.json")).toBe('{"version":1,"identities":[]}\n');
    expect(await gitShow(repoDir, ".codex/identities/personal/config.toml")).toBe("x = 1\n");
    expect(await gitLog(repoDir)).toHaveLength(1);
    expect(await Bun.file(join(repoDir, ".codex")).exists()).toBe(false);
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
    expect(await gitShow(repoDir, ".codex/identities.json")).toBe('{"changed":true}\n');
  });

  test("a file deleted from the live source is removed from the next backup", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "identities.json"), "{}\n");
    const stale = join(home, ".codex", "stale.txt");
    await write(stale, "gone soon\n");
    const repoDir = await runBackup(["codex"], home);
    expect(await gitShow(repoDir, ".codex/stale.txt")).not.toBeNull();

    await rm(stale);
    await runBackup(["codex"], home);

    expect(await gitShow(repoDir, ".codex/stale.txt")).toBeNull();
  });

  test("excludes reproducible junk (node_modules, caches) from the mirrored tree", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "identities.json"), "{}\n");
    await write(join(home, ".codex", "node_modules", "pkg", "index.js"), "module.exports = {};\n");
    await write(join(home, ".codex", "cache", "big.bin"), "junk\n");

    const repoDir = await runBackup(["codex"], home);

    expect(await gitShow(repoDir, ".codex/node_modules/pkg/index.js")).toBeNull();
    expect(await gitShow(repoDir, ".codex/cache/big.bin")).toBeNull();
    expect(await gitShow(repoDir, ".codex/identities.json")).not.toBeNull();
  });

  test("excludes churning SQLite -shm files and Claude's rotating .claude.json backups, keeps -wal", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "state.sqlite-wal"), "wal\n");
    await write(join(home, ".codex", "state.sqlite-shm"), "shm\n");
    await write(join(home, ".claude", "backups", ".claude.json.backup.1792420307980"), "{}\n");
    await write(join(home, ".claude", "settings.json"), "{}\n");

    const repoDir = await runBackup(["codex", "claude"], home);

    expect(await gitShow(repoDir, ".codex/state.sqlite-wal")).toBe("wal\n");
    expect(await gitShow(repoDir, ".codex/state.sqlite-shm")).toBeNull();
    expect(await gitShow(repoDir, ".claude/backups/.claude.json.backup.1792420307980")).toBeNull();
    expect(await gitShow(repoDir, ".claude/settings.json")).not.toBeNull();
  });

  test("still includes SQLite databases, unlike SSH sync's own exclude list", async () => {
    const home = await makeHome();
    await write(join(home, ".zai", "identities.json"), "{}\n");
    await write(join(home, ".zai", "identities", "identity-a", "data", "session.db"), "not really sqlite bytes");

    const repoDir = await runBackup(["zai"], home);

    expect(await gitShow(repoDir, ".zai/identities/identity-a/data/session.db")).not.toBeNull();
  });

  test("has a backup group for ali (the second crush-backed tool), mirroring zai's shape", async () => {
    const home = await makeHome();
    await write(join(home, ".ali", "identities.json"), "{}\n");
    await write(join(home, ".ali", "identities", "identity-a", "data", "session.db"), "not really sqlite bytes");

    const repoDir = await runBackup(["ali"], home);

    expect(await gitShow(repoDir, ".ali/identities/identity-a/data/session.db")).not.toBeNull();
  });

  test("has a backup group for pi", async () => {
    const home = await makeHome();
    await write(join(home, ".pi", "identities.json"), "{}\n");
    await write(join(home, ".pi", "identities", "all", "auth.json"), "{}\n");

    const repoDir = await runBackup(["pi"], home);

    expect(await gitShow(repoDir, ".pi/identities/all/auth.json")).not.toBeNull();
  });

  test("tolerates an individual unreadable file and still commits", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "identities.json"), "{}\n");
    const unreadable = join(home, ".codex", "no-read.txt");
    await write(unreadable, "secret\n");
    await chmod(unreadable, 0o000);

    try {
      const repoDir = await runBackup(["codex"], home);
      expect(await gitShow(repoDir, ".codex/identities.json")).not.toBeNull();
      expect(await gitShow(repoDir, ".codex/no-read.txt")).toBeNull();
    } finally {
      await chmod(unreadable, 0o644);
    }
  });

  test("skips a top-level directory that is a symlink (post-migration compatibility shim)", async () => {
    const home = await makeHome();
    await write(join(home, "real-codex", "identities.json"), "{}\n");
    await symlink(join(home, "real-codex"), join(home, ".codex"));

    const repoDir = await runBackup(["codex"], home);

    expect(await gitShow(repoDir, ".codex")).toBeNull();
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

    expect(await gitShow(repoDir, ".claude/identities.json")).not.toBeNull();
    expect(await gitLog(repoDir)).toHaveLength(1);
  });

  test("reuses the same repo across independently-scoped runs instead of creating a new one each time", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "identities.json"), "{}\n");
    await write(join(home, ".grok", "identities.json"), "{}\n");

    const repoDir = await runBackup(["codex"], home);
    const second = await runBackup(["grok"], home);

    expect(repoDir).toBe(second);
    expect(await gitShow(repoDir, ".codex/identities.json")).not.toBeNull();
    expect(await gitShow(repoDir, ".grok/identities.json")).not.toBeNull();
    expect(await gitLog(repoDir)).toHaveLength(2);
  });

  test("migration deletes old plain mirror dirs but keeps history", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "identities.json"), "{}\n");
    const repoDir = await runBackup(["codex"], home);
    // Simulate the old design's leftovers.
    await write(join(repoDir, ".codex", "identities.json"), "{}\n");
    await write(join(repoDir, "keep-me.txt"), "not a group dir\n");

    await write(join(home, ".codex", "identities.json"), '{"v":2}\n');
    await runBackup(["codex"], home);

    expect(await Bun.file(join(repoDir, ".codex")).exists()).toBe(false);
    expect(await Bun.file(join(repoDir, "keep-me.txt")).exists()).toBe(true);
    expect(await gitLog(repoDir)).toHaveLength(2);
    expect(await gitShow(repoDir, ".codex/identities.json")).toBe('{"v":2}\n');
  });

  test("an unreadable tracked file or dir does not break later backups or drop history", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "ok.txt"), "ok\n");
    await write(join(home, ".codex", "secret.txt"), "s\n");
    await write(join(home, ".codex", "sub", "deep.txt"), "d\n");
    const repoDir = await runBackup(["codex"], home);
    await write(join(home, ".codex", "ok.txt"), "changed\n");
    await chmod(join(home, ".codex", "secret.txt"), 0o000);
    await chmod(join(home, ".codex", "sub"), 0o000);
    try {
      await runBackup(["codex"], home);
    } finally {
      await chmod(join(home, ".codex", "sub"), 0o755);
      await chmod(join(home, ".codex", "secret.txt"), 0o644);
    }
    expect(await gitLs(repoDir)).toEqual(expect.arrayContaining([".codex/secret.txt", ".codex/sub/deep.txt", ".codex/ok.txt"]));
    expect(await gitShow(repoDir, ".codex/ok.txt")).toBe("changed\n");
  });

  test("a fatal git add error (stale index.lock) rejects", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "a.txt"), "a\n");
    const repoDir = await runBackup(["codex"], home);
    await write(join(repoDir, ".git", "index.lock"), "");
    await write(join(home, ".codex", "a.txt"), "b\n");
    await expect(runBackup(["codex"], home)).rejects.toThrow(/git add failed/);
  });

  test("an index.lock older than a minute (killed git) is removed and the backup commits", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "a.txt"), "a\n");
    const repoDir = await runBackup(["codex"], home);
    const lock = join(repoDir, ".git", "index.lock");
    await write(lock, "");
    const old = new Date(Date.now() - 2 * 3600_000);
    await utimes(lock, old, old);
    await write(join(home, ".codex", "a.txt"), "b\n");
    await runBackup(["codex"], home);
    expect(await gitShow(repoDir, ".codex/a.txt")).toBe("b\n");
    expect(existsSync(lock)).toBe(false);
  });

  test("nested git repos are stored as files, not gitlinks", async () => {
    const home = await makeHome();
    const nested = join(home, ".codex", "memories");
    await write(join(nested, "m.md"), "memo\n");
    await write(join(home, ".codex", "x.txt"), "x\n");
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qm", "c"]]) {
      expect(await Bun.spawn(["git", "-C", nested, ...args], { stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
    }
    const repoDir = await runBackup(["codex"], home);
    expect(await gitShow(repoDir, ".codex/memories/m.md")).toBe("memo\n");
    expect(await gitStage(repoDir)).not.toContain("160000");
    expect(await gitLs(repoDir)).not.toContain(".codex/memories/.git/HEAD");
    // Group root itself being a repo works too.
    const home2 = await makeHome();
    await write(join(home2, ".pi", "a.txt"), "a\n");
    await Bun.spawn(["git", "-C", join(home2, ".pi"), "init", "-q"]).exited;
    const repo2 = await runBackup(["pi"], home2);
    expect(await gitShow(repo2, ".pi/a.txt")).toBe("a\n");
    expect(await gitStage(repo2)).not.toContain("160000");
  });

  test("git hooks from global config do not run", async () => {
    const home = await makeHome();
    const hooks = join(home, "hooks");
    const marker = join(home, "marker");
    await write(join(hooks, "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`);
    await chmod(join(hooks, "pre-commit"), 0o755);
    await write(join(home, "gitconfig"), `[core]\n\thooksPath = ${hooks}\n`);
    await write(join(home, ".codex", "a.txt"), "a\n");
    const prev = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");
    try {
      await runBackup(["codex"], home);
    } finally {
      if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prev;
    }
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("a root .gitignore that ignores the group dir makes the backup fail loudly", async () => {
    const home = await makeHome();
    await write(join(home, ".gitignore"), "*\n");
    await write(join(home, ".codex", "a.txt"), "a\n");
    await expect(runBackup(["codex"], home)).rejects.toThrow(/ignored by a gitignore rule/);
  });

  test("files that newly match the excludes leave the index", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "a.txt"), "a\n");
    await write(join(home, ".codex", "x.lock"), "l\n");
    const repoDir = await runBackup(["codex"], home);
    // Force-track a now-excluded file, as an older version could have.
    await Bun.spawn(["git", `--git-dir=${join(repoDir, ".git")}`, `--work-tree=${home}`, "add", "-f", ".codex/x.lock"]).exited;
    await write(join(home, ".codex", "a.txt"), "b\n");
    await runBackup(["codex"], home);
    expect(await gitLs(repoDir)).not.toContain(".codex/x.lock");
  });

  test("core.bare is set so plain git in the backups dir does not show deletions", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "a.txt"), "a\n");
    const repoDir = await runBackup(["codex"], home);
    const out = await new Response(Bun.spawn(["git", `--git-dir=${join(repoDir, ".git")}`, "config", "core.bare"], { stdout: "pipe" }).stdout).text();
    expect(out.trim()).toBe("true");
  });

  test("legacy mirrors are not removed when the backups dir resolves into a config dir or no history exists", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "a.txt"), "a\n");
    // Backups dir symlinked into the live .codex: deleting <backups>/.codex would hit live data.
    await mkdir(join(home, ".ais"), { recursive: true });
    await mkdir(join(home, ".codex", "bk", ".codex"), { recursive: true });
    await write(join(home, ".codex", "bk", ".codex", "precious"), "p\n");
    await symlink(join(home, ".codex", "bk"), join(home, ".ais", "backups"));
    expect(await realpath(join(home, ".ais", "backups"))).toBe(join(await realpath(home), ".codex", "bk"));
    await runBackup(["codex"], home).catch(() => {});
    expect(await Bun.file(join(home, ".codex", "bk", ".codex", "precious")).exists()).toBe(true);

    // No history yet: leftovers stay.
    const home2 = await makeHome();
    await write(join(home2, ".ais", "backups", ".grok", "old"), "o\n");
    await runBackup(["grok"], home2); // .grok missing in home2, so no commit
    expect(await Bun.file(join(home2, ".ais", "backups", ".grok", "old")).exists()).toBe(true);
  });

  test("a tracked nested-repo file replaced by a directory (D/F conflict) still backs up", async () => {
    const home = await makeHome();
    const nested = join(home, ".codex", "memories");
    await write(join(nested, "x"), "file\n");
    await Bun.spawn(["git", "-C", nested, "init", "-q"]).exited;
    const repoDir = await runBackup(["codex"], home);
    await rm(join(nested, "x"));
    await write(join(nested, "x", "y"), "deep\n");
    await runBackup(["codex"], home);
    expect(await gitLs(repoDir)).toContain(".codex/memories/x/y");
    expect(await gitLs(repoDir)).not.toContain(".codex/memories/x");
  });

  test("a negated root .gitignore (* then !.codex/) does not block the backup", async () => {
    const home = await makeHome();
    await write(join(home, ".gitignore"), "*\n!.codex/\n!.codex/**\n");
    await write(join(home, ".codex", "a.txt"), "a\n");
    const repoDir = await runBackup(["codex"], home);
    expect(await gitShow(repoDir, ".codex/a.txt")).toBe("a\n");
  });

  test("partial root .gitignore rules skip files with a warning", async () => {
    const home = await makeHome();
    await write(join(home, ".gitignore"), ".codex/auth.json\n");
    await write(join(home, ".codex", "a.txt"), "a\n");
    await write(join(home, ".codex", "auth.json"), "t\n");
    const orig = console.error;
    const msgs: string[] = [];
    console.error = (...a: unknown[]) => void msgs.push(a.join(" "));
    let repoDir: string;
    try {
      repoDir = await runBackup(["codex"], home);
    } finally {
      console.error = orig;
    }
    expect(await gitShow(repoDir, ".codex/auth.json")).toBeNull();
    expect(msgs.some((m) => m.includes("1 file(s) skipped") && m.includes(".codex/auth.json"))).toBe(true);
  });

  test("an in-group .gitignore with no root .gitignore gives no skipped-files warning", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "plugin", ".gitignore"), "node_modules/\n");
    await write(join(home, ".codex", "plugin", "node_modules", "m.js"), "m\n");
    await write(join(home, ".codex", "a.txt"), "a\n");
    const orig = console.error;
    const msgs: string[] = [];
    console.error = (...a: unknown[]) => void msgs.push(a.join(" "));
    try {
      await runBackup(["codex"], home);
    } finally {
      console.error = orig;
    }
    expect(msgs.some((m) => m.includes("skipped because a .gitignore"))).toBe(false);
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

describe("runBackup off-host push", () => {
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
    expect(await git(a, [`--work-tree=${home}`, "status", "--porcelain"])).toBe("");
    expect(await git(remote, ["rev-parse", `refs/heads/${await branchOf(a)}`])).toBe(await git(a, ["rev-parse", "HEAD"]));
    expect(existsSync(join(home, ".ais", "backups.lock"))).toBe(false);
  });
});

describe("runBackup never uses Git LFS", () => {
  // Simulates a global `git lfs install` with a fake filter, so no git-lfs binary is needed.
  // GIT_CONFIG_NOSYSTEM keeps a real system-level filter.lfs.process from overriding the fake clean filter.
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
  afterEach(() => {
    if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved.global;
    if (saved.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = saved.nosystem;
  });

  async function useFakeLfsGlobalConfig(home: string): Promise<void> {
    const path = join(home, "global.gitconfig");
    await Bun.write(
      path,
      "[filter \"lfs\"]\n\tclean = sed s/^/POINTER:/\n\tsmudge = cat\n\trequired = true\n",
    );
    process.env.GIT_CONFIG_GLOBAL = path;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
  }

  const real = "real bytes\n";
  const lfsAttributes = "*.bin filter=lfs diff=lfs merge=lfs -text\n";

  test("nested .gitattributes with filter=lfs does not turn content into pointers", async () => {
    const home = await makeHome();
    await useFakeLfsGlobalConfig(home);
    await write(join(home, ".codex", "sub", ".gitattributes"), lfsAttributes);
    await write(join(home, ".codex", "sub", "a.bin"), real);

    const repo = await runBackup(["codex"], home);

    expect(await git(repo, ["show", "HEAD:.codex/sub/a.bin"])).toBe(real.trim());
    expect(await Bun.file(join(repo, ".git", "info", "attributes")).text()).toContain("* -filter -text -ident -working-tree-encoding\n");
  });

  test("an already-polluted repo is renormalised to real content", async () => {
    const home = await makeHome();
    await useFakeLfsGlobalConfig(home);
    await write(join(home, ".codex", "sub", ".gitattributes"), lfsAttributes);
    await write(join(home, ".codex", "sub", "a.bin"), real);
    const repo = join(home, ".ais", "backups");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "--quiet"]);
    await git(repo, ["config", "user.name", "t"]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "commit.gpgsign", "false"]);
    await write(join(repo, ".codex", "sub", ".gitattributes"), lfsAttributes);
    await write(join(repo, ".codex", "sub", "a.bin"), real);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "--quiet", "-m", "polluted"]);
    expect(await git(repo, ["show", "HEAD:.codex/sub/a.bin"])).toBe(`POINTER:${real.trim()}`);

    await runBackup(["codex"], home);

    expect(await git(repo, ["show", "HEAD:.codex/sub/a.bin"])).toBe(real.trim());
    expect(await Bun.file(join(repo, ".git", "info", "attributes")).exists()).toBe(true);
    expect(await git(repo, [`--work-tree=${home}`, "status", "--porcelain"])).toBe("");
  });

  test("a polluted path under an excluded jobs/<id>/tmp/ is dropped, never re-hashed into the object store", async () => {
    const home = await makeHome();
    await useFakeLfsGlobalConfig(home);
    const secret = "huge asset bytes that must not enter the store\n";
    await write(join(home, ".codex", "keep.txt"), "keep\n");
    await write(join(home, ".codex", "jobs", "j1", "tmp", ".gitattributes"), lfsAttributes);
    await write(join(home, ".codex", "jobs", "j1", "tmp", "big.bin"), secret);
    const repo = join(home, ".ais", "backups");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "--quiet"]);
    await git(repo, ["config", "user.name", "t"]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "commit.gpgsign", "false"]);
    await write(join(repo, ".codex", "keep.txt"), "keep\n");
    await write(join(repo, ".codex", "jobs", "j1", "tmp", ".gitattributes"), lfsAttributes);
    await write(join(repo, ".codex", "jobs", "j1", "tmp", "big.bin"), secret);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "--quiet", "-m", "polluted"]);
    expect(await git(repo, ["show", "HEAD:.codex/jobs/j1/tmp/big.bin"])).toBe(`POINTER:${secret.trim()}`);
    const realHash = await git(join(home, ".codex"), ["hash-object", "--no-filters", "jobs/j1/tmp/big.bin"]);

    await runBackup(["codex"], home);

    expect(Bun.spawnSync(["git", "-C", repo, "cat-file", "-e", "HEAD:.codex/jobs/j1/tmp/big.bin"]).exitCode).not.toBe(0);
    expect(await git(repo, ["show", "HEAD:.codex/keep.txt"])).toBe("keep");
    expect(Bun.spawnSync(["git", "-C", repo, "cat-file", "-e", realHash]).exitCode).not.toBe(0);
  });

  test("failing LFS-style hooks neither run nor block the push", async () => {
    const home = await makeHome();
    const remote = await makeBareRemote();
    await write(join(home, ".codex", "identities.json"), "{}\n");
    const repo = await runBackup(["codex"], home);
    const hooks = join(repo, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    await Bun.write(join(hooks, "pre-push"), "#!/bin/sh\nexit 1\n");
    await Bun.write(join(hooks, "post-commit"), `#!/bin/sh\ntouch "${join(home, "hook-ran")}"\n`);
    await chmod(join(hooks, "pre-push"), 0o755);
    await chmod(join(hooks, "post-commit"), 0o755);
    await write(join(home, ".codex", "identities.json"), '{"changed":true}\n');

    await runBackup(["codex"], home, await writeConfig(home, { remote }));

    expect(await git(remote, ["rev-parse", `refs/heads/${await branchOf(repo)}`])).toBe(await git(repo, ["rev-parse", "HEAD"]));
    expect(existsSync(join(home, "hook-ran"))).toBe(false);
  });

  test("excludes jobs/<id>/tmp/ at any depth but keeps other files in jobs/<id>/", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "jobs", "j1", "tmp", "scratch.txt"), "x\n");
    await write(join(home, ".codex", "jobs", "j1", "other.txt"), "keep\n");
    await write(join(home, ".codex", "identities", "p", "jobs", "j2", "tmp", "deep", "scratch.txt"), "x\n");
    await write(join(home, ".codex", "identities", "p", "jobs", "j2", "other.txt"), "keep\n");

    const repo = await runBackup(["codex"], home);

    const files = (await git(repo, ["ls-tree", "-r", "--name-only", "HEAD"])).split("\n");
    expect(files).toContain(".codex/jobs/j1/other.txt");
    expect(files).toContain(".codex/identities/p/jobs/j2/other.txt");
    expect(files.some((f) => f.includes("/tmp/"))).toBe(false);
  });

  test("a root $HOME/.gitattributes with filter=lfs is neutralised and nothing is written to $HOME", async () => {
    const home = await makeHome();
    await useFakeLfsGlobalConfig(home);
    await write(join(home, ".gitattributes"), "* filter=lfs\n");
    await write(join(home, ".codex", "a.txt"), real);

    const repo = await runBackup(["codex"], home);

    expect(await git(repo, ["show", "HEAD:.codex/a.txt"])).toBe(real.trim());
    expect(await Bun.file(join(home, ".gitattributes")).text()).toBe("* filter=lfs\n");
    expect(existsSync(join(home, ".git"))).toBe(false);
  });
});

describe("runBackup shallow push and vanished files", () => {
  test("shallow source is rejected by a fresh bare remote with a specific hint, then accepted after receive.shallowUpdate", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "identities.json"), "{}\n");
    const repo = await seedOldHistory(home, [40, 30, 20]);
    const first = await makeBareRemote();
    await runBackup(["codex"], home, await writeConfig(home, { remote: first, localRetentionDays: 25 }));
    expect(existsSync(join(repo, ".git", "shallow"))).toBe(true);

    const fresh = await makeBareRemote();
    const configPath = await writeConfig(home, { remote: fresh });
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      await runBackup(["codex"], home, configPath);
    } finally {
      console.error = orig;
    }
    expect(errors.join("\n")).toContain("receive.shallowUpdate true");
    expect(Bun.spawnSync(["git", "-C", fresh, "rev-parse", `refs/heads/${await branchOf(repo)}`]).exitCode).not.toBe(0);

    await git(fresh, ["config", "receive.shallowUpdate", "true"]);
    await runBackup(["codex"], home, configPath);
    expect(await git(fresh, ["rev-parse", `refs/heads/${await branchOf(repo)}`])).toBe(await git(repo, ["rev-parse", "HEAD"]));
  });

  test("a 128 'unable to stat ... No such file' is retried with the path skipped; other 128s are returned", async () => {
    const vanished = { exitCode: 128, stdout: "", stderr: "fatal: unable to stat 'x/gone.txt': No such file or directory" };
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      let calls = 0;
      const ok = await addRetryingVanished("/r", async () => (++calls === 1 ? vanished : { exitCode: 0, stdout: "", stderr: "" }));
      expect(ok.exitCode).toBe(0);
      expect(calls).toBe(2);
      expect(errors.join("\n")).toContain("skipped unreadable or vanished files");

      calls = 0;
      const lock = await addRetryingVanished("/r", async () => (calls++, { exitCode: 128, stdout: "", stderr: "fatal: Unable to create index.lock" }));
      expect(lock.exitCode).toBe(128);
      expect(calls).toBe(1);

      // Continuous churn: a new file vanishes on every attempt; backup still completes.
      calls = 0;
      const churn = await addRetryingVanished("/r", async (skip) => {
        calls++;
        return calls <= 50
          ? { exitCode: 128, stdout: "", stderr: `fatal: unable to stat 'f${calls}': No such file or directory` }
          : { exitCode: 0, stdout: "", stderr: String(skip.length) };
      });
      expect(churn.exitCode).toBe(0);
      expect(churn.stderr).toBe("50");

      // Same path reported again despite being skipped: no progress, returned (terminates).
      calls = 0;
      const stuck = await addRetryingVanished("/r", async () => (calls++, vanished));
      expect(stuck.exitCode).toBe(128);
      expect(calls).toBe(2);
    } finally {
      console.error = orig;
    }
  });

  test(".claude/identities/*/sessions files are not committed", async () => {
    const home = await makeHome();
    await write(join(home, ".claude", "identities", "a", "settings.json"), "{}\n");
    await write(join(home, ".claude", "identities", "a", "sessions", "123.abc.key"), "k\n");
    const repo = await runBackup(["claude"], home);
    expect(await gitLs(repo)).toEqual([".claude/identities/a/settings.json"]);
  });

  test(".caveman-sessions content is not committed", async () => {
    const home = await makeHome();
    await write(join(home, ".codex", "identities.json"), "{}\n");
    await write(join(home, ".codex", ".caveman-sessions", "s1.json"), "{}\n");
    const repo = await runBackup(["codex"], home);
    expect(await gitLs(repo)).toEqual([".codex/identities.json"]);
  });
});
