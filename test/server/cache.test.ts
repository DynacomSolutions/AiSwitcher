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

describe("PollCache.getSwr", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("first request waits for the scan and propagates failure", async () => {
    const cache = new PollCache(60_000);
    const ok = await cache.getSwr("k", async () => "v1");
    expect(ok).toEqual({ value: "v1", cached: false, stale: false });
    const cold = new PollCache(60_000);
    await expect(cold.getSwr("k", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });

  test("serves a stale value immediately and starts a single refresh", async () => {
    const cache = new PollCache(60_000);
    await cache.getSwr("k", async () => "old", 5);
    await sleep(15);
    let calls = 0;
    let release!: (v: string) => void;
    const gate = new Promise<string>((r) => (release = r));
    const fetcher = () => {
      calls += 1;
      return gate;
    };
    const a = await cache.getSwr("k", fetcher, 5);
    const b = await cache.getSwr("k", fetcher, 5);
    expect(a).toMatchObject({ value: "old", cached: true, stale: true });
    expect(b.stale).toBe(true);
    expect(calls).toBe(1);
    release("new");
    await sleep(5);
    const c = await cache.getSwr("k", fetcher, 60_000);
    expect(c).toEqual({ value: "new", cached: true, stale: false });
  });

  test("a failed refresh keeps the last-good value and exposes the error", async () => {
    const cache = new PollCache(60_000);
    await cache.getSwr("k", async () => "good", 5);
    await sleep(15);
    const failing = async (): Promise<string> => {
      throw new Error("scan timed out");
    };
    const stale = await cache.getSwr("k", failing, 5);
    expect(stale.value).toBe("good");
    await sleep(5);
    const after = await cache.getSwr("k", failing, 5);
    expect(after.value).toBe("good");
    expect(after.lastError).toBe("scan timed out");
    expect(typeof after.lastErrorAt).toBe("number");
    await sleep(5);
    await cache.getSwr("k", async () => "fresh", 5);
    await sleep(5);
    const healed = await cache.getSwr("k", async () => "fresh", 60_000);
    expect(healed.value).toBe("fresh");
    expect(healed.lastError).toBeUndefined();
  });
});
