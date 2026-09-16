import { boolFlag, foldValuedFlags, parseArgs, stringFlag } from "./args.ts";
import { yellow } from "./colors.ts";
import { CliUsageError } from "./errors.ts";
import { resolveHerdrBinary } from "../shared/herdr-bin.ts";
import { ensureAistuiBinary, resolveTuiBinary } from "../shared/aistui-bin.ts";

/**
 * `ais herdr`: the native wrapper around the third-party herdr client.
 * The wrapper EXECUTES `aistui herdr` (the Rust TUI under apps/tui), which
 * embeds the real herdr client in a PTY on the LEFT and renders the
 * identity/limits/cost overview natively on the RIGHT. No tmux, no nested
 * multiplexer: one binary owns the whole screen.
 *
 * herdr itself is never bundled with ais: it is resolved from PATH /
 * ~/.local/bin / AIS_HERDR_BIN at run time and handed to aistui via
 * --herdr-bin, so herdr updates stay independent.
 *
 * Remote support: `--remote=<ssh-target>` makes the embedded child run
 * `herdr --remote <target>` (the REAL client runs, so remote sessions need
 * no wrapper-side magic). The overview then defaults to LOCAL ais data with
 * highlighting honestly disabled; `--remote-ais` additionally mirrors the
 * remote machine's console through an `ssh -L` tunnel owned by THIS process
 * (started before aistui, killed after it exits), so the panel and
 * highlights reflect the remote ais. When the remote turns out to have no
 * reachable console, the panel falls back to local data and says so in a
 * note line - never a fabricated remote view.
 *
 * This command never starts, stops, signals, or configures any herdr
 * process beyond launching the client exactly like a user typing `herdr`
 * (or `herdr --remote ...`); quitting the wrapper kills only that client,
 * which is safe because herdr sessions live server-side.
 */

export const DEFAULT_PANEL_WIDTH = 42;
export const MIN_PANEL_WIDTH = 16;
export const MAX_PANEL_WIDTH = 80;

/* ------------------------------ argument model ----------------------------- */

export interface HerdrInvocation {
  /** --raw: exec plain herdr with no wrapper (escape hatch). */
  raw: boolean;
  /** --force: proceed even when already inside a herdr pane. */
  force: boolean;
  remote?: string;
  /** --remote-ais: mirror the remote machine's console through ssh -L. */
  remoteAis: boolean;
  panelWidth: number;
}

/** herdr's flags that carry a value. These may be written either as
 * --flag=value or the natural --flag value space form (folded before
 * parsing); --raw/--force/--remote-ais stay bare-only booleans. */
export const HERDR_VALUED_FLAGS = ["remote", "panel-width"] as const;

/** The tmux-era flags: removed with the tmux architecture. Each maps to a
 * short explanation instead of a silent "unknown flag". */
export const REMOVED_TMUX_FLAGS: Record<string, string> = {
  new: "there is no persistent session any more: the wrapper is a plain "
    + "foreground TUI, so just run `ais herdr` again",
  "panel-cmd": "the overview panel is now rendered natively by aistui and "
    + "cannot be replaced by an external command",
  "tmux-socket": "the wrapper no longer uses tmux, so there is no session "
    + "or socket to isolate",
};

export function parseHerdrArgs(
  rest: string[],
  flags: Record<string, string | true>,
): HerdrInvocation {
  if (rest.length > 0) {
    throw new CliUsageError(`unexpected argument "${rest[0]}": ais herdr takes no positionals`);
  }
  for (const [flag, hint] of Object.entries(REMOVED_TMUX_FLAGS)) {
    if (flag in flags) {
      throw new CliUsageError(`--${flag} is gone: the wrapper no longer uses tmux. ${hint}`);
    }
  }
  const raw = boolFlag(flags, "raw");
  const force = boolFlag(flags, "force");
  const remote = stringFlag(flags, "remote");
  const remoteAis = boolFlag(flags, "remote-ais");
  let panelWidth = DEFAULT_PANEL_WIDTH;
  const widthRaw = stringFlag(flags, "panel-width");
  if (widthRaw !== undefined) {
    const parsed = Number(widthRaw);
    if (!Number.isInteger(parsed) || parsed < MIN_PANEL_WIDTH || parsed > MAX_PANEL_WIDTH) {
      throw new CliUsageError(
        `--panel-width must be an integer between ${MIN_PANEL_WIDTH} and ${MAX_PANEL_WIDTH} (got "${widthRaw}")`,
      );
    }
    panelWidth = parsed;
  }
  if (remoteAis && !remote) {
    throw new CliUsageError("--remote-ais needs --remote=<ssh-target>: there is nothing to mirror without a remote");
  }
  return {
    raw,
    force,
    ...(remote !== undefined ? { remote } : {}),
    remoteAis,
    panelWidth,
  };
}

