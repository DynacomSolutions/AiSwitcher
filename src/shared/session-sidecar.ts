import { appendFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolConfig } from "../identities/types.ts";
import { launchThenStartBackgroundSync, startBackgroundProfileSync } from "../sync/background.ts";
import { startProfileSyncWatcher } from "../sync/watch.ts";
import { markUsageSnapshotDirty, usageSnapshotTargetKey } from "../cli/usage/snapshot-dirty.ts";
import { aisHerdrTabLabelsPath, aisStateDir } from "./ais-home.ts";
import { isOnline } from "./connectivity.ts";
import { darwinExe, darwinProc } from "./darwin-proc.ts";
import {
  execveReal,
  IDENTITY_SESSION_MARKER,
  IDENTITY_SESSION_TOOL_MARKER,
  spawnReal,
  withUsableCwd,
} from "./exec.ts";
import { readHerdrChatTitle, type HerdrChatTool } from "./herdr-chat-source.ts";
import { HerdrTabTitleWatcher } from "./herdr-tab-title.ts";

/**
 * In-session work (profile-sync watcher, Herdr tab titles, post-exit sync)
 * used to run inside the wrapper, which therefore had to stay alive as the
 * real tool's parent for the whole session. When a wrapper died (a JSC GC
 * crash on 2026-10-14) the tool was orphaned with the terminal in an
 * undefined state. Now the wrapper hands this work to a detached sidecar,
 * then `execve`s the real tool over itself (see execve.ts); the sidecar
 * watches the tool's PID and never touches the terminal.
 */

export const SIDECAR_ARG = "__session-sidecar";
export const SIDECAR_SPEC_ENV = "AIS_SESSION_SIDECAR_SPEC";
/** The title uses about 64 characters; this only bounds the env var (one string holds ~128 KiB). */
export const MAX_PROMPT_BYTES = 1024;
/** The fallback log is truncated when it grows past this. */
export const MAX_LOG_BYTES = 1024 * 1024;
const EXEC_WAIT_MS = 3_000;
const POLL_MS = 500;

export interface SessionSpec {
  toolName: ToolConfig["toolName"];
  /** PID to watch: the wrapper's own PID, which the real tool takes over via execve. */
  pid: number;
  /** Start time of `pid` (/proc on Linux, sysctl on macOS), guarding against PID reuse. */
  startTime?: string;
  /** Wrapper's executable path at spawn (/proc/<pid>/exe, proc_pidpath on macOS); a change means the exec happened. */
  initialExe?: string;
  identity?: { name: string; configDir: string };
  configDirValue: string;
  cwd: string;
  /** Start a background sync once the real tool is launched (not for nested launches). */
  syncAtLaunch: boolean;
  title?: { tool: HerdrChatTool; initialPrompt?: string };
}

export interface RealLaunch {
  path: string;
  args: string[];
  env: Record<string, string>;
}

interface ProcStat {
  state: string;
  startTime: string;
}

function readProcStat(pid: number): ProcStat | undefined {
  if (process.platform === "darwin") return darwinProc(pid);
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm may contain spaces and parentheses: fields resume after the LAST ")".
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0] ?? "", startTime: fields[19] ?? "" };
  } catch {
    return undefined;
  }
}

export function procStartTime(pid: number): string | undefined {
  return readProcStat(pid)?.startTime || undefined;
}

/** A zombie (exited, not yet reaped by its parent) counts as exited. */
export function isPidRunning(pid: number, startTime?: string): boolean {
  const stat = readProcStat(pid);
  if (stat) return stat.state !== "Z" && stat.state !== "X" && (!startTime || stat.startTime === startTime);
  if (existsSync("/proc/self/stat")) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Polls (pidfd_open is not reachable from Bun; kqueue neither) until `pid` is gone. */
export async function waitForPidExit(
  pid: number,
  options: { startTime?: string; pollMs?: number; isRunning?: (pid: number, startTime?: string) => boolean } = {},
): Promise<void> {
  const running = options.isRunning ?? isPidRunning;
  while (running(pid, options.startTime)) await Bun.sleep(options.pollMs ?? POLL_MS);
}

function exeOf(pid: number): string | undefined {
  if (process.platform === "darwin") return darwinExe(pid);
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return undefined;
  }
}

