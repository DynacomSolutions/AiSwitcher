import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedOnline, shimOfflineNotice } from "../../src/shared/connectivity.ts";

test("cached offline yields the warning text", () => {
  expect(shimOfflineNotice({ cached: () => false })).toContain("No internet connection");
});

test("cached online, cache miss and stale entry yield nothing", () => {
  for (const v of [true, undefined]) expect(shimOfflineNotice({ cached: () => v })).toBeUndefined();
});

test("the notice path never probes and stays inside the shim latency budget", () => {
  const cachePath = join(mkdtempSync(join(tmpdir(), "ais-shim-")), "online.json");
  const at = 1_000_000;
  writeFileSync(cachePath, JSON.stringify({ at, online: false }));
  const t0 = performance.now();
  const text = shimOfflineNotice({ cached: () => cachedOnline({ cachePath, now: () => at + 1 }) });
  expect(text).toBeDefined();
  expect(performance.now() - t0).toBeLessThan(20);
});

test("a stale offline entry yields nothing", () => {
  const cachePath = join(mkdtempSync(join(tmpdir(), "ais-shim-")), "online.json");
  writeFileSync(cachePath, JSON.stringify({ at: 0, online: false }));
  expect(shimOfflineNotice({ cached: () => cachedOnline({ cachePath, now: () => 10 * 60_000 }) })).toBeUndefined();
});

test("a missing or corrupt cache file never throws", () => {
  expect(shimOfflineNotice({ cached: () => cachedOnline({ cachePath: "/nonexistent/online.json" }) })).toBeUndefined();
  const cachePath = join(mkdtempSync(join(tmpdir(), "ais-shim-")), "online.json");
  writeFileSync(cachePath, "{not json");
  expect(shimOfflineNotice({ cached: () => cachedOnline({ cachePath }) })).toBeUndefined();
});