/** herdr's own panes carry HERDR_* env vars (verified live: HERDR_PANE_ID,
 * HERDR_WORKSPACE_ID, ...). Exported because it decides more than the
 * wrapper's nesting guard: `ais upgrade` pre-checks it before running
 * `herdr update`, which refuses while a herdr client is attached. */
export function insideHerdrPane(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).some((key) => key.startsWith("HERDR_"));
}

/** Nesting guard: a herdr wrapper inside a herdr pane is a foot-gun (the
 * inner client would attach inside the outer client's pane). tmux is
 * deliberately NOT a conflict any more: the wrapper is a plain TUI and runs
 * fine inside tmux, ssh, or anything else that gives it a PTY. */
export function nestingConflict(env: NodeJS.ProcessEnv): "herdr" | undefined {
  if (insideHerdrPane(env)) return "herdr";
  return undefined;
}

/* ------------------------------ remote console ----------------------------- */

/** Tolerant parse of a remote machine's ~/.ais/web/server.json (fetched
 * over ssh). Never logs or returns anything but the port/token fields. */
export function parseRemoteConsoleState(stdout: string): { port?: number; token?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {};
  }
  const record = (parsed ?? {}) as { port?: unknown; token?: unknown };
  const port = typeof record.port === "number" && Number.isInteger(record.port) && record.port > 0 ? record.port : undefined;
  const token = typeof record.token === "string" && record.token.length > 0 ? record.token : undefined;
  return {
    ...(port !== undefined ? { port } : {}),
    ...(token !== undefined ? { token } : {}),
  };
}

export function tunnelForwardArgs(localPort: number, remotePort: number): string[] {
  // -N: no remote command, pure forwarding; ExitOnForwardFailure so a
  // dead remote port fails the tunnel instead of sitting there silent.
  return ["-N", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`];
}

/** Same non-interactive SSH discipline as sync: no prompts ever, host keys
 * pinned by the user's own known_hosts. */
export const SSH_BASE_ARGS = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"];

export function remoteStateArgs(target: string): string[] {
  return [...SSH_BASE_ARGS, target, "cat", "~/.ais/web/server.json"];
}

export function tunnelArgs(target: string, localPort: number, remotePort: number): string[] {
  return [...SSH_BASE_ARGS, ...tunnelForwardArgs(localPort, remotePort), target];
}

export async function pickFreePort(): Promise<number> {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data() {},
    },
  });
  const port = server.port;
  await server.stop(true);
  return port;
}

/* ---------------------------------- exec ----------------------------------- */

/** The aistui argv for the wrapper: subcommand first, then the resolved
 * herdr path (so the Rust side never re-resolves), then the presentation
 * flags. Pure for tests. */
export function wrapperArgv(opts: {
  herdrPath: string;
  inv: HerdrInvocation;
}): string[] {
  const argv = ["herdr", "--herdr-bin", opts.herdrPath, "--panel-width", String(opts.inv.panelWidth)];
  if (opts.inv.remote) argv.push("--remote", opts.inv.remote);
  return argv;
}

/* ---------------------------------- deps ----------------------------------- */

export interface Tunnel {
  kill(): void;
}

export interface HerdrCommandDeps {
  env: NodeJS.ProcessEnv;
  isInteractive(): boolean;
  herdrPath(): string | null;
  tuiPath(): string | null;
  /** One-shot self-heal when tuiPath() finds nothing: downloads aistui
   * from the matching release into ~/.local/bin; throws with the reason
   * when it cannot. Optional so test fakes without network stay honest. */
  ensureTuiPath?(): Promise<string>;
  /** Ensures the local console daemon is up; returns its URL. */
  consoleUrl(): Promise<string>;
  consoleToken(): Promise<string>;
  /** ssh-reads the remote console state; throws when ssh fails. */
  readRemoteState(target: string): Promise<string>;
  pickFreePort(): Promise<number>;
  /** Starts the ssh -L tunnel; kill() tears it down. */
  spawnTunnel(target: string, localPort: number, remotePort: number): Tunnel;
  /** Probes the tunnelled console; short retries absorb tunnel setup. */
  verifyTunnel(localPort: number, token: string): Promise<boolean>;
  /** Runs the wrapper TUI with the given env, full stdio; resolves with
   * its exit code. */
  runAistui(argv: string[], env: Record<string, string>): Promise<number>;
  /** Full-stdio raw herdr exec (--raw). */
  execRaw(command: string, args: string[]): Promise<number>;
  log(message: string): void;
}

function realDeps(): HerdrCommandDeps {
  return {
    env: process.env,
    isInteractive: () => process.stdin.isTTY === true,
    herdrPath: () => resolveHerdrBinary() ?? null,
    tuiPath: () => resolveTuiBinary() ?? null,
    ensureTuiPath: () => ensureAistuiBinary(),
    consoleUrl: async () => {
      const { ensureConsoleRunning } = await import("./web.ts");
      const port = await ensureConsoleRunning();
      return `http://127.0.0.1:${port}`;
    },
    consoleToken: async () => {
      const { readServerState } = await import("../server/state.ts");
      return (await readServerState())?.token ?? "";
    },
    readRemoteState: async (target) => {
      const proc = Bun.spawn(["ssh", ...remoteStateArgs(target)], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // already exited
        }
      }, 15_000);
      timer.unref?.();
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      clearTimeout(timer);
      if (code !== 0) {
        throw new Error(`ssh read of the remote console state failed: ${(stderr || stdout).trim() || `exit ${code}`}`);
      }
      return stdout;
    },
    pickFreePort,
    spawnTunnel: (target, localPort, remotePort) => {
      const proc = Bun.spawn(["ssh", ...tunnelArgs(target, localPort, remotePort)], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      return {
        kill: () => {
          try {
            proc.kill();
          } catch {
            // already gone
          }
        },
      };
    },
    verifyTunnel: async (localPort, token) => {
      const url = `http://127.0.0.1:${localPort}/api/status`;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const response = await fetch(url, {
            headers: {
              "X-AIS-Console": "1",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            signal: AbortSignal.timeout(5_000),
          });
          if (response.ok) return true;
        } catch {
          // tunnel may still be coming up; retry
        }
        await Bun.sleep(750);
      }
      return false;
    },
    runAistui: async (argv, env) => {
      const { spawnReal } = await import("../shared/exec.ts");
      const [bin, ...args] = argv;
      return await spawnReal(bin!, args, env);
    },
    execRaw: async (command, args) => {
      const { spawnReal } = await import("../shared/exec.ts");
      return await spawnReal(command, args, {});
    },
    log: (message) => console.log(message),
  };
}

