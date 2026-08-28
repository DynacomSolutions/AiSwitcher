import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readlink, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GROK_CONFIG,
  KIMI_CONFIG,
  PI_CONFIG,
  OPENCODE_CONFIG,
  ZAI_CONFIG,
} from "../src/identities/tool-configs.ts";
import {
  appendGlobalMemory,
  ensureGlobalMemoryFile,
  projectGlobalMemoryForLaunch,
  readGlobalMemory,
} from "../src/shared/global-memory.ts";

const homes: string[] = [];

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ais-memory-test-"));
  homes.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("AIS global memory", () => {
  test("creates one private canonical file and appends durable entries", async () => {
    const root = await home();
    const path = await ensureGlobalMemoryFile(root);
    expect(path).toBe(join(root, ".ais", "memory", "GLOBAL.md"));
    await appendGlobalMemory("## Durable fact\n\n- one source", root);
    expect(await readGlobalMemory(root)).toContain("## Durable fact\n\n- one source");
  });

  test("uses native runtime instruction channels without vendor memory copies", async () => {
    const root = await home();
    const path = await ensureGlobalMemoryFile(root);
    const claude = await projectGlobalMemoryForLaunch(CLAUDE_CONFIG, "/identity", ["-p", "hi"], {}, root);
    expect(claude.argv).toEqual(["--append-system-prompt-file", path, "-p", "hi"]);

    const codex = await projectGlobalMemoryForLaunch(CODEX_CONFIG, "/identity", ["exec", "hi"], {}, root);
    expect(codex.argv[0]).toBe("-c");
    expect(codex.argv[1]).toStartWith("developer_instructions=");
    expect(codex.argv.slice(2)).toEqual(["exec", "hi"]);

    const grok = await projectGlobalMemoryForLaunch(GROK_CONFIG, "/identity", ["-p", "hi"], {}, root);
    expect(grok.argv[0]).toBe("--rules");
    expect(grok.argv[1]).toContain("# AIS global memory");

    const pi = await projectGlobalMemoryForLaunch(PI_CONFIG, "/identity", ["-p", "hi"], {}, root);
    expect(pi.argv).toEqual(["--append-system-prompt", path, "-p", "hi"]);
  });

  test("projects Kimi through its native global AGENTS.md discovery", async () => {
    const root = await home();
    const projection = await projectGlobalMemoryForLaunch(KIMI_CONFIG, "/identity", [], {}, root);
    expect(await readlink(join(root, ".agents", "AGENTS.md"))).toBe(projection.memoryPath);
  });

  test("merges OpenCode runtime instructions with existing config content", async () => {
    const root = await home();
    const projection = await projectGlobalMemoryForLaunch(
      OPENCODE_CONFIG,
      "/identity",
      ["run", "hi"],
      { OPENCODE_CONFIG_CONTENT: '{"instructions":["existing.md"],"theme":"dark"}' },
      root,
    );
    const config = JSON.parse(projection.env.OPENCODE_CONFIG_CONTENT!);
    expect(config.instructions).toEqual(["existing.md", projection.memoryPath]);
    expect(config.theme).toBe("dark");
  });

  test("adds Crush global context without replacing identity settings", async () => {
    const root = await home();
    const configDir = join(root, "zai");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "crush.json"), '{"providers":{"zai":{"api_key":"test"}},"options":{"debug":true}}');
    const projection = await projectGlobalMemoryForLaunch(ZAI_CONFIG, configDir, ["models"], {}, root);
    const config = JSON.parse(await readFile(join(configDir, "crush.json"), "utf8"));
    expect(config.providers.zai.api_key).toBe("test");
    expect(config.options.debug).toBe(true);
    expect(config.options.global_context_paths).toEqual([projection.memoryPath]);
  });
});
