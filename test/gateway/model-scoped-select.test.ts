import { describe, expect, test } from "bun:test";
import type { PoolUsage } from "../../src/identities/pool/adapter.ts";
import { memberUsages, pickIdentity, scopedModelMatches } from "../../src/gateway/select.ts";
import { summariseLimit } from "../../src/gateway/native-limit.ts";
import { parseUsageBody } from "../../src/identities/claude-usage-api.ts";
import type { GatewayApp } from "../../src/gateway/types.ts";

const FABLE = "claude-fable-5-2";
const OPUS = "claude-opus-5-5";
const RESET = "2026-11-15T00:00:00.000Z";

/** 5h/7d account windows plus a Fable weekly, the shape the claude adapter produces. */
const usage = (sevenDay: number, fable: number): PoolUsage => ({
  status: "live",
  maxUtilization: sevenDay,
  capturedAt: "2026-11-12T00:00:00.000Z",
  windows: [
    { label: "five-hour", utilization: 1 },
    { label: "seven-day", utilization: sevenDay, resetsAt: RESET },
    { label: "seven-day (Fable)", model: "Fable", utilization: fable, resetsAt: RESET },
  ],
});

const pool: GatewayApp = {
  name: "a", owner: "o", namespace: "n", provider: "claude", style: "anthropic",
  target: { kind: "pool" }, state: "active", createdAt: "2026-11-01T00:00:00.000Z",
};
const pin: GatewayApp = { ...pool, target: { kind: "pin", identity: "low" } };

// "low" has the lowest 7d but its Fable weekly is full; "high" has Fable headroom.
const readings: Record<string, PoolUsage> = { low: usage(10, 100), high: usage(40, 20) };
const deps = { usageFor: async (_p: string, id: string) => readings[id], poolMembers: async () => ["low", "high"] };

describe("model-scoped selection", () => {
  test("a Fable request avoids a member whose Fable weekly is full, even with the lowest 7d", async () => {
    expect(await pickIdentity(pool, deps, undefined, FABLE)).toEqual({ identity: "high" });
  });

  test("an Opus request still picks that member: a full Fable window never blocks Opus", async () => {
    expect(await pickIdentity(pool, deps, undefined, OPUS)).toEqual({ identity: "low" });
    expect(await pickIdentity(pool, deps)).toEqual({ identity: "low" });
  });

  test("a pinned member at 100% Fable is refused for Fable only", async () => {
    expect(await pickIdentity(pin, deps, undefined, FABLE)).toEqual({ reject: "reserve" });
    expect(await pickIdentity(pin, deps, undefined, OPUS)).toEqual({ identity: "low" });
  });

  test("no member has Fable headroom: no-headroom, and the native answer resets with the Fable week", async () => {
    const full = { ...deps, usageFor: async () => usage(10, 100) };
    expect(await pickIdentity(pool, full, undefined, FABLE)).toEqual({ reject: "no-headroom" });
    const fable = summariseLimit(await memberUsages(pool, full, FABLE), 100, new Date("2026-11-12T00:00:00.000Z"));
    expect(fable.claim).toBe("long");
    expect(fable.resetAtSec).toBe(Date.parse(RESET) / 1000);
    expect((await memberUsages(pool, full, OPUS))[0]?.windows?.some((w) => w.model)).toBe(false);
  });

  test("display names match inside model ids, case-insensitively", () => {
    expect(scopedModelMatches("Fable", FABLE)).toBe(true);
    expect(scopedModelMatches("fable", "CLAUDE-FABLE-5-2")).toBe(true);
    expect(scopedModelMatches("Opus 5", "claude-opus-5-5")).toBe(true);
    expect(scopedModelMatches("Fable", OPUS)).toBe(false);
    expect(scopedModelMatches("Fable", undefined)).toBe(false);
  });
});

describe("usage body scoped windows", () => {
  test("limits[] weekly_scoped entries become per-model windows; account windows come from limits[] too", () => {
    const u = parseUsageBody({
      limits: [
        { kind: "session", percent: 12, resets_at: "2026-11-12T05:00:00Z" },
        { kind: "weekly_all", percent: 30, resets_at: RESET },
        { kind: "weekly_scoped", percent: 100, resets_at: RESET, scope: { model: { display_name: "Fable" } } },
        { kind: "weekly_scoped", percent: 50, scope: { surface: "web" } },
      ],
    });
    expect(u.status).toBe("live");
    expect(u.fiveHour?.utilization).toBe(12);
    expect(u.sevenDay?.utilization).toBe(30);
    expect(u.maxUtilization).toBe(30); // a per-model window is not account-wide
    expect(u.scoped).toEqual([{ model: "Fable", utilization: 100, resetsAt: RESET }]);
  });

  test("older bodies' seven_day_<model> fields are read when limits[] does not name the model", () => {
    const u = parseUsageBody({
      five_hour: { utilization: 5 },
      seven_day: { utilization: 20 },
      seven_day_opus: { utilization: 70 },
      seven_day_sonnet: null,
      limits: [{ kind: "weekly_scoped", percent: 90, scope: { model: { display_name: "Opus" } } }],
    });
    expect(u.scoped).toEqual([{ model: "Opus", utilization: 90 }]);
    expect(parseUsageBody({ five_hour: { utilization: 5 }, seven_day_fable: { utilization: 99 } }).scoped).toEqual([{ model: "fable", utilization: 99 }]);
  });
});
