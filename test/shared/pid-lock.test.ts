import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
    for (let round = 0; round < 8; round++) {
      await writeFile(path, `${JSON.stringify({ pid: dead, token: "old" })}\n`);
      const results = await Promise.all(
        Array.from({ length: 16 }, () => acquirePidLock(path, { waitMs: 0, retryMs: 1 })),
      );
      expect(results.filter((r) => r !== undefined).length).toBe(1);
      await results.find((r) => r)?.();
    }
    expect(await readdir(dir)).toEqual([]);
  }, 30000);

  test.skipIf(process.getuid?.() === 0)("unreadable lock returns undefined within about waitMs", async () => {
    dir = await mkdtemp(join(tmpdir(), "pid-lock-"));
    const path = join(dir, "x.lock");
    await writeFile(path, `${JSON.stringify({ pid: process.pid })}\n`);
    await chmod(path, 0);
    const t0 = Date.now();
    expect(await acquirePidLock(path, { waitMs: 100, retryMs: 10 })).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("a lost claim with waitMs 0 returns promptly", async () => {
    dir = await mkdtemp(join(tmpdir(), "pid-lock-"));
    const path = join(dir, "x.lock");
    const stale = `${JSON.stringify({ pid: await deadPid(), token: "old" })}\n`;
    await writeFile(path, stale);
    // A live claimant already holds the claim for this exact stale content.
    const hash = new Bun.CryptoHasher("sha1").update(stale).digest("hex");
    await writeFile(`${path}.claim-${hash}`, `${JSON.stringify({ pid: process.pid })}\n`);
    const t0 = Date.now();
    expect(await acquirePidLock(path, { waitMs: 0, retryMs: 10 })).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("reaps temp files of dead pids", async () => {
    dir = await mkdtemp(join(tmpdir(), "pid-lock-"));
    const path = join(dir, "x.lock");
    const orphan = `${path}.${await deadPid()}-${crypto.randomUUID()}.tmp`;
    await writeFile(orphan, "x");
    await (await acquirePidLock(path, { waitMs: 0, retryMs: 1 }))?.();
    expect(await Bun.file(orphan).exists()).toBe(false);
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
