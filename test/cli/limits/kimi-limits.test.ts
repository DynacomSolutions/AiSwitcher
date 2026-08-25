import { describe, expect, test } from "bun:test";
import {
  overageFromBoosterWallet,
  windowsFromUsagesResponse,
  type KimiBoosterWalletWire,
  type KimiUsagesResponseWire,
} from "../../../src/cli/limits/kimi-limits.ts";

/** Same formatting the adapter itself applies, recomputed here so the
 * assertions pin the ISO->display-string mapping without hardcoding one
 * machine's locale output. */
function expectedResetsAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

describe("windowsFromUsagesResponse", () => {
  test("maps the realistic live payload to a session window plus a week window", () => {
    // Verbatim shape of the response confirmed live 2026-07-17 against the
    // real account on this machine (numeric counters as STRINGS).
    const payload: KimiUsagesResponseWire = {
      user: { membership: { level: "LEVEL_STANDARD" } },
      usage: { limit: "100", remaining: "100", resetTime: "2026-07-24T03:31:45.259929Z" },
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "100", used: "1", remaining: "99", resetTime: "2026-07-17T08:31:45.259929Z" },
        },
      ],
    };

    const windows = windowsFromUsagesResponse(payload);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toEqual({
      label: "session",
      category: "session",
      usedPercent: 1,
      resetsAt: expectedResetsAt("2026-07-17T08:31:45.259929Z"),
    });
    expect(windows[1]).toEqual({
      label: "week",
      category: "week",
      usedPercent: 0,
      resetsAt: expectedResetsAt("2026-07-24T03:31:45.259929Z"),
    });
  });

  test("a usage block identical in usedPercent and resetTime to a listed window is not duplicated", () => {
    const payload: KimiUsagesResponseWire = {
      usage: { limit: "100", remaining: "99", resetTime: "2026-07-17T08:31:45.259929Z" },
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "100", used: "1", remaining: "99", resetTime: "2026-07-17T08:31:45.259929Z" },
        },
      ],
    };

    const windows = windowsFromUsagesResponse(payload);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.category).toBe("session");
  });

  test("entries with a zero limit or non-numeric remaining are skipped", () => {
    const payload: KimiUsagesResponseWire = {
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "0", used: "0", remaining: "0", resetTime: "2026-07-17T08:31:45.259929Z" },
        },
        {
          window: { duration: 60, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "100", used: "1", remaining: "not-a-number", resetTime: "2026-07-17T09:31:45.259929Z" },
        },
      ],
    };

    expect(windowsFromUsagesResponse(payload)).toEqual([]);
  });

  test("an empty payload yields no windows", () => {
    expect(windowsFromUsagesResponse({})).toEqual([]);
  });

  test("a fully-exhausted session window with no `remaining` field falls back to used/limit", () => {
    // Verbatim shape confirmed live 2026-07-20 against a real account whose
    // 5h session window was fully used: `remaining` is omitted entirely
    // (not reported as "0") once the window is exhausted.
    const payload: KimiUsagesResponseWire = {
      usage: { limit: "100", used: "26", remaining: "74", resetTime: "2026-07-24T03:31:45.259929Z" },
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "100", used: "100", resetTime: "2026-07-20T11:31:45.259929Z" },
        },
      ],
    };

    const windows = windowsFromUsagesResponse(payload);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toEqual({
      label: "session",
      category: "session",
      usedPercent: 100,
      resetsAt: expectedResetsAt("2026-07-20T11:31:45.259929Z"),
    });
    expect(windows[1]).toEqual({
      label: "week",
      category: "week",
      usedPercent: 26,
      resetsAt: expectedResetsAt("2026-07-24T03:31:45.259929Z"),
    });
  });
});

describe("overageFromBoosterWallet", () => {
  test("no monthlyUsed field at all yields undefined (never used Extra Usage)", () => {
    expect(overageFromBoosterWallet(undefined)).toBeUndefined();
    expect(overageFromBoosterWallet({})).toBeUndefined();
  });

  test("zero spent this month is reported inactive, not undefined", () => {
    const wallet: KimiBoosterWalletWire = { monthlyUsed: { priceInCents: 0, currency: "USD" } };
    expect(overageFromBoosterWallet(wallet)).toEqual({
      active: false,
      label: "no extra usage this month",
      spentUsd: 0,
    });
  });

  test("real spend with a configured cap includes both dollar figures in the label", () => {
    const wallet: KimiBoosterWalletWire = {
      monthlyChargeLimitEnabled: true,
      monthlyChargeLimit: { priceInCents: 2000, currency: "USD" },
      monthlyUsed: { priceInCents: 420, currency: "USD" },
    };
    expect(overageFromBoosterWallet(wallet)).toEqual({
      active: true,
      label: "extra usage: $4.20 of $20.00 cap this month",
      spentUsd: 4.2,
      limitUsd: 20,
    });
  });

  test("real spend with no configured cap omits the cap from the label and result", () => {
    const wallet: KimiBoosterWalletWire = { monthlyUsed: { priceInCents: 150, currency: "USD" } };
    const result = overageFromBoosterWallet(wallet);
    expect(result).toEqual({ active: true, label: "extra usage: $1.50 this month", spentUsd: 1.5 });
    expect(result).not.toHaveProperty("limitUsd");
  });

  test("a non-numeric monthlyUsed is skipped rather than guessed at", () => {
    const wallet = { monthlyUsed: { priceInCents: "not-a-number" } } as unknown as KimiBoosterWalletWire;
    expect(overageFromBoosterWallet(wallet)).toBeUndefined();
  });
});
