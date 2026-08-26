import { cyan, dim } from "./colors.ts";
import { CliUsageError } from "./errors.ts";
import { boolFlag } from "./args.ts";
import { statSync } from "node:fs";
import { clearServerState, pidAlive, readServerState } from "../server/state.ts";
import { DEFAULT_CONSOLE_PORT, findDistDir, startConsoleServer } from "../server/serve.ts";

export interface WebCommandSummary {
  action: "started" | "already-running" | "stopped" | "status" | "opened";
  url: string;
}

/** `ais web`: lifecycle for the local console server. Default (and
 * `start`) spawns a detached daemon and prints the URL; --foreground runs it
 * in this terminal instead; stop/status/open do what they say. The hidden
 * --serve-internal flag is what the daemon child actually executes. */
export async function runWebCommand(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const subcommand = positionals[0] ?? "start";

  if (boolFlag(flags as never, "serve-internal")) {
    const distDir = findDistDir();
    await startConsoleServer({ ...(numberFlag(flags) ? { port: numberFlag(flags) } : {}), ...(distDir ? { distDir } : {}) });
    return; // Bun.serve keeps the process alive.
  }

  switch (subcommand) {
    case "start":
    case "restart": {
      if (subcommand === "restart") await stopDaemon();
      if (boolFlag(flags as never, "foreground") || boolFlag(flags as never, "fg")) {
        const distDir = findDistDir();
        await startConsoleServer({ ...(numberFlag(flags) ? { port: numberFlag(flags) } : {}), ...(distDir ? { distDir } : {}) });
        return;
      }
      const state = await readServerState();
      if (state && pidAlive(state.pid) && (await healthy(state.port))) {
        printUrl(state.port, "already running");
        return;
      }
      const daemon = spawnDaemon(numberFlag(flags));
      const ready = await waitUntilHealthyOrExit(daemon.proc);
      if (!ready) throw new CliUsageError("console daemon did not become healthy within 10s (it may have failed to bind)");
      const fresh = await readServerState();
      printUrl(fresh?.port ?? daemon.requestedPort, "started");
      return;
    }
    case "stop": {
      await stopDaemon();
      return;
    }
    case "status": {
      const state = await readServerState();
      if (!state || !pidAlive(state.pid)) {
        if (boolFlag(flags as never, "json")) console.log(JSON.stringify({ running: false }));
        else console.log("not running");
        return;
      }
      const up = await healthy(state.port);
      if (boolFlag(flags as never, "json")) {
        console.log(JSON.stringify({ running: true, healthy: up, ...state }));
      } else {
        console.log(`running at http://127.0.0.1:${state.port} (${up ? "healthy" : "NOT responding"}, pid ${state.pid}, since ${state.startedAt})`);
      }
      return;
    }
    case "open": {
      const state = await readServerState();
      let port = state && pidAlive(state.pid) && (await healthy(state.port)) ? state.port : undefined;
      if (port === undefined) {
        const daemon = spawnDaemon(numberFlag(flags));
        if (!(await waitUntilHealthyOrExit(daemon.proc))) throw new CliUsageError("console daemon did not become healthy within 10s (it may have failed to bind)");
        const fresh = await readServerState();
        port = fresh?.port ?? DEFAULT_CONSOLE_PORT;
      }
      openBrowser(`http://127.0.0.1:${port}`);
      return;
    }
    default:
      throw new CliUsageError(`Unknown web action "${subcommand}". Use start, stop, status, or open.`);
  }
}

function numberFlag(flags: Record<string, string | true>): number | undefined {
  const raw = flags["port"] ?? flags["p"];
  if (typeof raw !== "string" || raw === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new CliUsageError(`invalid --port="${raw}"`);
  return parsed;
}

/** Re-invokes this same ais entrypoint as a detached background process.
 * Compiled binary: argv IS [exe, ...]. Dev (`bun src/ais.ts`): prepend the
 * bun runtime with the script path. AIS_WEB_DAEMON marks the child so logs
 * can be attributed and accidental recursion stays visible. */
interface SpawnedDaemon {
  proc: Bun.Subprocess<"ignore", "ignore", "ignore">;
  requestedPort: number;
}

function spawnDaemon(port: number | undefined): SpawnedDaemon {
  const main = Bun.main;
  // Compiled binary: Bun.main is a VIRTUAL "/$bunfs/root/<name>" path
  // (which can pass a plain statSync!) and process.execPath is the real
  // executable. Dev (`bun src/ais.ts`): Bun.main is a real script file.
  // Discriminator: a SCRIPT EXTENSION plus on-disk existence; the bunfs
  // path has neither a script extension nor a real directory entry that
  // survives both checks.
  const looksLikeScript = /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(main) && statSyncSafe(main);
  const base = looksLikeScript ? [process.execPath, main] : [process.execPath];
  // NOTE: parseArgs only understands --flag=value, never --flag value.
  const args = [...base, "web", "--serve-internal", `--port=${port ?? DEFAULT_CONSOLE_PORT}`];
  const proc = Bun.spawn(args, {
    env: { ...process.env, AIS_WEB_DAEMON: "1" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  proc.unref();
  return { proc, requestedPort: port ?? DEFAULT_CONSOLE_PORT };
}

function statSyncSafe(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

async function stopDaemon(): Promise<void> {
  const state = await readServerState();
  if (!state || !pidAlive(state.pid)) {
    await clearServerState();
    console.log("not running");
    return;
  }
  process.kill(state.pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (pidAlive(state.pid) && Date.now() < deadline) {
    await Bun.sleep(100);
  }
  await clearServerState();
  console.log(`stopped (pid ${state.pid})`);
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { Authorization: `Bearer ${(await readServerState())?.token ?? ""}` },
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntilHealthy(port: number): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await healthy(port)) return true;
    await Bun.sleep(200);
  }
  return false;
}

/** Waits for the freshly spawned daemon to answer, failing fast if the
 * child dies first (e.g. bind failure because a STALE daemon still holds
 * the port). Prevents the classic race where an old daemon answers the
 * health probe and start reports success while the new child has exited. */
async function waitUntilHealthyOrExit(proc: Bun.Subprocess<"ignore", "ignore", "ignore">): Promise<boolean> {
  const exitPromise = proc.exited;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const exited = await Promise.race([exitPromise.then(() => true as const), Bun.sleep(150).then(() => false as const)]);
    if (exited) return false;
    const state = await readServerState();
    if (state?.pid === proc.pid && (await healthy(state.port))) return true;
  }
  return false;
}

function printUrl(port: number, verb: string): void {
  const url = `http://127.0.0.1:${port}`;
  console.log(`AIS console ${verb}: ${cyan(url)} ${dim("(web UI served from apps/web/dist when built)")}`);
  console.log(dim("stop it with: ais web stop"));
}

function openBrowser(url: string): void {
  for (const bin of ["xdg-open", "open"]) {
    const found = Bun.which(bin);
    if (found) {
      void Bun.spawn([found, url], { stdio: ["ignore", "ignore", "ignore"] }).unref();
      return;
    }
  }
  console.error("no xdg-open/open available; open the URL manually");
}
