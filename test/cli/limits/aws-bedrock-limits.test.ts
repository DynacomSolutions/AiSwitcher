import { describe, expect, test } from "bun:test";
import {
  fetchAwsBedrockLimits,
  isSsoAuthError,
  overageFromBudgets,
  resetDateForTimeUnit,
  windowFromBudget,
  type BudgetWire,
} from "../../../src/cli/limits/aws-bedrock-limits.ts";
import type { Identity } from "../../../src/identities/types.ts";

function identity(name = "acme-bedrock"): Identity {
  return { name, label: name, configDir: `/tmp/does-not-exist/${name}` };
}

/** Verbatim shape of a DescribeBudget-calibre COST budget (amounts are
 * STRINGS on the wire). */
function costBudget(overrides: Partial<BudgetWire> = {}): BudgetWire {
  return {
    BudgetName: "monthly-bedrock",
    BudgetType: "COST",
    TimeUnit: "MONTHLY",
    BudgetLimit: { Amount: "50", Unit: "USD" },
    TimePeriod: { Start: "2026-01-01T00:00:00Z", End: "2087-06-15T00:00:00Z" },
    CalculatedSpend: { ActualSpend: { Amount: "12.5", Unit: "USD" } },
    ...overrides,
  };
}

const MAPPING_DEPS = {
  readText: (path: string): string => {
    if (path.endsWith("aws-profiles.json")) return JSON.stringify({ version: 1, identities: { "acme-bedrock": { profile: "acme-prod" } } });
    if (path.endsWith("config")) return "[profile acme-prod]\nsso_account_id = 779846811377\nregion = eu-west-2\n";
    throw new Error(`unexpected path ${path}`);
  },
  awsProfilesPath: "/fixtures/aws-profiles.json",
  awsConfigPath: "/fixtures/config",
};

describe("windowFromBudget", () => {
  test("maps a live COST budget to a month-category window with budget label", () => {
    const window = windowFromBudget(costBudget(), { now: () => new Date("2026-09-10T12:00:00Z") });
    expect(window).toEqual({
      label: "budget: monthly-bedrock",
      category: "month",
      usedPercent: 25,
      resetsAt: new Date(2026, 9, 1).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      note: undefined,
    });
  });

  test("usedPercent is raw (over budget exceeds 100; the bar clamps for display)", () => {
    const window = windowFromBudget(costBudget({ CalculatedSpend: { ActualSpend: { Amount: "61.2", Unit: "USD" } } }));
    expect(window?.usedPercent).toBeCloseTo(122.4);
    expect(window?.note).toBe("over budget: $61.20 of $50.00");
  });

  test("non-COST budgets never render (their limits are not dollars)", () => {
    expect(windowFromBudget(costBudget({ BudgetType: "USAGE" }))).toBeUndefined();
    expect(windowFromBudget(costBudget({ BudgetType: "RI_UTILIZATION" }))).toBeUndefined();
  });

  test("a budget with no parseable limit is skipped rather than guessed at", () => {
    expect(windowFromBudget(costBudget({ BudgetLimit: undefined }))).toBeUndefined();
    expect(windowFromBudget(costBudget({ BudgetLimit: { Amount: "abc", Unit: "USD" } }))).toBeUndefined();
    expect(windowFromBudget(costBudget({ BudgetName: undefined }))).toBeUndefined();
  });

  test("a zero-limit budget with no spend reads as 0%, with spend reads as 100%", () => {
    expect(windowFromBudget(costBudget({ BudgetLimit: { Amount: "0", Unit: "USD" }, CalculatedSpend: { ActualSpend: { Amount: "0", Unit: "USD" } } }))?.usedPercent).toBe(0);
    expect(
      windowFromBudget(costBudget({ BudgetLimit: { Amount: "0", Unit: "USD" }, CalculatedSpend: { ActualSpend: { Amount: "0.01", Unit: "USD" } } }))?.usedPercent,
    ).toBe(100);
  });

  test("missing spend reads as $0, not an error", () => {
    expect(windowFromBudget(costBudget({ CalculatedSpend: undefined }))?.usedPercent).toBe(0);
  });
});

describe("resetDateForTimeUnit", () => {
  const now = new Date(2026, 8, 10, 15, 30); // 10 Sep 2026, local

  test("MONTHLY resets on the 1st of the next month", () => {
    expect(resetDateForTimeUnit("MONTHLY", now)).toEqual(new Date(2026, 9, 1));
  });

  test("DAILY resets tomorrow, QUARTERLY on the next quarter start, ANNUALLY next Jan 1", () => {
    expect(resetDateForTimeUnit("DAILY", now)).toEqual(new Date(2026, 8, 11));
    expect(resetDateForTimeUnit("QUARTERLY", now)).toEqual(new Date(2026, 9, 1));
    expect(resetDateForTimeUnit("ANNUALLY", now)).toEqual(new Date(2027, 0, 1));
  });

  test("an unknown or absent TimeUnit yields no reset guess", () => {
    expect(resetDateForTimeUnit(undefined, now)).toBeUndefined();
    expect(resetDateForTimeUnit("WEEKLY", now)).toBeUndefined();
  });
});

