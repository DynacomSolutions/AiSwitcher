import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateLimitResults, collectLimitTargets, fetchLimitResults, isMirroredPoolTarget, pendingLimitResult, runBatched } from "../../../src/cli/limits/collect.ts";
import type { ToolLimitResult } from "../../../src/cli/limits/types.ts";
import type { Identity, ToolConfig } from "../../../src/identities/types.ts";

function identity(name: string): Identity {
  return { name, label: name, configDir: `/tmp/does-not-exist/${name}` };
}

function target(toolName: ToolConfig["toolName"], name = "acme") {
  return { toolName, identity: identity(name) };
}

function row(overrides: Partial<ToolLimitResult> & Pick<ToolLimitResult, "toolName" | "provider" | "status">): ToolLimitResult {
  return { identity: identity("acme"), windows: [], ...overrides };
}

describe("pendingLimitResult", () => {
  test("1:1 tools seed a pending row under their known provider", async () => {
    const [pending] = await pendingLimitResult(target("claude"));
    expect(pending!.provider).toBe("anthropic");
    expect(pending!.status).toBe("pending");
  });

  test("multi-provider clients with no readable auth store seed nothing", async () => {
    expect(await pendingLimitResult(target("pi"))).toEqual([]);
    expect(await pendingLimitResult(target("opencode"))).toEqual([]);
  });

  test("pi and opencode seed one pending row per fetchable provider, skipping native-covered ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ais-pending-"));
    try {
      const piDir = join(dir, "pi");
      const ocDir = join(dir, "oc");
      mkdirSync(piDir, { recursive: true });
      mkdirSync(join(ocDir, "data", "opencode"), { recursive: true });
      writeFileSync(join(piDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth" }, zai: { key: "k" }, "opencode-go": { key: "k" } }));
      writeFileSync(join(ocDir, "data", "opencode", "auth.json"), JSON.stringify({ alibaba_token_plan: { key: "k" }, zai_coding_plan: { key: "k" } }));
      const pi = await pendingLimitResult({ toolName: "pi", identity: { ...identity("a"), configDir: piDir } });
      const oc = await pendingLimitResult({ toolName: "opencode", identity: { ...identity("a"), configDir: ocDir } });
      expect(pi.map((r) => r.provider)).toEqual(["zai", "opencode-go"]);
      expect(oc.map((r) => r.provider)).toEqual(["zai"]);
      expect([...pi, ...oc].every((r) => r.status === "pending")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cached-mode results", () => {
  test("1:1 tools report their honest cached-unavailable row", async () => {
    const results = await fetchLimitResults([target("claude")], true, false);
    expect(results).toHaveLength(1);
    expect(results[0]!.provider).toBe("anthropic");
    expect(results[0]!.status).toBe("unavailable");
  });

  test("multi-provider clients render nothing unscoped; an explicit --tool= still gets an honest row", async () => {
    const targets = [target("pi"), target("opencode")];
    expect(await fetchLimitResults(targets, true, false)).toEqual([]);

    const explicit = await fetchLimitResults([targets[0]!], true, true);
    expect(explicit).toHaveLength(1);
    expect(explicit[0]!.status).toBe("unavailable");
    expect(explicit[0]!.error).toContain("cached data not available");
  });
});

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

describe("collectLimitTargets with duplicate pool records", () => {
  test("two pool records sharing a configDir produce only one limits target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ais-limits-pool-"));
    try {
      const identitiesJsonPath = join(dir, "identities.json");
      writeFileSync(identitiesJsonPath, JSON.stringify({
        version: 1,
        identities: [
          { name: "a", label: "a", configDir: join(dir, "a") },
          { name: "b", label: "b", configDir: join(dir, "b") },
          { name: "pool", label: "pool", configDir: join(dir, "pool"), swapPool: { accounts: ["a", "b"], active: "a" } },
          { name: "pool-dup", label: "pool-dup", configDir: join(dir, "pool"), swapPool: { accounts: ["a", "b"], active: "a" } },
        ],
      }));
      const cfg = { toolName: "claude", identitiesJsonPath } as ToolConfig;
      expect((await collectLimitTargets(undefined, {}, [cfg])).map((t) => t.identity.name)).toEqual(["a", "b", "pool"]);
      // A filter naming the duplicate record redirects to the canonical pool.
      expect((await collectLimitTargets("pool-dup", {}, [cfg])).map((t) => t.identity.name)).toEqual(["pool"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isMirroredPoolTarget", () => {
  const pool = (active?: string) => ({
    toolName: "claude" as const,
    identity: { ...identity("pool-x"), swapPool: { accounts: ["a"], ...(active ? { active } : {}) } },
  });

  test("a pool whose active member is also a target is skipped; others are not", () => {
    const member = target("claude", "a");
    const p = pool("a");
    expect(isMirroredPoolTarget(p, [member, p])).toBe(true);
    expect(isMirroredPoolTarget(member, [member, p])).toBe(false);
    expect(isMirroredPoolTarget(p, [p])).toBe(false);
    expect(isMirroredPoolTarget(pool(), [member, pool()])).toBe(false);
  });

  test("codex pools mirror their active codex member, never a same-named claude one", () => {
    const p = { ...pool("a"), toolName: "codex" as const };
    expect(isMirroredPoolTarget(p, [target("codex", "a"), p])).toBe(true);
    expect(isMirroredPoolTarget(p, [target("claude", "a"), p])).toBe(false);
  });
});
