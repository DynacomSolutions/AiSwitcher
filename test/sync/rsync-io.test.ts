import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRsyncArgs } from "../../src/sync/rsync.ts";

const rsync = Bun.which("rsync");
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Local analogue of a staged pull with compareDest: drop the transport and host. */
function localArgs(source: string, incoming: string, extra: string[] = []): string[] {
  const args = buildRsyncArgs("example-host", "pull", [], source, { localRoot: incoming, compareDest: "../../../.." });
  const kept: string[] = [];
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === "-e") i++;
    else if (!args[i]!.startsWith("--rsync-path=")) kept.push(args[i]!);
  }
  return [...kept, ...extra, `${source}/`, `${incoming}/`];
}

async function rchar(args: string[]): Promise<number> {
  const quoted = args.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" ");
  const proc = Bun.spawn(["sh", "-c", `${rsync} ${quoted}; cat /proc/$$/io`], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return Number(/^rchar: (\d+)/m.exec(out)![1]);
}

test.skipIf(process.platform !== "linux" || !rsync)("an unchanged staged pull reads almost nothing; --checksum would read the tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "ais-rsync-io-"));
  dirs.push(root);
  // incoming = <home>/.ais/remote-cache/profile-incoming/<id>, so ../../../.. is home.
  const home = join(root, "home");
  const incoming = join(home, ".ais", "remote-cache", "profile-incoming", "snap");
  await mkdir(incoming, { recursive: true });
  const chunk = Buffer.alloc(100_000, 7);
  let treeBytes = 0;
  for (let d = 0; d < 10; d++) {
    await mkdir(join(home, "data", `d${d}`), { recursive: true });
    for (let f = 0; f < 20; f++) {
      await Bun.write(join(home, "data", `d${d}`, `f${f}.bin`), chunk);
      treeBytes += chunk.length;
    }
  }
  expect(treeBytes).toBeGreaterThanOrEqual(20_000_000);

  // The "remote" source is a copy of the live home with identical size and mtime.
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  await Bun.spawn(["cp", "-a", join(home, "data"), source]).exited;

  const filtered = (extra: string[] = []) => localArgs(source, incoming, extra);
  const quick = await rchar(filtered());
  expect(quick).toBeLessThan(treeBytes * 0.01);
  expect((await readdir(incoming, { recursive: true })).filter((p) => p.endsWith(".bin"))).toEqual([]);

  expect(await rchar(filtered(["--checksum"]))).toBeGreaterThanOrEqual(treeBytes);
});
