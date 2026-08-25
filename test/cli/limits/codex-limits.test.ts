import { describe, expect, test } from "bun:test";
import { overageFromSnapshot, type RateLimitSnapshotWire } from "../../../src/cli/limits/codex-limits.ts";

describe("overageFromSnapshot", () => {
  test("neither signal set yields undefined", () => {
    expect(overageFromSnapshot({})).toBeUndefined();
  });

  test("credits_depleted takes precedence over spendControlReached, matching deriveNote's own precedence", () => {
    const snapshot: RateLimitSnapshotWire = {
      spendControlReached: true,
      rateLimitReachedType: "workspace_owner_credits_depleted",
    };
    expect(overageFromSnapshot(snapshot)).toEqual({ active: false, label: "credits depleted" });
  });

  test("spendControlReached alone is reported with the exact wording deriveNote already uses", () => {
    expect(overageFromSnapshot({ spendControlReached: true })).toEqual({
      active: false,
      label: "spend control reached",
    });
  });

  test("a rateLimitReachedType that isn't credits_depleted (e.g. usage_limit_reached) is not treated as overage", () => {
    expect(overageFromSnapshot({ rateLimitReachedType: "usage_limit_reached" })).toBeUndefined();
  });

  test("active is always false — this signal only ever describes a blocked state, never confirmed ongoing overage", () => {
    const result = overageFromSnapshot({ spendControlReached: true });
    expect(result?.active).toBe(false);
  });
});
