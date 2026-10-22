import { afterEach, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUpdate } from "../../src/cli/update.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function shims(version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-update-shims-"));
  dirs.push(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "ais"), `#!/bin/sh\necho ${version}\n`);
  await chmod(join(dir, "ais"), 0o755);
  return dir;
}

test("a failed backup aborts with a clear error and downloads nothing", async () => {
  const shimDir = await shims("0.0.1");
  const log = spyOn(console, "log").mockImplementation(() => {});
  let fetched = 0;
  try {
    await expect(runUpdate({
      shimDir,
      backup: async () => { throw new Error("disk full"); },
      fetchImpl: (async () => { fetched++; return new Response("x"); }) as unknown as typeof fetch,
    })).rejects.toThrow(/backup failed, so NOTHING was updated: disk full.*--no-backup/);
    expect(fetched).toBe(0);
  } finally { log.mockRestore(); }
});

test("a successful backup is followed by the upgrade, and the new version is reported", async () => {
  const shimDir = await shims("0.0.1");
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runUpdate({
      shimDir,
      backup: async () => "backup-dir",
      fetchImpl: (async () => new Response("#!/bin/sh\necho 9.9.9\n")) as unknown as typeof fetch,
    });
    const lines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toContain("0.0.1 -> 9.9.9");
  } finally { log.mockRestore(); }
});

test("a downloaded binary that does not run is an error, not a silent success", async () => {
  const shimDir = await shims("0.0.1");
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(runUpdate({
      shimDir,
      skipBackup: true,
      fetchImpl: (async () => new Response("not a program")) as unknown as typeof fetch,
    })).rejects.toThrow(/does not run/);
    // The working binary was never replaced.
    expect((await Bun.$`${join(shimDir, "ais")} version`.text()).trim()).toBe("0.0.1");
    expect(await Bun.file(`${join(shimDir, "ais")}.download-tmp`).exists()).toBe(false);
  } finally { log.mockRestore(); }
});
