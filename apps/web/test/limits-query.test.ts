import { describe, expect, test } from "bun:test";
import { canSpendCodexReset, creditsAreLastKnown, spendCreditSentence, SPEND_LOCK_MS } from "../src/lib/codex-reset.ts";
import { adjustRefreshCounts, applyRefreshedLimits, isIdentityRefreshing, limitsRefetchInterval, POLL, reconcileLimits } from "../src/lib/limits-reconciliation.ts";
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

describe("manual refresh of limits", () => {
  const registryIdentity = (name: string) => ({ name, label: `Registry ${name}`, configDir: "synthetic" });

  test("a refreshed row replaces the row on screen, even a failed read, and keeps the other rows", () => {
    const stale: ToolLimitResult = { ...codexRow("member-a", 90, 1, 31_000), status: "cached", identity: registryIdentity("SYNTHETIC_FIXTURE-member-a") };
    const other = codexRow("member-b", 40, 2);
    const failed: ToolLimitResult = { ...stale, error: "OpenAI rejected this Codex login (refresh_token_invalidated).", identity: { name: stale.identity.name, label: stale.identity.name, configDir: "" } };
    delete (failed as { resetPendingUntil?: number }).resetPendingUntil;

    const next = applyRefreshedLimits(payload(stale, other), [payload(failed)]);
    expect(next?.results[0]).toMatchObject({ status: "cached", error: "OpenAI rejected this Codex login (refresh_token_invalidated)." });
    expect(next?.results[0]?.identity.label).toBe("Registry SYNTHETIC_FIXTURE-member-a");
    expect(next?.results[0]).not.toHaveProperty("resetPendingUntil");
    expect(next?.results[1]).toBe(other);
  });

  test("a fresher reading replaces an older one", () => {
    const next = applyRefreshedLimits(payload(codexRow("member-a", 90, 1)), [payload(codexRow("member-a", 5, 500))]);
    expect(next?.results[0]?.windows[0]?.usedPercent).toBe(5);
  });

  test("an empty answer or no cached data changes nothing", () => {
    const current = payload(codexRow("member-a", 90, 1));
    expect(applyRefreshedLimits(current, [payload()])).toBe(current);
    expect(applyRefreshedLimits(undefined, [current])).toBeUndefined();
  });
});

describe("the Codex use-reset button", () => {
  const withReset = (over: Partial<ToolLimitResult> = {}, reset: Partial<NonNullable<ToolLimitResult["manualReset"]>> = {}): ToolLimitResult => ({
    ...codexRow("member-a", 100, 1),
    manualReset: { availableCount: 2, ...reset },
    ...over,
  });

  test("shows for a live reading", () => {
    expect(canSpendCodexReset(withReset())).toBe(true);
  });

  test("still shows when the reading is cached, unavailable or the credit list is the last known one", () => {
    expect(canSpendCodexReset(withReset({ status: "cached", error: "OpenAI rejected this Codex login" }))).toBe(true);
    expect(canSpendCodexReset(withReset({ status: "unavailable", windows: [] }))).toBe(true);
    expect(canSpendCodexReset(withReset({}, { stale: true }))).toBe(true);
  });

  test("hides with no credit, for a retired or pooled identity, and for a row the gateway does not manage", () => {
    expect(canSpendCodexReset(withReset({}, { availableCount: 0 }))).toBe(false);
    expect(canSpendCodexReset(withReset({ identity: { ...registryIdentityOf("a"), retired: true } }))).toBe(false);
    expect(canSpendCodexReset(withReset({ gatewayManaged: false }))).toBe(false);
    expect(canSpendCodexReset({ ...withReset(), manualReset: undefined })).toBe(false);
    expect(canSpendCodexReset({ ...withReset(), toolName: "claude" })).toBe(false);
  });

  test("hides right after a spend and during the recheck, so one click cannot spend two credits", () => {
    const now = 1_000_000;
    expect(canSpendCodexReset(withReset({}, { spentAt: now - 1_000 }), now)).toBe(false);
    expect(canSpendCodexReset(withReset({}, { spentAt: now - SPEND_LOCK_MS - 1 }), now)).toBe(true);
    expect(canSpendCodexReset(withReset({ resetPendingUntil: now + 10_000 }), now)).toBe(false);
  });
});

