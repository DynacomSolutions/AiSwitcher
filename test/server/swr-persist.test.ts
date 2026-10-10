import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PollCache } from "../../src/server/expensive.ts";
import { warmUsageCaches } from "../../src/server/workers.ts";

const dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "swr-"));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("PollCache persistence", () => {
  test("round trip: restart serves the disk value stale with one refresh", async () => {
    const dir = await tmp();
    await new PollCache(1000, dir).getSwr("k", async () => ({ n: 1 }));
    const [file] = await readdir(dir);
    expect((await stat(join(dir, file!))).mode & 0o777).toBe(0o600);

    const restarted = new PollCache(1000, dir);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetcher = async () => {
      calls++;
      await gate;
      return { n: 2 };
    };
    const first = await restarted.getSwr("k", fetcher, 0);
    const second = await restarted.getSwr("k", fetcher, 0);
    expect(first.value).toEqual({ n: 1 });
    expect(first.stale).toBe(true);
    expect(second.value).toEqual({ n: 1 });
    expect(calls).toBe(1);
    release();
  });

  test("corrupt file is ignored", async () => {
    const dir = await tmp();
    await new PollCache(1000, dir).getSwr("k", async () => 1);
    const [file] = await readdir(dir);
    await writeFile(join(dir, file!), "{not json");
    const r = await new PollCache(1000, dir).getSwr("k", async () => 2);
    expect(r.value).toBe(2);
  });
});

describe("first request", () => {
  test("answers pending immediately while the fetch keeps running", async () => {
    const cache = new PollCache(1000);
    let resolveFetch!: (v: string) => void;
    const fetcher = () => new Promise<string>((r) => (resolveFetch = r));
    const r = await cache.getSwr("k", fetcher, undefined, { pending: async () => "pending" });
    expect(r.value).toBe("pending");
    resolveFetch("done");
    await Bun.sleep(5);
    const next = await cache.getSwr("k", fetcher);
    expect(next.value).toBe("done");
  });
});

describe("warmUsageCaches", () => {
  test("fires the default usage and breakdown scans once", () => {
    const calls: Array<[string, unknown]> = [];
    const run = (async (kind: string, params: unknown) => {
      calls.push([kind, params]);
      return { ok: true };
    }) as never;
    warmUsageCaches(run);
    warmUsageCaches(run);
    expect(calls).toEqual([["usage", {}], ["breakdown", { days: 30 }]]);
  });
});
