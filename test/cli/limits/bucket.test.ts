import { describe, expect, test } from "bun:test";
import { categorizeByLabel, categorizeByMinutes } from "../../../src/cli/limits/bucket.ts";

describe("categorizeByMinutes", () => {
  test("5 hours (300 min, Claude/Codex session window) buckets as session", () => {
    expect(categorizeByMinutes(300)).toBe("session");
  });

  test("7 days (10080 min, the confirmed Codex weekly window) buckets as week", () => {
    expect(categorizeByMinutes(10080)).toBe("week");
  });

  test("~30 days buckets as month", () => {
    expect(categorizeByMinutes(43200)).toBe("month");
  });

  test("something far outside any known window buckets as other", () => {
    expect(categorizeByMinutes(999999)).toBe("other");
  });
});

describe("categorizeByLabel", () => {
  test("Claude's free-text labels", () => {
    expect(categorizeByLabel("session")).toBe("session");
    expect(categorizeByLabel("week (all models)")).toBe("week");
    expect(categorizeByLabel("week (Fable)")).toBe("week");
  });

  test("Grok's USAGE_PERIOD_TYPE_* enum values", () => {
    expect(categorizeByLabel("USAGE_PERIOD_TYPE_WEEKLY")).toBe("week");
    expect(categorizeByLabel("USAGE_PERIOD_TYPE_MONTHLY")).toBe("month");
  });

  test("unrecognized labels fall back to other", () => {
    expect(categorizeByLabel("credits")).toBe("other");
  });
});
