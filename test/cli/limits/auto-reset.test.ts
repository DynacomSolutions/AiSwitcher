import { expect, test } from "bun:test";
import { applyLimitsAutoReset } from "../../../src/cli/limits/auto-reset.ts";
import { formatLimitsReport } from "../../../src/cli/limits/report.ts";
import type { ToolLimitResult } from "../../../src/cli/limits/types.ts";
import type { AutoResetView } from "../../../src/gateway/auto-reset-view.ts";

test("limits prints automatic reset separately from usable manual credit inventory", () => {
  const pool = "fixture-pool";
  const startedAt = "2026-11-27T10:00:00.000Z";
  const names = ["fixture-stale", "fixture-zero", "fixture-unknown"];
  const lastClaim = { pool, identity: names[0]!, startedAt, status: "unknown" as const };
  const settings: AutoResetView = {
    pools: [{ name: pool, enabled: true, members: names, lastClaim }],
  };
  const rows: ToolLimitResult[] = names.slice(0, 2).map((name, i) => ({
    toolName: "codex", provider: "openai", identity: { name, label: name, configDir: "" },
    windows: [{ label: "week", category: "week", usedPercent: 80 }],
    status: "cached", manualReset: { availableCount: i === 0 ? 1 : 0, stale: i === 0 },
  }));
  const result = applyLimitsAutoReset(rows, settings);
  expect(result.map((row) => row.autoReset?.name)).toEqual([undefined, undefined, pool]);
  for (const compact of [false, true]) {
    const report = formatLimitsReport(result, undefined, undefined, { compact, width: 140 });
    expect(report).toContain("automatic reset on, last claim: unknown at 17:00 ICT Fri 27 Nov, 10:00 GMT Fri 27 Nov");
    expect(report.match(/automatic reset /g)).toHaveLength(1);
    expect(report).toContain(compact ? "↺1" : "manual reset available");
  }
  expect(applyLimitsAutoReset(rows, settings, names[2])).toEqual(rows);
  expect(applyLimitsAutoReset([], settings, pool).map((row) => row.identity.name)).toEqual([pool]);

  const mirror: ToolLimitResult = {
    ...rows[0]!,
    identity: { name: pool, label: pool, configDir: "", swapPool: { accounts: names } },
  };
  expect(applyLimitsAutoReset([mirror], settings)).toEqual([{ ...mirror, autoReset: settings.pools[0] }]);
});
