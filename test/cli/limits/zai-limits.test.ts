import { describe, expect, test } from "bun:test";
import { windowsFromZaiQuotaResponse, type ZaiQuotaResponseWire } from "../../../src/cli/limits/zai-limits.ts";

/** Same formatting the adapter itself applies, recomputed here so the
 * assertions pin the epoch-ms->display-string mapping without hardcoding
 * one machine's locale output. */
function expectedResetsAt(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

describe("windowsFromZaiQuotaResponse", () => {
  test("maps the realistic live payload to session, week, and web-tools windows", () => {
    // Verbatim shape confirmed live 2026-07-18 against a real "GLM Coding
    // Max" account on this machine.
    const payload: ZaiQuotaResponseWire = {
      code: 200,
      msg: "Operation successful",
      success: true,
      data: {
        level: "max",
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1, nextResetTime: 1784314903145 },
          { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 1, nextResetTime: 1784866901994 },
          { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 0, nextResetTime: 1786940501978 },
        ],
      },
    };

    const windows = windowsFromZaiQuotaResponse(payload);
    expect(windows).toEqual([
      { label: "session", category: "session", usedPercent: 1, resetsAt: expectedResetsAt(1784314903145) },
      { label: "week", category: "week", usedPercent: 1, resetsAt: expectedResetsAt(1784866901994) },
      { label: "web tools", category: "other", usedPercent: 0, resetsAt: expectedResetsAt(1786940501978) },
    ]);
  });

  test("an unrecognized (type, unit, number) combination is skipped rather than guessed at", () => {
    const payload: ZaiQuotaResponseWire = {
      data: { limits: [{ type: "TOKENS_LIMIT", unit: 99, number: 99, percentage: 50, nextResetTime: 123 }] },
    };
    expect(windowsFromZaiQuotaResponse(payload)).toEqual([]);
  });

  test("an entry with no numeric percentage is skipped", () => {
    const payload: ZaiQuotaResponseWire = {
      data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, nextResetTime: 123 }] },
    };
    expect(windowsFromZaiQuotaResponse(payload)).toEqual([]);
  });

  test("percentage above 100 or below 0 is clamped", () => {
    const payload: ZaiQuotaResponseWire = {
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 150 },
          { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: -5 },
        ],
      },
    };
    const windows = windowsFromZaiQuotaResponse(payload);
    expect(windows[0]?.usedPercent).toBe(100);
    expect(windows[1]?.usedPercent).toBe(0);
  });

  test("an empty payload yields no windows", () => {
    expect(windowsFromZaiQuotaResponse({})).toEqual([]);
  });
});
