import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchClaudeLimits, windowsFromUsageBody } from "../../../src/cli/limits/claude-limits.ts";
import { carriedManualReset, manualResetFromCedarEmber, resetGrantKind } from "../../../src/identities/claude-usage-api.ts";

// Synthetic fixture shaped like GET /api/oauth/usage?cedar_ember=1 near a limit: one full reset and one Fable-only reset.
const NOW = Date.parse("2026-11-12T08:00:00Z");
const FULL_ID = "full-reset-2611-SYNTHETIC_FIXTURE";
const FABLE_ID = "launch-2610-fable-SYNTHETIC_FIXTURE";
const OLD_ID = "promo-reset-SYNTHETIC_FIXTURE";
const CEDAR = {
  eligible: true,
  exhausted: [{ id: OLD_ID, label: "Earlier usage-limit reset", resets_left: 0, usable_now: false, paused: false, ends_at: "2026-12-01T00:00:00Z" }],
  grants: [
    { id: FULL_ID, label: "One full limit reset (November 2026)", resets_left: 1, usable_now: true, paused: false, ends_at: "2026-11-30T23:59:59Z" },
    { id: FABLE_ID, label: "New model launch: one Fable reset", resets_left: 1, usable_now: true, paused: false, ends_at: "2026-11-20T00:00:00Z" },
  ],
  next_grant_id: FULL_ID,
  weekly_resets_at: "2026-11-15T00:00:00Z",
  cooldown_until: null,
};
const LIMITS = [
  { kind: "session", percent: 97, resets_at: "2026-11-12T10:00:00Z", scope: null },
  { kind: "weekly_all", percent: 60, resets_at: "2026-11-15T00:00:00Z", scope: null },
  { kind: "weekly_scoped", percent: 100, resets_at: "2026-11-15T00:00:00Z", scope: { model: { id: null, display_name: "Fable" }, surface: null } },
];

describe("cedar_ember grants", () => {
  test("every grant is kept with its kind, count and expiry; exhausted ones are listed as used up", () => {
    const info = manualResetFromCedarEmber(CEDAR, NOW)!;
    expect(info.availableCount).toBe(2);
    expect(info.label).toBe("One full limit reset (November 2026)");
    expect(info.grants).toEqual([
      { id: FULL_ID, label: "One full limit reset (November 2026)", kind: "full", resetsLeft: 1, usableNow: true, paused: false, endsAt: "2026-11-30T23:59:59.000Z" },
      { id: FABLE_ID, label: "New model launch: one Fable reset", kind: "fable", resetsLeft: 1, usableNow: true, paused: false, endsAt: "2026-11-20T00:00:00.000Z" },
      { id: OLD_ID, label: "Earlier usage-limit reset", kind: "other", resetsLeft: 0, usableNow: false, paused: false, endsAt: "2026-12-01T00:00:00.000Z" },
    ]);
    expect(info.grantsCapturedAt).toBe(new Date(NOW).toISOString());
    expect(info.cooldownUntil).toBeUndefined();
  });

  test("kind comes from id or label", () => {
    expect(resetGrantKind(FABLE_ID)).toBe("fable");
    expect(resetGrantKind("x-SYNTHETIC_FIXTURE", "One Fable reset")).toBe("fable");
    expect(resetGrantKind(FULL_ID)).toBe("full");
    expect(resetGrantKind("x-SYNTHETIC_FIXTURE", "one usage-limit reset")).toBe("other");
  });

  test("usable_now false, a cooldown and an ineligible account are honoured", () => {
    const off = manualResetFromCedarEmber({ ...CEDAR, grants: [{ ...CEDAR.grants[0], usable_now: false }] }, NOW)!;
    expect(off.availableCount).toBe(0);
    const cool = manualResetFromCedarEmber({ ...CEDAR, cooldown_until: "2026-11-12T09:00:00Z" }, NOW)!;
    expect(cool.cooldownUntil).toBe("2026-11-12T09:00:00.000Z");
    expect(manualResetFromCedarEmber({ ...CEDAR, eligible: false }, NOW)!.availableCount).toBe(0);
  });

  test("a carried list is marked stale, drops ended grants and keeps its capture time", () => {
    const seen = manualResetFromCedarEmber(CEDAR, NOW)!;
    const later = NOW + 10 * 86400_000; // past the Fable grant's end
    const carried = carriedManualReset(seen, later)!;
    expect(carried.stale).toBe(true);
    expect(carried.availableCount).toBe(0);
    expect(carried.grantsCapturedAt).toBe(seen.grantsCapturedAt);
    expect(carried.grants!.map((g) => g.id)).toEqual([FULL_ID, OLD_ID]);
    expect(carriedManualReset({ availableCount: 1 }, later)).toBeUndefined();
    expect(carriedManualReset(undefined, later)).toBeUndefined();
  });

  test("the per-model weekly window is read from limits[]", () => {
    expect(windowsFromUsageBody({ limits: LIMITS }).map((w) => [w.label, w.usedPercent])).toEqual([
      ["session (5h)", 97],
      ["week (all)", 60],
      ["week (Fable)", 100],
    ]);
  });
});

describe("fetchClaudeLimits keeps the last seen grant list", () => {
  const id = { name: "acct-synthetic", label: "Acct", configDir: "/nonexistent/acct" };
  const common = { reconcile: async () => undefined as never };

  test("a later read without cedar_ember carries the grants (stale) instead of dropping them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ais-resets-"));
    const first = await fetchClaudeLimits(id, { ...common, cacheDir: dir, fetchBody: async () => ({ body: { limits: LIMITS, cedar_ember: CEDAR } }) });
    expect(first.manualReset?.grants?.length).toBe(3);
    expect(first.manualReset?.stale).toBeUndefined();
    // Age the stored read past the shared fresh-read TTL so the next call fetches again.
    const file = join(dir, "claude-limits", `${id.name}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), capturedAt: new Date(Date.now() - 120_000).toISOString() }));
    const second = await fetchClaudeLimits(id, { ...common, cacheDir: dir, fetchBody: async () => ({ body: { limits: LIMITS } }) });
    expect(second.status).toBe("live");
    expect(second.manualReset?.stale).toBe(true);
    expect(second.manualReset?.grants?.map((g) => g.kind).sort()).toEqual(["fable", "full", "other"]);
    expect(second.manualReset?.grantsCapturedAt).toBe(first.manualReset?.grantsCapturedAt);
    // A 429 serves the stored read, grants included.
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), capturedAt: new Date(Date.now() - 120_000).toISOString() }));
    const limited = await fetchClaudeLimits(id, { ...common, cacheDir: dir, fetchBody: async () => ({ error: "usage endpoint answered HTTP 429", status: 429 }) });
    expect(limited.status).toBe("cached");
    expect(limited.manualReset?.grants?.length).toBe(3);
  });
});
