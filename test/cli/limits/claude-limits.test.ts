import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchClaudeLimits, overageFromUsageBody, overageFromUsageText, windowsFromUsageBody } from "../../../src/cli/limits/claude-limits.ts";

describe("overageFromUsageText", () => {
  test("the confirmed-live default intro line reports subscription-only with a confirmed $0 spend, not just a label", () => {
    // Verbatim first line of `claude -p "/usage"`, confirmed live 2026-07-23
    // against a real, fully-authenticated identity on this machine.
    const stdout = [
      "You are currently using your subscription to power your Claude Code usage",
      "",
      "Current session: 6% used · resets Jul 23 at 7:20am (Asia/Bangkok)",
    ].join("\n");
    expect(overageFromUsageText(stdout)).toEqual({ active: false, label: "subscription only", spentUsd: 0 });
  });

  test("'now using extra usage' reports active — confirmed string, not observed live", () => {
    // Confirmed present in the installed claude binary's own UI strings
    // (`strings` on the compiled executable), never triggered live since
    // doing so would spend real money on a real account.
    const stdout = "You're now using extra usage\n\nCurrent session: 40% used";
    expect(overageFromUsageText(stdout)).toEqual({ active: true, label: "using extra usage" });
  });

  test("'out of extra usage' reports inactive with its own label, not confused with the default", () => {
    const stdout = "You're out of extra usage\n\nCurrent session: 100% used";
    expect(overageFromUsageText(stdout)).toEqual({ active: false, label: "out of extra usage" });
  });

  test("a seat without extra usage eligibility is reported distinctly, also with a confirmed $0 spend", () => {
    const stdout = "Your seat type doesn't include extra usage\n\nCurrent session: 12% used";
    expect(overageFromUsageText(stdout)).toEqual({
      active: false,
      label: "extra usage not available on this seat",
      spentUsd: 0,
    });
  });

  test("leading blank lines are skipped when finding the intro sentence", () => {
    const stdout = "\n\n  You are currently using your subscription to power your Claude Code usage\n";
    expect(overageFromUsageText(stdout)).toEqual({ active: false, label: "subscription only", spentUsd: 0 });
  });

  test("unrecognized or empty output yields undefined rather than guessing", () => {
    expect(overageFromUsageText("")).toBeUndefined();
    expect(overageFromUsageText("Some future wording this parser doesn't know about")).toBeUndefined();
  });
});

const LIVE_BODY = {
  five_hour: { utilization: 48.0, resets_at: "2026-10-11T20:10:00.108395+00:00" },
  seven_day: { utilization: 11.0, resets_at: "2026-10-18T15:00:00.108414+00:00" },
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, disabled_reason: null, spend_limit_reached: false },
  limits: [
    { kind: "session", group: "session", percent: 48, resets_at: "2026-10-11T20:10:00.108395+00:00", scope: null, is_active: true },
    { kind: "weekly_all", group: "weekly", percent: 11, resets_at: "2026-10-18T15:00:00.108414+00:00", scope: null },
    { kind: "weekly_scoped", group: "weekly", percent: 0, resets_at: "2026-10-18T15:00:00+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null } },
  ],
};

describe("windowsFromUsageBody", () => {
  test("maps the live limits[] shape", () => {
    const w = windowsFromUsageBody(LIVE_BODY);
    expect(w.map((x) => [x.label, x.category, x.usedPercent])).toEqual([
      ["session (5h)", "session", 48],
      ["week (all)", "week", 11],
      ["week (Fable)", "week", 0],
    ]);
    expect(w[0]!.resetsAtMs).toBe(Date.parse("2026-10-11T20:10:00.108395+00:00"));
    expect(typeof w[0]!.resetsAt).toBe("string");
  });

  test("falls back to five_hour/seven_day without limits[]", () => {
    const { limits: _l, ...rest } = LIVE_BODY;
    expect(windowsFromUsageBody(rest).map((x) => [x.label, x.usedPercent])).toEqual([["session (5h)", 48], ["week (all)", 11]]);
  });

  test("unknown kind uses kind as label; junk yields nothing", () => {
    expect(windowsFromUsageBody({ limits: [{ kind: "monthly_x", percent: 5 }] })[0]!.label).toBe("monthly_x");
    expect(windowsFromUsageBody(null)).toEqual([]);
  });
});

describe("overageFromUsageBody", () => {
  test("covers the four states", () => {
    const sub = { active: false, label: "subscription only", spentUsd: 0 };
    expect(overageFromUsageBody(LIVE_BODY)).toEqual(sub);
    expect(overageFromUsageBody({ extra_usage: { is_enabled: false, disabled_reason: "seat_type_not_eligible" } })).toEqual({
      active: false,
      label: "extra usage not available on this seat",
      spentUsd: 0,
    });
    expect(overageFromUsageBody({ extra_usage: { is_enabled: true, spend_limit_reached: true } })).toEqual({ active: false, label: "out of extra usage" });
    expect(overageFromUsageBody({ extra_usage: { is_enabled: true } })).toEqual({ active: true, label: "using extra usage" });
    expect(overageFromUsageBody({})).toBeUndefined();
  });
});

describe("fetchClaudeLimits rate limiting", () => {
  const id = { name: "acct", label: "Acct", configDir: "/nonexistent/acct" };
  const cacheDir = () => mkdtempSync(join(tmpdir(), "ais-limits-"));
  const ok = async () => ({ body: { five_hour: { utilization: 42, resets_at: "2026-10-12T00:00:00Z" } } });
  const limited = async () => ({ error: "usage endpoint answered HTTP 429", status: 429 });
  const common = { reconcile: async () => undefined as never };

  test("a 429 with a last-good read returns it as cached, with its original capturedAt, without spawning", async () => {
    const dir = cacheDir();
    const live = await fetchClaudeLimits(id, { ...common, cacheDir: dir, fetchBody: ok });
    expect(live.status).toBe("live");
    const stale = await fetchClaudeLimits(id, { ...common, cacheDir: dir, fetchBody: limited });
    expect(stale.status).toBe("cached");
    expect(stale.windows[0]?.usedPercent).toBe(42);
    expect(stale.capturedAt).toBe(live.capturedAt);
  });

  test("a 429 with no cache fails fast as unavailable", async () => {
    const result = await fetchClaudeLimits(id, { ...common, cacheDir: cacheDir(), fetchBody: limited });
    expect(result.status).toBe("unavailable");
    expect(result.error).toContain("rate-limited");
  });
});
