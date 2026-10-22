import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runBackup } from "../../scripts/backup.ts";
import { aisBackupLockPath } from "../../src/shared/ais-home.ts";
import { runUpdate } from "../../src/cli/update.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// No managed binary exists under the real ~/.local/bin of a CI runner only if absent; the
// download loop is not reached because these tests inject the backup and assert the first lines.
test("update announces the backup before it starts and heartbeats while it runs", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  let announcedBefore = -1;
  try {
    await runUpdate({
      heartbeatMs: 20,
      backup: async () => {
        announcedBefore = log.mock.calls.length;
        await Bun.sleep(100);
        throw new Error("stop before any download");
      },
    }).catch(() => undefined);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(announcedBefore).toBe(1);
    expect(lines[0]).toContain("backing up tool config directories first");
    expect(lines.filter((l) => l.includes("still backing up")).length).toBeGreaterThan(0);
  } finally { log.mockRestore(); }
});

test("--no-backup skips the backup and says so", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runUpdate({ skipBackup: true, shimDir: join(tmpdir(), "ais-no-such-shims"), backup: async () => { throw new Error("must not run"); } }).catch(() => undefined);
    expect(String(log.mock.calls[0]?.[0])).toContain("skipping backup");
  } finally { log.mockRestore(); }
});

test("a backup lock held by a live process is reported, not waited on silently", async () => {
  const home = await mkdtemp(join(tmpdir(), "ais-update-lock-"));
  dirs.push(home);
  const lock = aisBackupLockPath(home);
  await mkdir(dirname(lock), { recursive: true });
  await writeFile(lock, `${JSON.stringify({ pid: process.pid, token: "t", startedAt: new Date().toISOString() })}\n`);
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    setTimeout(() => void rm(lock, { force: true }), 400);
    await runBackup([], home, join(home, "none.json")).catch(() => undefined);
    expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain(`another backup (pid ${process.pid}) holds`);
  } finally { err.mockRestore(); }
});
