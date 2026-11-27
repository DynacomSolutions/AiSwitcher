import { describe, expect, test } from "bun:test";
import type { ManualResetInfo } from "../../src/cli/limits/types.ts";
import type { PoolUsage } from "../../src/identities/pool/adapter.ts";
import { MemoryAutoResetStore, type AutoResetClaimInput } from "../../src/gateway/auto-reset-store.ts";
import { createAutoResetRecovery, exhaustedWeeklyReset, weeklyWindow } from "../../src/gateway/auto-reset.ts";
import type { AutoResetProvider } from "../../src/gateway/auto-reset-view.ts";

const NOW = Date.parse("2026-11-27T08:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const RESET = NOW + 3_600_000;
const GRANT = "full-reset-SYNTHETIC_FIXTURE";

const claudeUsage = (used = 100): PoolUsage => ({
  status: "live", capturedAt: iso(NOW), windows: [
    { label: "five-hour", utilization: used, resetsAt: iso(NOW + 600_000) },
    { label: "seven-day", utilization: used, resetsAt: iso(RESET) },
  ],
});
const codexUsage = (used = 100): PoolUsage => ({
  status: "live", capturedAt: iso(NOW), windows: [{ label: "week", utilization: used, resetsAt: iso(RESET) }],
});
const credit = (id: string): ManualResetInfo => ({ availableCount: 1, creditExpiries: [{ id, endsAt: iso(NOW + 100_000) }] });

describe("weekly window per provider", () => {
  test("each provider names its weekly window", () => {
    expect(exhaustedWeeklyReset(claudeUsage(), NOW, "claude")).toBe(RESET);
    expect(exhaustedWeeklyReset(codexUsage(), NOW, "codex")).toBe(RESET);
    expect(exhaustedWeeklyReset(codexUsage(), NOW)).toBe(RESET);
    // A window name of one provider is no proof for the other.
    expect(exhaustedWeeklyReset(claudeUsage(), NOW, "codex")).toBeUndefined();
    expect(exhaustedWeeklyReset(codexUsage(), NOW, "claude")).toBeUndefined();
    expect(weeklyWindow(claudeUsage(60), NOW, "claude")).toEqual({ utilization: 60, reset: RESET });
  });

  test("a full five-hour window alone is not a weekly limit", () => {
    const fiveHourOnly: PoolUsage = { ...claudeUsage(100), windows: [claudeUsage().windows![0]!, { label: "seven-day", utilization: 40, resetsAt: iso(RESET) }] };
    expect(exhaustedWeeklyReset(fiveHourOnly, NOW, "claude")).toBeUndefined();
  });
});

describe("pool setting is the only setting", () => {
  const claim = (provider: AutoResetProvider, over: Partial<AutoResetClaimInput> = {}): AutoResetClaimInput => ({
    provider, eventKey: `event-${provider}`, pool: "shared-name", identity: "member", creditId: `credit-${provider}`,
    creditExpiresAt: iso(NOW + 100_000), startedAt: iso(NOW), redeemRequestId: `request-${provider}`,
    usageEvidence: [{ identity: "member", resetAt: iso(RESET), capturedAt: iso(NOW), weeklyUtilisation: 100 }],
    creditEvidence: { reason: "only_candidate", inventories: [] }, ...over,
  });

  test("a pool name is set per provider, and a claim needs its own provider's pool", async () => {
    const store = new MemoryAutoResetStore(() => NOW);
    expect(await store.claim(claim("claude"))).toEqual({ kind: "blocked" });
    await store.setEnabled("codex", "shared-name", true);
    expect(await store.enabled("claude", "shared-name")).toBe(false);
    expect(await store.claim(claim("claude"))).toEqual({ kind: "blocked" });
    await store.setEnabled("claude", "shared-name", true);
    expect(await store.claim(claim("claude"))).toEqual({ kind: "created" });
    // Equal member names under two providers do not block each other.
    expect(await store.claim(claim("codex"))).toEqual({ kind: "created" });
    expect(await store.lastClaim("claude", "shared-name")).toMatchObject({ creditId: "credit-claude" });
    expect(await store.lastMemberClaim("codex", "member")).toMatchObject({ creditId: "credit-codex" });
  });

  test("no identity name can enable a claim. Only the pool of the claim counts", async () => {
    const store = new MemoryAutoResetStore(() => NOW);
    // The old identity form is gone from the type. At run time it is only an unknown provider name.
    await store.setEnabled("identity" as never, "member", true);
    await store.setEnabled("codex", "member", true);
    expect(await store.claim(claim("codex"))).toEqual({ kind: "blocked" });
    await store.setEnabled("codex", "shared-name", true);
    expect(await store.claim(claim("codex"))).toEqual({ kind: "created" });
  });

  test("a disabled pool blocks a claim even when its member has a claim history", async () => {
    const store = new MemoryAutoResetStore(() => NOW);
    await store.setEnabled("claude", "shared-name", true);
    expect(await store.claim(claim("claude"))).toEqual({ kind: "created" });
    await store.finish("event-claude", "reset", "credit-claude");
    await store.setEnabled("claude", "shared-name", false);
    const next = claim("claude", { eventKey: "event-claude-2", creditId: "credit-claude-2", redeemRequestId: "request-claude-2" });
    expect(await store.claim(next)).toEqual({ kind: "blocked" });
    expect(await store.lastMemberClaim("claude", "member")).toMatchObject({ status: "reset" });
  });
});

describe("Claude recovery on the shared engine", () => {
  function harness(provider: AutoResetProvider, store: MemoryAutoResetStore) {
    const spends: string[] = [];
    const logs: string[] = [];
    let recovered = false;
    const recovery = createAutoResetRecovery({
      provider, store, now: () => NOW, confirmationBudgetMs: 55, log: (line) => logs.push(line),
      pools: async () => [{ name: "claude-fixture-pool", members: ["alpha", "beta"] }],
      freshUsage: async () => provider === "claude" ? claudeUsage(recovered ? 4 : 100) : codexUsage(recovered ? 4 : 100),
      readCredits: async (identity) => credit(`${provider}-${GRANT}-${identity}`),
      spend: async (identity, creditId) => { spends.push(`${identity}:${creditId}`); recovered = true; return { result: "reset", creditId }; },
    });
    return { recovery, spends, logs };
  }
  const input = () => ({ members: ["alpha", "beta"], reservePercent: 90, signal: AbortSignal.timeout(2_500) });

  test("a pool setting alone lets the Claude engine spend one grant, and the audit names the provider", async () => {
    const store = new MemoryAutoResetStore(() => NOW);
    const h = harness("claude", store);
    expect(await h.recovery.enabled()).toBe(false);
    expect(await h.recovery.recover(input())).toBeUndefined();
    expect(h.spends).toEqual([]);
    await store.setEnabled("claude", "claude-fixture-pool", true);
    expect(await h.recovery.enabled()).toBe(true);
    expect(await h.recovery.recover(input())).toBe("alpha");
    expect(h.spends).toEqual([`alpha:claude-${GRANT}-alpha`]);
    expect(await store.lastClaim("claude", "claude-fixture-pool")).toMatchObject({ identity: "alpha", status: "reset" });
    const audit = h.logs.map((line) => JSON.parse(line) as { event: string; provider: string; status: string });
    expect(audit.map((row) => [row.event, row.provider, row.status])).toEqual([
      ["claude-auto-reset", "claude", "pending"], ["claude-auto-reset", "claude", "reset"],
    ]);
  });

  test("a Codex pool setting does not enable the Claude engine", async () => {
    const store = new MemoryAutoResetStore(() => NOW);
    await store.setEnabled("codex", "claude-fixture-pool", true);
    const h = harness("claude", store);
    expect(await h.recovery.enabled()).toBe(false);
    expect(await h.recovery.recover(input())).toBeUndefined();
    expect(h.spends).toEqual([]);
  });

  test("the Claude engine needs seven-day proof, so Codex week windows spend nothing", async () => {
    const store = new MemoryAutoResetStore(() => NOW);
    await store.setEnabled("claude", "claude-fixture-pool", true);
    const spends: string[] = [];
    const recovery = createAutoResetRecovery({
      provider: "claude", store, now: () => NOW, confirmationBudgetMs: 55, log: () => {},
      pools: async () => [{ name: "claude-fixture-pool", members: ["alpha", "beta"] }],
      freshUsage: async () => codexUsage(),
      readCredits: async () => credit(GRANT),
      spend: async (identity) => { spends.push(identity); return { result: "reset" }; },
    });
    expect(await recovery.recover(input())).toBeUndefined();
    expect(spends).toEqual([]);
  });

  test("two providers with equal member names keep separate claim keys", async () => {
    const store = new MemoryAutoResetStore(() => NOW);
    await store.setEnabled("claude", "claude-fixture-pool", true);
    await store.setEnabled("codex", "claude-fixture-pool", true);
    const claude = harness("claude", store);
    expect(await claude.recovery.recover(input())).toBe("alpha");
    const codex = harness("codex", store);
    expect(await codex.recovery.recover(input())).toBe("alpha");
    expect(await store.lastClaim("claude", "claude-fixture-pool")).toMatchObject({ status: "reset" });
    expect(await store.lastClaim("codex", "claude-fixture-pool")).toMatchObject({ status: "reset" });
  });
});
