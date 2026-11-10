import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { normalizePath, untranslateHostPath } from "./match.ts";

/** Tools whose running sessions can be found by their config-folder variable. */
export type SessionTool = "claude" | "codex" | "pi";

const ENV_OF: Record<SessionTool, string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", pi: "PI_CODING_AGENT_DIR" };
const DEFAULT_DIR_OF: Record<SessionTool, string> = { claude: ".claude", codex: ".codex", pi: join(".pi", "agent") };
/** The package entry a node launcher runs when argv[1] is not named after the tool (`node …/cli.js`). */
const PACKAGE_ENTRY_OF: Record<SessionTool, RegExp> = {
  claude: /(^|\/)@anthropic-ai\/claude-code\/cli\.m?js$/,
  codex: /(^|\/)@openai\/codex\/bin\/codex(\.m?js)?$/,
  pi: /(^|\/)pi-coding-agent\/dist\/cli\.m?js$/,
};

export interface LiveSessionOptions {
  /** /proc (tests pass a fake tree). */
  procRoot?: string;
  /** Home that holds the tool's default folder, used for a process without the variable and without HOME (default the user's home). */
  home?: string;
}

export interface LiveSessionScan {
  pids: number[];
  /** Set when the scan could not run (no /proc, unreadable, or this process not visible in it): the pids prove nothing. */
  unavailable?: string;
}

const toolName = (path: string | undefined): string => basename(path ?? "").replace(/\.exe$/, "");

const envOf = (text: string): Map<string, string> => {
  const map = new Map<string, string>();
  for (const kv of text.split("\0")) {
    const eq = kv.indexOf("=");
    if (eq > 0 && !map.has(kv.slice(0, eq))) map.set(kv.slice(0, eq), kv.slice(eq + 1));
  }
  return map;
};

/**
 * Running `tool` sessions (owned by this user) whose config folder is `configDir`: the folder variable (CLAUDE_CONFIG_DIR,
 * CODEX_HOME, PI_CODING_AGENT_DIR) when the process has it, else the tool's default folder in the process's HOME (or
 * `home`). A process is the tool when its argv[0], its executable or (a node launcher) its argv[1] is named after it or is
 * the tool's package entry (`node …/@anthropic-ai/claude-code/cli.js`); AIS helper subcommands (`claude __session-sidecar`)
 * are not sessions. Folders are compared after resolving symlinks. A process carrying AIS_HOST_HOME (a console-pod
 * session, whose paths are container paths under its own HOME) has its paths mapped back to the host home first. A
 * process that is the tool but whose environment cannot be read counts as a match (it may use the folder). A null
 * `configDir` finds every session of the tool, whatever its folder.
 * Linux /proc only: elsewhere, or when /proc is unreadable, `unavailable` says why.
 */
export async function scanLiveSessions(tool: SessionTool, configDir: string | null, opts: LiveSessionOptions = {}): Promise<LiveSessionScan> {
  const procRoot = opts.procRoot ?? "/proc";
  const want = configDir === null ? null : normalizePath(configDir);
  const prefix = ENV_OF[tool];
  const uid = process.getuid?.();
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch (err) {
    const why = process.platform === "linux" ? `${procRoot} is unreadable (${(err as NodeJS.ErrnoException).code ?? "error"})` : `no ${procRoot} on ${process.platform}`;
    return { pids: [], unavailable: `cannot check for running sessions: ${why}` };
  }
  // The real /proc must show this very process, or it hides processes (hidepid, a restricted mount).
  if (opts.procRoot === undefined && !entries.includes(String(process.pid))) {
    return { pids: [], unavailable: `cannot check for running sessions: ${procRoot} does not list this process (hidepid or a restricted mount)` };
  }
  // Thousands of processes on a busy host: scan in parallel chunks, a sequential scan took over half a second.
  const pids = entries.filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid);
  const matches = async (entry: string): Promise<boolean> => {
    let argv: string[];
    try {
      if (uid !== undefined && (await stat(`${procRoot}/${entry}`)).uid !== uid) return false;
      argv = (await readFile(`${procRoot}/${entry}/cmdline`, "utf8")).split("\0");
    } catch {
      return false; // gone, or not ours to read
    }
    const exe = await readlink(`${procRoot}/${entry}/exe`).catch(() => undefined);
    const named = toolName(argv[0]) === tool || toolName(exe?.replace(/ \(deleted\)$/, "")) === tool;
    const launched = toolName(argv[1]) === tool || PACKAGE_ENTRY_OF[tool].test(argv[1] ?? "");
    if (!named && !launched) return false;
    if (named && (argv[1] ?? "").startsWith("__")) return false;
    if (want === null) return true;
    let env: Map<string, string>;
    try {
      env = envOf(await readFile(`${procRoot}/${entry}/environ`, "utf8"));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code !== "ENOENT" && code !== "ESRCH"; // the tool, but its folder is unknowable: count it
    }
    const procHome = env.get("HOME")?.trim() || opts.home || homedir();
    const raw = env.get(prefix) ?? join(procHome, DEFAULT_DIR_OF[tool]);
    const expanded = raw.startsWith("~/") || raw === "~" ? join(procHome, raw.slice(1)) : raw;
    const hostHome = env.get("AIS_HOST_HOME");
    const dir = hostHome ? untranslateHostPath(expanded, { AIS_HOST_HOME: hostHome }, procHome.replace(/\/+$/, "")) : expanded;
    return normalizePath(dir) === want;
  };
  const found: number[] = [];
  for (let i = 0; i < pids.length; i += 256) {
    const chunk = pids.slice(i, i + 256);
    const hits = await Promise.all(chunk.map(matches));
    chunk.forEach((pid, n) => {
      if (hits[n]) found.push(Number(pid));
    });
  }
  return { pids: found.sort((a, b) => a - b) };
}

/** `scanLiveSessions` pids, best effort: a scan that cannot run finds none (callers that must refuse use the scan). */
export async function liveSessionPids(tool: SessionTool, configDir: string, opts: LiveSessionOptions = {}): Promise<number[]> {
  return (await scanLiveSessions(tool, configDir, opts)).pids;
}