function requireBinary(path: string | null, what: string, hint: string): string {
  if (path) return path;
  throw new CliUsageError(`${what} is required but was not found. ${hint}`);
}

/** aistui with one self-heal attempt: plain resolution first (tuiPath()),
 * then ensureTuiPath()'s single release download when the binary is
 * missing. The historical not-found error stays as the final fallback,
 * extended with WHY the auto-install failed (or that it never ran, which
 * happens in tests where the dep is not wired). */
async function requireTuiBinary(deps: {
  tuiPath(): string | null;
  ensureTuiPath?(): Promise<string>;
}): Promise<string> {
  const found = deps.tuiPath();
  if (found) return found;
  let reason: string | undefined;
  if (deps.ensureTuiPath) {
    try {
      return await deps.ensureTuiPath();
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
  }
  throw new CliUsageError(
    `the aistui binary is required but was not found${reason ? `, and the automatic download from the GitHub release failed (${reason})` : ""}. Build it with (cd apps/tui && cargo build --release), or install it to ~/.local/bin/aistui.`,
  );
}

/** `ais herdr`: prepare the console data source (local daemon, or the
 * --remote-ais tunnel), then run the native wrapper TUI in the foreground.
 * Takes the subcommand's own argv (everything after the "herdr" token) so
 * the space form `--remote <target>` can be folded into `--remote=<target>`
 * pre-parse. */
export async function runHerdrCommand(
  subArgv: string[],
  deps: HerdrCommandDeps = realDeps(),
): Promise<void> {
  const { positionals: rest, flags } = parseArgs(foldValuedFlags(subArgv, HERDR_VALUED_FLAGS));
  const inv = parseHerdrArgs(rest, flags);

  if (inv.raw) {
    const herdr = requireBinary(
      deps.herdrPath(),
      "herdr",
      'Install it with "ais upgrade" (herdr is never bundled with ais), or point AIS_HERDR_BIN at it.',
    );
    const code = await deps.execRaw(herdr, inv.remote ? ["--remote", inv.remote] : []);
    if (code !== 0) process.exit(code);
    return;
  }

  // The wrapper is a foreground full-screen TUI: without a terminal there
  // is nothing to embed herdr into (there is no detachable session any
  // more), so fail before touching the console or the network.
  if (!deps.isInteractive()) {
    throw new CliUsageError(
      "ais herdr runs an interactive full-screen wrapper and needs a terminal on stdin. Run it from a shell (or use --raw for a plain non-wrapper herdr).",
    );
  }

  const conflict = nestingConflict(deps.env);
  if (conflict && !inv.force) {
    throw new CliUsageError(
      "refusing to nest: this shell already runs inside a herdr pane and ais herdr would open another herdr client inside it. Pass --force if you really mean it.",
    );
  }

  const herdr = requireBinary(
    deps.herdrPath(),
    "herdr",
    'Install it with "ais upgrade" (herdr is never bundled with ais), or point AIS_HERDR_BIN at it.',
  );
  const tui = await requireTuiBinary(deps);

  // Presentation env for the overview panel (consumed by aistui).
  const env: Record<string, string> = {
    ...(await baseConsoleEnv(deps)),
  };
  let tunnel: Tunnel | undefined;
  if (inv.remote) {
    env.AIS_OVERVIEW_LABEL = `remote:${inv.remote}`;
  }
  if (inv.remote && inv.remoteAis) {
    tunnel = await mirrorRemoteConsole(deps, inv.remote, env);
  } else if (inv.remote) {
    // Honest degradation: the local bridge describes LOCAL panes, which
    // are not the ones on screen, so highlighting would be fabricated.
    env.AIS_OVERVIEW_BRIDGE = "off";
    env.AIS_OVERVIEW_NOTE =
      `herdr is showing ${inv.remote}; this console is local, so there is no highlight source (use --remote-ais to mirror the remote console)`;
  }

  const argv = [tui, ...wrapperArgv({ herdrPath: herdr, inv })];
  let code: number;
  try {
    code = await deps.runAistui(argv, env);
  } finally {
    // The tunnel's lifetime is exactly this process's wrapper lifetime.
    tunnel?.kill();
  }
  if (code !== 0) process.exit(code);
}

async function baseConsoleEnv(deps: HerdrCommandDeps): Promise<Record<string, string>> {
  const env: Record<string, string> = { AIS_CONSOLE_URL: await deps.consoleUrl() };
  const token = await deps.consoleToken();
  if (token) env.AIS_CONSOLE_TOKEN = token;
  return env;
}

/** --remote-ais: mirrors the REMOTE machine's console through an ssh -L
 * tunnel owned by this process. Any failure degrades to the LOCAL console
 * with an honest note - the panel never fakes a remote view. Returns the
 * tunnel to keep alive (undefined when degraded). */
async function mirrorRemoteConsole(
  deps: HerdrCommandDeps,
  remote: string,
  env: Record<string, string>,
): Promise<Tunnel | undefined> {
  let state: { port?: number; token?: string } = {};
  let sshError: string | undefined;
  try {
    state = parseRemoteConsoleState(await deps.readRemoteState(remote));
  } catch (err) {
    sshError = err instanceof Error ? err.message : String(err);
  }

  if (state.port) {
    const localPort = await deps.pickFreePort();
    const tunnel = deps.spawnTunnel(remote, localPort, state.port);
    if (await deps.verifyTunnel(localPort, state.token ?? "")) {
      env.AIS_CONSOLE_URL = `http://127.0.0.1:${localPort}`;
      // The remote token must REPLACE the local one (and its absence must
      // remove it): the panel talks to the remote console now.
      if (state.token) {
        env.AIS_CONSOLE_TOKEN = state.token;
      } else {
        delete env.AIS_CONSOLE_TOKEN;
      }
      // Highlights come from the REMOTE bridge, which IS the server the
      // embedded herdr client attaches to: no override needed.
      return tunnel;
    }
    tunnel.kill();
  }
  if (state.port === undefined && sshError) {
    deps.log(yellow(`ais herdr: ${remote} has no readable ais console state (${sshError})`));
  }
  delete env.AIS_CONSOLE_TOKEN;
  env.AIS_CONSOLE_URL = await deps.consoleUrl();
  env.AIS_OVERVIEW_BRIDGE = "off";
  env.AIS_OVERVIEW_NOTE = `${remote} has no reachable ais console; showing LOCAL data`;
  return undefined;
}
