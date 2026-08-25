import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aisConfigDir, aisNpmDir, aisRemoteCacheDir } from "../../src/shared/ais-home.ts";
import { migrateLegacyAisHome } from "../../src/shared/migrate-ais-home.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "ais-migrate-home-"));
  tempDirs.push(home);
  return home;
}

async function write(path: string, contents: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, contents);
}

async function exists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

describe("migrateLegacyAisHome", () => {
  test("moves the legacy npm prefix, sync config, and remote cache into ~/.ais", async () => {
    const home = await makeHome();
    await write(join(home, ".local", "share", "ais", "npm", "bin", "claude"), "#!/bin/sh\n");
    await write(join(home, ".config", "ais", "sync-v2.json"), '{"version":2,"remotes":[]}\n');
    await write(join(home, ".cache", "ais", "dedupe-backups", "run", "note.txt"), "archived\n");

    await migrateLegacyAisHome(home, {});

    expect(await exists(join(aisNpmDir(home), "bin", "claude"))).toBe(true);
    expect(await exists(join(home, ".local", "share", "ais", "npm"))).toBe(false);

    expect(await exists(join(aisConfigDir(home), "sync-v2.json"))).toBe(true);
    expect(await exists(join(home, ".config", "ais"))).toBe(false);

    expect(await exists(join(aisRemoteCacheDir(home), "dedupe-backups", "run", "note.txt"))).toBe(true);
    expect(await exists(join(home, ".cache", "ais"))).toBe(false);
  });

  test("is a no-op when there is nothing legacy to migrate", async () => {
    const home = await makeHome();
    await expect(migrateLegacyAisHome(home, {})).resolves.toBeUndefined();
  });

  test("never throws even when a migration step fails", async () => {
    const home = await makeHome();
    await write(join(home, ".local", "share", "ais", "npm", "bin", "claude"), "#!/bin/sh\n");
    // Every new target lives under home/.ais — making that a plain file
    // means mkdir(dirname(target), { recursive: true }) must fail with
    // ENOTDIR for every migration step.
    await write(join(home, ".ais"), "occupied by a file, not a directory\n");

    await expect(migrateLegacyAisHome(home, {})).resolves.toBeUndefined();
    expect(await exists(join(home, ".local", "share", "ais", "npm", "bin", "claude"))).toBe(true);
  });

  test("respects an explicit AI_PROFILE_SWITCHER_REAL_BIN_DIR override and leaves the legacy npm prefix alone", async () => {
    const home = await makeHome();
    await write(join(home, ".local", "share", "ais", "npm", "bin", "claude"), "#!/bin/sh\n");

    await migrateLegacyAisHome(home, { AI_PROFILE_SWITCHER_REAL_BIN_DIR: "/custom/bin" });

    expect(await exists(join(home, ".local", "share", "ais", "npm", "bin", "claude"))).toBe(true);
    expect(await exists(join(aisNpmDir(home), "bin", "claude"))).toBe(false);
  });

  test("respects an explicit AIS_SYNC_CONFIG override and leaves the legacy config dir alone", async () => {
    const home = await makeHome();
    await write(join(home, ".config", "ais", "sync-v2.json"), "{}\n");

    await migrateLegacyAisHome(home, { AIS_SYNC_CONFIG: "/custom/sync.json" });

    expect(await exists(join(home, ".config", "ais", "sync-v2.json"))).toBe(true);
    expect(await exists(join(aisConfigDir(home), "sync-v2.json"))).toBe(false);
  });

  test("defers the remote-cache migration while its sync.lock names a live process", async () => {
    const home = await makeHome();
    await write(join(home, ".cache", "ais", "sync.lock"), JSON.stringify({ pid: process.pid }));
    await write(join(home, ".cache", "ais", "dedupe-backups", "run", "note.txt"), "archived\n");

    await migrateLegacyAisHome(home, {});

    expect(await exists(join(home, ".cache", "ais", "dedupe-backups", "run", "note.txt"))).toBe(true);
    expect(await exists(join(aisRemoteCacheDir(home), "dedupe-backups", "run", "note.txt"))).toBe(false);
  });

  test("migrates the remote cache when its sync.lock names a dead process", async () => {
    const home = await makeHome();
    // A PID astronomically unlikely to be alive in the test sandbox.
    await write(join(home, ".cache", "ais", "sync.lock"), JSON.stringify({ pid: 999_999 }));
    await write(join(home, ".cache", "ais", "dedupe-backups", "run", "note.txt"), "archived\n");

    await migrateLegacyAisHome(home, {});

    expect(await exists(join(aisRemoteCacheDir(home), "dedupe-backups", "run", "note.txt"))).toBe(true);
  });

  test("defers the npm-prefix migration while a process has an open file handle underneath it", async () => {
    const home = await makeHome();
    const openFilePath = join(home, ".local", "share", "ais", "npm", "bin", "claude");
    await write(openFilePath, "#!/bin/sh\n");
    const handle = await open(openFilePath, "r");
    try {
      await migrateLegacyAisHome(home, {});

      expect(await exists(openFilePath)).toBe(true);
      expect(await exists(join(aisNpmDir(home), "bin", "claude"))).toBe(false);
    } finally {
      await handle.close();
    }
  });

  test("migrates the npm prefix once nothing has it open", async () => {
    const home = await makeHome();
    const openFilePath = join(home, ".local", "share", "ais", "npm", "bin", "claude");
    await write(openFilePath, "#!/bin/sh\n");
    const handle = await open(openFilePath, "r");
    await handle.close();

    await migrateLegacyAisHome(home, {});

    expect(await exists(join(aisNpmDir(home), "bin", "claude"))).toBe(true);
  });

  test("a race between two concurrent calls migrates exactly once and never logs a false failure", async () => {
    const home = await makeHome();
    await write(join(home, ".local", "share", "ais", "npm", "bin", "claude"), "#!/bin/sh\n");
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      await Promise.all([migrateLegacyAisHome(home, {}), migrateLegacyAisHome(home, {})]);
    } finally {
      console.error = originalError;
    }

    expect(await exists(join(aisNpmDir(home), "bin", "claude"))).toBe(true);
    expect(await exists(join(home, ".local", "share", "ais", "npm"))).toBe(false);
    expect(errors.some((line) => line.includes("failed to migrate"))).toBe(false);
  });

  test("leaves both in place when the target already exists (does not merge or clobber)", async () => {
    const home = await makeHome();
    await write(join(home, ".config", "ais", "sync-v2.json"), '{"legacy":true}\n');
    await write(join(aisConfigDir(home), "sync-v2.json"), '{"current":true}\n');

    await migrateLegacyAisHome(home, {});

    expect(await Bun.file(join(home, ".config", "ais", "sync-v2.json")).text()).toBe('{"legacy":true}\n');
    expect(await Bun.file(join(aisConfigDir(home), "sync-v2.json")).text()).toBe('{"current":true}\n');
  });
});
