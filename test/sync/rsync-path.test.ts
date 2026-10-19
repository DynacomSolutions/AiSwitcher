import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRsyncArgs, REMOTE_LOW_PRIORITY } from "../../src/sync/rsync.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

test("the generated --rsync-path runs rsync with the server args appended, under a POSIX shell", async () => {
  const bin = await mkdtemp(join(tmpdir(), "ais-rsync-path-"));
  dirs.push(bin);
  await Bun.write(join(bin, "rsync"), '#!/bin/sh\nprintf "ran:%s|" "$@"\n');
  await chmod(join(bin, "rsync"), 0o755);

  const arg = buildRsyncArgs("example-host", "pull", []).find((a) => a.startsWith("--rsync-path="))!;
  expect(arg).toBe(`--rsync-path=${REMOTE_LOW_PRIORITY} rsync`);
  const remoteCommand = `${arg.slice("--rsync-path=".length)} --server --sender -vlogDtpre.iLsfxCIvu . 'a b'`;
  const proc = Bun.spawn(["sh", "-c", remoteCommand], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out).toBe("ran:--server|ran:--sender|ran:-vlogDtpre.iLsfxCIvu|ran:.|ran:a b|");
});

test("a failing ionice does not stop the command from running", async () => {
  const bin = await mkdtemp(join(tmpdir(), "ais-rsync-path-"));
  dirs.push(bin);
  await Bun.write(join(bin, "rsync"), '#!/bin/sh\nprintf "ran:%s|" "$@"\n');
  await Bun.write(join(bin, "ionice"), "#!/bin/sh\nexit 1\n");
  await chmod(join(bin, "rsync"), 0o755);
  await chmod(join(bin, "ionice"), 0o755);
  const proc = Bun.spawn(["sh", "-c", `${REMOTE_LOW_PRIORITY} rsync --server .`], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await new Response(proc.stdout).text()).toBe("ran:--server|ran:.|");
  expect(await proc.exited).toBe(0);
});
