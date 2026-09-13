import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoIdentityColour } from "../../src/identities/colour.ts";
import type { Identity, ToolConfig } from "../../src/identities/types.ts";
import {
  createIdentityInRegistry,
  listRegistries,
  updateIdentityInRegistry,
} from "../../src/server/registries.ts";
import { HttpError } from "../../src/server/types.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeHome(): Promise<{ home: string; registryPath: string; configDir: string }> {
  const home = await mkdtemp(join(tmpdir(), "ais-sessions-server-"));
  tempDirs.push(home);
  return { home, registryPath: join(home, "identities.json"), configDir: join(home, "cfg") };
}

function fakeConfig(registryPath: string): ToolConfig {
  return {
    toolName: "claude",
    realBinaryName: "claude",
    envVarName: "CLAUDE_CONFIG_DIR",
    identitiesJsonPath: registryPath,
    identitiesRootDir: join(registryPath, "..", "identities"),
    globalMemoryProjection: "claude-append-file",
  };
}

/* ------------------------- colour surface of the API ------------------------ */

describe("identity colour through the registry API", () => {
  test("PATCH sets/clears colour; invalid colour is a 400", async () => {
    const { registryPath, configDir } = await makeHome();
    const configs = [fakeConfig(registryPath)];
    await mkdir(configDir, { recursive: true });
    await createIdentityInRegistry("claude", { name: "testa", label: "Test A", configDir }, configs);

    const set = await updateIdentityInRegistry("claude", "testa", { colour: "#abc" }, configs);
    expect(set.identities[0]!.colour).toBe("#aabbcc");
    expect(set.identities[0]!.effectiveColour).toBe("#aabbcc");

    const cleared = await updateIdentityInRegistry("claude", "testa", { colour: "" }, configs);
    expect(cleared.identities[0]!.colour).toBeUndefined();
    // effectiveColour is ALWAYS present: auto palette pick when unset
    expect(cleared.identities[0]!.effectiveColour).toBe(autoIdentityColour("claude", "testa"));

    try {
      await updateIdentityInRegistry("claude", "testa", { colour: "chartreuse" }, configs);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
    }
  });

  test("listRegistries always carries effectiveColour", async () => {
    const { registryPath, configDir } = await makeHome();
    const configs = [fakeConfig(registryPath)];
    await mkdir(configDir, { recursive: true });
    await createIdentityInRegistry("claude", { name: "testb", label: "Test B", configDir }, configs);
    const listed = await listRegistries(configs);
    const dto = listed.registries[0]!.identities[0]!;
    expect(dto.effectiveColour).toBe(autoIdentityColour("claude", "testb"));
    expect(dto.colour).toBeUndefined();
  });
});
