import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { chmod, lstat, readdir, stat, mkdtemp, readFile, readlink, rm, symlink, writeFile, mkdir } from "node:fs/promises";
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
  isSdkHostLaunch,
  piBypassesMemoryProjection,
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
  await Promise.all(
    homes.splice(0).map(async (path) => {
      // The projection folder is deliberately read-only.
      await chmod(join(path, ".ais", "claude-memory-projection"), 0o700).catch(() => undefined);
      await rm(path, { recursive: true, force: true });
    }),
  );
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

    // Grok: memory must stay off argv (pkill -f matched the 43 KB cmdline);
    // it arrives as a symlinked global rule under $GROK_HOME/rules/.
    const grokDir = join(root, "grok-home");
    const grok = await projectGlobalMemoryForLaunch(GROK_CONFIG, grokDir, ["-p", "hi"], {}, root);
    expect(grok.argv).toEqual(["-p", "hi"]);
    const rule = join(grokDir, "rules", "ais-global-memory.md");
    expect(await readlink(rule)).toBe(path);
    await projectGlobalMemoryForLaunch(GROK_CONFIG, grokDir, ["-p", "hi"], {}, root); // idempotent

    const pi = await projectGlobalMemoryForLaunch(PI_CONFIG, "/identity", ["-p", "hi"], {}, root);
    expect(pi.argv).toEqual(["--append-system-prompt", path, "-p", "hi"]);
  });

  test("pi management subcommands bypass the prepend so pi still routes them", async () => {
    const root = await home();
    // pi routes package/config/auth subcommands ONLY when argv[0] names them;
    // a prepended flag turns `pi update --extensions` into a chat launch that
    // dies with "Unknown option: --extensions" (confirmed live, 2026-09-16).
    for (const argv of [
      ["update", "--extensions"],
      ["update", "self"],
      ["install", "npm:some-extension"],
      ["remove", "some-extension"],
      ["uninstall", "some-extension"],
      ["list"],
      ["config"],
      ["auth", "check"],
    ]) {
      const projection = await projectGlobalMemoryForLaunch(PI_CONFIG, "/identity", argv, {}, root);
      expect(projection.argv).toEqual(argv);
    }
    // A chat message that merely STARTS with the word "update" still gets the
    // projection - bypass keys off argv[0] exactly, like pi's own router.
    const chat = await projectGlobalMemoryForLaunch(PI_CONFIG, "/identity", ["update the readme"], {}, root);
    expect(chat.argv[0]).toBe("--append-system-prompt");
    expect(piBypassesMemoryProjection([])).toBe(false);
    expect(piBypassesMemoryProjection(["--verbose", "update"])).toBe(false);
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

describe("Claude launches started by an SDK host", () => {
  const sdkArgv = ["--output-format", "stream-json", "--input-format", "stream-json", "--verbose"];
  const claudeDir = (root: string) => join(root, ".ais", "claude-memory-projection");

  async function quietly<T>(run: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
    const warnings: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((line: unknown) => {
      warnings.push(String(line));
    });
    try {
      return { result: await run(), warnings };
    } finally {
      spy.mockRestore();
    }
  }

  function expectFallback(projection: { argv: string[]; env: Record<string, string> }, memory: string) {
    expect(projection.argv).toEqual(["--append-system-prompt-file", memory, ...sdkArgv]);
    expect(projection.env).toEqual({});
  }

  test("detects both spellings of the input format flag", () => {
    expect(isSdkHostLaunch(sdkArgv)).toBe(true);
    expect(isSdkHostLaunch(["--input-format=stream-json"])).toBe(true);
    expect(isSdkHostLaunch(["--input-format", "text"])).toBe(false);
    expect(isSdkHostLaunch(["--output-format", "stream-json"])).toBe(false);
    expect(isSdkHostLaunch(["-p", "stream-json"])).toBe(false);
  });

  test("links a CLAUDE.md folder instead of the append file and locks it", async () => {
    const root = await home();
    const memory = await ensureGlobalMemoryFile(root);
    const dir = claudeDir(root);
    for (const argv of [sdkArgv, ["--input-format=stream-json", "--verbose"]]) {
      const projection = await projectGlobalMemoryForLaunch(CLAUDE_CONFIG, "/identity", argv, {}, root);
      expect(projection.argv).toEqual([`--add-dir=${dir}`, ...argv]);
      expect(projection.argv).not.toContain("--append-system-prompt-file");
      expect(projection.env).toEqual({ CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" });
      expect(await readlink(join(dir, "CLAUDE.md"))).toBe(memory);
      expect((await stat(dir)).mode & 0o777).toBe(0o500);
    }
    expect(await readdir(dir)).toEqual(["CLAUDE.md"]);
  });

  test("a launch that finds the folder correct changes nothing", async () => {
    const root = await home();
    await projectGlobalMemoryForLaunch(CLAUDE_CONFIG, "/identity", sdkArgv, {}, root);
    const dir = claudeDir(root);
    const before = await stat(dir);
    const spy = spyOn(fsPromises, "chmod");
    try {
      await projectGlobalMemoryForLaunch(CLAUDE_CONFIG, "/identity", sdkArgv, {}, root);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect((await stat(dir)).ctimeMs).toBe(before.ctimeMs);
  });

  test("8 parallel launches on a fresh home all succeed with one correct link", async () => {
    const root = await home();
    const memory = await ensureGlobalMemoryFile(root);
    const dir = claudeDir(root);
    const { result, warnings } = await quietly(() =>
      Promise.all(
        Array.from({ length: 8 }, () => projectGlobalMemoryForLaunch(CLAUDE_CONFIG, "/identity", sdkArgv, {}, root)),
      ),
    );
    for (const projection of result) expect(projection.argv[0]).toBe(`--add-dir=${dir}`);
    expect(warnings).toEqual([]);
    expect(await readdir(dir)).toEqual(["CLAUDE.md"]);
    expect(await readlink(join(dir, "CLAUDE.md"))).toBe(memory);
    expect((await readdir(join(root, ".ais"))).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  test("repairs a stale link, also in parallel", async () => {
    const root = await home();
    const memory = await ensureGlobalMemoryFile(root);
    const dir = claudeDir(root);
    await mkdir(dir, { recursive: true });
    await symlink(join(root, "moved.md"), join(dir, "CLAUDE.md"));
    await chmod(dir, 0o500);
    const { result, warnings } = await quietly(() =>
      Promise.all(
        Array.from({ length: 8 }, () => projectGlobalMemoryForLaunch(CLAUDE_CONFIG, "/identity", sdkArgv, {}, root)),
      ),
    );
    for (const projection of result) expect(projection.argv[0]).toBe(`--add-dir=${dir}`);
    expect(warnings).toEqual([]);
    expect(await readlink(join(dir, "CLAUDE.md"))).toBe(memory);
    expect((await stat(dir)).mode & 0o777).toBe(0o500);
  });

  test("a read-only ais home falls back to the file flag with a warning", async () => {
    const root = await home();
    const memory = await ensureGlobalMemoryFile(root);
    const ais = join(root, ".ais");
    await chmod(ais, 0o500);
    try {
      const { result, warnings } = await quietly(() =>
        projectGlobalMemoryForLaunch(CLAUDE_CONFIG, "/identity", sdkArgv, {}, root),
      );
      expectFallback(result, memory);
      expect(warnings).toHaveLength(1);
    } finally {
      await chmod(ais, 0o700);
    }
  });

  test("a regular file at the link path falls back and is left untouched", async () => {
    const root = await home();
    const memory = await ensureGlobalMemoryFile(root);
    const dir = claudeDir(root);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "CLAUDE.md"), "mine");
    const { result, warnings } = await quietly(() =>
      projectGlobalMemoryForLaunch(CLAUDE_CONFIG, "/identity", sdkArgv, {}, root),
    );
    expectFallback(result, memory);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("is not an AIS-managed link");
    expect((await lstat(join(dir, "CLAUDE.md"))).isFile()).toBe(true);
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe("mine");
  });

  test("an extra entry in the folder falls back and the warning names the folder", async () => {
    const root = await home();
    const memory = await ensureGlobalMemoryFile(root);
    const dir = claudeDir(root);
    await mkdir(join(dir, ".claude"), { recursive: true });
    const { result, warnings } = await quietly(() =>
      projectGlobalMemoryForLaunch(CLAUDE_CONFIG, "/identity", sdkArgv, {}, root),
    );
    expectFallback(result, memory);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(dir);
  });

  test("creates nothing inside a memory folder that is a link elsewhere", async () => {
    const root = await home();
    const target = join(root, "checkout", "memory");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "GLOBAL.md"), "# linked memory\n");
    await mkdir(join(root, ".ais"), { recursive: true });
    await symlink(target, join(root, ".ais", "memory"));
    const before = await readdir(target, { recursive: true });
    const projection = await projectGlobalMemoryForLaunch(CLAUDE_CONFIG, "/identity", sdkArgv, {}, root);
    expect(await readdir(target, { recursive: true })).toEqual(before);
    expect(projection.argv[0]).toBe(`--add-dir=${join(root, ".ais", "claude-memory-projection")}`);
  });

  test("normal launches keep the append file and create no folder", async () => {
    const root = await home();
    const memory = await ensureGlobalMemoryFile(root);
    const projection = await projectGlobalMemoryForLaunch(CLAUDE_CONFIG, "/identity", ["-p", "hi"], {}, root);
    expect(projection.argv).toEqual(["--append-system-prompt-file", memory, "-p", "hi"]);
    expect(projection.env).toEqual({});
    await expect(lstat(join(root, ".ais", "claude-memory-projection"))).rejects.toThrow();
  });
});

describe("ensureGlobalMemoryFile on an existing file", () => {
  async function existing(mode: number): Promise<{ root: string; path: string }> {
    const root = await home();
    const path = await ensureGlobalMemoryFile(root);
    await chmod(path, mode);
    return { root, path };
  }

  test("does not chmod an already-0600 file", async () => {
    const { root } = await existing(0o600);
    const spy = spyOn(fsPromises, "chmod");
    try {
      await ensureGlobalMemoryFile(root);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("tolerates EROFS from chmod on a loose-mode existing file", async () => {
    const { root, path } = await existing(0o644);
    const spy = spyOn(fsPromises, "chmod").mockRejectedValue(
      Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" }),
    );
    try {
      expect(await ensureGlobalMemoryFile(root)).toBe(path);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
