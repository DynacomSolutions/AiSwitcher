import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBackup } from "../scripts/backup.ts";

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
