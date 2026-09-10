import { describe, expect, test } from "bun:test";
import { spendGuardDoctorRows } from "../../src/spend/doctor.ts";
import type { SpendGuardCycleResult } from "../../src/spend/compute.ts";
import type { AccountSpendState } from "../../src/spend/state.ts";

const NOW = new Date(2026, 8, 10, 12, 0, 0);

function state(overrides: Partial<AccountSpendState> = {}): AccountSpendState {
  return {
    accountId: "123456789012",
    profile: "nazare-prod",
    budgetName: "pcg-bedrock-monthly-1000",
    budgetLimitUsd: 1000,
    budgetActualUsd: 12.5,
    budgetTimeUnit: "MONTHLY",
    localEstimateUsd: 100,
    realReportedUsd: 55.5,
    effectiveUsd: 100,
    breached: false,
    enforced: true,
    degraded: false,
    identities: ["phoenix-court-group-bedrock"],
    computedAt: NOW.toISOString(),
    ...overrides,
  };
}

function cycle(states: AccountSpendState[], errors: string[] = []): SpendGuardCycleResult {
  return { states: Object.fromEntries(states.map((s) => [s.accountId, s])), errors, computedAt: NOW.toISOString() };
}

describe("spendGuardDoctorRows", () => {
  test("healthy: responsive/in budget with the full signal breakdown", () => {
    const [row] = spendGuardDoctorRows(cycle([state()]));
    expect(row).toMatchObject({ toolName: "aws-spend-guard", status: "responsive", statusWord: "in budget" });
    expect(row.detail).toContain("cap $1000.00");
    expect(row.detail).toContain("local $100.00");
    expect(row.detail).toContain("Cost Explorer $55.50");
    expect(row.detail).toContain("budget actual $12.50");
    expect(row.detail).toContain("phoenix-court-group-bedrock");
  });

  test("breached: hung/BREACHED with the enforcement wording", () => {
    const [row] = spendGuardDoctorRows(cycle([state({ breached: true, effectiveUsd: 1004, localEstimateUsd: 1004, reason: "over" })]));
    expect(row.status).toBe("hung");
    expect(row.statusWord).toBe("BREACHED");
    expect(row.detail).toContain("new launches blocked, active sessions terminated");
  });

  test("degraded: unavailable/DEGRADED carrying the reason", () => {
    const [row] = spendGuardDoctorRows(
      cycle([state({ degraded: true, enforced: false, budgetName: undefined, budgetLimitUsd: undefined, reason: "SSO expired" })]),
    );
    expect(row.status).toBe("unavailable");
    expect(row.statusWord).toContain("DEGRADED");
    expect(row.detail).toContain("SSO expired");
  });

  test("multiple accounts render as multiple rows", () => {
    const rows = spendGuardDoctorRows(cycle([state(), state({ accountId: "999999999999", profile: "nazare-dev", identities: [] })]));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.identity.name).sort()).toEqual(["account ...9012", "account ...9999"]);
  });

  test("an empty cycle (no mapped accounts) renders nothing at all", () => {
    expect(spendGuardDoctorRows(cycle([]))).toEqual([]);
  });
});
