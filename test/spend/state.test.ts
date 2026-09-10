import { describe, expect, test } from "bun:test";
import {
  chooseBudget,
  computeAccountState,
  enteredBreach,
  periodStartForTimeUnit,
  type AccountSpendState,
  type BudgetSnapshot,
} from "../../src/spend/state.ts";

function budget(overrides: Partial<BudgetSnapshot> = {}): BudgetSnapshot {
  return { name: "pcg-bedrock-monthly-1000", limitUsd: 1000, actualUsd: 0, timeUnit: "MONTHLY", ...overrides };
}

const NOW = new Date(2026, 8, 10, 12, 0, 0); // 10 Sep 2026, local noon

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "123456789012",
    profile: "nazare-prod",
    budgets: [budget()],
    localEstimateUsd: 100,
    identities: ["phoenix-court-group-bedrock"],
    now: NOW,
    ...overrides,
  } as Parameters<typeof computeAccountState>[0];
}

describe("periodStartForTimeUnit", () => {
  test("MONTHLY starts on the 1st, DAILY at local midnight, ANNUALLY on Jan 1", () => {
    expect(periodStartForTimeUnit("MONTHLY", NOW).getDate()).toBe(1);
    expect(periodStartForTimeUnit("MONTHLY", NOW).getMonth()).toBe(8);
    expect(periodStartForTimeUnit("DAILY", NOW).getHours()).toBe(0);
    expect(periodStartForTimeUnit("DAILY", NOW).getDate()).toBe(10);
    expect(periodStartForTimeUnit("ANNUALLY", NOW).getMonth()).toBe(0);
    expect(periodStartForTimeUnit("ANNUALLY", NOW).getDate()).toBe(1);
  });

  test("QUARTERLY starts on the calendar quarter; WEEKLY on Sunday", () => {
    expect(periodStartForTimeUnit("QUARTERLY", NOW).getMonth()).toBe(6); // Jul
    expect(periodStartForTimeUnit("WEEKLY", NOW).getDay()).toBe(0);
  });

  test("an unknown TimeUnit falls back to calendar month (estimate window still sane)", () => {
    expect(periodStartForTimeUnit("HOURLY", NOW).getDate()).toBe(1);
  });
});

describe("chooseBudget", () => {
  test("largest limit wins; ties break lexicographically by name", () => {
    expect(chooseBudget([budget({ limitUsd: 300 }), budget({ limitUsd: 1000 })])?.limitUsd).toBe(1000);
    expect(chooseBudget([budget({ name: "b-two", limitUsd: 500 }), budget({ name: "a-one", limitUsd: 500 })])?.name).toBe("a-one");
    expect(chooseBudget([])).toBeUndefined();
  });
});

describe("computeAccountState", () => {
  test("effective spend is max(local, every real source that succeeded this cycle)", () => {
    const state = computeAccountState(baseInput({ localEstimateUsd: 400, realReportedUsd: 250 }));
    expect(state.effectiveUsd).toBe(400);
    const realWins = computeAccountState(baseInput({ localEstimateUsd: 100, realReportedUsd: 900 }));
    expect(realWins.effectiveUsd).toBe(900);
    const budgetActualWins = computeAccountState(
      baseInput({ localEstimateUsd: 100, realReportedUsd: 10, budgets: [budget({ actualUsd: 950 })] }),
    );
    expect(budgetActualWins.effectiveUsd).toBe(950);
    expect(budgetActualWins.budgetActualUsd).toBe(950);
  });

  test("breach hits at >= the cap (a request that reached the cap already billed)", () => {
    expect(computeAccountState(baseInput({ localEstimateUsd: 999.99 })).breached).toBe(false);
    expect(computeAccountState(baseInput({ localEstimateUsd: 1000 })).breached).toBe(true);
    expect(computeAccountState(baseInput({ localEstimateUsd: 1200 })).breached).toBe(true);
  });

  test("below the cap: enforced, not degraded, no reason", () => {
    const state = computeAccountState(baseInput());
    expect(state).toMatchObject({ breached: false, enforced: true, degraded: false });
    expect(state.reason).toBeUndefined();
  });

  test("breach carries a human-readable reason; period bounds follow the budget's TimeUnit", () => {
    const state = computeAccountState(baseInput({ localEstimateUsd: 1400 }));
    expect(state.reason).toContain("1400.00");
    expect(state.reason).toContain("1000.00");
    expect(state.periodStart).toBe(new Date(2026, 8, 1).toISOString());
    expect(state.periodEnd).toBe(new Date(2026, 9, 1).toISOString());
    expect(state.budgetTimeUnit).toBe("MONTHLY");
  });

  test("a failed budget fetch leaves the account UNENFORCED but degraded, never breached", () => {
    const state = computeAccountState(
      baseInput({ budgets: [], budgetError: "AWS SSO credentials expired or unavailable for profile \"nazare-prod\"", localEstimateUsd: 99999 }),
    );
    expect(state).toMatchObject({ breached: false, enforced: false, degraded: true });
    expect(state.reason).toContain("SSO");
    expect(state.effectiveUsd).toBe(99999); // display only; nothing enforces it
    expect(state.budgetLimitUsd).toBeUndefined();
  });

  test("an account with no COST budget at all is degraded with a self-explaining reason", () => {
    const state = computeAccountState(baseInput({ budgets: [] }));
    expect(state.degraded).toBe(true);
    expect(state.reason).toContain("no AWS COST budget");
    expect(state.reason).toContain("9012");
  });

  test("computedAt and identities travel with the state for surfacing", () => {
    const state = computeAccountState(baseInput());
    expect(state.computedAt).toBe(NOW.toISOString());
    expect(state.identities).toEqual(["phoenix-court-group-bedrock"]);
  });
});

function state(overrides: Partial<AccountSpendState> = {}): AccountSpendState {
  return {
    accountId: "123456789012",
    profile: "nazare-prod",
    localEstimateUsd: 0,
    effectiveUsd: 0,
    breached: false,
    enforced: true,
    degraded: false,
    identities: [],
    computedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("enteredBreach", () => {
  test("kills on transition into breach, including first observation", () => {
    expect(enteredBreach(undefined, state({ breached: true }))).toBe(true);
    expect(enteredBreach(state({ breached: false }), state({ breached: true }))).toBe(true);
  });

  test("never re-kills an account that stayed breached; never kills a healthy or degraded account", () => {
    expect(enteredBreach(state({ breached: true }), state({ breached: true }))).toBe(false);
    expect(enteredBreach(undefined, state({ breached: false }))).toBe(false);
    expect(enteredBreach(undefined, state({ breached: true, enforced: false, degraded: true }))).toBe(false);
  });
});
