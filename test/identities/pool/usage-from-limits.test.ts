import { describe, expect, test } from "bun:test";
import type { LimitWindow, ManualResetInfo } from "../../../src/cli/limits/types.ts";
import { usageFromLimits } from "../../../src/identities/pool/grant-file-adapter.ts";

const win = (usedPercent: number): LimitWindow => ({ label: "week", category: "week", usedPercent });
const grants = (id: string): ManualResetInfo => ({
  availableCount: 1,
  grants: [{ id, kind: "full", resetsLeft: 1, usableNow: true, paused: false }],
});
const A = grants("full-reset-SYNTHETIC_FIXTURE-a");
const B = grants("full-reset-SYNTHETIC_FIXTURE-b");

describe("usageFromLimits reset grants", () => {
  test("the first live result's grants ride on the pool reading", () => {
    const u = usageFromLimits([
      { status: "live", windows: [win(40)], manualReset: A },
      { status: "live", windows: [win(10)], manualReset: B },
    ]);
    expect(u).toMatchObject({ status: "live", maxUtilization: 40 });
    expect(u.manualReset).toEqual(A);
  });

  test("an unavailable result's grants never count; a later live one wins", () => {
    const u = usageFromLimits([
      { status: "unavailable", windows: [], error: "no login", manualReset: A },
      { status: "live", windows: [win(10)], manualReset: B },
    ]);
    expect(u.manualReset).toEqual(B);
  });

  test("a rate-limited reading at 100% keeps its grants", () => {
    const u = usageFromLimits([{ status: "rate-limited", windows: [win(100)], manualReset: A }]);
    expect(u).toMatchObject({ status: "rate-limited", maxUtilization: 100 });
    expect(u.manualReset).toEqual(A);
  });

  test("no grants anywhere emits none, and an all-unavailable reading stays honest", () => {
    expect(usageFromLimits([{ status: "live", windows: [win(10)] }]).manualReset).toBeUndefined();
    const down = usageFromLimits([{ status: "unavailable", windows: [], error: "no login", manualReset: A }], "no login");
    expect(down).toMatchObject({ status: "unavailable", error: "no login" });
    expect(down.manualReset).toBeUndefined();
  });
});