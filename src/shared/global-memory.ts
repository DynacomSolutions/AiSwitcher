import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { ToolConfig } from "../identities/types.ts";
import { aisClaudeProjectionDir, aisGlobalMemoryPath } from "./ais-home.ts";

export const INITIAL_MEMORY = `# AIS global memory

This is the machine-local source of durable context shared by every
AIS-managed agent and identity. Vendor-specific files are projections only.

Only add durable facts when the user explicitly asks for them to be saved.
Use \`ais memory add\` (or \`ais memory add --stdin\` for multiline Markdown).
`;

export interface GlobalMemoryLaunchProjection {
  argv: string[];
  env: Record<string, string>;
  memoryPath: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeAtomic(path: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, content, { mode });
    await rename(temporary, path);
    await chmod(path, mode);
  } finally {
    if (await exists(temporary)) await unlink(temporary);
  }
}

export async function ensureGlobalMemoryFile(home: string = homedir()): Promise<string> {
  const path = aisGlobalMemoryPath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(INITIAL_MEMORY);
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Existing file: a read-only mount (Codex workspace-write sandbox) must not break reads.
    if (((await stat(path)).mode & 0o777) !== 0o600) {
      try {
        await chmod(path, 0o600);
      } catch (chmodError) {
        if (!["EROFS", "EPERM", "EACCES"].includes((chmodError as NodeJS.ErrnoException).code ?? "")) throw chmodError;
      }
    }
  }
  return path;
}

export async function readGlobalMemory(home: string = homedir()): Promise<string> {
  return readFile(await ensureGlobalMemoryFile(home), "utf8");
}

/** New file content produced by appending `entry`; shared by the in-place and
 * git-base landing write paths so both append identically. */
export function appendedMemoryContent(current: string, entry: string): string {
  return `${current}${appendedMemoryBlock(entry)}`;
}

/** The exact bytes an append adds after content that ends with a newline. */
export function appendedMemoryBlock(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) throw new Error("Global memory entry cannot be empty");
  return `\n${trimmed}\n`;
}

export async function appendGlobalMemory(entry: string, home: string = homedir()): Promise<string> {
  const trimmed = entry.trim();
  if (!trimmed) throw new Error("Global memory entry cannot be empty");
  const path = await ensureGlobalMemoryFile(home);
  const handle = await open(path, "a", 0o600);
  try {
    await handle.write(`\n${trimmed}\n`);
  } finally {
    await handle.close();
  }
  return path;
}

