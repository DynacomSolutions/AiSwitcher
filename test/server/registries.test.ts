import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolConfig } from "../../src/identities/types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeHome(): Promise<{
  home: string;
  registryPath: string;
  configDir: (name: string, sub?: string) => string;
}> {
  const home = await mkdtemp(join(tmpdir(), "ais-registry-"));
  tempDirs.push(home);
  return {
    home,
    registryPath: join(home, ".claude", "identities.json"),
    configDir: (name: string, sub?: string) => (sub === undefined ? join(home, ".claude", name) : join(home, ".claude", name, sub)),
  };
}

function fakeConfig(registryPath: string, overrides: Partial<ToolConfig> = {}): ToolConfig {
  return {
    toolName: "claude",
    realBinaryName: "claude",
    envVarName: "CLAUDE_CONFIG_DIR",
    identitiesJsonPath: registryPath,
    identitiesRootDir: join(registryPath, "..", "identities"),
    globalMemoryProjection: "claude-append-file",
    ...overrides,
  };
}

describe("console identity mutations", () => {
  test("create then list round-trips through the real store", async () => {
    const { registryPath, configDir } = await makeHome();
    const configs = [fakeConfig(registryPath)];
    const mod = await import("../../src/server/registries.ts");

    const afterCreate = await mod.createIdentityInRegistry(
      "claude",
      { name: "work", label: "Work", configDir: configDir("identities", "work"), aliases: ["wk"] },
      configs,
    );
    expect(afterCreate.identities).toHaveLength(1);
    expect(afterCreate.identities[0]).toMatchObject({ name: "work", aliases: ["wk"] });

    const listed = await mod.listRegistries(configs);
    expect(listed.registries[0].identities[0].name).toBe("work");
  });

  test("update and directory/alias mutations persist atomically", async () => {
    const { registryPath, configDir } = await makeHome();
    const configs = [fakeConfig(registryPath)];
    const mod = await import("../../src/server/registries.ts");
    await mod.createIdentityInRegistry("claude", { name: "a", label: "A", configDir: configDir("a") }, configs);

    const afterUpdate = await mod.updateIdentityInRegistry("claude", "a", { label: "Alpha" }, configs);
    expect(afterUpdate.identities[0].label).toBe("Alpha");

    const withDir = await mod.mutateDirectory("claude", "a", "/tmp/proj/*", true, configs);
    expect(withDir.identities[0].directories).toEqual(["/tmp/proj/*"]);
    const withoutDir = await mod.mutateDirectory("claude", "a", "/tmp/proj/*", false, configs);
    expect(withoutDir.identities[0].directories).toBeUndefined();

    const withAlias = await mod.mutateAlias("claude", "a", "al", true, configs);
    expect(withAlias.identities[0].aliases).toEqual(["al"]);
  });

  test("delete removes from the registry only and rejects unknown names", async () => {
    const { registryPath, configDir } = await makeHome();
    const configs = [fakeConfig(registryPath)];
    const mod = await import("../../src/server/registries.ts");
    const dir = configDir("keepme");
    await mkdir(dir, { recursive: true });
    await mod.createIdentityInRegistry("claude", { name: "gone", label: "G", configDir: configDir("gone") }, configs);

    const afterDelete = await mod.deleteIdentityFromRegistry("claude", "gone", configs);
    expect(afterDelete.identities).toHaveLength(0);

    await expect(mod.updateIdentityInRegistry("claude", "missing", { label: "x" }, configs)).rejects.toThrow();
  });

  test("an apiKey at creation time seeds zai auth into crush.json", async () => {
    const { registryPath, configDir } = await makeHome();
    const zaiConfig = fakeConfig(registryPath, {
      toolName: "zai",
      realBinaryName: "crush",
      envVarName: "CRUSH_GLOBAL_CONFIG",
    });
    const configs = [zaiConfig];
    const mod = await import("../../src/server/registries.ts");
    const dir = configDir("zaiid");
    await mkdir(dir, { recursive: true });

    await mod.createIdentityInRegistry(
      "zai",
      { name: "z", label: "Z", configDir: dir, apiKey: "test-key-value" },
      configs,
    );
    const crushJson = JSON.parse(await Bun.file(join(dir, "crush.json")).text());
    expect(crushJson.providers.zai.api_key).toBe("test-key-value");
  });

  test("with AIS_HOST_HOME set: host-form configDir writes under the local home, updates persist host paths", async () => {
    const { registryPath } = await makeHome();
    const saved = { HOME: process.env.HOME, AIS_HOST_HOME: process.env.AIS_HOST_HOME };
    const localHome = await mkdtemp(join(tmpdir(), "ais-local-home-"));
    tempDirs.push(localHome);
    process.env.AIS_HOST_HOME = "/synthetic/host-home";
    process.env.HOME = localHome; // translation reads $HOME live (os.homedir() is cached in bun)
    const localDir = join(localHome, ".zai", "z");
    await mkdir(localDir, { recursive: true });
    try {
      const configs = [fakeConfig(registryPath, { toolName: "zai", realBinaryName: "crush", envVarName: "CRUSH_GLOBAL_CONFIG" })];
      const mod = await import("../../src/server/registries.ts");
      const hostDir = "/synthetic/host-home/.zai/z";
      await mod.createIdentityInRegistry("zai", { name: "z", label: "Z", configDir: hostDir, apiKey: "SYNTHETIC_FIXTURE-key-value" }, configs);
      const crush = JSON.parse(await Bun.file(join(localDir, "crush.json")).text());
      expect(crush.providers.zai.api_key).toBe("SYNTHETIC_FIXTURE-key-value");

      await mod.updateIdentityInRegistry("zai", "z", { label: "Zed" }, configs);
      const stored = await Bun.file(registryPath).text();
      expect(stored).toContain(hostDir);
      expect(stored).not.toContain(localHome);
      const listed = await mod.listRegistries(configs);
      expect(listed.registries[0]!.identities[0]!.configDirExists).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
