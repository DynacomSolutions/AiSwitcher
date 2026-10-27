import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PoolAdapter, PoolUsage } from "../../../src/identities/pool/adapter.ts";
import { appendSwapEvent, ledgerPathFor, readSwapEvents } from "../../../src/identities/pool/ledger.ts";
import { performPoolSwap } from "../../../src/identities/pool/swap.ts";
import { chooseBest, swapIfLimited } from "../../../src/identities/pool/ops.ts";
import { PoolSwapScheduler } from "../../../src/identities/pool/scheduler.ts";
import { poolsOf, requirePool } from "../../../src/identities/pool/swap-pool.ts";
import type { IdentitiesFile, Identity } from "../../../src/identities/types.ts";
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

  test("an exhausted hard limit bypasses cooldown and chooses a non-exhausted member", async () => {
    const registry = join(root, "claude.json");
    await writeRegistry(registry);
    const ledger = join(root, "claude-swap.jsonl");
    const now = Date.now();
    await appendSwapEvent({ ts: new Date(now).toISOString(), pool: "pool", from: "b", to: "a", reason: "auto" }, ledger);
    const adapter: PoolAdapter = {
      ...fakeAdapter("claude", registry, {}),
      fetchUsage: async (member) => live(member.name === "a" ? 100 : 96),
    };
    const result = await swapIfLimited(adapter, { ledgerPath: ledger, now: () => now + 1 }, "pool", "auto", { assumeLimited: true });
    expect(result.action).toBe("swapped");
    if (result.action === "swapped") expect(result.result.to).toBe("b");
    expect((await readSwapEvents(ledger)).at(-1)?.hardLimitUntilMs).toBeGreaterThan(now + 1);
  });

  test("fresh live headroom overrides a generic assumed rate limit", async () => {
    const registry = join(root, "claude.json");
    await writeRegistry(registry);
    const ledger = join(root, "claude-swap.jsonl");
    const adapter: PoolAdapter = {
      ...fakeAdapter("claude", registry, {}),
      fetchUsage: async (member) => live(member.name === "a" ? 40 : 10),
    };
    const result = await swapIfLimited(adapter, { ledgerPath: ledger }, "pool", "auto", { assumeLimited: true });
    expect(result).toMatchObject({ action: "not-limited", utilization: 40 });
    expect(await readSwapEvents(ledger)).toHaveLength(0);
  });

  test("live headroom refutes an assumed limit only when read at or after the failure", async () => {
    const failureAtMs = Date.now();
    const run = async (capturedAt: number) => {
      const registry = join(root, `claude-${capturedAt}.json`); // fresh each run: a swap rewrites the active member
      await writeRegistry(registry);
      const adapter: PoolAdapter = {
        ...fakeAdapter("claude", registry, {}),
        fetchUsage: async (member) => ({ ...live(member.name === "a" ? 98 : 10), capturedAt: new Date(capturedAt).toISOString() }),
      };
      return swapIfLimited(adapter, { ledgerPath: join(root, `claude-swap-${capturedAt}.jsonl`), now: () => failureAtMs + 5 }, "pool", "auto", { assumeLimited: true, failureAtMs });
    };
    expect(await run(failureAtMs - 1000)).toMatchObject({ action: "swapped", result: { from: "a", to: "b" } });
    expect(await run(failureAtMs + 1)).toMatchObject({ action: "not-limited", utilization: 98 });
  });

  test("explicit provider limit evidence can override stale live headroom", async () => {
    const registry = join(root, "claude.json");
    await writeRegistry(registry);
    const adapter: PoolAdapter = {
      ...fakeAdapter("claude", registry, {}),
      fetchUsage: async (member) => live(member.name === "a" ? 60 : 10),
    };
    const result = await swapIfLimited(adapter, { ledgerPath: join(root, "claude-swap.jsonl") }, "pool", "auto", {
      assumeLimited: true,
      trustLimitEvidence: true,
      failureAtMs: Date.now(),
    });
    expect(result).toMatchObject({ action: "swapped", result: { from: "a", to: "b" } });
  });

  test("a swap since this failure prevents a second rotation in a three-member pool", async () => {
    const registry = join(root, "claude.json");
    const member = (name: string) => ({ name, label: name, configDir: join(root, name) });
    await writeFile(registry, JSON.stringify({ version: 1, identities: [member("a"), member("b"), member("c"), { ...member("pool"), swapPool: { accounts: ["a", "b", "c"], active: "b" } }] }));
    const ledger = join(root, "claude-swap.jsonl");
    const failureAtMs = Date.now() - 10;
    await appendSwapEvent({ ts: new Date(failureAtMs + 1).toISOString(), pool: "pool", from: "a", to: "b", reason: "auto" }, ledger);
    const adapter: PoolAdapter = { ...fakeAdapter("claude", registry, {}), fetchUsage: async (m) => live(m.name === "b" ? 100 : 5) };
    const result = await swapIfLimited(adapter, { ledgerPath: ledger, now: () => failureAtMs + 2 }, "pool", "auto", { assumeLimited: true, trustLimitEvidence: true, failureAtMs });
    expect(result.action).toBe("skipped");
    expect(await readSwapEvents(ledger)).toHaveLength(1);
  });

  test("a recent hard-limit marker keeps an exhausted member out of candidate selection", async () => {
    const registry = join(root, "claude.json");
    await writeRegistry(registry);
    const ledger = join(root, "claude-swap.jsonl");
    const now = Date.now();
    await appendSwapEvent({ ts: new Date(now - 1_000).toISOString(), pool: "pool", from: "b", to: "a", reason: "auto", hardLimitUntilMs: now + 60_000 }, ledger);
    const adapter: PoolAdapter = {
      ...fakeAdapter("claude", registry, {}),
      fetchUsage: async (member) => live(member.name === "a" ? 100 : 5),
    };
    const result = await swapIfLimited(adapter, { ledgerPath: ledger, now: () => now }, "pool", "auto", { assumeLimited: true });
    expect(result.action).toBe("no-candidate");
  });

  test("all exhausted members return the earliest member reset for scheduler retry", async () => {
    const registry = join(root, "claude.json");
    await writeRegistry(registry);
    const ledger = join(root, "claude-swap.jsonl");
    const now = Date.now();
    const resetSoon = new Date(now + 90_000).toISOString(); // SYNTHETIC_FIXTURE reset timestamp
    const resetLater = new Date(now + 180_000).toISOString(); // SYNTHETIC_FIXTURE reset timestamp
    const exhausted = (resetsAt: string): PoolUsage => ({
      status: "live",
      maxUtilization: 100,
      windows: [{ label: "synthetic-window", utilization: 100, resetsAt }],
      capturedAt: "SYNTHETIC_FIXTURE",
    });
    const adapter: PoolAdapter = {
      ...fakeAdapter("claude", registry, {}),
      fetchUsage: async (member) => exhausted(member.name === "b" ? resetSoon : resetLater),
    };
    const result = await swapIfLimited(adapter, { ledgerPath: ledger, now: () => now }, "pool", "auto");
    expect(result).toMatchObject({ action: "no-candidate", retryAtMs: now + 90_000 });
  });

  test("an unknown member does not hide another member's imminent reset", async () => {
    const registry = join(root, "claude.json");
    await writeRegistry(registry);
    const now = Date.now();
    const resetSoon = new Date(now + 15_000).toISOString(); // SYNTHETIC_FIXTURE reset timestamp
    const adapter: PoolAdapter = {
      ...fakeAdapter("claude", registry, {}),
      fetchUsage: async (member) => member.name === "a"
        ? { ...live(100), windows: [{ label: "synthetic-window", utilization: 100, resetsAt: resetSoon }] }
        : { status: "unavailable", error: "SYNTHETIC_FIXTURE transient error", capturedAt: "SYNTHETIC_FIXTURE" },
    };
    const result = await swapIfLimited(adapter, { ledgerPath: join(root, "claude-swap.jsonl"), now: () => now }, "pool", "auto");
    expect(result).toMatchObject({ action: "no-candidate", retryAtMs: now + 15_000 });
  });

  test("pool retry time is not reported as the active member's reset", async () => {
    const registry = join(root, "claude.json");
    await writeRegistry(registry);
    const now = Date.now();
    const otherReset = new Date(now + 15_000).toISOString(); // SYNTHETIC_FIXTURE reset timestamp
    const adapter: PoolAdapter = {
      ...fakeAdapter("claude", registry, {}),
      fetchUsage: async (member) => member.name === "a"
        ? { status: "rate-limited", capturedAt: "SYNTHETIC_FIXTURE" }
        : { ...live(100), windows: [{ label: "synthetic-window", utilization: 100, resetsAt: otherReset }] },
    };
    const result = await swapIfLimited(adapter, { ledgerPath: join(root, "claude-swap.jsonl"), now: () => now }, "pool", "auto", { assumeLimited: true });
    expect(result).toMatchObject({ action: "no-candidate", retryAtMs: now + 15_000 });
    if (result.action === "no-candidate") expect(result.activeRetryAtMs).toBeUndefined();
  });

  test("the active Claude member can be usable before its later non-exhausted window resets", async () => {
    const registry = join(root, "claude.json");
    await writeRegistry(registry);
    const now = Date.now();
    const activeSoon = new Date(now + 15_000).toISOString(); // SYNTHETIC_FIXTURE reset timestamp
    const otherLater = new Date(now + 180_000).toISOString(); // SYNTHETIC_FIXTURE reset timestamp
    const active: PoolUsage = {
      status: "live",
      maxUtilization: 100,
      windows: [
        { label: "synthetic-five-hour", utilization: 100, resetsAt: activeSoon },
        { label: "synthetic-seven-day", utilization: 20, resetsAt: otherLater },
      ],
      capturedAt: "SYNTHETIC_FIXTURE",
    };
    const full = (resetsAt: string): PoolUsage => ({
      status: "live",
      maxUtilization: 100,
      windows: [{ label: "synthetic-window", utilization: 100, resetsAt }],
      capturedAt: "SYNTHETIC_FIXTURE",
    });
    const adapter: PoolAdapter = {
      ...fakeAdapter("claude", registry, {}),
      fetchUsage: async (member) => member.name === "a" ? active : full(otherLater),
    };
    const result = await swapIfLimited(adapter, { ledgerPath: join(root, "claude-swap.jsonl"), now: () => now }, "pool", "auto");
    expect(result).toMatchObject({ action: "no-candidate", retryAtMs: now + 15_000 });
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

  test("daemon floors an imminent reset at the jittered poll interval", async () => {
    const registry = join(root, "claude.json");
    await writeRegistry(registry);
    const seen: string[] = [];
    const sched = new PoolSwapScheduler({
      adapters: () => [fakeAdapter("claude", registry, {})],
      random: () => 0,
      log: () => {},
      check: async () => { seen.push("check"); return { action: "no-candidate", retryAtMs: 1_030_000 }; },
    });
    await sched.tick(1_000_000);
    expect((await sched.status()).pools[0]?.backoffMs).toBe(60_000);
    await sched.tick(1_059_999);
    expect(seen).toHaveLength(1);
    await sched.tick(1_060_000);
    expect(seen).toHaveLength(2);
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

describe("canonical pools by configDir", () => {
  const entry = (name: string, configDir: string, extra: Partial<Identity> = {}): Identity => ({ name, label: name, configDir, ...extra });
  const duplicatedRegistry = (): IdentitiesFile => ({
    version: 1,
    identities: [
      entry("a", join(root, "a")),
      entry("b", join(root, "b")),
      entry("pool", join(root, "pool"), { swapPool: { accounts: ["a", "b"], active: "a" } }),
      // A legacy/sync duplicate: same configDir (trailing slash included) as "pool".
      entry("pool-dup", `${join(root, "pool")}/`, { swapPool: { accounts: ["a", "b"], active: "b" } }),
    ],
  });

  test("poolsOf keeps the first record per configDir and still drops retired pools", () => {
    const file = duplicatedRegistry();
    file.identities.push(
      entry("pool-gone", join(root, "pool-gone"), { swapPool: { accounts: ["a", "b"] }, retired: true }),
      entry("pool-two", join(root, "pool-two"), { swapPool: { accounts: ["a", "b"] } }),
    );
    expect(poolsOf(file).map((p) => p.name)).toEqual(["pool", "pool-two"]);
  });

  test("requirePool redirects a duplicate pool name to the canonical record", () => {
    const pool = requirePool(duplicatedRegistry(), "pool-dup", "kimi");
    expect(pool.name).toBe("pool");
    expect(pool.swapPool.active).toBe("a");
  });

  test("an unqualified requirePool resolves the single canonical pool despite a duplicate record", () => {
    expect(requirePool(duplicatedRegistry(), undefined, "kimi").name).toBe("pool");
    const file = duplicatedRegistry();
    file.identities.push(entry("pool-two", join(root, "pool-two"), { swapPool: { accounts: ["a", "b"] } }));
    expect(() => requirePool(file, undefined, "kimi")).toThrow(/More than one swap pool exists \(pool, pool-two\)/);
  });

  test("unknown, non-pool and retired errors are preserved", () => {
    const file = duplicatedRegistry();
    file.identities.push(entry("pool-gone", join(root, "pool-gone"), { swapPool: { accounts: ["a", "b"] }, retired: true }));
    expect(() => requirePool(file, "nope", "kimi")).toThrow(/No identity named "nope"/);
    expect(() => requirePool(file, "a", "kimi")).toThrow(/Identity "a" is not a swap pool/);
    expect(() => requirePool(file, "pool-gone", "kimi")).toThrow(/Swap pool "pool-gone" is retired/);
  });
});
