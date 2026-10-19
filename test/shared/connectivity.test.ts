import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedOnline, isOnline, offlineWarning } from "../../src/shared/connectivity";

let cachePath = "";
beforeEach(() => {
  cachePath = join(mkdtempSync(join(tmpdir(), "ais-conn-")), "online.json");
});

test("any HTTP response counts as online", async () => {
  expect(await isOnline({ probe: async () => true, cachePath })).toBe(true);
});
test("probe rejection or false means offline", async () => {
  expect(await isOnline({ probe: async () => { throw new Error("net"); }, cachePath })).toBe(false);
});
test("online result is cached for 60s", async () => {
  let calls = 0; let t = 0;
  const deps = { probe: async () => (calls++, true), now: () => t, cachePath };
  await isOnline(deps); t = 59_999; await isOnline(deps);
  expect(calls).toBe(1);
  t = 60_001; await isOnline(deps);
  expect(calls).toBe(2);
});
test("offline result is re-probed after 5s", async () => {
  let calls = 0; let t = 0;
  const deps = { probe: async () => (calls++, false), now: () => t, cachePath };
  await isOnline(deps); t = 4_999; await isOnline(deps);
  expect(calls).toBe(1);
  t = 5_001; await isOnline(deps);
  expect(calls).toBe(2);
});
test("unwritable or corrupt cache never throws and still probes", async () => {
  await Bun.write(cachePath, "not json");
  expect(await isOnline({ probe: async () => true, cachePath })).toBe(true);
  expect(await isOnline({ probe: async () => true, cachePath: "/proc/nope/online.json" })).toBe(true);
});
test("AIS_ONLINE_PROBE_URL overrides the default URL", async () => {
  let seen = "";
  await isOnline({ probe: async (u) => ((seen = u), true), env: { AIS_ONLINE_PROBE_URL: "http://localhost:1/x" }, cachePath });
  expect(seen).toBe("http://localhost:1/x");
});
test("cachedOnline never probes and returns undefined on miss, corrupt file or entry older than 120s", async () => {
  expect(cachedOnline({ cachePath })).toBeUndefined();
  await Bun.write(cachePath, JSON.stringify({ at: 0, online: false }));
  expect(cachedOnline({ cachePath, now: () => 119_000 })).toBe(false);
  expect(cachedOnline({ cachePath, now: () => 121_000 })).toBeUndefined();
  await Bun.write(cachePath, "not json");
  expect(cachedOnline({ cachePath })).toBeUndefined();
});
test("offlineWarning names the subject and points at the local model only when one exists", () => {
  expect(offlineWarning("claude", false)).toContain("claude");
  expect(offlineWarning("claude", false)).not.toContain("ais local");
  expect(offlineWarning("claude", true)).toContain("ais local start");
});
