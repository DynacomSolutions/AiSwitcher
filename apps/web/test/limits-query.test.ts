import { describe, expect, test } from "bun:test";
import { limitsRefetchInterval, POLL, reconcileLimits } from "../src/lib/limits-reconciliation.ts";
import type { LimitsResponse, ToolLimitResult } from "../src/types/api.ts";

const capturedAt = (seconds: number) => new Date(seconds * 1_000).toISOString();
const codexRow = (identity: string, usedPercent: number, captured: number, resetPendingUntil?: number): ToolLimitResult => ({
  toolName: "codex",
  provider: "openai",
  identity: { name: `SYNTHETIC_FIXTURE-${identity}`, label: identity, configDir: "synthetic" },
  windows: [{ label: "session (5h)", category: "session", usedPercent }],
  status: "live",
  gatewayManaged: true,
  capturedAt: capturedAt(captured),
  ...(resetPendingUntil ? { resetPendingUntil } : {}),
});
const payload = (...results: ToolLimitResult[]): LimitsResponse => ({ results, cached: false, fetchedAt: capturedAt(100) });

describe("limits query reset reconciliation", () => {
  test("keeps fast polling when a newer reading still shows full usage", () => {
    const initial = payload(codexRow("member-a", 100, 1, 30_000));
    const unchanged = reconcileLimits(initial, payload(codexRow("member-a", 100, 3)), 3_000);
    expect(limitsRefetchInterval(unchanged, 3_000)).toBe(2_000);
    const relieved = reconcileLimits(unchanged, payload(codexRow("member-a", 2, 5)), 5_000);
    expect(relieved.results[0]?.windows[0]?.usedPercent).toBe(2);
    expect(limitsRefetchInterval(relieved, 5_000)).toBe(POLL.slow);
  });

  test("returns to ordinary polling after the 30 second accelerated window", () => {
    const cached = payload(codexRow("member-a", 90, 1, 30_000));

    expect(limitsRefetchInterval(cached, 29_999)).toBe(2_000);
    expect(limitsRefetchInterval(cached, 31_000)).toBe(POLL.slow);
    const ordinary = reconcileLimits(cached, payload(codexRow("member-a", 90, 1)), 31_000);
    expect(ordinary.results[0]).not.toHaveProperty("resetPendingUntil");
    expect(ordinary.results[0]?.windows[0]?.usedPercent).toBe(90);
  });

  test("does not let an expired reset recheck starve a later active identity", () => {
    const now = 50_000;
    const cached = payload(
      codexRow("member-a", 90, 1, now - 1),
      codexRow("member-b", 70, 2, now + 10_000),
    );

    expect(limitsRefetchInterval(cached, now)).toBe(2_000);
  });

  test("accepts honest unchanged usage and later zero while keeping other identities visible", () => {
    const initial = payload(codexRow("member-a", 90, 1, 31_000), codexRow("member-b", 40, 1));
    const unchanged = reconcileLimits(initial, payload(codexRow("member-a", 90, 40), codexRow("member-b", 40, 40)), 32_000);
    expect(unchanged.results.map((row) => [row.identity.name, row.windows[0]?.usedPercent])).toEqual([
      ["SYNTHETIC_FIXTURE-member-a", 90],
      ["SYNTHETIC_FIXTURE-member-b", 40],
    ]);

    const zero = reconcileLimits(unchanged, payload(codexRow("member-a", 0, 100), codexRow("member-b", 40, 100)), 33_000);
    expect(zero.results.map((row) => [row.identity.name, row.windows[0]?.usedPercent])).toEqual([
      ["SYNTHETIC_FIXTURE-member-a", 0],
      ["SYNTHETIC_FIXTURE-member-b", 40],
    ]);
  });

  test("does not treat a newer host fallback as a Gateway reset reading", () => {
    const initial = payload(codexRow("member-a", 90, 1, 31_000));
    const hostFallback = { ...codexRow("member-a", 0, 40), gatewayManaged: false };

    const result = reconcileLimits(initial, payload(hostFallback));
    expect(result.results[0]).toMatchObject({ gatewayManaged: true, capturedAt: capturedAt(1), windows: [{ usedPercent: 90 }] });
  });
});
