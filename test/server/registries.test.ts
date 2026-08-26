import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolConfig } from "../../src/identities/types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeHome(): Promise<{ home: string; registryPath: string; configDir: (name: string) => string }> {
  const home = await mkdtemp(join(tmpdir(), "ais-registry-"));
  tempDirs.push(home);
  return {
    home,
    registryPath: join(home, ".claude", "identities.json"),
    configDir: (name: string) => join(home, ".claude", name),
  };
}

function fakeConfig(registryPath: string, overrides: Partial<ToolConfig> = {}): ToolConfig {
  return {
    toolName: "claude",
    realBinaryName: "claude",
    envVarName: "CLAUDE_CONFIG_DIR",
    identitiesJsonPath: registryPath,
    identitiesRootDir: join(registryPath, "..", "identities"),
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
});
