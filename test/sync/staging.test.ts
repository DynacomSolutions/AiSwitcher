import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aisRemoteCacheDir } from "../../src/shared/ais-home.ts";
import { CONFLICT_MAX_AGE_MS, STAGING_MAX_AGE_MS, pruneStaging } from "../../src/sync/staging.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

test("prunes by ctime: staging past 6 hours, merge-conflicts past 30 days, never dedupe-backups", async () => {
  const home = await mkdtemp(join(tmpdir(), "ais-prune-"));
  dirs.push(home);
  const root = aisRemoteCacheDir(home);
  const make = async (rel: string) => {
    await mkdir(join(root, rel), { recursive: true });
    return (await stat(join(root, rel))).ctimeMs;
  };
  const staged = ["profile-incoming/a", "profile-incoming/busy", "sqlite-incoming/a", "sqlite-snapshots/a"];
  const base = Math.max(...(await Promise.all(staged.map(make))));
  const conflict = await make("merge-conflicts/a");
  await make("dedupe-backups/ancient");

  await pruneStaging({ home, now: base + STAGING_MAX_AGE_MS - 1000 });
  expect((await readdir(join(root, "profile-incoming"))).sort()).toEqual(["a", "busy"]);

  await pruneStaging({ home, now: base + STAGING_MAX_AGE_MS + 1000, keep: "busy" });
  expect(await readdir(join(root, "profile-incoming"))).toEqual(["busy"]);
  expect(await readdir(join(root, "sqlite-incoming"))).toEqual([]);
  expect(await readdir(join(root, "sqlite-snapshots"))).toEqual([]);
  expect(await readdir(join(root, "merge-conflicts"))).toEqual(["a"]);

  await pruneStaging({ home, now: conflict + CONFLICT_MAX_AGE_MS - 1000 });
  expect(await readdir(join(root, "merge-conflicts"))).toEqual(["a"]);
  await pruneStaging({ home, now: conflict + CONFLICT_MAX_AGE_MS + 1000 });
  expect(await readdir(join(root, "merge-conflicts"))).toEqual([]);
  expect(await readdir(join(root, "dedupe-backups"))).toEqual(["ancient"]);
});

test.skipIf(!Bun.which("rsync"))("a root freshly staged by rsync -a from an old-mtime source survives", async () => {
  const home = await mkdtemp(join(tmpdir(), "ais-prune-rsync-"));
  dirs.push(home);
  const src = join(home, "src");
  await mkdir(src, { recursive: true });
  await Bun.write(join(src, "f"), "x");
  const old = new Date(Date.now() - STAGING_MAX_AGE_MS - 3_600_000);
  await utimes(src, old, old);
  const staged = join(aisRemoteCacheDir(home), "profile-incoming", "fresh");
  await mkdir(join(staged, ".."), { recursive: true });
  await Bun.spawn(["rsync", "-a", `${src}/`, `${staged}/`]).exited;
  await pruneStaging({ home });
  expect(await readdir(join(aisRemoteCacheDir(home), "profile-incoming"))).toEqual(["fresh"]);
});
