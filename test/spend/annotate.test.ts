import { describe, expect, test } from "bun:test";
import { annotateWithSpendGuard } from "../../src/spend/annotate.ts";
import type { SpendGuardCache } from "../../src/spend/cache.ts";
import type { AccountSpendState } from "../../src/spend/state.ts";
import type { ToolLimitResult } from "../../src/cli/limits/types.ts";
import type { Identity } from "../../src/identities/types.ts";

const NOW = new Date("2026-09-10T10:00:00.000Z");

function identity(name: string): Identity {
  return { name, label: name, configDir: `/id/${name}` };
}

function limitResult(name: string, provider = "aws-bedrock"): ToolLimitResult {
  return {
    toolName: "codex",
    provider,
    identity: identity(name),
    windows: [{ label: "budget: pcg-bedrock-monthly-1000", category: "month", usedPercent: 100.4 }],
    status: "live",
  };
}

function state(overrides: Partial<AccountSpendState> = {}): AccountSpendState {
  return {
    accountId: "123456789012",
    profile: "nazare-prod",
    localEstimateUsd: 0,
    effectiveUsd: 0,
    breached: false,
    enforced: true,
    degraded: false,
    identities: [identity("guarded").name],
    computedAt: NOW.toISOString(),
    ...overrides,
  };
}

function cache(accounts: Record<string, AccountSpendState>): SpendGuardCache {
  return { version: 1, updatedAt: NOW.toISOString(), accounts, recentKills: [] };
}

const MAPPING_DEPS = {
  awsProfileDeps: {
    readText: (path: string) => {
      if (path.endsWith("aws-profiles.json")) return JSON.stringify({ version: 1, identities: { guarded: { profile: "p" } } });
      if (path.endsWith("config")) return "[profile p]\nsso_account_id = 123456789012\n";
      throw new Error(`unexpected ${path}`);
    },
    awsProfilesPath: "/f/aws-profiles.json",
    awsConfigPath: "/f/config",
  },
};

describe("annotateWithSpendGuard", () => {
  test("a breached account's rows carry the loud over-cap note", () => {
    const [row] = annotateWithSpendGuard([limitResult("guarded")], cache({ "123456789012": state({ breached: true, effectiveUsd: 1004, localEstimateUsd: 1004, reason: "over" }) }), MAPPING_DEPS);
    expect(row.windows[0]?.note).toContain("SPEND GUARD: over cap");
    expect(row.windows[0]?.note).toContain("launches blocked");
  });

  test("a degraded account says why it is unenforced", () => {
    const [row] = annotateWithSpendGuard([limitResult("guarded")], cache({ "123456789012": state({ degraded: true, enforced: false, reason: "SSO expired" }) }), MAPPING_DEPS);
    expect(row.windows[0]?.note).toContain("unenforced (SSO expired)");
  });

  test("healthy rows stay silent; identities with no cached state are untouched", () => {
    const rows = annotateWithSpendGuard(
      [limitResult("guarded"), limitResult("plain", "openai")],
      cache({ "123456789012": state() }),
      MAPPING_DEPS,
    );
    expect(rows[0]?.windows[0]?.note).toBeUndefined();
    expect(rows[1]?.windows[0]?.note).toBeUndefined();
  });

  test("an existing window note is extended, not replaced; no cache is a no-op", () => {
    const withNote = limitResult("guarded");
    withNote.windows[0]!.note = "over budget: $1004.00 of $1000.00";
    const [row] = annotateWithSpendGuard(
      [withNote],
      cache({ "123456789012": state({ breached: true, effectiveUsd: 1004, localEstimateUsd: 1004, reason: "over" }) }),
      MAPPING_DEPS,
    );
    expect(row.windows[0]?.note).toContain("over budget");
    expect(row.windows[0]?.note).toContain("SPEND GUARD");
    expect(annotateWithSpendGuard([limitResult("guarded")], undefined, MAPPING_DEPS)[0]?.windows[0]?.note).toBeUndefined();
  });
});
