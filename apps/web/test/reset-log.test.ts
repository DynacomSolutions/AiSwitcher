import { describe, expect, test } from "bun:test";
import {
  afterView,
  EMPTY_RESET_LOG_FILTERS,
  hasResetLogFilters,
  isIsoDate,
  needsCanonicalSearch,
  percentText,
  readResetLogFilters,
  resetLogPath,
  resetLogRequest,
  resetLogSearch,
  windowName,
  withResetLogFilter,
} from "../src/lib/reset-log.ts";

const url = (search: string) => new URLSearchParams(search);

describe("reset log filters in the URL", () => {
  test("a plain address means no filter", () => {
    expect(readResetLogFilters(url(""))).toEqual(EMPTY_RESET_LOG_FILTERS);
    expect(hasResetLogFilters(readResetLogFilters(url("")))).toBe(false);
    expect(needsCanonicalSearch(url(""))).toBe(false);
  });

  test("the URL alone reproduces the view and the request", () => {
    const search = "identity=SYNTHETIC_FIXTURE-member-a&provider=claude&trigger=auto&outcome=error&from=2026-11-01&to=2026-11-28";
    const filters = readResetLogFilters(url(search));
    expect(filters).toEqual({ identity: "SYNTHETIC_FIXTURE-member-a", provider: "claude", trigger: "auto", outcome: "error", from: "2026-11-01", to: "2026-11-28" });
    expect(resetLogSearch(filters).toString()).toBe(search);
    expect(needsCanonicalSearch(url(search))).toBe(false);
    expect(resetLogRequest(filters)).toEqual({ limit: 50, identity: "SYNTHETIC_FIXTURE-member-a", provider: "claude", trigger: "auto", outcome: "error", from: "2026-11-01", to: "2026-11-28" });
  });

  test("an invalid or unknown value is dropped, and the address is corrected", () => {
    const search = "provider=grok&trigger=sometimes&outcome=maybe&from=2026-02-30&to=yesterday&identity=%20&junk=1&outcome=error";
    expect(readResetLogFilters(url(search))).toEqual(EMPTY_RESET_LOG_FILTERS);
    expect(needsCanonicalSearch(url(search))).toBe(true);
    expect(resetLogSearch(readResetLogFilters(url("provider=codex&trigger=nope"))).toString()).toBe("provider=codex");
  });

  test("keys are written in a fixed order", () => {
    const params = url("to=2026-11-28&provider=codex&identity=a");
    expect(needsCanonicalSearch(params)).toBe(true);
    expect(resetLogSearch(readResetLogFilters(params)).toString()).toBe("identity=a&provider=codex&to=2026-11-28");
  });

  test("changing one filter keeps the others and an empty value removes the key", () => {
    const before = url("identity=a&provider=codex");
    expect(withResetLogFilter(before, "outcome", "reset").toString()).toBe("identity=a&provider=codex&outcome=reset");
    expect(withResetLogFilter(before, "provider", "").toString()).toBe("identity=a");
    expect(withResetLogFilter(before, "trigger", "bogus").toString()).toBe("identity=a&provider=codex");
  });

  test("a date must be a real calendar day", () => {
    expect(isIsoDate("2026-11-28")).toBe(true);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("28-11-2026")).toBe(false);
    expect(isIsoDate("")).toBe(false);
  });

  test("the cursor goes into the request of the next page", () => {
    expect(resetLogRequest(EMPTY_RESET_LOG_FILTERS, "SYNTHETIC_FIXTURE-cursor", 20)).toEqual({ limit: 20, before: "SYNTHETIC_FIXTURE-cursor" });
  });

  test("the link from the Limits page filters by identity and encodes the name", () => {
    expect(resetLogPath("SYNTHETIC_FIXTURE-member-a")).toBe("/logs/resets?identity=SYNTHETIC_FIXTURE-member-a");
    expect(resetLogPath("a b&c")).toBe("/logs/resets?identity=a+b%26c");
    expect(readResetLogFilters(url(resetLogPath("a b&c").split("?")[1]!)).identity).toBe("a b&c");
    expect(resetLogPath()).toBe("/logs/resets");
  });
});

describe("reset log row text", () => {
  test("a window shows its label, else a readable key", () => {
    expect(windowName({ key: "five_hour", label: null })).toBe("5-hour");
    expect(windowName({ key: "weekly_opus", label: null })).toBe("Weekly Opus");
    expect(windowName({ key: "weekly_fable", label: null })).toBe("Weekly fable");
    expect(windowName({ key: "weekly", label: "week (all)" })).toBe("week (all)");
  });

  test("a percentage keeps one decimal at most and is never clamped or invented", () => {
    expect(percentText(62)).toBe("62%");
    expect(percentText(62.46)).toBe("62.5%");
    expect(percentText(0)).toBe("0%");
    expect(percentText(104)).toBe("104%");
    expect(percentText(Number.NaN)).toBe("unknown");
  });

  test("only a reset that worked waits for the next reading", () => {
    const windows = [{ key: "weekly", label: null, percent: 3, resetsAt: null }];
    expect(afterView({ outcome: "reset", after: null, afterAt: null })).toEqual({ kind: "waiting" });
    expect(afterView({ outcome: "error", after: null, afterAt: null })).toEqual({ kind: "none" });
    expect(afterView({ outcome: "no_credit", after: null, afterAt: null })).toEqual({ kind: "none" });
    expect(afterView({ outcome: "reset", after: windows, afterAt: "2026-11-28T01:00:00Z" })).toEqual({ kind: "windows", windows, at: "2026-11-28T01:00:00Z" });
  });
});
