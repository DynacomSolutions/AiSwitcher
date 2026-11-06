import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshUsageSnapshot } from "../../../src/cli/usage/snapshot.ts";
import { aisNativeSourceEnv, aisTokscaleCacheScope, markTokscaleCacheScopeUsed, sweepUnusedTokscaleCacheScopes, TOKSCALE_CACHE_SCOPE_MAX_IDLE_MS } from "../../../src/cli/usage/tokscale.ts";
import type { UsageTarget } from "../../../src/cli/usage/run.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

async function scopeRoot(): Promise<{ base: string; root: string }> {
  const base = await mkdtemp(join(tmpdir(), "ais-cache-scope-"));
  dirs.push(base);
  const root = join(base, "scopes");
  await mkdir(root, { recursive: true });
  return { base, root };
}

const identity = (name: string, configDir: string) => ({ name, label: name, configDir }) as UsageTarget["identity"];
const scopeOf = (toolName: UsageTarget["toolName"], id?: UsageTarget["identity"]) => aisTokscaleCacheScope(toolName, aisNativeSourceEnv(toolName, id)!);

describe("Tokscale cache scope", () => {
  test("is keyed by tool and scanned directory, not the identity name", () => {
    expect(scopeOf("claude", identity("old-name", "/ids/claude/a"))).toBe(scopeOf("claude", identity("new-name", "/ids/claude/a")));
    expect(scopeOf("claude", identity("a", "/ids/claude/a"))).not.toBe(scopeOf("claude", identity("a", "/ids/claude/b")));
    expect(scopeOf("claude", identity("a", "/ids/a"))).not.toBe(scopeOf("codex", identity("a", "/ids/a")));
    expect(scopeOf("claude", identity("a", "/ids/a"))).toMatch(/^[a-f0-9]{64}$/);
    expect(aisNativeSourceEnv("zai", identity("a", "/ids/a"))).toBeUndefined();
  });

  const DAY = 24 * 60 * 60_000;
  const age = async (path: string, ms: number) => { const when = new Date(Date.now() - ms); await utimes(path, when, when); };

  test("the sweep removes a scope only when it is unused and idle for 30 days", async () => {
    const { root } = await scopeRoot();
    const liveOld = "a".repeat(64);
    const unusedRecent = "b".repeat(64);
    const unusedOld = "c".repeat(64);
    for (const name of [liveOld, unusedRecent, unusedOld, "not-a-scope"]) await mkdir(join(root, name, "claude"), { recursive: true });
    await age(join(root, liveOld), 400 * DAY);
    await age(join(root, unusedRecent), 29 * DAY);
    await age(join(root, unusedOld), 31 * DAY);
    await age(join(root, "not-a-scope"), 400 * DAY);
    expect(TOKSCALE_CACHE_SCOPE_MAX_IDLE_MS).toBe(30 * DAY);
    expect(sweepUnusedTokscaleCacheScopes(new Set([liveOld]), root)).toBe(1);
    expect(existsSync(join(root, liveOld))).toBe(true);
    expect(existsSync(join(root, unusedRecent))).toBe(true);
    expect(existsSync(join(root, unusedOld))).toBe(false);
    expect(existsSync(join(root, "not-a-scope"))).toBe(true);
    expect(sweepUnusedTokscaleCacheScopes(new Set(), join(root, "missing"))).toBe(0);
  });

  test("every scoped export stamps its scope as used", async () => {
    const { base } = await scopeRoot();
    const scope = "d".repeat(64);
    const dir = join(base, "cache", "source-message-cache-v2-ais-scope", scope);
    markTokscaleCacheScopeUsed({ TOKSCALE_CONFIG_DIR: base, TOKSCALE_AIS_CACHE_SCOPE: scope });
    expect(existsSync(dir)).toBe(true);
    await age(dir, 40 * DAY);
    markTokscaleCacheScopeUsed({ TOKSCALE_CONFIG_DIR: base, TOKSCALE_AIS_CACHE_SCOPE: scope });
    expect(Date.now() - (await stat(dir)).mtimeMs).toBeLessThan(DAY);
    markTokscaleCacheScopeUsed({ TOKSCALE_CONFIG_DIR: base, TOKSCALE_AIS_CACHE_SCOPE: "../x" });
    expect(existsSync(join(base, "cache", "x"))).toBe(false);
  });

  test("a cycle keeps scopes while a registry is missing, keeps live scopes however old, and removes an old unused one", async () => {
    const { base, root } = await scopeRoot();
    const kept = identity("kept", "/ids/claude/kept");
    const codex = identity("cx", "/ids/codex/cx");
    const pool = { name: "fixturepool", label: "Pool", configDir: "/ids/claude/pool", swapPool: { accounts: ["kept"], active: "kept" } } as unknown as UsageTarget["identity"];
    const keptScope = scopeOf("claude", kept);
    const poolScope = scopeOf("claude", pool);
    const codexScope = scopeOf("codex", codex);
    const opencodeScope = scopeOf("opencode");
    const removedScope = scopeOf("claude", identity("removed", "/ids/claude/removed"));
    for (const name of [keptScope, poolScope, codexScope, opencodeScope, removedScope]) {
      await mkdir(join(root, name), { recursive: true });
      await age(join(root, name), 90 * DAY);
    }
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const run = (claudeTargets: UsageTarget[], registriesPresent: boolean, poolTargets: () => Promise<UsageTarget[]>) => refreshUsageSnapshot({
        path: join(base, "snapshot.json"), dirtyDirectory: join(base, "dirty"), tokscaleCacheScopeRoot: root,
        identityRegistriesPresent: () => registriesPresent,
        collectTargets: async () => [...claudeTargets, { toolName: "codex", identity: codex }],
        collectTargetResults: async () => [], collectDefaultProfile: async () => [], collectSwapPools: async () => [],
        collectPoolTargets: poolTargets,
      });
      const pools = async () => [{ toolName: "claude" as const, identity: pool }];
      // The claude registry renamed away for one cycle loads as no identities.
      await run([], false, pools);
      for (const scope of [keptScope, poolScope, codexScope, opencodeScope, removedScope]) expect(existsSync(join(root, scope))).toBe(true);
      // Pool discovery failing also skips the sweep.
      await run([{ toolName: "claude", identity: kept }], true, async () => { throw new Error("pool discovery down"); });
      expect(existsSync(join(root, removedScope))).toBe(true);
      // Complete discovery: only the old unused scope goes.
      await run([{ toolName: "claude", identity: kept }], true, pools);
      expect(existsSync(join(root, removedScope))).toBe(false);
      for (const scope of [keptScope, poolScope, codexScope, opencodeScope]) expect(existsSync(join(root, scope))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
