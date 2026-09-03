import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDoctorTargets } from "../../../src/cli/doctor/collect.ts";
import { CliUsageError } from "../../../src/cli/errors.ts";
import type { ToolConfig } from "../../../src/identities/types.ts";

// Mirrors test/cli/usage/run.test.ts's makeRegistry — collectDoctorTargets
// does real Bun.file I/O via loadIdentitiesFile, so exercise it against real
// temp files rather than in-memory objects, never the user's actual
// registries.
const tempDirs: string[] = [];

const ENV_VAR_NAMES = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  grok: "GROK_HOME",
} as const;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRegistry(toolName: "claude" | "codex" | "grok", identities: unknown[]): Promise<ToolConfig> {
  const dir = await mkdtemp(join(tmpdir(), "ais-doctor-collect-test-"));
  tempDirs.push(dir);
  const identitiesJsonPath = join(dir, "identities.json");
  await writeFile(identitiesJsonPath, JSON.stringify({ version: 1, identities }));
  return {
    toolName,
    realBinaryName: toolName,
    envVarName: ENV_VAR_NAMES[toolName],
    globalMemoryProjection: "claude-append-file",
    identitiesJsonPath,
    identitiesRootDir: join(dir, "identities"),
  };
}

describe("collectDoctorTargets", () => {
  test("with no filters, returns every identity across every registry", async () => {
    const claude = await makeRegistry("claude", [
      { name: "personal", label: "Personal", configDir: "/tmp/does-not-exist/personal" },
    ]);
    const codex = await makeRegistry("codex", [{ name: "work", label: "Work", configDir: "/tmp/does-not-exist/work" }]);

    const targets = await collectDoctorTargets({}, [claude, codex]);
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.toolName).sort()).toEqual(["claude", "codex"]);
  });

  test("--identity matching more than one registry returns every match, not an error", async () => {
    const claude = await makeRegistry("claude", [
      { name: "shared", label: "Shared", configDir: "/tmp/does-not-exist/shared-claude" },
    ]);
    const codex = await makeRegistry("codex", [
      { name: "shared", label: "Shared", configDir: "/tmp/does-not-exist/shared-codex" },
    ]);

    const targets = await collectDoctorTargets({ identity: "shared" }, [claude, codex]);
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.toolName).sort()).toEqual(["claude", "codex"]);
  });

  test("--identity resolves via alias too", async () => {
    const claude = await makeRegistry("claude", [
      { name: "work", label: "Work", configDir: "/tmp/does-not-exist/work", aliases: ["w"] },
    ]);

    const targets = await collectDoctorTargets({ identity: "w" }, [claude]);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.identity.name).toBe("work");
  });

  test("throws when --identity matches nothing", async () => {
    const claude = await makeRegistry("claude", []);

    await expect(collectDoctorTargets({ identity: "ghost" }, [claude])).rejects.toThrow(CliUsageError);
  });

  test("empty result (no filters, no identities anywhere) is not an error", async () => {
    const claude = await makeRegistry("claude", []);

    const targets = await collectDoctorTargets({}, [claude]);
    expect(targets).toEqual([]);
  });
});
