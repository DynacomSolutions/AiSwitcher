import { describe, expect, test } from "bun:test";
import { overageFromUsageText } from "../../../src/cli/limits/claude-limits.ts";

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
