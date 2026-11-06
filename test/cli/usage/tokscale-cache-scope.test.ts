import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshUsageSnapshot } from "../../../src/cli/usage/snapshot.ts";
import { aisNativeSourceEnv, aisTokscaleCacheScope, sweepUnusedTokscaleCacheScopes } from "../../../src/cli/usage/tokscale.ts";
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

  test("the sweep removes only unused scope directories", async () => {
    const { root } = await scopeRoot();
    const live = "a".repeat(64);
    const unused = "b".repeat(64);
    for (const name of [live, unused, "not-a-scope"]) await mkdir(join(root, name, "claude"), { recursive: true });
    expect(sweepUnusedTokscaleCacheScopes(new Set([live]), root)).toBe(1);
    expect(existsSync(join(root, live))).toBe(true);
    expect(existsSync(join(root, unused))).toBe(false);
    expect(existsSync(join(root, "not-a-scope"))).toBe(true);
    expect(sweepUnusedTokscaleCacheScopes(new Set(), join(root, "missing"))).toBe(0);
  });

  test("a cycle keeps every live source's scope, drops a removed identity's, and skips the sweep when pool discovery failed", async () => {
    const { base, root } = await scopeRoot();
    const kept = identity("kept", "/ids/claude/kept");
    const pool = { name: "fixturepool", label: "Pool", configDir: "/ids/claude/pool", swapPool: { accounts: ["kept"], active: "kept" } } as unknown as UsageTarget["identity"];
    const keptScope = scopeOf("claude", kept);
    const poolScope = scopeOf("claude", pool);
    const opencodeScope = scopeOf("opencode");
    const removedScope = scopeOf("claude", identity("removed", "/ids/claude/removed"));
    for (const name of [keptScope, poolScope, opencodeScope, removedScope]) await mkdir(join(root, name), { recursive: true });
    await writeFile(join(base, "placeholder"), "");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const run = (collectPoolTargets: () => Promise<UsageTarget[]>) => refreshUsageSnapshot({
        path: join(base, "snapshot.json"), dirtyDirectory: join(base, "dirty"), tokscaleCacheScopeRoot: root,
        collectTargets: async () => [{ toolName: "claude", identity: kept }],
        collectTargetResults: async () => [], collectDefaultProfile: async () => [], collectSwapPools: async () => [],
        collectPoolTargets,
      });
      await run(async () => { throw new Error("pool discovery down"); });
      expect(existsSync(join(root, removedScope))).toBe(true);
      expect(existsSync(join(root, poolScope))).toBe(true);
      await run(async () => [{ toolName: "claude", identity: pool }]);
      expect(existsSync(join(root, removedScope))).toBe(false);
      for (const scope of [keptScope, poolScope, opencodeScope]) expect(existsSync(join(root, scope))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
