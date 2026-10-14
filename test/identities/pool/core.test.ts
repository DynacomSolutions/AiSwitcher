import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PoolAdapter, PoolUsage } from "../../../src/identities/pool/adapter.ts";
import { appendSwapEvent, ledgerPathFor, readSwapEvents } from "../../../src/identities/pool/ledger.ts";
import { chooseBest, swapIfLimited } from "../../../src/identities/pool/ops.ts";
import { PoolSwapScheduler } from "../../../src/identities/pool/scheduler.ts";
import { aisClaudeSwapLedgerPath, aisSwapLedgerPath } from "../../../src/shared/ais-home.ts";
import { CLAUDE_CONFIG } from "../../../src/identities/tool-configs.ts";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ais-pool-core-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const live = (maxUtilization: number): PoolUsage => ({ status: "live", maxUtilization, capturedAt: "x" });

function fakeAdapter(tool: "claude" | "codex", registry: string, util: Record<string, number>): PoolAdapter {
  return {
    tool,
    config: { ...CLAUDE_CONFIG, toolName: tool, identitiesJsonPath: registry },
    liveSwap: false,
    hasCredentials: () => true,
    swapCredentials: async ({ pool, target }) => ({ pool: pool.name, from: pool.swapPool.active ?? null, to: target.name, noop: false, writeBack: "none-identical", notes: [] }),
    fetchUsage: async (m) => live(util[m.name] ?? 0),
  };
}

async function writeRegistry(path: string, auto = true): Promise<void> {
  const member = (name: string) => ({ name, label: name, configDir: join(root, name) });
  await writeFile(path, JSON.stringify({ version: 1, identities: [member("a"), member("b"), { ...member("pool"), swapPool: { accounts: ["a", "b"], active: "a", auto } }] }));
}

describe("generic pool core", () => {
  test("chooseBest ranks by headroom and honours threshold", () => {
    const rows = [{ name: "a", usage: live(80) }, { name: "b", usage: live(10) }, { name: "c" }];
    expect(chooseBest(rows, {})).toBe("b");
    expect(chooseBest(rows, { exclude: "b" })).toBe("a");
    expect(chooseBest(rows, { belowPercent: 5, requireKnown: true })).toBeUndefined();
  });

  test("swapIfLimited swaps through the fake adapter and writes the per-tool ledger", async () => {
    const registry = join(root, "codex.json");
    await writeRegistry(registry);
    const ledger = join(root, "codex-swap.jsonl");
    const adapter = fakeAdapter("codex", registry, { a: 99, b: 5 });
    const r = await swapIfLimited(adapter, { ledgerPath: ledger }, "pool", "auto");
    expect(r.action === "swapped" && r.result.to).toBe("b");
    expect((await readSwapEvents(ledger))[0]).toMatchObject({ pool: "pool", from: "a", to: "b", reason: "auto" });
    const again = await swapIfLimited(adapter, { ledgerPath: ledger, now: () => Date.now() + 1000 }, "pool", "auto");
    expect(again.action).toBe("cooldown");
  });

  test("ledger path is per tool and claude stays claude-swap.jsonl", async () => {
    expect(aisSwapLedgerPath("codex", root)).toBe(join(root, ".ais", "state", "codex-swap.jsonl"));
    expect(aisClaudeSwapLedgerPath(root)).toBe(aisSwapLedgerPath("claude", root));
    expect(aisClaudeSwapLedgerPath(root).endsWith("/claude-swap.jsonl")).toBe(true);
    expect(ledgerPathFor("codex").endsWith("/codex-swap.jsonl")).toBe(true);
    const p = join(root, "x", "t-swap.jsonl");
    await appendSwapEvent({ ts: new Date().toISOString(), pool: "p", from: null, to: "a", reason: "manual" }, p);
    expect((await readFile(p, "utf8")).trim().startsWith("{")).toBe(true);
  });

  test("daemon iterates every adapter's registry", async () => {
    const r1 = join(root, "claude.json");
    const r2 = join(root, "codex.json");
    await writeRegistry(r1);
    await writeRegistry(r2);
    const seen: string[] = [];
    const sched = new PoolSwapScheduler({
      adapters: () => [fakeAdapter("claude", r1, {}), fakeAdapter("codex", r2, {})],
      random: () => 0,
      log: () => {},
      check: async (a, pool) => { seen.push(`${a.tool}:${pool}`); return { action: "not-limited" }; },
    });
    await sched.tick(1_000_000);
    expect(seen).toEqual(["claude:pool", "codex:pool"]);
    const st = await sched.status();
    expect(st.pools.map((p) => p.tool)).toEqual(["claude", "codex"]);
  });
});
