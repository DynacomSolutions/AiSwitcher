import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliUsageError } from "../../src/cli/errors.ts";
import { runIdentitiesCommand } from "../../src/cli/identities/dispatch.ts";
import { sortRetiredLast } from "../../src/cli/identities/list.ts";
import type { PurgeOptions } from "../../src/identities/retire-credentials.ts";
import type { Identity, ToolConfig } from "../../src/identities/types.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRegistry(toolName: "claude" | "codex" | "zai", identities: unknown[]): Promise<ToolConfig> {
  const dir = await mkdtemp(join(tmpdir(), "ais-retire-cli-"));
  tempDirs.push(dir);
  const identitiesJsonPath = join(dir, "identities.json");
  await Bun.write(identitiesJsonPath, JSON.stringify({ version: 1, identities }));
  return {
    toolName,
    realBinaryName: toolName === "zai" ? "crush" : toolName,
    envVarName: toolName === "claude" ? "CLAUDE_CONFIG_DIR" : toolName === "zai" ? "CRUSH_GLOBAL_CONFIG" : "CODEX_HOME",
    globalMemoryProjection: "claude-append-file",
    identitiesJsonPath,
    identitiesRootDir: join(dir, "identities"),
  };
}

const NOW = new Date("2026-05-01T00:00:00.000Z");

function deps(configs: ToolConfig[], over: Record<string, unknown> = {}) {
  const purged: PurgeOptions[] = [];
  return {
    purged,
    deps: {
      configs,
      now: () => NOW,
      isInteractive: () => false,
      purge: async (opts: PurgeOptions) => {
        purged.push(opts);
        return { removed: [`${opts.identity.configDir}/auth.json`], warnings: [] };
      },
      ...over,
    },
  };
}

async function registry(cfg: ToolConfig): Promise<Identity[]> {
  return ((await Bun.file(cfg.identitiesJsonPath).json()) as { identities: Identity[] }).identities;
}

