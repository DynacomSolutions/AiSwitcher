import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aisRemoteCacheDir } from "../../src/shared/ais-home.ts";
import { acquireSyncLock } from "../../src/sync/service.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function heldLock(home: string): Promise<string> {
  const lock = join(aisRemoteCacheDir(home), "sync.lock");
  await mkdir(aisRemoteCacheDir(home), { recursive: true });
  await writeFile(lock, `${JSON.stringify({ pid: process.pid, token: "t", startedAt: "2026-01-01T00:00:00.000Z" })}\n`);
  return lock;
}

test("a foreground sync names the holder and runs once the lock frees", async () => {
  const home = await mkdtemp(join(tmpdir(), "ais-lock-wait-"));
  dirs.push(home);
  const lock = await heldLock(home);
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    setTimeout(() => void rm(lock, { force: true }), 400);
    const release = await acquireSyncLock(true, home, 5000);
    expect(release).toBeDefined();
    expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain(`(pid ${process.pid}, started 2026-01-01`);
    await release!();
  } finally { err.mockRestore(); }
});

test("a background sync does not wait and a foreground one gives up after its budget", async () => {
  const home = await mkdtemp(join(tmpdir(), "ais-lock-wait-"));
  dirs.push(home);
  await heldLock(home);
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await acquireSyncLock(false, home)).toBeUndefined();
    expect(await acquireSyncLock(true, home, 300)).toBeUndefined();
  } finally { err.mockRestore(); }
});
