import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withUsableCwd } from "../shared/exec.ts";
import type { SyncRunOptions } from "./types.ts";

interface BackgroundSyncDeps {
  resolveBinary?: () => string | undefined;
  spawnDetached?: (binary: string, args: string[]) => void;
  warn?: (message: string) => void;
}

export function resolveInstalledAisBinary(): string | undefined {
  const shimDir = process.env.AI_PROFILE_SWITCHER_SHIM_DIR ?? join(homedir(), ".local", "bin");
  const sibling = join(shimDir, "ais");
  return existsSync(sibling) ? sibling : Bun.which("ais") ?? undefined;
}

/** Command prefix that starts the worker at the lowest CPU priority and, on
 * Linux when ionice works here, idle I/O class (setpriority/ionice -p only hit
 * one thread, so the whole process must start that way). */
// The ionice probe runs in the child shell: a denied ioprio_set makes util-linux
// ionice skip the command, and probing here via spawnSync would hold fds open.
const IONICE_SCRIPT = 'if ionice -c3 true >/dev/null 2>&1; then exec ionice -c3 "$@"; fi; exec "$@"';

export function lowPriorityPrefix(
  which: (name: string) => string | null = Bun.which,
  platform: string = process.platform,
): string[] {
  const nice = which("nice");
  const sh = which("sh");
  const ionice = platform === "linux" && sh && which("ionice");
  return [...(nice ? [nice, "-n", "19"] : []), ...(ionice ? [sh, "-c", IONICE_SCRIPT, "sh"] : [])];
}

function spawnDetached(binary: string, args: string[]): void {
  withUsableCwd(() =>
    Bun.spawn([...lowPriorityPrefix(), binary, ...args], {
      env: process.env,
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    }),
  ).unref();
}

export function backgroundSyncArgs(options: SyncRunOptions = {}): string[] {
  const args = ["sync", "background"];
  if (options.direction === "pull") args.push("--pull-only");
  if (options.direction === "push") args.push("--push-only");
  if (options.waitForLock) args.push("--wait");
  if (options.includeDatabases === false) args.push("--no-databases");
  if (options.scope?.kind === "identity") {
    args.push(`--tool=${options.scope.cfg.toolName}`, `--identity=${options.scope.identityName}`);
    if (options.scope.cwd) args.push(`--cwd=${options.scope.cwd}`);
  }
  return args;
}

/**
 * Start automatic SSH reconciliation in a detached AIS process. The caller
 * never owns or awaits the network work, so SSH, rsync, dedupe, and lock waits
 * cannot delay launching or returning from a wrapped agent.
 */
export function startBackgroundProfileSync(
  options: SyncRunOptions = {},
  deps: BackgroundSyncDeps = {},
): boolean {
  const binary = (deps.resolveBinary ?? resolveInstalledAisBinary)();
  const warn = deps.warn ?? console.error;
  if (!binary) {
    warn("ais sync: could not find the installed ais binary; background sync was skipped");
    return false;
  }

  try {
    (deps.spawnDetached ?? spawnDetached)(binary, backgroundSyncArgs(options));
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`ais sync: could not start background sync: ${message}`);
    return false;
  }
}

/** Keep the ordering invariant explicit and unit-testable: launch first. */
export function launchThenStartBackgroundSync<T>(
  launch: () => T,
  startSync: () => unknown = () => startBackgroundProfileSync(),
): T {
  const launched = launch();
  startSync();
  return launched;
}
