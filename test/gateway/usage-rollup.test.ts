import { describe, expect, test } from "bun:test";
import { planRollupRange, rollupAggregateSql, rollupSource } from "../../src/gateway/usage-rollup.ts";

const d = (s: string): Date => new Date(s);

describe("planRollupRange", () => {
  test("splits an unaligned range into raw edges and an aligned middle", () => {
    expect(planRollupRange(d("2026-11-02T00:07:00.000Z"), d("2026-11-02T01:41:00.000Z"))).toEqual({
      start: "2026-11-02T00:15:00.000Z",
      end: "2026-11-02T01:30:00.000Z",
      head: { start: "2026-11-02T00:07:00.000Z", end: "2026-11-02T00:15:00.000Z" },
      tail: { start: "2026-11-02T01:30:00.000Z", end: "2026-11-02T01:41:00.000Z" },
    });
  });

  test("an aligned range has no edges", () => {
    expect(planRollupRange(d("2026-11-02T00:15:00.000Z"), d("2026-11-02T01:30:00.000Z"))).toEqual({
      start: "2026-11-02T00:15:00.000Z",
      end: "2026-11-02T01:30:00.000Z",
    });
  });

  test("an open end has no tail", () => {
    expect(planRollupRange(d("2026-11-02T00:07:00.000Z"))).toEqual({
      start: "2026-11-02T00:15:00.000Z",
      end: null,
      head: { start: "2026-11-02T00:07:00.000Z", end: "2026-11-02T00:15:00.000Z" },
    });
    expect(planRollupRange(d("1970-01-01T00:00:00.000Z"))).toEqual({ start: "1970-01-01T00:00:00.000Z", end: null });
  });

  test("a range shorter than one bucket reads the raw ledger", () => {
    expect(planRollupRange(d("2026-11-02T00:01:00.000Z"), d("2026-11-02T00:14:00.000Z"))).toBeUndefined();
    expect(planRollupRange(d("2026-11-02T00:01:00.000Z"), d("2026-11-02T00:29:00.000Z"))).toBeUndefined();
    expect(planRollupRange(d("2026-11-02T00:15:00.000Z"), d("2026-11-02T00:15:00.000Z"))).toBeUndefined();
    expect(planRollupRange(d("2026-11-02T00:20:00.000Z"), d("2026-11-02T00:10:00.000Z"))).toBeUndefined();
  });
});

describe("rollupSource", () => {
  test("uses one parameter per bound and reuses the zone", () => {
    const plan = planRollupRange(d("2026-11-02T00:07:00.000Z"), d("2026-11-02T01:41:00.000Z"));
    if (!plan) throw new Error("plan expected");
    const src = rollupSource(plan, "Asia/Bangkok");
    expect(src.params).toEqual([
      "Asia/Bangkok",
      "2026-11-02T00:15:00.000Z",
      "2026-11-02T01:30:00.000Z",
      "2026-11-02T00:07:00.000Z",
      "2026-11-02T00:15:00.000Z",
      "2026-11-02T01:30:00.000Z",
      "2026-11-02T01:41:00.000Z",
    ]);
    expect(src.text.match(/UNION ALL/g)?.length).toBe(2);
    const sql = rollupAggregateSql(src, "day, provider, identity, model", "day, provider, identity, model");
    expect(sql.text).toContain("GROUP BY day, provider, identity, model ORDER BY day, provider, identity, model");
  });
});
