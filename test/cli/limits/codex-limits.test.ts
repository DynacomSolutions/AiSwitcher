import { describe, expect, test } from "bun:test";
import {
  manualResetFromWire,
  overageFromSnapshot,
  type RateLimitResetCreditsWire,
  type RateLimitSnapshotWire,
} from "../../../src/cli/limits/codex-limits.ts";

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

describe("manualResetFromWire", () => {
  /** Verbatim shape confirmed live 2026-09-04 against the real
   * phoenix-court-group team account on this machine (id shortened). */
  const liveGrant: RateLimitResetCreditsWire = {
    availableCount: 1,
    credits: [
      {
        id: "RateLimitResetCredit_2dbf116fad388191ad4f8f6d48f12d38",
        resetType: "codexRateLimits",
        status: "available",
        grantedAt: 1788487959,
        expiresAt: 1791079959,
        title: "Full reset (Weekly + 5 hr)",
        description: "Thanks for using Codex! You've been granted one free rate limit reset.",
      },
    ],
  };

  test("the live grant maps to a count-1 manual reset with title and expiry", () => {
    expect(manualResetFromWire(liveGrant)).toEqual({
      availableCount: 1,
      label: "Full reset (Weekly + 5 hr)",
      expiresAt: new Date(1791079959 * 1000).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    });
  });

  test("absent wire block (accounts without the concept) yields undefined", () => {
    expect(manualResetFromWire(undefined)).toBeUndefined();
    expect(manualResetFromWire({})).toBeUndefined();
  });

  test("a zero availableCount yields undefined rather than a fabricated no-resets row", () => {
    expect(manualResetFromWire({ availableCount: 0, credits: liveGrant.credits })).toBeUndefined();
  });

  test("a non-numeric availableCount falls back to counting status-available credits", () => {
    const wire: RateLimitResetCreditsWire = {
      credits: [
        { status: "available", title: "Full reset (Weekly + 5 hr)" },
        { status: "used", title: "Full reset (Weekly + 5 hr)" },
      ],
    };
    expect(manualResetFromWire(wire)).toEqual({ availableCount: 1, label: "Full reset (Weekly + 5 hr)" });
  });

  test("credits with a non-available status never count or supply title/expiry", () => {
    const wire: RateLimitResetCreditsWire = { availableCount: 1, credits: [{ status: "used", title: "Full reset" }] };
    expect(manualResetFromWire(wire)).toEqual({ availableCount: 1 });
  });
});
