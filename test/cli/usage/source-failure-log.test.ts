import { describe, expect, spyOn, test } from "bun:test";
import { logUsageSourceFailure } from "../../../src/cli/usage/run.ts";

describe("usage source failure logging", () => {
  test("logs the message and stack of an Error, not just a category", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      logUsageSourceFailure("pool SYNTHETIC_FIXTURE_pool attribution", new Error("usage source changed during attribution scan"));
      const text = String(warn.mock.calls[0]?.[0]);
      expect(text).toContain("pool SYNTHETIC_FIXTURE_pool attribution");
      expect(text).toContain("usage source changed during attribution scan");
      expect(text).toContain("at ");
    } finally {
      warn.mockRestore();
    }
  });

  test("logs a plain string reason from a failed tokscale result", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      logUsageSourceFailure("pool SYNTHETIC_FIXTURE_pool tokscale", "tokscale timed out after 600s");
      expect(String(warn.mock.calls[0]?.[0])).toContain("tokscale timed out after 600s");
    } finally {
      warn.mockRestore();
    }
  });
});
