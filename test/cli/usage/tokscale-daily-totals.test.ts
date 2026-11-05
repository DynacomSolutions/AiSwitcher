import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dailyUsageFromHourlyEntries,
  dailyUsageFromNativeMessages,
  hourlyEntriesFromNativeMessages,
  tokscalePinnedZone,
  mergeDailyTotals,
  readTokscaleBucketTimezone,
} from "../../../src/cli/usage/tokscale.ts";
import nativeExport from "../../fixtures/tokscale-native-daily/export.json";
import hourlyReport from "../../fixtures/tokscale-native-daily/hourly.json";

describe("exact per-day totals", () => {
  test("hourly buckets roll up per local day with every field", () => {
    const daily = dailyUsageFromHourlyEntries([
      { hour: "2026-11-01 01:00", input: 1, output: 2, cacheRead: 3, cacheWrite: 4, messageCount: 5, cost: 0.5 },
      { hour: "2026-11-01 23:00", input: 10, output: 20, cacheRead: 30, cacheWrite: 40, messageCount: 50, cost: 1.5 },
      { hour: "2026-11-02 00:00", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, messageCount: 1, cost: 2 },
    ]);
    expect(daily?.totals["2026-11-01"]).toEqual([11, 22, 33, 44, 55, 2]);
    expect(daily?.totals["2026-11-02"]).toEqual([1, 1, 0, 0, 1, 2]);
    expect(daily?.daily["2026-11-01"]).toBe(33);
  });

  test("merging adds days and keeps unmatched ones", () => {
    const merged = mergeDailyTotals({ a: [1, 1, 1, 1, 1, 1] }, { a: [1, 1, 1, 1, 1, 1], b: [2, 0, 0, 0, 0, 0] });
    expect(merged).toEqual({ a: [2, 2, 2, 2, 2, 2], b: [2, 0, 0, 0, 0, 0] });
  });
});

