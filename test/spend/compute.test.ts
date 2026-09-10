import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetSnapshotsFromWires, runSpendGuardCycle, type SpendCycleDeps } from "../../src/spend/compute.ts";
import type { BudgetWire } from "../../src/cli/limits/aws-bedrock-limits.ts";
import type { CostExplorerWire } from "../../src/cli/usage/aws-bedrock-usage.ts";
import type { GuardAccount } from "../../src/spend/accounts.ts";
import { resolveGuardAccounts } from "../../src/spend/accounts.ts";
import type { Identity } from "../../src/identities/types.ts";

function wire(overrides: Partial<BudgetWire> = {}): BudgetWire {
  return {
    BudgetName: "acme-bedrock-monthly",
    BudgetType: "COST",
    TimeUnit: "MONTHLY",
    BudgetLimit: { Amount: "1000", Unit: "USD" },
    CalculatedSpend: { ActualSpend: { Amount: "12.5", Unit: "USD" } },
    ...overrides,
  };
}

describe("budgetSnapshotsFromWires", () => {
  test("COST budgets map to snapshots with parsed dollars; non-COST and unparseable are skipped", () => {
    const snapshots = budgetSnapshotsFromWires([
      wire(),
      wire({ BudgetName: "ri-util", BudgetType: "RI_UTILIZATION", BudgetLimit: { Amount: "90", Unit: "PERCENT" } }),
      wire({ BudgetName: "no-limit", BudgetLimit: undefined }),
      wire({ BudgetName: "bad-limit", BudgetLimit: { Amount: "abc", Unit: "USD" } }),
    ]);
    expect(snapshots).toEqual([
      { name: "acme-bedrock-monthly", limitUsd: 1000, actualUsd: 12.5, timeUnit: "MONTHLY" },
    ]);
  });

  test("a budget AWS has not valued yet reads as $0 actual", () => {
    expect(budgetSnapshotsFromWires([wire({ CalculatedSpend: undefined })])[0]?.actualUsd).toBe(0);
  });
});

const ACCOUNT: GuardAccount = {
  accountId: "123456789012",
  profile: "acme-prod",
  region: "eu-west-2",
  identities: [
    { toolName: "codex", identity: { name: "guarded-a", label: "a", configDir: "/id/a" } },
    { toolName: "claude", identity: { name: "guarded-b", label: "b", configDir: "/id/b" } },
  ],
};

function cycleDeps(overrides: Partial<SpendCycleDeps> = {}): SpendCycleDeps {
  const now = new Date(2026, 8, 10, 12, 0, 0);
  return {
    accounts: [ACCOUNT],
    budgets: {
      listBudgets: async () => [wire()],
      describeBudget: async () => wire(),
    },
    costExplorer: {
      getCostAndUsage: async (): Promise<CostExplorerWire> => ({
        ResultsByTime: [{ TimePeriod: { Start: "2026-09-01" }, Total: { UnblendedCost: { Amount: "55.5", Unit: "USD" } } }],
      }),
    },
    localEstimate: () => ({ usd: 100, unknownModelUsd: 0, filesRead: 1, notes: [] }),
    now: () => now,
    ...overrides,
  };
}

