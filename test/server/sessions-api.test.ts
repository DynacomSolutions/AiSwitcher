import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, ToolConfig } from "../../src/identities/types.ts";
import { runScan } from "../../src/server/scan-worker.ts";

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

/* --------------------------- scan-worker tree/transcript ------------------- */

async function seedClaudeSession(registryPath: string, configDir: string, sessionId: string): Promise<void> {
  await mkdir(configDir, { recursive: true });
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    identities: [{ name: "testa", label: "Test A", configDir } as Identity],
  }));
  const enc = join(configDir, "projects", "-tmp-proj-a");
  await mkdir(enc, { recursive: true });
  await writeFile(
    join(enc, `${sessionId}.jsonl`),
    [
      { type: "user", message: { role: "user", content: "SYNTHETIC_FIXTURE server scan prompt" }, cwd: "/tmp/proj-a", timestamp: "2026-01-12T08:00:00.000Z", isMeta: false },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "SYNTHETIC_FIXTURE reply" }] }, timestamp: "2026-01-12T08:00:05.000Z" },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

describe("scan-worker tree + transcript kinds", () => {
  test("tree kind returns the per-tool envelope; opencode honest unavailable", async () => {
    const { registryPath, configDir } = await makeHome();
    const configs = [fakeConfig(registryPath)];
    await seedClaudeSession(registryPath, configDir, "srv-sess");

    const result = await runScan<{ tools: Array<{ tool: string; nodes: unknown[]; unavailable?: string }>; days: number }>({
      kind: "tree",
      tool: "claude",
      configs,
      days: 30,
    });
    expect(result.ok).toBe(true);
    const payload = result.payload!;
    expect(payload.days).toBe(30);
    expect(payload.tools).toHaveLength(1);
    expect(payload.tools[0]!.nodes.length).toBe(1);

    const unavailable = await runScan<{ tools: Array<{ tool: string; unavailable?: string; nodes: unknown[] }> }>({
      kind: "tree",
      tool: "opencode",
      configs,
      days: 30,
    });
    expect(unavailable.ok).toBe(true);
    expect(unavailable.payload!.tools[0]!.unavailable).toContain("no session tree reader");
    expect(unavailable.payload!.tools[0]!.nodes).toEqual([]);
  });

  test("transcript kind returns the dto, caches repeats, and maps misses to a 404-shaped result", async () => {
    const { registryPath, configDir } = await makeHome();
    const configs = [fakeConfig(registryPath)];
    await seedClaudeSession(registryPath, configDir, "srv-sess");

    const first = await runScan<{ transcript: { totalTurns: number } | null; cached: boolean }>({
      kind: "transcript",
      tool: "claude",
      identity: "testa",
      id: "srv-sess",
      tail: 50,
      configs,
    });
    expect(first.ok).toBe(true);
    expect(first.payload!.transcript!.totalTurns).toBe(2);
    expect(first.payload!.cached).toBe(false);

    const second = await runScan<{ transcript: { totalTurns: number } | null; cached: boolean }>({
      kind: "transcript",
      tool: "claude",
      identity: "testa",
      id: "srv-sess",
      tail: 50,
      configs,
    });
    expect(second.payload!.cached).toBe(true);

    const missing = await runScan<{ transcript: unknown }>({
      kind: "transcript",
      tool: "claude",
      identity: "testa",
      id: "ghost",
      configs,
    });
    expect(missing.ok).toBe(true);
    expect(missing.payload!.transcript).toBeNull(); // endpoint maps to 404

    const noId = await runScan<unknown>({ kind: "transcript", tool: "claude", identity: "testa", configs });
    expect(noId.ok).toBe(false);
    expect(noId.status).toBe(400);
  });
});