/** Resolves once the PID runs a different image (the exec happened), or after a bounded wait. */
async function waitForExec(spec: SessionSpec): Promise<void> {
  if (!spec.initialExe) return;
  const deadline = Date.now() + EXEC_WAIT_MS;
  while (Date.now() < deadline && isPidRunning(spec.pid, spec.startTime) && exeOf(spec.pid) === spec.initialExe) {
    await Bun.sleep(50);
  }
}

export interface SessionWork {
  /** Stops the title watcher, then does the post-exit sync (scoped push, or a full sync). */
  stop(): Promise<void>;
}

/** The in-session watchers, shared by the sidecar and the in-process fallback. */
export async function startSessionWork(cfg: ToolConfig, spec: SessionSpec): Promise<SessionWork> {
  const markDirty = () => {
    if (!spec.identity) return;
    try {
      markUsageSnapshotDirty(usageSnapshotTargetKey(cfg.toolName, spec.identity.name));
    } catch { /* freshness markers are best-effort */ }
  };
  markDirty();
  const watcher = spec.identity
    ? startProfileSyncWatcher(cfg, spec.identity.name, spec.identity.configDir, spec.cwd)
    : undefined;
  const titleWatcher = spec.title
    ? new HerdrTabTitleWatcher({
        agent: cfg.realBinaryName,
        tool: spec.title.tool,
        configDir: spec.configDirValue,
        cwd: spec.cwd,
        ...(spec.title.initialPrompt !== undefined ? { initialPrompt: spec.title.initialPrompt } : {}),
        readTitle: readHerdrChatTitle,
        statePath: aisHerdrTabLabelsPath(),
        pid: spec.pid,
      })
    : undefined;
  await titleWatcher?.start();
  return {
    async stop() {
      markDirty();
      titleWatcher?.stop();
      if (watcher) {
        await watcher.stop();
      } else {
        // An explicit environment override may not reverse-map to a registry
        // identity, so there is no safe remote destination for a scoped push.
        // The next full sync still catches standard registered profiles.
        startBackgroundProfileSync({ direction: "both", scope: { kind: "all" }, waitForLock: true });
      }
    },
  };
}

/** Body of the detached `__session-sidecar` process. Never reads or writes the terminal. */
export async function runSessionSidecar(cfg: ToolConfig, spec: SessionSpec): Promise<void> {
  // Keeps the connectivity cache warm for the next shim launch; fire and forget.
  void isOnline().catch(() => {});
  if (spec.syncAtLaunch) {
    await waitForExec(spec);
    startBackgroundProfileSync();
  }
  const work = await startSessionWork(cfg, spec);
  await waitForPidExit(spec.pid, spec.startTime === undefined ? {} : { startTime: spec.startTime });
  await work.stop();
}

/** True when this process was spawned by `spawnSidecar`; consumes the spec. */
export function takeSidecarSpec(argv: string[], env: Record<string, string | undefined>): SessionSpec | undefined {
  const raw = env[SIDECAR_SPEC_ENV];
  if (argv[2] !== SIDECAR_ARG || !raw) return undefined;
  delete env[SIDECAR_SPEC_ENV];
  try {
    const spec = JSON.parse(raw) as SessionSpec;
    return typeof spec.pid === "number" ? spec : undefined;
  } catch {
    return undefined;
  }
}

/** Command that re-enters this same program: the compiled shim itself, or `bun <entry.ts>`. */
export function selfCommand(execPath = process.execPath, main = Bun.main): string[] {
  return main.startsWith("/$bunfs/") || main.includes("~BUN") ? [execPath] : [execPath, main];
}

const REAP_WAIT_MS = 2_000;

/**
 * Starts the detached sidecar (own session, stdio to /dev/null) and
 * double-forks it: a short-lived `sh` (the session leader) backgrounds the
 * sidecar and exits, and we reap it here. After the exec the sidecar is then
 * a child of init, not of the real tool, so it can never become the tool's
 * zombie or be reaped or signalled by it. Falls back to a direct detached
 * spawn without `sh`. False if the sidecar could not start.
 */
