import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliUsageError } from "../../src/cli/errors.ts";
import { resolveMutationTarget } from "../../src/cli/identities/resolve-tool.ts";
import type { ToolConfig } from "../../src/identities/types.ts";

// resolveMutationTarget always does real Bun.file I/O (via loadIdentitiesFile),
// so this exercises it against real temp files rather than in-memory objects —
// its injectable `configs` param (default: the real TOOL_CONFIGS values)
// exists specifically so tests never have to touch the user's actual
// ~/.claude, ~/.codex, or ~/.grok registries.
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
  const dir = await mkdtemp(join(tmpdir(), "ais-resolve-tool-test-"));
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

describe("resolveMutationTarget", () => {
  test("auto-resolves when the name exists in exactly one registry", async () => {
    const claude = await makeRegistry("claude", [
      { name: "personal", label: "Personal", configDir: "/tmp/does-not-exist/personal" },
    ]);
    const codex = await makeRegistry("codex", []);

    const resolved = await resolveMutationTarget({}, "personal", [claude, codex]);
    expect(resolved.cfg.toolName).toBe("claude");
  });

  test("resolves via alias too", async () => {
    const claude = await makeRegistry("claude", [
      { name: "work", label: "Work", configDir: "/tmp/does-not-exist/work", aliases: ["w"] },
    ]);
    const codex = await makeRegistry("codex", []);

    const resolved = await resolveMutationTarget({}, "w", [claude, codex]);
    expect(resolved.cfg.toolName).toBe("claude");
  });

  test("requires --tool when the name exists in both registries", async () => {
    const claude = await makeRegistry("claude", [
      { name: "shared", label: "Shared", configDir: "/tmp/does-not-exist/shared-claude" },
    ]);
    const codex = await makeRegistry("codex", [
      { name: "shared", label: "Shared", configDir: "/tmp/does-not-exist/shared-codex" },
    ]);

    await expect(resolveMutationTarget({}, "shared", [claude, codex])).rejects.toThrow(CliUsageError);
  });

  test("throws when the name exists in neither registry", async () => {
    const claude = await makeRegistry("claude", []);
    const codex = await makeRegistry("codex", []);

    await expect(resolveMutationTarget({}, "ghost", [claude, codex])).rejects.toThrow(CliUsageError);
  });

  test("requires --tool when the name exists in all three registries", async () => {
    const claude = await makeRegistry("claude", [
      { name: "shared", label: "Shared", configDir: "/tmp/does-not-exist/shared-claude" },
    ]);
    const codex = await makeRegistry("codex", [
      { name: "shared", label: "Shared", configDir: "/tmp/does-not-exist/shared-codex" },
    ]);
    const grok = await makeRegistry("grok", [
      { name: "shared", label: "Shared", configDir: "/tmp/does-not-exist/shared-grok" },
    ]);

    await expect(resolveMutationTarget({}, "shared", [claude, codex, grok])).rejects.toThrow(CliUsageError);
  });

  test("auto-resolves to the one registry containing the name among three", async () => {
    const claude = await makeRegistry("claude", []);
    const codex = await makeRegistry("codex", []);
    const grok = await makeRegistry("grok", [
      { name: "personal", label: "Personal", configDir: "/tmp/does-not-exist/personal" },
    ]);

    const resolved = await resolveMutationTarget({}, "personal", [claude, codex, grok]);
    expect(resolved.cfg.toolName).toBe("grok");
  });
});
