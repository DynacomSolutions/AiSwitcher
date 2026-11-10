import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolConfig } from "../../src/identities/types.ts";
import { createIdentityInRegistry, updateIdentityInRegistry } from "../../src/server/registries.ts";
import { HttpError } from "../../src/server/types.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(tool: "codex" | "claude") {
  const home = await mkdtemp(join(tmpdir(), "ais-codex-login-"));
  tempDirs.push(home);
  const registryPath = join(home, "identities.json");
  const cfg: ToolConfig =
    tool === "codex"
      ? {
          toolName: "codex",
          realBinaryName: "codex",
          envVarName: "CODEX_HOME",
          identitiesJsonPath: registryPath,
          identitiesRootDir: join(home, "identities"),
          globalMemoryProjection: "codex-developer-instructions",
        }
      : {
          toolName: "claude",
          realBinaryName: "claude",
          envVarName: "CLAUDE_CONFIG_DIR",
          identitiesJsonPath: registryPath,
          identitiesRootDir: join(home, "identities"),
          globalMemoryProjection: "claude-append-file",
        };
  const configDir = join(home, "cfg");
  await mkdir(configDir, { recursive: true });
  await createIdentityInRegistry(tool, { name: "testa", label: "Test A", configDir }, [cfg]);
  return { cfg, registryPath };
}

describe("codexLoginMethod through the registry API", () => {
  test("defaults to device, switches to browser, and back clears the field", async () => {
    const { cfg, registryPath } = await setup("codex");
    const configs = [cfg];
    const set = await updateIdentityInRegistry("codex", "testa", { codexLoginMethod: "browser" }, configs);
    expect(set.identities[0]!.codexLoginMethod).toBe("browser");
    expect(JSON.parse(await readFile(registryPath, "utf8")).identities[0].codexLoginMethod).toBe("browser");
    const back = await updateIdentityInRegistry("codex", "testa", { codexLoginMethod: "device" }, configs);
    expect(back.identities[0]!.codexLoginMethod).toBe("device");
    expect(JSON.parse(await readFile(registryPath, "utf8")).identities[0].codexLoginMethod).toBeUndefined();
  });

  test("invalid values and non-codex tools are 400", async () => {
    const codex = await setup("codex");
    await expect(
      updateIdentityInRegistry("codex", "testa", { codexLoginMethod: "magic" }, [codex.cfg]),
    ).rejects.toBeInstanceOf(HttpError);
    const claude = await setup("claude");
    try {
      await updateIdentityInRegistry("claude", "testa", { codexLoginMethod: "browser" }, [claude.cfg]);
      expect.unreachable();
    } catch (err) {
      expect((err as HttpError).status).toBe(400);
    }
  });
});
