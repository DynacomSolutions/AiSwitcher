import { readdir, readlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { IDENTITY_SESSION_MARKER, withUsableCwd } from "../shared/exec.ts";
import { TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import type { ProcessInfoDto, ProcessesDto } from "./types.ts";

const PROC = "/proc";

/** Binary names that count as "an AI agent is running". Shim names (zai/ali)
 * and real binaries (crush) both appear; the marker env var is what actually
 * attributes a process to an identity. */
const AGENT_BINARIES = new Set(["claude", "codex", "grok", "kimi", "zai", "ali", "pi", "crush", "opencode"]);

/** Every per-identity config-dir env var any tool wrapper sets (envVarName
 * plus each extraEnvVarNames entry). The spend guard reads these from a
 * process's /proc/<pid>/environ to confirm a marked session's tool
 * config dir, same detection shape as herdr's own environ matching. */
const IDENTITY_ENV_VARS: ReadonlySet<string> = new Set(
  Object.values(TOOL_CONFIGS).flatMap((cfg) => [
    cfg.envVarName,
    ...(cfg.extraEnvVarNames ?? []).map((extra) => extra.name),
  ]),
);

function clockTicksPerSecond(): number {
  // Linux is essentially always 100, but read it properly where possible.
  try {
    const clkTck = withUsableCwd(() => Bun.spawnSync(["getconf", "CLK_TCK"])).stdout.toString().trim();
    const n = Number.parseInt(clkTck, 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    // fall through
  }
  return 100;
}

async function bootTimeSeconds(): Promise<number | null> {
  try {
    const text = await Bun.file(join(PROC, "stat")).text();
    for (const line of text.split("\n")) {
      if (line.startsWith("btime ")) {
        const v = Number.parseFloat(line.slice(6));
        if (Number.isFinite(v)) return v;
      }
    }
  } catch {
    // fall through
  }
  return null;
}

interface RawProc {
  pid: number;
  command: string;
  binary: string;
  identity: string | null;
  /** True when the environ carried the wrapper's IDENTITY_SESSION_MARKER. */
  wrapped: boolean;
  /** The per-identity config-dir env vars present in the process env. */
  identityEnv: Record<string, string>;
  cwd: string | null;
  startedAt: string | null;
}

/** Reads one process's attributes. Returns undefined when the process
 * vanished mid-scan or belongs to another user (environ/cwd unreadable).
 * A process can still qualify via cmdline alone when environ is readable but
 * has no marker; identity attribution simply stays null then. */
/** The identity-bearing slice of one process's environment: the wrapper's
 * session marker (identity name + wrapped flag) and any recognised
 * per-identity config-dir env vars. Pure over the raw environ text so the
 * herdr bridge can attribute pane pids with exactly the same rules. */
export interface EnvironAttribution {
  identity: string | null;
  wrapped: boolean;
  identityEnv: Record<string, string>;
}

/** Pure environ-text parser (the same shape the herdr detection uses):
 * NUL-separated KEY=VALUE entries. A marker with an empty value still means
 * wrapped, with identity null. Exported for tests and the herdr bridge. */
export function parseIdentityEnviron(text: string): EnvironAttribution {
  let identity: string | null = null;
  let wrapped = false;
  const identityEnv: Record<string, string> = {};
  for (const entry of text.split("\0")) {
    if (entry.startsWith(`${IDENTITY_SESSION_MARKER}=`)) {
      identity = entry.slice(IDENTITY_SESSION_MARKER.length + 1) || null;
      wrapped = true;
      continue;
    }
    const eq = entry.indexOf("=");
    if (eq > 0 && IDENTITY_ENV_VARS.has(entry.slice(0, eq))) {
      identityEnv[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  }
  return { identity, wrapped, identityEnv };
}

/** Reads and parses one process's /proc/<pid>/environ. Undefined when the
 * process vanished mid-scan or belongs to another user (unreadable). */
export async function readProcessEnviron(pid: number): Promise<EnvironAttribution | undefined> {
  let text: string;
  try {
    text = new TextDecoder().decode(await Bun.file(join(PROC, String(pid), "environ")).bytes());
  } catch {
    return undefined;
  }
  return parseIdentityEnviron(text);
}

async function inspectPid(pid: number, ticks: number, btime: number | null): Promise<RawProc | undefined> {
  const base = join(PROC, String(pid));
  let command = "";
  try {
    const raw = await Bun.file(join(base, "cmdline")).bytes();
    command = new TextDecoder().decode(raw).replace(/\0+$/, "");
    if (!command) return undefined; // kernel thread or zombie
  } catch {
    return undefined;
  }
  const argv0 = command.split("\0")[0] ?? "";
  const binary = argv0.split("/").pop() ?? argv0;
  if (!AGENT_BINARIES.has(binary)) return undefined;

  let identity: string | null = null;
  let wrapped = false;
  const identityEnv: Record<string, string> = {};
  let cwd: string | null = null;
  let startedAt: string | null = null;
  try {
    const parsed = parseIdentityEnviron(new TextDecoder().decode(await Bun.file(join(base, "environ")).bytes()));
    identity = parsed.identity;
    wrapped = parsed.wrapped;
    Object.assign(identityEnv, parsed.identityEnv);
  } catch {
    // Other-user process: still report the binary/command line.
  }
  try {
    cwd = await readlink(join(base, "cwd"));
  } catch {
    // unreadable for other-user processes
  }
  try {
    const statText = await Bun.file(join(base, "stat")).text();
    // Field 22 (1-indexed) is starttime in clock ticks after boot. comm may
    // contain spaces/parens, so split from the LAST ')'.
    const afterComm = statText.slice(statText.lastIndexOf(")") + 2);
    const fields = afterComm.split(" ");
    const starttimeTicks = Number.parseFloat(fields[19]); // field 22 overall
    if (Number.isFinite(starttimeTicks) && btime !== null) {
      startedAt = new Date((btime + starttimeTicks / ticks) * 1000).toISOString();
    }
  } catch {
    // best effort only
  }
  return { pid, command: command.replace(/\0/g, " ").trim(), binary, identity, wrapped, identityEnv, cwd, startedAt };
}

export async function scanProcesses(now: Date = new Date()): Promise<ProcessesDto> {
  const ticks = clockTicksPerSecond();
  const btime = await bootTimeSeconds();
  let pids: string[] = [];
  try {
    pids = await readdir(PROC);
  } catch {
    return { processes: [], scannedAt: now.toISOString() };
  }
  const inspected = await Promise.all(
    pids
      .filter((p) => /^\d+$/.test(p))
      .map((p) => Number.parseInt(p, 10))
      .map((pid) => inspectPid(pid, ticks, btime)),
  );
  const processes: ProcessInfoDto[] = inspected
    .filter((p): p is RawProc => p !== undefined)
    .map((p) => ({
      pid: p.pid,
      tool: p.binary,
      identity: p.identity,
      cwd: p.cwd,
      startedAt: p.startedAt,
      command: p.command.replace(new RegExp(`^${homedir()}`), "~"),
      ...(p.wrapped ? { wrapped: true } : {}),
      ...(Object.keys(p.identityEnv).length > 0 ? { identityEnv: p.identityEnv } : {}),
    }))
    .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.pid - b.pid);
  return { processes, scannedAt: now.toISOString() };
}