describe("runSpendGuardCycle", () => {
  test("blends budgets, Cost Explorer and the local identity sum into one enforced state", async () => {
    const { states, errors } = await runSpendGuardCycle(cycleDeps());
    expect(errors).toEqual([]);
    const state = states["123456789012"]!;
    expect(state).toMatchObject({
      profile: "acme-prod",
      budgetName: "acme-bedrock-monthly",
      budgetLimitUsd: 1000,
      budgetActualUsd: 12.5,
      localEstimateUsd: 200, // both identities summed
      realReportedUsd: 55.5,
      effectiveUsd: 200, // max(local, real, budget actual)
      breached: false,
      enforced: true,
      degraded: false,
      identities: ["guarded-a", "guarded-b"],
    });
    expect(state.periodStart).toBe(new Date(2026, 8, 1).toISOString());
  });

  test("a Cost Explorer failure removes real from the blend and records the error, never throws", async () => {
    const { states, errors } = await runSpendGuardCycle(
      cycleDeps({
        costExplorer: {
          getCostAndUsage: async () => {
            throw new Error("us-east-1 is on fire");
          },
        },
      }),
    );
    const state = states["123456789012"]!;
    expect(state.realReportedUsd).toBeUndefined();
    expect(state.effectiveUsd).toBe(200);
    expect(errors.join(" ")).toContain("Cost Explorer query failed");
  });

  test("an SSO-dead budget fetch degrades the account (unenforced, loud reason) and skips Cost Explorer", async () => {
    const costExplorer = { getCostAndUsage: async () => ({ ResultsByTime: [] }) };
    const spy = { calls: 0 };
    const { states, errors } = await runSpendGuardCycle(
      cycleDeps({
        budgets: {
          listBudgets: async () => {
            throw Object.assign(new Error("SSO session token has expired"), { name: "ExpiredTokenException" });
          },
          describeBudget: async () => wire(),
        },
        costExplorer: {
          ...costExplorer,
          getCostAndUsage: async () => {
            spy.calls += 1;
            return { ResultsByTime: [] };
          },
        },
      }),
    );
    const state = states["123456789012"]!;
    expect(state).toMatchObject({ degraded: true, enforced: false, breached: false });
    expect(state.reason).toContain("aws sso login");
    expect(errors.join(" ")).toContain("SSO");
    expect(spy.calls).toBe(0); // no real fetch attempted without a cap to compare against
  });

  test("an account with no COST budgets is degraded with the no-budget reason", async () => {
    const { states } = await runSpendGuardCycle(
      cycleDeps({ budgets: { listBudgets: async () => [], describeBudget: async () => wire() } }),
    );
    expect(states["123456789012"]?.degraded).toBe(true);
    expect(states["123456789012"]?.reason).toContain("no AWS COST budget");
  });

  test("the Cost Explorer window matches the budget's own period (month-to-date for MONTHLY)", async () => {
    let captured = "";
    await runSpendGuardCycle(
      cycleDeps({
        costExplorer: {
          getCostAndUsage: async (_granularity, start) => {
            captured = start;
            return { ResultsByTime: [] };
          },
        },
      }),
    );
    expect(captured).toBe("2026-09-01");
  });
});

describe("resolveGuardAccounts", () => {
  const identity = (name: string): Identity => ({ name, label: name, configDir: `/id/${name}` });

  function codexConfigFixture(identitiesJsonPath: string) {
    return {
      toolName: "codex" as const,
      realBinaryName: "codex" as const,
      envVarName: "CODEX_HOME" as const,
      globalMemoryProjection: "codex-developer-instructions" as const,
      identitiesJsonPath,
      identitiesRootDir: "/id/registries",
    };
  }

  test("groups identities by account; unmapped identities are invisible", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ais-spend-accounts-"));
    try {
      const registry = join(dir, "identities.json");
      writeFileSync(
        registry,
        JSON.stringify({ version: 1, identities: [identity("mapped-one"), identity("unmapped")] }),
      );
      const { accounts, errors } = await resolveGuardAccounts([codexConfigFixture(registry)], {
        readText: (path: string) => {
          if (path.endsWith("aws-profiles.json"))
            return JSON.stringify({ version: 1, identities: { "mapped-one": { profile: "p-one" } } });
          if (path.endsWith("config")) return "[profile p-one]\nsso_account_id = 123456789012\nregion = eu-west-2\n";
          throw new Error(`unexpected ${path}`);
        },
        awsProfilesPath: `${dir}/aws-profiles.json`,
        awsConfigPath: `${dir}/config`,
      });
      expect(errors).toEqual([]);
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ accountId: "123456789012", profile: "p-one", region: "eu-west-2" });
      expect(accounts[0]?.identities.map((i) => i.identity.name)).toEqual(["mapped-one"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a malformed mapping file surfaces as an error, not a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ais-spend-accounts2-"));
    try {
      const registry = join(dir, "identities.json");
      writeFileSync(registry, JSON.stringify({ version: 1, identities: [identity("mapped-one")] }));
      const { accounts, errors } = await resolveGuardAccounts([codexConfigFixture(registry)], {
        readText: () => "{ broken",
        awsProfilesPath: `${dir}/aws-profiles.json`,
        awsConfigPath: `${dir}/config`,
      });
      expect(accounts).toEqual([]);
      expect(errors[0]).toContain("Invalid AWS profiles config");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
