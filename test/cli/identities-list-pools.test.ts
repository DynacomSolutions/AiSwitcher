import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printRegistry } from "../../src/cli/identities/list.ts";
import type { ToolConfig } from "../../src/identities/types.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeClaude(identities: unknown[]): Promise<ToolConfig> {
  const dir = await mkdtemp(join(tmpdir(), "ais-list-pools-"));
  tempDirs.push(dir);
  const identitiesJsonPath = join(dir, "identities.json");
  await Bun.write(identitiesJsonPath, JSON.stringify({ version: 1, identities }));
  return {
    toolName: "claude",
    realBinaryName: "claude",
    envVarName: "CLAUDE_CONFIG_DIR",
    globalMemoryProjection: "claude-append-file",
    identitiesJsonPath,
    identitiesRootDir: join(dir, "identities"),
  };
}

async function render(cfg: ToolConfig): Promise<string> {
  const prev = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await printRegistry(cfg);
    return log.mock.calls.map((c) => String(c[0])).join("\n");
  } finally {
    log.mockRestore();
    if (prev === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prev;
  }
}

const member = (name: string, label: string) => ({ name, label, configDir: `/example/${name}` });

describe("ais identities list: pools", () => {
  test("pool is excluded from the tree and listed apart with every member", async () => {
    const cfg = await makeClaude([
      member("solo", "Solo"),
      member("acct-a", "Account A"),
      member("acct-b", "Account B"),
      member("acct-c", "Account C"),
      {
        ...member("shared-pool", "Shared Pool"),
        swapPool: { accounts: ["acct-a", "acct-b", "acct-c"], active: "acct-b", disallowed: ["acct-c"] },
      },
    ]);
    const out = await render(cfg);
    const [tree, section] = out.split("claude pools (not identities)");
    expect(section).toBeDefined();
    expect(tree).toContain("solo");
    expect(tree).not.toContain("shared-pool");
    expect(tree).not.toContain("/example/shared-pool");
    expect(section).toContain("shared-pool  (Shared Pool)");
    expect(section).toContain("/example/shared-pool");
    const lines = section!.split("\n");
    const a = lines.find((l) => l.includes("acct-a"))!;
    const b = lines.find((l) => l.includes("acct-b"))!;
    const c = lines.find((l) => l.includes("acct-c"))!;
    expect(a).toContain("Account A");
    expect(a).toContain("yes");
    expect(a).not.toContain("active");
    expect(b).toContain("* ");
    expect(b).toContain("active");
    expect(b).toContain("yes");
    expect(c).toContain("no (disallowed)");
    expect(c).not.toContain("active");
  });

  test("registry without pools prints no pool section", async () => {
    const cfg = await makeClaude([member("solo", "Solo")]);
    expect(await render(cfg)).not.toContain("claude pools");
  });
});