function registryIdentityOf(name: string) {
  return { name: `SYNTHETIC_FIXTURE-${name}`, label: name, configDir: "synthetic" };
}

describe("the spend lock survives the server rows", () => {
  const spentRow = (spentAt: number): ToolLimitResult => ({ ...codexRow("member-a", 100, 1), manualReset: { availableCount: 1, stale: true, spentAt } });
  const serverRow = (captured: number): ToolLimitResult => ({ ...codexRow("member-a", 100, captured), manualReset: { availableCount: 1 } });
  const now = 1_000_000;

  test("a poll that returns the server reset keeps spentAt, so the button stays hidden for the lock time", () => {
    const next = reconcileLimits(payload(spentRow(now - 1_000)), payload(serverRow(5)), now);
    expect(next.results[0]?.manualReset?.spentAt).toBe(now - 1_000);
    expect(canSpendCodexReset(next.results[0]!, now)).toBe(false);
    expect(canSpendCodexReset(next.results[0]!, now + SPEND_LOCK_MS)).toBe(true);
  });

  test("a manual refresh keeps spentAt too", () => {
    const next = applyRefreshedLimits(payload(spentRow(now - 1_000)), [payload(serverRow(5))]);
    expect(next?.results[0]?.manualReset?.spentAt).toBe(now - 1_000);
  });

  test("a row that was never spent gains no spentAt", () => {
    const next = reconcileLimits(payload(codexRow("member-a", 100, 1)), payload(serverRow(5)), now);
    expect(next.results[0]?.manualReset).not.toHaveProperty("spentAt");
  });
});

describe("overlapping refresh calls", () => {
  test("a card keeps spinning until the last call that covers it ends", () => {
    const empty = new Map<string, number>();
    const one = adjustRefreshCounts(empty, [{ tool: "codex", identity: "a" }], 1);
    const both = adjustRefreshCounts(one, [{ tool: "codex", identity: "a" }, { tool: "codex", identity: "b" }], 1);
    const firstEnded = adjustRefreshCounts(both, [{ tool: "codex", identity: "a" }], -1);
    expect(isIdentityRefreshing(firstEnded, "codex", "a")).toBe(true);
    expect(isIdentityRefreshing(firstEnded, "codex", "b")).toBe(true);
    const secondEnded = adjustRefreshCounts(firstEnded, [{ tool: "codex", identity: "a" }, { tool: "codex", identity: "b" }], -1);
    expect(isIdentityRefreshing(secondEnded, "codex", "a")).toBe(false);
    expect(secondEnded.size).toBe(0);
  });

  test("a call for a whole tool covers every identity of that tool, and no other tool", () => {
    const counts = adjustRefreshCounts(new Map(), [{ tool: "codex" }], 1);
    expect(isIdentityRefreshing(counts, "codex", "a")).toBe(true);
    expect(isIdentityRefreshing(counts, "claude", "a")).toBe(false);
  });
});

describe("the spend dialog on a cached card", () => {
  test("a live count is a fact, and a cached one says last known with its age", () => {
    expect(spendCreditSentence(3, false, undefined)).toBe("This spends one of 3 available reset credits on this Codex account.");
    const now = Date.parse("2026-11-27T10:00:00.000Z");
    const text = spendCreditSentence(3, true, "2026-11-27T09:50:00.000Z", now);
    expect(text).toContain("last known count is 3");
    expect(text).toContain("10m");
    expect(text).not.toContain("available reset credits");
    expect(creditsAreLastKnown({ ...codexRow("a", 1, 1), status: "cached" })).toBe(true);
    expect(creditsAreLastKnown({ ...codexRow("a", 1, 1), manualReset: { availableCount: 1, stale: true } })).toBe(true);
    expect(creditsAreLastKnown({ ...codexRow("a", 1, 1), manualReset: { availableCount: 1 } })).toBe(false);
  });
});
