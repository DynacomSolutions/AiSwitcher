import { describe, expect, test } from "bun:test";
import { aliExpiredMessage, windowsFromAliUsage, type AliUsageWire } from "../../../src/cli/limits/ali-limits.ts";
import type { RefreshFailureSummary } from "../../../src/server/auth-refresh.ts";

/** Same formatting the adapter itself applies, recomputed here so the
 * assertions pin the epoch-ms->display-string mapping without hardcoding
 * one machine's locale output. */
function expectedResetsAt(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

describe("windowsFromAliUsage", () => {
  test("maps the realistic live payload (0-1 fractions) to session and week windows", () => {
    // Verbatim shape from CodexBar's own confirmed live fixture for this
    // endpoint — percentages are 0-1 FRACTIONS, unlike zai's 0-100 points.
    const wire: AliUsageWire = {
      per5HourPercentage: 0.0009973083333333333,
      per5HourResetTime: 1784813220000,
      per1WeekPercentage: 0.0003014725,
      per1WeekResetTime: 1785234900000,
    };

    const windows = windowsFromAliUsage(wire);
    expect(windows).toEqual([
      {
        label: "session (5h)",
        category: "session",
        usedPercent: 0.09973083333333333,
        resetsAt: expectedResetsAt(1784813220000),
      },
      { label: "week", category: "week", usedPercent: 0.03014725, resetsAt: expectedResetsAt(1785234900000) },
    ]);
  });

  test("a fraction above 1 or below 0 is clamped to the 0-100 point range", () => {
    const wire: AliUsageWire = { per5HourPercentage: 1.5, per1WeekPercentage: -0.2 };
    const windows = windowsFromAliUsage(wire);
    expect(windows[0]?.usedPercent).toBe(100);
    expect(windows[1]?.usedPercent).toBe(0);
  });

  test("a missing reset time yields a window with no resetsAt", () => {
    const windows = windowsFromAliUsage({ per5HourPercentage: 0.5 });
    expect(windows).toEqual([{ label: "session (5h)", category: "session", usedPercent: 50, resetsAt: undefined }]);
  });

  test("a window with no numeric fraction is skipped rather than guessed at", () => {
    const windows = windowsFromAliUsage({ per5HourResetTime: 123 });
    expect(windows).toEqual([]);
  });

  test("an empty payload yields no windows", () => {
    expect(windowsFromAliUsage({})).toEqual([]);
  });
});

describe("aliExpiredMessage", () => {
  test("without a failure record, the classic self-serve message stands alone", () => {
    expect(aliExpiredMessage(undefined)).toBe(
      "console session expired — replace console-cookie.txt with a fresh Alibaba Cloud console Cookie header",
    );
  });

  test("with a failed refresh on record, the message says when and why the automation is not saving you", () => {
    const failure: RefreshFailureSummary = {
      lastAttemptAt: "2026-09-10T01:38:14.927Z",
      lastError:
        "the auth browser for \"personal\" is not signed in to the Alibaba console (no login-ticket cookie after opening the console page)",
      consecutiveFailures: 41,
    };
    const message = aliExpiredMessage(failure);
    expect(message).toContain("console session expired");
    expect(message).toContain("(last refresh attempt 2026-09-10T01:38:14.927Z:");
    expect(message).toContain("no login-ticket cookie");
  });
});