describe("daily usage from an AIS native export", () => {
  const message = (overrides: Record<string, unknown>) => ({
    client: "claude", session_id: "s", dedup_key: "m:r", timestamp: Date.UTC(2026, 10, 1, 10, 30), date: "2026-11-01",
    tokens: { input: 1, output: 2, cache_read: 3, cache_write: 4, cache_write_1h: 0, reasoning: 0 },
    cost: 0.25, message_count: 1, ...overrides,
  });

  // Fixture (generate.ts): synthetic Claude transcripts with duplicate
  // messages, the local recovery overlay (untimestamped request rows and
  // daily floors) and the America/New_York DST change, bucketed in that zone.
  // export.json and hourly.json both come from the AIS-patched Tokscale
  // 4.20.0 binary, with one config dir.
  test("equals the rollup of Tokscale's hourly report for the same transcripts", () => {
    const derived = dailyUsageFromNativeMessages(nativeExport.messages, "America/New_York");
    expect(derived).toEqual(dailyUsageFromHourlyEntries(hourlyReport.entries)!);
    expect(hourlyEntriesFromNativeMessages(nativeExport.messages, "America/New_York").map(({ hour, input, output, cacheRead, cacheWrite, messageCount, cost }) => ({ hour, input, output, cacheRead, cacheWrite, messageCount, cost })))
      .toEqual(hourlyReport.entries.map(({ hour, input, output, cacheRead, cacheWrite, messageCount, cost }) => ({ hour, input, output, cacheRead, cacheWrite, messageCount, cost })));
  });

  test("keys hours in the pinned zone, including non-hour offsets", () => {
    const at = Date.UTC(2026, 10, 1, 18, 20);
    expect(hourlyEntriesFromNativeMessages([message({ timestamp: at })], "Asia/Bangkok")[0]?.hour).toBe("2026-11-02 01:00");
    expect(hourlyEntriesFromNativeMessages([message({ timestamp: at })], "Asia/Kathmandu")[0]?.hour).toBe("2026-11-02 00:00");
    expect(hourlyEntriesFromNativeMessages([message({ timestamp: at })], "UTC")[0]?.hour).toBe("2026-11-01 18:00");
  });

  test("the fixture really covers recovery rows, untimestamped rows and the DST hour", () => {
    const keys = nativeExport.messages.map((m) => m.dedup_key ?? "");
    expect(keys.some((k) => k.startsWith("local-recovery:daily:"))).toBe(true);
    expect(nativeExport.messages.some((m) => m.timestamp === 0 && !String(m.dedup_key).startsWith("local-recovery:daily:"))).toBe(true);
    // 01:00 EDT and 01:00 EST share one New York hour key.
    const repeated = nativeExport.messages.filter((m) => m.timestamp >= Date.UTC(2026, 10, 1, 5) && m.timestamp < Date.UTC(2026, 10, 1, 7));
    expect(new Set(repeated.map((m) => m.timestamp >= Date.UTC(2026, 10, 1, 6)))).toEqual(new Set([false, true]));
    expect(hourlyEntriesFromNativeMessages(repeated, "America/New_York").map((e) => e.hour)).toEqual(["2026-11-01 01:00"]);
  });

  test("zone names follow chrono-tz: exact IANA names and links, anything else is local time", () => {
    const at = Date.UTC(2026, 10, 1, 18, 20);
    const local = hourlyEntriesFromNativeMessages([message({ timestamp: at })]);
    for (const rejected of ["Not/AZone", "asia/bangkok", "ASIA/BANGKOK", "+07:00", "UTC+7", "GMT+7", "Etc/GMT+07", ""]) {
      expect(tokscalePinnedZone(rejected)).toBeUndefined();
      expect(hourlyEntriesFromNativeMessages([message({ timestamp: at })], rejected)).toEqual(local);
    }
    expect(tokscalePinnedZone(" Asia/Bangkok ")).toBe("Asia/Bangkok");
    expect(tokscalePinnedZone("US/Eastern")).toBe("US/Eastern");
    expect(tokscalePinnedZone("Etc/GMT-7")).toBe("Etc/GMT-7");
    expect(tokscalePinnedZone("UTC")).toBe("UTC");
    expect(hourlyEntriesFromNativeMessages([message({ timestamp: at })], "US/Eastern")[0]?.hour).toBe("2026-11-01 13:00");
  });

  test("skips recovery daily rows and undated balances, and keys timestamp-less rows by date", () => {
    const entries = hourlyEntriesFromNativeMessages([
      message({}),
      message({ session_id: "local-recovery:daily:x", dedup_key: "local-recovery:daily:x" }),
      message({ timestamp: 0, date: "unknown" }),
      message({ timestamp: 0, date: "2026-10-30", message_count: undefined }),
      message({ message_count: -3, cost: 0.5 }),
    ], "UTC");
    expect(entries).toEqual([
      { hour: "2026-10-30 00:00", input: 1, output: 2, cacheRead: 3, cacheWrite: 4, messageCount: 1, cost: 0.25 },
      { hour: "2026-11-01 10:00", input: 2, output: 4, cacheRead: 6, cacheWrite: 8, messageCount: 1, cost: 0.75 },
    ]);
  });

  test("an export with no dated messages has no daily usage", () => {
    expect(dailyUsageFromNativeMessages([], "UTC")).toBeUndefined();
    expect(dailyUsageFromNativeMessages([message({ timestamp: 0, date: "unknown" })], "UTC")).toBeUndefined();
  });

  test("reads the bucket timezone Tokscale pinned in its settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ais-tokscale-settings-"));
    try {
      expect(readTokscaleBucketTimezone(dir)).toBeUndefined();
      await writeFile(join(dir, "settings.json"), JSON.stringify({ scanner: { bucketTimezone: "Asia/Bangkok" } }));
      expect(readTokscaleBucketTimezone(dir)).toBe("Asia/Bangkok");
      await writeFile(join(dir, "settings.json"), "{not json");
      expect(readTokscaleBucketTimezone(dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
