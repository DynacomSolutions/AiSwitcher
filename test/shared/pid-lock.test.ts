import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePidLock } from "../../src/shared/pid-lock";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"]);
  await proc.exited;
  return proc.pid;
}

describe("acquirePidLock", () => {
  test("racing takeovers of a stale lock yield exactly one holder", async () => {
    dir = await mkdtemp(join(tmpdir(), "pid-lock-"));
    const path = join(dir, "x.lock");
    const dead = await deadPid();
    for (let round = 0; round < 20; round++) {
      await writeFile(path, `${JSON.stringify({ pid: dead, token: "old" })}\n`);
      const results = await Promise.all(
        Array.from({ length: 16 }, () => acquirePidLock(path, { waitMs: 0, retryMs: 1 })),
      );
      expect(results.filter((r) => r !== undefined).length).toBe(1);
      await results.find((r) => r)?.();
    }
    expect(await readdir(dir)).toEqual([]);
  });

  test("live lock is not taken; unparseable lock is", async () => {
    dir = await mkdtemp(join(tmpdir(), "pid-lock-"));
    const path = join(dir, "x.lock");
    const release = await acquirePidLock(path, { waitMs: 0, retryMs: 1 });
    expect(release).toBeDefined();
    expect(await acquirePidLock(path, { waitMs: 0, retryMs: 1 })).toBeUndefined();
    await release?.();
    await writeFile(path, "garbage");
    expect(await acquirePidLock(path, { waitMs: 0, retryMs: 1 })).toBeDefined();
  });
});
