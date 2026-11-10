import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { expandPath } from "./match.ts";

/** Tools whose running sessions can be found by their config-folder variable. */
export type SessionTool = "claude" | "codex";

const ENV_OF: Record<SessionTool, string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };
const DEFAULT_DIR_OF: Record<SessionTool, string> = { claude: ".claude", codex: ".codex" };

export interface LiveSessionOptions {
  /** /proc (tests pass a fake tree). */
  procRoot?: string;
  /** Home that holds the tool's default folder, used for a process without the variable (default the user's home). */
  home?: string;
}

const toolName = (path: string | undefined): string => basename(path ?? "").replace(/\.exe$/, "");

/**
 * Process ids of running `tool` sessions (owned by this user) whose config folder is `configDir`: the folder variable
 * (CLAUDE_CONFIG_DIR, CODEX_HOME) when the process has it, else the tool's default folder in `home`. A process is the
 * tool when its argv[0], its executable or (a node launcher) its argv[1] is named after it; AIS helper subcommands
 * (`claude __session-sidecar`) are not sessions. Linux /proc only: elsewhere, or when /proc is unreadable, none are found.
 */
export async function liveSessionPids(tool: SessionTool, configDir: string, opts: LiveSessionOptions = {}): Promise<number[]> {
  const procRoot = opts.procRoot ?? "/proc";
  const want = resolve(expandPath(configDir));
  const fallback = resolve(join(opts.home ?? homedir(), DEFAULT_DIR_OF[tool]));
  const prefix = `${ENV_OF[tool]}=`;
  const uid = process.getuid?.();
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch {
    return [];
  }
  // Thousands of processes on a busy host: scan in parallel chunks, a sequential scan took over half a second.
  const pids = entries.filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid);
  const matches = async (entry: string): Promise<boolean> => {
    try {
      if (uid !== undefined && (await stat(`${procRoot}/${entry}`)).uid !== uid) return false;
      const argv = (await readFile(`${procRoot}/${entry}/cmdline`, "utf8")).split("\0");
      const exe = await readlink(`${procRoot}/${entry}/exe`).catch(() => undefined);
      const named = toolName(argv[0]) === tool || toolName(exe?.replace(/ \(deleted\)$/, "")) === tool;
      const launched = toolName(argv[1]) === tool;
      if (!named && !launched) return false;
      if (named && (argv[1] ?? "").startsWith("__")) return false;
      const env = (await readFile(`${procRoot}/${entry}/environ`, "utf8")).split("\0").find((kv) => kv.startsWith(prefix));
      const dir = env === undefined ? fallback : resolve(expandPath(env.slice(prefix.length)));
      return dir === want;
    } catch {
      return false; // gone, or not ours to read
    }
  };
  const found: number[] = [];
  for (let i = 0; i < pids.length; i += 256) {
    const chunk = pids.slice(i, i + 256);
    const hits = await Promise.all(chunk.map(matches));
    chunk.forEach((pid, n) => {
      if (hits[n]) found.push(Number(pid));
    });
  }
  return found.sort((a, b) => a - b);
}
