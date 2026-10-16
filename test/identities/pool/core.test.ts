import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PoolAdapter, PoolUsage } from "../../../src/identities/pool/adapter.ts";
import { appendSwapEvent, ledgerPathFor, readSwapEvents } from "../../../src/identities/pool/ledger.ts";
import { performPoolSwap } from "../../../src/identities/pool/swap.ts";
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

  const extra = (maxUtilization: number, available = true): PoolUsage => ({ ...live(maxUtilization), extraUsage: { enabled: true, available, label: "extra usage" } });

  test("chooseBest prefers available extra usage on equal headroom", () => {
    expect(chooseBest([{ name: "a", usage: live(100) }, { name: "b", usage: extra(100) }], {})).toBe("b");
    expect(chooseBest([{ name: "a", usage: live(50) }, { name: "b", usage: extra(60) }], {})).toBe("a");
    expect(chooseBest([{ name: "a", usage: live(100) }, { name: "b", usage: extra(100, false) }], {})).toBe("a");
  });

  describe("extra usage fallback", () => {
    const run = async (usage: Record<string, PoolUsage>) => {
      const registry = join(root, "claude.json");
      const member = (name: string) => ({ name, label: name, configDir: join(root, name) });
      await writeFile(registry, JSON.stringify({ version: 1, identities: [member("a"), member("b"), member("c"), { ...member("pool"), swapPool: { accounts: ["a", "b", "c"], active: "a", auto: true } }] }));
      const adapter: PoolAdapter = { ...fakeAdapter("claude", registry, {}), fetchUsage: async (m) => usage[m.name] ?? live(100) };
      return swapIfLimited(adapter, { ledgerPath: join(root, "claude-swap.jsonl") }, "pool", "auto");
    };

    test("everyone at 100, active without extra usage: swaps to the member that has it", async () => {
      const r = await run({ a: live(100), b: live(100), c: extra(100) });
      expect(r.action === "swapped" && r.result.to).toBe("c");
    });

    test("a rate-limited member carrying stale extra usage is chosen", async () => {
      const limited: PoolUsage = { status: "rate-limited", capturedAt: "2026-01-01T00:00:00Z", extraUsage: { enabled: true, available: true, label: "extra usage", stale: true } };
      const r = await run({ a: live(100), b: live(100), c: limited });
      expect(r.action === "swapped" && r.result.to).toBe("c");
    });

    test("active with available extra usage stays put", async () => {
      expect((await run({ a: extra(100), b: live(100), c: extra(100) })).action).toBe("no-candidate");
    });

    test("active at 96 (still has headroom) does not move to a paid member", async () => {
      expect((await run({ a: live(96), b: extra(100), c: extra(100) })).action).toBe("no-candidate");
    });

    test("a member under 100 wins over an extra-usage member", async () => {
      const r = await run({ a: live(100), b: live(90), c: extra(100) });
      expect(r.action === "swapped" && r.result.to).toBe("b");
    });
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

  test("liveSwap:false adapter still swaps and notifySwapped runs after the ledger append", async () => {
    const registry = join(root, "codex.json");
    await writeRegistry(registry);
    const ledger = join(root, "codex-swap.jsonl");
    const calls: string[] = [];
    const adapter: PoolAdapter = {
      ...fakeAdapter("codex", registry, { a: 99, b: 5 }),
      notifySwapped: async (pool, from, to) => {
        calls.push(`${pool.name}:${from}->${to}:${(await readSwapEvents(ledger)).length}`);
        return { sessions: 2 };
      },
    };
    const r = await swapIfLimited(adapter, { ledgerPath: ledger }, "pool", "auto");
    expect(r.action === "swapped" && r.result.runningSessions).toBe(2);
    expect(calls).toEqual(["pool:a->b:1"]);
    const throwing: PoolAdapter = { ...adapter, notifySwapped: async () => { throw new Error("boom"); } };
    const back = await performPoolSwap(throwing, { registryPath: registry, ledgerPath: ledger, target: "a", reason: "manual" });
    expect(back.to).toBe("a");
  });

  test("two concurrent swapIfLimited on one pool produce exactly one ledger event", async () => {
    const registry = join(root, "codex.json");
    await writeRegistry(registry);
    const ledger = join(root, "codex-swap.jsonl");
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const util: Record<string, number> = { a: 99, b: 5 };
    const adapter: PoolAdapter = {
      ...fakeAdapter("codex", registry, util),
      fetchUsage: async (m) => {
        if (m.name === "a" && ++arrived <= 2) {
          if (arrived === 2) release();
          await barrier;
        }
        return live(util[m.name] ?? 0);
      },
    };
    const now = () => 1_000_000;
    const [x, y] = await Promise.all([
      swapIfLimited(adapter, { ledgerPath: ledger, now }, "pool", "auto"),
      swapIfLimited(adapter, { ledgerPath: ledger, now }, "pool", "auto"),
    ]);
    expect([x.action, y.action].filter((a) => a === "swapped")).toHaveLength(1);
    expect(await readSwapEvents(ledger)).toHaveLength(1);
  });
});

describe("claude scheduler view", () => {
  test("is null when the claude adapter is not served", async () => {
    const { claudeSchedulerView } = await import("../../../src/server/claude-swap-auto.ts");
    const registry = join(root, "codex.json");
    await writeRegistry(registry);
    const only = (tool: "claude" | "codex") => new PoolSwapScheduler({ adapters: () => [fakeAdapter(tool, registry, {})] });
    expect(claudeSchedulerView(await only("codex").status())).toBeNull();
    expect(claudeSchedulerView(await only("claude").status())?.pools).toHaveLength(1);
  });
});
