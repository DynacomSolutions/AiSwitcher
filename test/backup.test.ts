import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
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
});
