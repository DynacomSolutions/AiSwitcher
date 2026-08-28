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
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { ToolConfig } from "../identities/types.ts";
import { aisGlobalMemoryPath } from "./ais-home.ts";

const INITIAL_MEMORY = `# AIS global memory

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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await chmod(path, 0o600);
  return path;
}

export async function readGlobalMemory(home: string = homedir()): Promise<string> {
  return readFile(await ensureGlobalMemoryFile(home), "utf8");
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

/** Project the one AIS-owned memory file through each tool's supported
 * native instruction channel. No adapter creates another writable store. */
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
      return { argv: ["--append-system-prompt-file", memoryPath, ...argv], env: {}, memoryPath };
    case "codex-developer-instructions":
      return { argv: ["-c", `developer_instructions=${JSON.stringify(content)}`, ...argv], env: {}, memoryPath };
    case "grok-rules":
      return { argv: ["--rules", content, ...argv], env: {}, memoryPath };
    case "kimi-global-agents":
      await ensureKimiProjection(memoryPath, home);
      return { argv: [...argv], env: {}, memoryPath };
    case "pi-append-file":
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