describe("ais identities retire / unretire", () => {
  test("auto-resolves the registry, persists, then purges", async () => {
    const claude = await makeRegistry("claude", [{ name: "old-team", label: "Old", configDir: "/tmp/nope/old-team" }]);
    const codex = await makeRegistry("codex", []);
    const log = spyOn(console, "log").mockImplementation(() => {});
    const { deps: d, purged } = deps([claude, codex]);
    try {
      await runIdentitiesCommand(["retire", "old-team"], { yes: true }, d);
    } finally {
      log.mockRestore();
    }
    expect((await registry(claude))[0]).toMatchObject({ retired: true, retiredAt: NOW.toISOString() });
    expect(purged).toHaveLength(1);
    expect(purged[0]).toMatchObject({ toolName: "claude" });
  });

  test("--tool honours the injected registries", async () => {
    const entry = { name: "work", label: "Work", configDir: "/tmp/nope/work" };
    const claude = await makeRegistry("claude", [entry]);
    const codex = await makeRegistry("codex", [entry]);
    const log = spyOn(console, "log").mockImplementation(() => {});
    const { deps: d, purged } = deps([claude, codex]);
    try {
      await runIdentitiesCommand(["retire", "work"], { yes: true, tool: "codex" }, d);
    } finally {
      log.mockRestore();
    }
    expect((await registry(codex))[0]?.retired).toBe(true);
    expect((await registry(claude))[0]?.retired).toBeUndefined();
    expect(purged.map((p) => p.toolName)).toEqual(["codex"]);
  });

  test("update --api-key is refused for a retired identity and writes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ais-retire-key-"));
    tempDirs.push(dir);
    const zai = await makeRegistry("zai", [
      { name: "old-zai", label: "Old", configDir: join(dir, "old-zai"), retired: true, retiredAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await expect(
      runIdentitiesCommand(["update", "old-zai"], { tool: "zai", "api-key": "SYNTHETIC_FIXTURE-key", label: "New" }, deps([zai]).deps),
    ).rejects.toThrow(/retired.*unretire old-zai --tool=zai/);
    expect(await Bun.file(join(dir, "old-zai", "auth.json")).exists()).toBe(false);
    expect((await registry(zai))[0]?.label).toBe("Old");
  });

  test("ambiguous name across registries errors and changes nothing", async () => {
    const entry = { name: "work", label: "Work", configDir: "/tmp/nope/work" };
    const claude = await makeRegistry("claude", [entry]);
    const codex = await makeRegistry("codex", [entry]);
    const { deps: d, purged } = deps([claude, codex]);
    await expect(runIdentitiesCommand(["retire", "work"], { yes: true }, d)).rejects.toThrow(/more than one registry/);
    expect(purged).toHaveLength(0);
    expect((await registry(claude))[0]?.retired).toBeUndefined();
  });

  test("without --yes and non-interactive it refuses before touching anything", async () => {
    const claude = await makeRegistry("claude", [{ name: "work", label: "Work", configDir: "/tmp/nope/work" }]);
    const { deps: d, purged } = deps([claude]);
    await expect(runIdentitiesCommand(["retire", "work"], {}, d)).rejects.toThrow(CliUsageError);
    expect(purged).toHaveLength(0);
    expect((await registry(claude))[0]?.retired).toBeUndefined();
  });

  test("interactive decline cancels; accept proceeds", async () => {
    const claude = await makeRegistry("claude", [{ name: "work", label: "Work", configDir: "/tmp/nope/work" }]);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const no = deps([claude], { isInteractive: () => true, confirm: async () => false });
      await runIdentitiesCommand(["retire", "work"], {}, no.deps);
      expect(no.purged).toHaveLength(0);
      expect((await registry(claude))[0]?.retired).toBeUndefined();
      const yes = deps([claude], { isInteractive: () => true, confirm: async () => true });
      await runIdentitiesCommand(["retire", "work"], {}, yes.deps);
      expect(yes.purged).toHaveLength(1);
      expect((await registry(claude))[0]?.retired).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test("unretire restores, notes the re-login, and errors on an active identity", async () => {
    const claude = await makeRegistry("claude", [
      { name: "old-team", label: "Old", configDir: "/tmp/nope/old-team", retired: true, retiredAt: "2026-01-01T00:00:00.000Z" },
      { name: "work", label: "Work", configDir: "/tmp/nope/work" },
    ]);
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));
    try {
      await runIdentitiesCommand(["unretire", "old-team"], {}, deps([claude]).deps);
      await expect(runIdentitiesCommand(["unretire", "work"], {}, deps([claude]).deps)).rejects.toThrow(/not retired/);
    } finally {
      log.mockRestore();
    }
    const [first] = await registry(claude);
    expect(first?.retired).toBeUndefined();
    expect(first?.unretiredAt).toBe(NOW.toISOString());
    expect(lines.join("\n")).toContain("sign in again");
  });
});

describe("automatic background sync", () => {
  test("is skipped for retire/unretire but kept for other identities commands", async () => {
    const { wantsAutoBackgroundSync } = await import("../../src/cli/dispatch.ts");
    expect(wantsAutoBackgroundSync("identities", ["retire", "x"])).toBe(false);
    expect(wantsAutoBackgroundSync("identities", ["unretire", "x"])).toBe(false);
    expect(wantsAutoBackgroundSync("identities", ["list"])).toBe(true);
    expect(wantsAutoBackgroundSync("identities", [])).toBe(true);
    expect(wantsAutoBackgroundSync("usage", [])).toBe(true);
    expect(wantsAutoBackgroundSync("resume", [])).toBe(false);
  });
});

describe("sortRetiredLast", () => {
  test("moves retired identities last, keeping order otherwise", () => {
    const list = [
      { name: "a", retired: true },
      { name: "b" },
      { name: "c", retired: true },
      { name: "d" },
    ] as Identity[];
    expect(sortRetiredLast(list).map((i) => i.name)).toEqual(["b", "d", "a", "c"]);
  });
});
