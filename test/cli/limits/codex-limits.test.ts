import { describe, expect, test } from "bun:test";
import {
  isTransientCodexLimitsError,
  manualResetFromWire,
  overageFromSnapshot,
  withTransientCodexRetries,
  type RateLimitResetCreditsWire,
  type RateLimitSnapshotWire,
} from "../../../src/cli/limits/codex-limits.ts";
import type { FetchedLimitResult } from "../../../src/cli/limits/types.ts";
import type { Identity } from "../../../src/identities/types.ts";

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

describe("isTransientCodexLimitsError", () => {
  test("all three observed upstream-flakiness signatures are transient", () => {
    // Verbatim error strings from real degraded runs (2026-09-03/04).
    expect(isTransientCodexLimitsError("failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)")).toBe(true);
    expect(isTransientCodexLimitsError("codex app-server did not respond within 30s.")).toBe(true);
    expect(isTransientCodexLimitsError("codex app-server closed its output before responding.")).toBe(true);
  });

  test("codex's semantic answers are never retried", () => {
    expect(
      isTransientCodexLimitsError("ChatGPT-plan login required (API-key auth doesn't expose rate limits)"),
    ).toBe(false);
    expect(isTransientCodexLimitsError("codex app-server returned no rate-limit data.")).toBe(false);
    expect(
      isTransientCodexLimitsError("codex reported no active rate-limit windows (primary and secondary both empty)."),
    ).toBe(false);
  });

  test("absent or unrelated errors are not transient", () => {
    expect(isTransientCodexLimitsError(undefined)).toBe(false);
    expect(isTransientCodexLimitsError("spawnSync /nonexistent ENOENT")).toBe(false);
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

describe("withTransientCodexRetries", () => {
  const identity: Identity = { name: "acme", label: "Acme", configDir: "/tmp/does-not-exist/acme" };
  const TRANSIENT = "failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)";

  function unavailable(error: string): FetchedLimitResult {
    return { toolName: "codex", identity, windows: [], status: "unavailable", error };
  }

  function live(): FetchedLimitResult {
    return {
      toolName: "codex",
      identity,
      windows: [{ label: "week", category: "week", usedPercent: 42 }],
      status: "live",
      capturedAt: new Date().toISOString(),
    };
  }

  function recordingSleep(): { sleep: (ms: number) => Promise<void>; pauses: number[] } {
    const pauses: number[] = [];
    return {
      pauses,
      sleep: (ms: number) => {
        pauses.push(ms);
        return Promise.resolve();
      },
    };
  }

  test("a transient failure is retried through the FULL backoff: 5 attempts, pauses 3s/8s/20s/45s", async () => {
    const { sleep, pauses } = recordingSleep();
    let calls = 0;
    const result = await withTransientCodexRetries(async () => {
      calls++;
      return unavailable(TRANSIENT);
    }, sleep);
    expect(calls).toBe(5);
    expect(pauses).toEqual([3_000, 8_000, 20_000, 45_000]);
    expect(result.error).toBe(`${TRANSIENT} (still failing after 5 attempts)`);
  });

  test("a success mid-backoff stops retrying and returns the live result untouched", async () => {
    const { sleep, pauses } = recordingSleep();
    let calls = 0;
    const result = await withTransientCodexRetries(async () => {
      calls++;
      return calls < 3 ? unavailable(TRANSIENT) : live();
    }, sleep);
    expect(calls).toBe(3);
    expect(pauses).toEqual([3_000, 8_000]);
    expect(result.status).toBe("live");
    expect(result.error).toBeUndefined();
  });

  test("codex's semantic answers are NOT retried: one attempt, no pause", async () => {
    const { sleep, pauses } = recordingSleep();
    let calls = 0;
    const result = await withTransientCodexRetries(async () => {
      calls++;
      return unavailable("ChatGPT-plan login required (API-key auth doesn't expose rate limits)");
    }, sleep);
    expect(calls).toBe(1);
    expect(pauses).toEqual([]);
    expect(result.error).not.toContain("still failing");
  });

  test("a transient SIGNATURE on a non-unavailable result is not retried either", async () => {
    // Belt and braces: the retry condition is transient AND unavailable, so a
    // hypothetical live result carrying a transient-looking error string
    // still returns as-is.
    const { sleep, pauses } = recordingSleep();
    let calls = 0;
    const result = await withTransientCodexRetries(async () => {
      calls++;
      return { ...live(), error: TRANSIENT };
    }, sleep);
    expect(calls).toBe(1);
    expect(pauses).toEqual([]);
    expect(result.status).toBe("live");
  });
});