export async function spawnSidecar(spec: SessionSpec): Promise<boolean> {
  const env = { ...process.env, [SIDECAR_SPEC_ENV]: JSON.stringify(spec) };
  const command = [...selfCommand(), SIDECAR_ARG];
  try {
    const stage = withUsableCwd(() =>
      Bun.spawn(["/bin/sh", "-c", '"$@" </dev/null >/dev/null 2>&1 &', "sh", ...command], {
        env,
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      }),
    );
    const exited = await Promise.race([stage.exited, Bun.sleep(REAP_WAIT_MS).then(() => undefined)]);
    // A stage that has not exited yet may still start the sidecar: never spawn a second one.
    if (exited === 0 || exited === undefined) return true;
  } catch {
    // no usable sh: fall through to the direct spawn
  }
  try {
    withUsableCwd(() =>
      Bun.spawn(command, { env, stdio: ["ignore", "ignore", "ignore"], detached: true }),
    ).unref();
    return true;
  } catch {
    return false;
  }
}

/** One line per fallback to the old spawn path, never to the terminal. Best effort. */
function logFallback(path: string | undefined, tool: string, message: string): void {
  try {
    const file = path ?? join(aisStateDir(), "shim-fallback.log");
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) writeFileSync(file, "");
    appendFileSync(file, `${new Date().toISOString()} ${tool} pid=${process.pid} ${message}\n`);
  } catch {}
}

export interface LaunchDeps {
  spawnSidecar: (spec: SessionSpec) => boolean | Promise<boolean>;
  /** Never returns on success; otherwise the failure reason. */
  execve: (real: RealLaunch) => string | undefined;
  /** Where fallbacks are recorded; defaults to the AIS state dir. */
  logPath?: string;
  /** Defaults to process.platform; execve is expected to be unsupported off Linux and macOS. */
  platform?: NodeJS.Platform;
  spawn: (real: RealLaunch) => Promise<number>;
  startWork: (cfg: ToolConfig, spec: SessionSpec) => Promise<SessionWork>;
}

const defaultDeps: LaunchDeps = {
  spawnSidecar,
  execve: (real) => execveReal(real.path, real.args, real.env),
  spawn: (real) => spawnReal(real.path, real.args, real.env),
  startWork: startSessionWork,
};

/**
 * Launches the real tool so that it, not this process, owns the PID and the
 * terminal. Returns an exit code only when `execve` was not possible:
 *  1. sidecar spawned, execve ok: never returns (the sidecar does the rest);
 *  2. sidecar spawned, execve unavailable: spawn the tool as a child; the
 *     sidecar still handles the session work and the post-exit sync;
 *  3. sidecar could not start: legacy in-process path.
 */
export async function launchWithSession(
  cfg: ToolConfig,
  spec: Omit<SessionSpec, "toolName" | "pid" | "startTime" | "initialExe">,
  real: RealLaunch,
  deps: LaunchDeps = defaultDeps,
): Promise<number> {
  const launch: RealLaunch = real.env[IDENTITY_SESSION_MARKER]
    ? { ...real, env: { ...real.env, [IDENTITY_SESSION_TOOL_MARKER]: cfg.toolName } }
    : real;
  const title = spec.title?.initialPrompt === undefined
    ? spec.title
    : { ...spec.title, initialPrompt: spec.title.initialPrompt.slice(0, MAX_PROMPT_BYTES) };
  const full: SessionSpec = {
    ...spec,
    ...(title ? { title } : {}),
    toolName: cfg.toolName,
    pid: process.pid,
    ...(procStartTime(process.pid) ? { startTime: procStartTime(process.pid) as string } : {}),
    ...(exeOf(process.pid) ? { initialExe: exeOf(process.pid) as string } : {}),
  };
  if (await deps.spawnSidecar(full)) {
    const reason = deps.execve(launch);
    // Elsewhere the spawn path is the normal route, not a fallback worth recording.
    if (["linux", "darwin"].includes(deps.platform ?? process.platform)) {
      logFallback(deps.logPath, cfg.toolName, `spawn fallback (sidecar keeps the session work): ${reason}`);
    }
    return await deps.spawn(launch);
  }
  logFallback(deps.logPath, cfg.toolName, "in-process fallback: the sidecar could not be started");
  const work = await deps.startWork(cfg, full);
  const spawn = () => deps.spawn(launch);
  const exitCode = await (spec.syncAtLaunch ? launchThenStartBackgroundSync(spawn) : spawn());
  await work.stop();
  return exitCode;
}
