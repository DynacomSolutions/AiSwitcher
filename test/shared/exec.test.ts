import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chdir } from "node:process";
import { ensureUsableCwd, withUsableCwd } from "../../src/shared/exec.ts";

const tempDirs: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  chdir(originalCwd);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Moves the process into a fresh directory, then deletes it out from under
 * the process — the exact state a daemon ends up in when its checkout is
 * moved or pruned while it runs. */
async function enterDeletedDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-deleted-cwd-"));
  tempDirs.push(dir);
  chdir(dir);
  await rm(dir, { recursive: true, force: true });
  return dir;
}

describe("deleted-cwd resilience", () => {
  test("a deleted cwd fails child spawn with a POSIX error", async () => {
    await enterDeletedDirectory();
    expect(() => Bun.spawn(["/bin/true"])).toThrow();
  });

  test("ensureUsableCwd moves a dangling process to $HOME", async () => {
    await enterDeletedDirectory();
    ensureUsableCwd();
    expect(process.cwd()).toBe(homedir());
    expect(() => Bun.spawn(["/bin/true"])).not.toThrow();
  });

  test("withUsableCwd retries the failed attempt exactly once", async () => {
    await enterDeletedDirectory();
    let attempts = 0;
    const result = withUsableCwd(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("spawnSync /bin/true ENOENT");
      return "recovered";
    });
    expect(result).toBe("recovered");
    expect(attempts).toBe(2);
  });

  test("withUsableCwd passes a healthy cwd through untouched", () => {
    let attempts = 0;
    const marker = Symbol("marker");
    const result = withUsableCwd(() => {
      attempts += 1;
      return marker;
    });
    expect(attempts).toBe(1);
    expect(result).toBe(marker);
  });
});
