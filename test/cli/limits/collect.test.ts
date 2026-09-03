import { describe, expect, test } from "bun:test";
import { aggregateLimitResults, runBatched } from "../../../src/cli/limits/collect.ts";
import type { ToolLimitResult } from "../../../src/cli/limits/types.ts";
import type { Identity } from "../../../src/identities/types.ts";

function identity(name: string): Identity {
  return { name, label: name, configDir: `/tmp/does-not-exist/${name}` };
}

function row(overrides: Partial<ToolLimitResult> & Pick<ToolLimitResult, "toolName" | "provider" | "status">): ToolLimitResult {
  return { identity: identity("acme"), windows: [], ...overrides };
}

describe("aggregateLimitResults", () => {
  test("merges the same provider+identity reached through two sources into one row", async () => {
    // A Z.ai key imported into Pi is the same account the zai tool queries —
    // without merging, the provider-first report would show two acme
    // branches under Z.ai.
    const merged = aggregateLimitResults([
      row({ toolName: "zai", provider: "zai", identity: identity("acme"), status: "unavailable", error: "quota fetch failed: timeout" }),
      row({
        toolName: "pi",
        provider: "zai",
        identity: identity("acme"),
        status: "live",
        windows: [{ label: "session", category: "session", usedPercent: 10 }],
      }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.toolName).toBe("pi");
    expect(merged[0]!.status).toBe("live");
    expect(merged[0]!.windows).toHaveLength(1);
    // A live answer makes the duplicate source's failure irrelevant.
    expect(merged[0]!.error).toBeUndefined();
  });

  test("when both sources fail, their reasons merge instead of one hiding the other", () => {
    const merged = aggregateLimitResults([
      row({ toolName: "zai", provider: "zai", identity: identity("acme"), status: "unavailable", error: "quota fetch timed out" }),
      row({ toolName: "pi", provider: "zai", identity: identity("acme"), status: "unavailable", error: "quota fetch timed out" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.error).toBe("quota fetch timed out");
  });

  test("canonical aliases collapse onto one row", () => {
    const merged = aggregateLimitResults([
      row({ toolName: "pi", provider: "kimi-coding", identity: identity("acme"), status: "unavailable", error: "x" }),
      row({ toolName: "kimi", provider: "kimi", identity: identity("acme"), status: "unavailable", error: "y" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.provider).toBe("kimi");
    expect(merged[0]!.error).toBe("x; y");
  });

  test("a resolved result supersedes a pending placeholder for the same key", () => {
    const merged = aggregateLimitResults([
      row({ toolName: "kimi", provider: "kimi", identity: identity("acme"), status: "pending" }),
      row({ toolName: "kimi", provider: "kimi", identity: identity("acme"), status: "unavailable", error: "not authenticated" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.status).toBe("unavailable");
  });

  test("different identities or providers stay separate, in first-appearance order", () => {
    const merged = aggregateLimitResults([
      row({ toolName: "claude", provider: "anthropic", identity: identity("acme"), status: "live", windows: [] }),
      row({ toolName: "pi", provider: "kimi", identity: identity("acme"), status: "live", windows: [] }),
      row({ toolName: "claude", provider: "anthropic", identity: identity("other"), status: "live", windows: [] }),
    ]);
    expect(merged.map((r) => `${r.provider}/${r.identity.name}`)).toEqual(["anthropic/acme", "kimi/acme", "anthropic/other"]);
  });
});

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
