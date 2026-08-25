import { describe, expect, test } from "bun:test";
import { runBatched } from "../../../src/cli/limits/collect.ts";

describe("runBatched", () => {
  test("resolves every item, in original order, regardless of completion order", async () => {
    const delays = [30, 10, 20];
    const results = await runBatched(delays, 3, async (ms) => {
      await Bun.sleep(ms);
      return ms;
    });
    expect(results).toEqual(delays);
  });

  test("never runs more than `limit` items concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    await runBatched([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(5);
      active--;
      return n;
    });
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  test("onItemDone fires with each item's ORIGINAL index as it resolves, not worker claim order", async () => {
    // Item 0 is slower than item 1 — with limit=2 both start immediately,
    // but item 1 finishes first. onItemDone must report index 1 before
    // index 0, proving it's keyed to the original position, not call order.
    const done: Array<{ index: number; result: string }> = [];
    const results = await runBatched(
      [30, 5],
      2,
      async (ms) => {
        await Bun.sleep(ms);
        return `took-${ms}`;
      },
      (index, result) => done.push({ index, result }),
    );
    expect(results).toEqual(["took-30", "took-5"]);
    expect(done).toEqual([
      { index: 1, result: "took-5" },
      { index: 0, result: "took-30" },
    ]);
  });

  test("an empty item list resolves to an empty array without calling fn", async () => {
    let calls = 0;
    const results = await runBatched([] as number[], 4, async (n) => {
      calls++;
      return n;
    });
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });
});
