import { expect, test } from "bun:test";
import { applyLimitsAutoReset } from "../../../src/cli/limits/auto-reset.ts";
import { formatLimitsReport } from "../../../src/cli/limits/report.ts";
import type { ToolLimitResult } from "../../../src/cli/limits/types.ts";
import type { AutoResetView } from "../../../src/gateway/auto-reset-view.ts";

const startedAt = "2026-11-27T10:00:00.000Z";

function row(toolName: "codex" | "claude", name: string): ToolLimitResult {
  return {
    toolName, provider: toolName === "codex" ? "openai" : "anthropic", identity: { name, label: name, configDir: "" },
    windows: [{ label: "week", category: "week", usedPercent: 80 }], status: "cached",
  };
}

test("limits prints the pool setting for every provider and only the last claim for a member", () => {
  const codexPool = "fixture-codex-pool";
  const claudePool = "claude-fixture-pool";
  const lastClaim = { pool: codexPool, identity: "fixture-codex-member", startedAt, status: "unknown" as const };
  const view: AutoResetView = { providers: [
    { provider: "codex", supported: true, memberClaims: { "fixture-codex-member": lastClaim },
      pools: [{ name: codexPool, enabled: true, members: ["fixture-codex-member"], lastClaim }] },
    { provider: "claude", supported: true, memberClaims: {}, pools: [{ name: claudePool, enabled: false, members: ["fixture-claude-member"] }] },
    { provider: "kimi", supported: false, reason: "no reset API" },
  ] };
  const rows = [row("codex", "fixture-codex-member"), row("claude", "fixture-claude-member")];
  const result = applyLimitsAutoReset(rows, view);
  expect(result.map((r) => r.identity.name)).toEqual(["fixture-codex-member", "fixture-claude-member", codexPool, claudePool]);
  // A member has no setting. A pool has one.
  expect(result[0]).toMatchObject({ autoResetClaim: lastClaim });
  expect(result[0]!.autoReset).toBeUndefined();
  expect(result[1]!.autoReset).toBeUndefined();
  expect(result[1]!.autoResetClaim).toBeUndefined();
  expect(result[2]).toMatchObject({ toolName: "codex", autoReset: { name: codexPool, enabled: true } });
  expect(result[3]).toMatchObject({ toolName: "claude", autoReset: { name: claudePool, enabled: false } });
  for (const compact of [false, true]) {
    const report = formatLimitsReport(result, undefined, undefined, { compact, width: 140 });
    expect(report).toContain("automatic reset on, last claim: unknown at 17:00 ICT Fri 27 Nov, 10:00 GMT Fri 27 Nov");
    expect(report).toContain("automatic reset off, last claim: none");
    expect(report).toContain("last automatic reset: unknown at 17:00 ICT Fri 27 Nov");
    expect(report).not.toContain("kimi");
  }
  expect(applyLimitsAutoReset([], view, claudePool).map((r) => r.identity.name)).toEqual([claudePool]);
  expect(applyLimitsAutoReset(rows, undefined)).toBe(rows);
});