async function ensureKimiProjection(memoryPath: string, home: string): Promise<void> {
  const projection = join(home, ".agents", "AGENTS.md");
  await mkdir(dirname(projection), { recursive: true, mode: 0o700 });
  try {
    const stat = await lstat(projection);
    if (stat.isSymbolicLink() && (await readlink(projection)) === memoryPath) return;
    throw new Error(
      `Cannot project AIS global memory into Kimi: ${projection} already exists and is not the AIS-managed link`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await symlink(memoryPath, projection);
}

/** Grok loads every `*.md` in `$GROK_HOME/rules/` as a global rule (verified
 * with 1.0.50: `grok inspect` lists it and the model sees it). A symlink keeps
 * the ~43 KB memory off argv, where `pkill -f` patterns matched and killed it. */
async function ensureGrokProjection(configDir: string, memoryPath: string): Promise<void> {
  const projection = join(configDir, "rules", "ais-global-memory.md");
  await mkdir(dirname(projection), { recursive: true, mode: 0o700 });
  try {
    const stat = await lstat(projection);
    if (stat.isSymbolicLink() && (await readlink(projection)) === memoryPath) return;
    if (!stat.isSymbolicLink()) {
      throw new Error(
        `Cannot project AIS global memory into Grok: ${projection} already exists and is not an AIS-managed link`,
      );
    }
    await unlink(projection); // stale AIS link (memory path moved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await symlink(memoryPath, projection);
}

/** True when a host drives Claude over the Agent SDK control protocol
 * (`--input-format stream-json`). Such a host sends its own
 * `appendSystemPrompt` in `initialize`, and Claude Code then drops the text of
 * `--append-system-prompt-file`. */
export function isSdkHostLaunch(argv: readonly string[]): boolean {
  return argv.some(
    (arg, index) =>
      arg === "--input-format=stream-json" || (arg === "--input-format" && argv[index + 1] === "stream-json"),
  );
}

/** `<aisHome>/claude-memory-projection/CLAUDE.md` links to the memory file.
 * Claude Code loads it as an additional-directory CLAUDE.md, a channel that
 * the host's `appendSystemPrompt` does not replace (verified with a live probe). */
async function ensureClaudeProjection(memoryPath: string, home: string): Promise<string> {
  const dir = aisClaudeProjectionDir(home);
  const projection = join(dir, "CLAUDE.md");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    const stat = await lstat(projection);
    if (stat.isSymbolicLink() && (await readlink(projection)) === memoryPath) return dir;
    if (!stat.isSymbolicLink()) {
      throw new Error(
        `Cannot project AIS global memory into Claude: ${projection} already exists and is not an AIS-managed link`,
      );
    }
    await unlink(projection); // stale AIS link (memory path moved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await symlink(memoryPath, projection);
  return dir;
}

async function ensureCrushProjection(configDir: string, memoryPath: string): Promise<void> {
  const configPath = join(configDir, "crush.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Cannot add AIS global memory to ${configPath}: ${(error as Error).message}`);
    }
  }

  const options = config.options && typeof config.options === "object" && !Array.isArray(config.options)
    ? { ...(config.options as Record<string, unknown>) }
    : {};
  const current = Array.isArray(options.global_context_paths)
    ? options.global_context_paths.filter((value): value is string => typeof value === "string")
    : [];
  if (current.includes(memoryPath)) return;
  options.global_context_paths = [...current, memoryPath];
  config.options = options;
  await writeAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function openCodeConfigContent(existing: string | undefined, memoryPath: string): string {
  let config: Record<string, unknown> = {};
  if (existing?.trim()) {
    try {
      config = JSON.parse(existing) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`OPENCODE_CONFIG_CONTENT is not valid JSON: ${(error as Error).message}`);
    }
  }
  const instructions = Array.isArray(config.instructions)
    ? config.instructions.filter((value): value is string => typeof value === "string")
    : [];
  config.instructions = instructions.includes(memoryPath) ? instructions : [...instructions, memoryPath];
  return JSON.stringify(config);
}

/** Pi routes its management subcommands ONLY when the literal first argv
 * token names them (dist/main.js: runAuthCommand/handlePackageCommand/
 * handleConfigCommand all test args[0]). Prepending the memory-projection
 * flag therefore breaks them: `pi update --extensions` launched as
 * `pi --append-system-prompt <memory> update --extensions` is parsed as a
 * CHAT invocation whose message is "update" and whose unknown extension
 * flag --extensions dies with "Error: Unknown option: --extensions"
 * (confirmed live, 2026-09-16). These subcommands are administrative -
 * none of them starts an agent turn - so they need no system-prompt
 * projection at all. Mirror pi's own routing test exactly: first token,
 * not first non-flag token (pi does NOT route `pi --verbose update`). */
export function piBypassesMemoryProjection(argv: readonly string[]): boolean {
  const PI_MANAGEMENT_SUBCOMMANDS = ["install", "remove", "uninstall", "update", "list", "config", "auth"];
  return argv.length > 0 && PI_MANAGEMENT_SUBCOMMANDS.includes(argv[0]!);
}

/** Project the one AIS-owned memory file through each tool's supported
 * native instruction channel. No adapter creates another writable store.
 * Claude normally gets `--append-system-prompt-file`. An SDK host launch
 * (see `isSdkHostLaunch`) gets a linked `CLAUDE.md` folder through `--add-dir`
 * plus `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, because the host's
 * own append would replace the file flag. */
export async function projectGlobalMemoryForLaunch(
  cfg: ToolConfig,
  configDir: string,
  argv: string[],
  inheritedEnv: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): Promise<GlobalMemoryLaunchProjection> {
  const memoryPath = await ensureGlobalMemoryFile(home);
  const content = await readFile(memoryPath, "utf8");

  switch (cfg.globalMemoryProjection) {
    case "claude-append-file":
      if (isSdkHostLaunch(argv)) {
        const dir = await ensureClaudeProjection(memoryPath, home);
        return {
          argv: ["--add-dir", dir, ...argv],
          env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" },
          memoryPath,
        };
      }
      return { argv: ["--append-system-prompt-file", memoryPath, ...argv], env: {}, memoryPath };
    case "codex-developer-instructions":
      return { argv: ["-c", `developer_instructions=${JSON.stringify(content)}`, ...argv], env: {}, memoryPath };
    case "grok-rules":
      await ensureGrokProjection(configDir, memoryPath);
      return { argv: [...argv], env: {}, memoryPath };
    case "kimi-global-agents":
      await ensureKimiProjection(memoryPath, home);
      return { argv: [...argv], env: {}, memoryPath };
    case "pi-append-file":
      // Management subcommands must stay at argv[0] or pi misroutes them
      // into chat mode - see piBypassesMemoryProjection.
      if (piBypassesMemoryProjection(argv)) return { argv: [...argv], env: {}, memoryPath };
      return { argv: ["--append-system-prompt", memoryPath, ...argv], env: {}, memoryPath };
    case "opencode-config-content":
      return {
        argv: [...argv],
        env: { OPENCODE_CONFIG_CONTENT: openCodeConfigContent(inheritedEnv.OPENCODE_CONFIG_CONTENT, memoryPath) },
        memoryPath,
      };
    case "crush-global-context":
      await ensureCrushProjection(configDir, memoryPath);
      return { argv: [...argv], env: {}, memoryPath };
  }
}
