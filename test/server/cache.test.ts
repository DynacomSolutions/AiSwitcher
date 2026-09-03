import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PollCache, flagsFor } from "../../src/server/expensive.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("PollCache", () => {
  test("serves repeat reads from cache inside the TTL", async () => {
    const cache = new PollCache(60_000);
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return { n: calls };
    };
    const first = await cache.get("k", fetcher);
    const second = await cache.get("k", fetcher);
    expect(calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.value).toEqual({ n: 1 });
  });

  test("a maxAge of zero always refetches", async () => {
    const cache = new PollCache(60_000);
    let calls = 0;
    const fetcher = async () => ({ n: (calls += 1) });
    await cache.get("k", fetcher, 0);
    await cache.get("k", fetcher, 0);
    expect(calls).toBe(2);
  });

  test("concurrent callers share one in-flight fetch", async () => {
    const cache = new PollCache(0);
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      await Bun.sleep(20);
      return { n: calls };
    };
    const [a, b] = await Promise.all([cache.get("k", fetcher), cache.get("k", fetcher)]);
    expect(calls).toBe(1);
    expect(a.value).toEqual(b.value);
  });

  test("a failed fetch clears the in-flight slot so a retry can happen", async () => {
    const cache = new PollCache(60_000);
    let attempts = 0;
    const flaky = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("boom");
      return "recovered";
    };
    await expect(cache.get("k", flaky)).rejects.toThrow("boom");
    const retry = await cache.get("k", flaky);
    expect(retry.value).toBe("recovered");
  });
});

describe("flagsFor", () => {
  test("maps query params onto the CLI flag shape the collectors read", () => {
    expect(flagsFor(undefined, undefined)).toEqual({});
    expect(flagsFor("zai", undefined)).toEqual({ tool: "zai" });
    expect(flagsFor("zai", "work")).toEqual({ tool: "zai", identity: "work" });
  });
});