describe("overageFromBudgets", () => {
  test("a budget blown past its limit is real overage with real dollars", () => {
    const overage = overageFromBudgets([costBudget({ CalculatedSpend: { ActualSpend: { Amount: "55.004", Unit: "USD" } } })]);
    expect(overage?.active).toBe(true);
    expect(overage?.spentUsd).toBeCloseTo(55.004);
    expect(overage?.limitUsd).toBe(50);
  });

  test("under budget is NOT overage (a budget is a watch line, not a quota)", () => {
    expect(overageFromBudgets([costBudget()])).toBeUndefined();
    expect(overageFromBudgets([])).toBeUndefined();
  });

  test("a USAGE budget never counts", () => {
    expect(overageFromBudgets([costBudget({ BudgetType: "USAGE", CalculatedSpend: { ActualSpend: { Amount: "99", Unit: "USD" } } })])).toBeUndefined();
  });
});

describe("isSsoAuthError", () => {
  test("matches the SDK's SSO failure signatures", () => {
    expect(isSsoAuthError(new Error("The SSO session has expired or is invalid"))).toBe(true);
    expect(isSsoAuthError({ name: "SSOOIDCException", message: "boom" })).toBe(true);
    expect(isSsoAuthError(new Error("Could not load credentials from any providers"))).toBe(true);
  });

  test("does not claim ordinary API failures are SSO problems", () => {
    expect(isSsoAuthError(new Error("socket hang up"))).toBe(false);
    expect(isSsoAuthError({ name: "UnauthorizedException", message: "no budgets" })).toBe(false);
  });
});

describe("fetchAwsBedrockLimits", () => {
  test("an unmapped identity renders nothing unscoped and one honest row when explicit", async () => {
    const unmapped = identity("personal");
    expect(await fetchAwsBedrockLimits(unmapped, false, { awsProfileDeps: MAPPING_DEPS })).toEqual([]);
    const explicit = await fetchAwsBedrockLimits(unmapped, true, { awsProfileDeps: MAPPING_DEPS });
    expect(explicit).toHaveLength(1);
    expect(explicit[0]!.status).toBe("unavailable");
    expect(explicit[0]!.provider).toBe("aws-bedrock");
    expect(explicit[0]!.error).toContain("no AWS profile mapping");
  });

  test("a malformed mapping file is a real failure in both scopes", async () => {
    const deps = { awsProfileDeps: { ...MAPPING_DEPS, readText: () => "not json" } };
    for (const explicitTool of [false, true]) {
      const results = await fetchAwsBedrockLimits(identity(), explicitTool, deps);
      expect(results[0]!.status).toBe("unavailable");
      expect(results[0]!.error).toContain("Invalid AWS profiles config");
    }
  });

  test("SSO expiry says exactly how to fix it, never a raw stack line", async () => {
    const deps = {
      awsProfileDeps: MAPPING_DEPS,
      budgets: {
        listBudgets: () => Promise.reject(new Error("The SSO session has expired or is invalid")),
        describeBudget: () => Promise.reject(new Error("unreachable")),
      },
    };
    const results = await fetchAwsBedrockLimits(identity(), false, deps);
    expect(results[0]!.status).toBe("unavailable");
    expect(results[0]!.error).toContain("aws sso login --profile acme-prod");
    expect(results[0]!.windows).toEqual([]);
  });

  test("live budgets render as provider-stamped windows with overage when over", async () => {
    const deps = {
      awsProfileDeps: MAPPING_DEPS,
      now: () => new Date(2026, 8, 10),
      budgets: {
        listBudgets: () => Promise.resolve([costBudget({ BudgetName: "monthly-bedrock" }), costBudget({ BudgetName: "prod-cap", BudgetLimit: { Amount: "20", Unit: "USD" }, CalculatedSpend: { ActualSpend: { Amount: "25", Unit: "USD" } } })]),
        describeBudget: (_accountId: string, name: string) =>
          Promise.resolve(name === "monthly-bedrock" ? costBudget({ BudgetName: name }) : costBudget({ BudgetName: name, BudgetLimit: { Amount: "20", Unit: "USD" }, CalculatedSpend: { ActualSpend: { Amount: "25", Unit: "USD" } } })),
      },
    };
    const results = await fetchAwsBedrockLimits(identity(), false, deps);
    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.provider).toBe("aws-bedrock");
    expect(result.toolName).toBe("codex");
    expect(result.status).toBe("live");
    expect(result.capturedAt).toBeDefined();
    expect(result.windows.map((w) => w.label)).toEqual(["budget: monthly-bedrock", "budget: prod-cap"]);
    expect(result.windows.every((w) => w.category === "month")).toBe(true);
    expect(result.overage?.active).toBe(true);
    expect(result.overage?.label).toContain("prod-cap");
  });

  test("an account with no COST budgets renders nothing unscoped, one honest row when explicit", async () => {
    const deps = {
      awsProfileDeps: MAPPING_DEPS,
      budgets: {
        listBudgets: () => Promise.resolve([costBudget({ BudgetType: "USAGE" })]),
        describeBudget: () => Promise.resolve({}),
      },
    };
    expect(await fetchAwsBedrockLimits(identity(), false, deps)).toEqual([]);
    const explicit = await fetchAwsBedrockLimits(identity(), true, deps);
    expect(explicit[0]!.status).toBe("unavailable");
    expect(explicit[0]!.error).toContain("no AWS COST budgets defined");
  });
});
