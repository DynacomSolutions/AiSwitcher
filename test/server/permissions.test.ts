import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolConfig } from "../../src/identities/types.ts";
import { buildPermissions } from "../../src/server/permissions.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fakeConfig(toolName: ToolConfig["toolName"], registryPath: string): ToolConfig {
  return {
    toolName,
    realBinaryName: toolName,
    envVarName: "X_CONFIG_DIR",
    identitiesJsonPath: registryPath,
    identitiesRootDir: join(registryPath, "..", "identities"),
    globalMemoryProjection: "claude-append-file",
  } as unknown as ToolConfig;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ais-perms-"));
  tempDirs.push(root);
  const localHome = join(root, "home");
  const configDir = join(localHome, ".claude", "identities", "a");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"], deny: ["Read(.env)"] } }));
  // The store already hands back local paths; buildPermissions reports host form.
  const registry = join(root, "claude-identities.json");
  await writeFile(registry, JSON.stringify({ version: 1, identities: [{ name: "a", label: "A", configDir }] }));
  const piRegistry = join(root, "pi-identities.json");
  await writeFile(piRegistry, JSON.stringify({ version: 1, identities: [{ name: "p", label: "P", configDir: join(root, "pi") }] }));
  const repos = join(root, "repos");
  const base = join(repos, ".worktrees", "owner", ".base", "r");
  const task = join(repos, ".worktrees", "owner", "t1", "r");
  await mkdir(join(base, ".claude"), { recursive: true });
  await mkdir(join(task, ".git"), { recursive: true });
  await writeFile(join(base, ".claude", "settings.local.json"), JSON.stringify({ permissions: { ask: ["Edit"] } }));
  return {
    base,
    deps: {
      configs: [fakeConfig("claude", registry), fakeConfig("pi", piRegistry)],
      reposRoot: repos,
      cachePath: join(root, "state", "permissions-cache.json"),
      env: { AIS_HOST_HOME: "/synthetic/host-home" },
      localHome,
    },
  };
}

describe("buildPermissions", () => {
  test("builds the tree, translating host config dirs and keeping zero-rule worktrees", async () => {
    const { deps } = await fixture();
    const dto = await buildPermissions(deps);
    const claude = dto.tools.find((t) => t.toolName === "claude")!;
    const id = claude.identities[0]!;
    expect(id.rules.allow).toEqual(["Bash(ls)"]);
    expect(id.configDir).toBe("/synthetic/host-home/.claude/identities/a");
    const repo = id.repos[0]!;
    expect(repo.worktrees.map((w) => w.kind)).toEqual(["base", "task"]);
    expect(repo.worktrees[0]!.counts.ask).toBe(1);
    expect(repo.worktrees[1]!.counts.total).toBe(0);
    const pi = dto.tools.find((t) => t.toolName === "pi")!.identities[0]!;
    expect(pi.reason).toBeTruthy();
    expect(pi.counts.total).toBe(0);
  });

  test("second call hits the cache; changed file misses; refresh bypasses", async () => {
    const { deps, base } = await fixture();
    const first = await buildPermissions(deps);
    expect(first.cache.misses).toBeGreaterThan(0);
    const second = await buildPermissions(deps);
    expect(second.cache.misses).toBe(0);
    expect(second.cache.hits).toBeGreaterThan(0);

    const local = join(base, ".claude", "settings.local.json");
    await writeFile(local, JSON.stringify({ permissions: { ask: ["Edit", "Write"] } }));
    await utimes(local, new Date(), new Date(Date.now() + 5000));
    const third = await buildPermissions(deps);
    expect(third.cache.misses).toBeGreaterThan(0);
    expect(third.tools[0]!.identities[0]!.repos[0]!.worktrees[0]!.counts.ask).toBe(2);

    const forced = await buildPermissions({ ...deps, refresh: true });
    expect(forced.cache.hits).toBe(0);
  });

  test("cache file records entries and an index, written atomically", async () => {
    const { deps, base } = await fixture();
    await buildPermissions(deps);
    const cache = JSON.parse(await readFile(deps.cachePath, "utf8"));
    const entry = cache.files[join(base, ".claude", "settings.local.json")];
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof entry.mtimeMs).toBe("number");
    expect(entry.size).toBeGreaterThan(0);
    expect(entry.parsedAt).toBeTruthy();
    expect(cache.identities["claude/a"].configDir).toBe("/synthetic/host-home/.claude/identities/a");
    expect(cache.repos["owner/r"]).toBeTruthy();
    expect(Object.keys(cache.worktrees)).toHaveLength(2);
    await expect(stat(`${deps.cachePath}.tmp`)).rejects.toThrow();
  });
});
