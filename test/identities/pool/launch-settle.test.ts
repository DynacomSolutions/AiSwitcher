import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PoolAdapter, PoolUsage } from "../../../src/identities/pool/adapter.ts";
import { poolLaunchCheck } from "../../../src/identities/pool/launch.ts";
import { CLAUDE_CONFIG } from "../../../src/identities/tool-configs.ts";
import type { Identity } from "../../../src/identities/types.ts";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ais-pool-settle-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const live = (maxUtilization: number): PoolUsage => ({ status: "live", maxUtilization, capturedAt: "x" });

async function setup(fetchMs: number, swapMs: number) {
  const registry = join(root, "claude.json");
  const member = (name: string) => ({ name, label: name, configDir: join(root, name) });
  const pool: Identity = { ...member("pool"), swapPool: { accounts: ["a", "b"], active: "a", auto: true } };
  await writeFile(registry, JSON.stringify({ version: 1, identities: [member("a"), member("b"), pool] }));
  const first = join(root, "marker-1");
  const second = join(root, "marker-2");
  const adapter: PoolAdapter = {
    tool: "claude",
    config: { ...CLAUDE_CONFIG, identitiesJsonPath: registry },
    liveSwap: false,
    hasCredentials: () => true,
    swapCredentials: async ({ pool: p, target }) => {
      await writeFile(first, "1");
      await Bun.sleep(swapMs);
      await writeFile(second, "2");
      return { pool: p.name, from: p.swapPool.active ?? null, to: target.name, noop: false, writeBack: "none-identical", notes: [] };
    },
    fetchUsage: async (m) => {
      await Bun.sleep(fetchMs);
      return live(m.name === "a" ? 99 : 5);
    },
  };
  return { adapter, pool, first, second, ledgerPath: join(root, "ledger.jsonl"), registryPath: registry };
}

describe("poolLaunchCheck vs process replacement", () => {
  test("a slow usage fetch that loses the timeout still completes its swap before returning", async () => {
    const { adapter, pool, first, second, ledgerPath, registryPath } = await setup(300, 150);
    const note = await poolLaunchCheck(adapter, pool, { timeoutMs: 50, ledgerPath, registryPath });
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
    expect(note).toContain("switched a -> b");
  });

  test("work that cannot start its swap within the settle window is cancelled before swapping", async () => {
    const { adapter, pool, first, ledgerPath, registryPath } = await setup(400, 0);
    const note = await poolLaunchCheck(adapter, pool, { timeoutMs: 20, settleMs: 100, ledgerPath, registryPath });
    expect(note).toBeUndefined();
    await Bun.sleep(1000); // nothing may start a swap after cancellation
    expect(existsSync(first)).toBe(false);
  });

  test("a swap already in flight when the settle window ends is awaited to the end", async () => {
    const { adapter, pool, second, ledgerPath, registryPath } = await setup(0, 300);
    await poolLaunchCheck(adapter, pool, { timeoutMs: 20, settleMs: 100, ledgerPath, registryPath });
    expect(existsSync(second)).toBe(true);
  });

  test("work that is cancelled after the settle window is still awaited to its end (no cut mid token refresh)", async () => {
    const { adapter, pool, ledgerPath, registryPath } = await setup(0, 0);
    const before = join(root, "refresh-1");
    const after = join(root, "refresh-2");
    adapter.fetchUsage = async () => {
      await writeFile(before, "1");
      await Bun.sleep(300);
      await writeFile(after, "2");
      return live(10); // not limited: no swap follows
    };
    await poolLaunchCheck(adapter, pool, { timeoutMs: 20, settleMs: 100, ledgerPath, registryPath });
    expect(existsSync(before)).toBe(true);
    expect(existsSync(after)).toBe(true);
  });

  test("heal runs before the usage/auto decision; a swap note replaces the heal notes", async () => {
    const { adapter, pool, ledgerPath, registryPath } = await setup(0, 0);
    const order: string[] = [];
    adapter.heal = async () => {
      order.push("heal");
      return ["pool pool credentials were repaired"];
    };
    const fetch = adapter.fetchUsage;
    adapter.fetchUsage = async (m) => {
      order.push("usage");
      return fetch(m);
    };
    const note = await poolLaunchCheck(adapter, pool, { ledgerPath, registryPath });
    expect(order[0]).toBe("heal");
    expect(order).toContain("usage");
    expect(note).toContain("switched a -> b");
    expect(note).not.toContain("repaired");
  });

  test("heal notes surface as the launch note when nothing swaps", async () => {
    const { adapter, pool, ledgerPath, registryPath } = await setup(0, 0);
    adapter.heal = async () => ["pool pool credentials were empty or partial", 'restored "a" into pool'];
    adapter.fetchUsage = async () => live(10);
    const note = await poolLaunchCheck(adapter, pool, { ledgerPath, registryPath });
    expect(note).toBe('claude-swap: pool pool credentials were empty or partial; restored "a" into pool');
  });
});
