import { boolFlag, foldValuedFlags, parseArgs, stringFlag } from "./args.ts";
import { dim, yellow } from "./colors.ts";
import { CliUsageError } from "./errors.ts";
import { resolveHerdrBinary } from "../shared/herdr-bin.ts";
import { resolveTuiBinary } from "./tui.ts";

/**
 * `ais herdr`: a tmux-based wrapper around the third-party herdr client.
 * The LEFT pane runs the real `herdr` binary (never bundled with ais: it is
 * resolved from PATH / ~/.local/bin / AIS_HERDR_BIN at run time, so herdr
 * updates stay independent); the RIGHT pane runs `aistui --overview`, a
 * compact responsive identity/limits/cost panel that highlights the
 * identities whose herdr panes are open on the left (the focused pane's
 * identity most strongly) via /api/herdr-bridge.
 *
 * Remote support: `--remote=<ssh-target>` points the LEFT pane at a remote
 * herdr server (`herdr --remote <target>`). The right panel then defaults
 * to LOCAL ais data with the highlight source honestly disabled (the local
 * bridge describes local panes, not the remote ones on screen);
 * `--remote-ais` additionally mirrors the remote machine's console through
 * an `ssh -L` tunnel run by the hidden `__herdr_panel` subcommand, so the
 * panel and highlights reflect the remote ais. When the remote turns out
 * to have no reachable ais console, the panel falls back to local data and
 * says so in a note line - never a fabricated remote view.
 *
 * This command never starts, stops, signals, or configures any herdr
 * process: it only EXECUTES the herdr client inside a tmux pane, exactly
 * like a user typing `herdr` (or `herdr --remote ...`).
 */

export const HERDR_SESSION = "ais-herdr";
export const DEFAULT_PANEL_WIDTH = 42;
export const MIN_PANEL_WIDTH = 16;
export const MAX_PANEL_WIDTH = 80;

/* ------------------------------ argument model ----------------------------- */

export interface HerdrInvocation {
  /** --raw: exec plain herdr with no wrapper (escape hatch). */
  raw: boolean;
  /** --new: kill any existing wrapper session and recreate it. */
  recreate: boolean;
  /** --force: proceed even when already inside a herdr/tmux pane. */
  force: boolean;
  remote?: string;
  /** --remote-ais: mirror the remote machine's console through ssh -L. */
  remoteAis: boolean;
  panelWidth: number;
  panelCmd?: string;
  tmuxSocket?: string;
}

/** herdr's flags that carry a value. These may be written either as
 * --flag=value or the natural --flag value space form (folded before
 * parsing); --raw/--new/--force/--remote-ais stay bare-only booleans. */
export const HERDR_VALUED_FLAGS = ["remote", "panel-width", "panel-cmd", "tmux-socket"] as const;

export function parseHerdrArgs(
  rest: string[],
  flags: Record<string, string | true>,
): HerdrInvocation {
  if (rest.length > 0) {
    throw new CliUsageError(`unexpected argument "${rest[0]}": ais herdr takes no positionals`);
  }
  const raw = boolFlag(flags, "raw");
  const recreate = boolFlag(flags, "new");
  const force = boolFlag(flags, "force");
  const remote = stringFlag(flags, "remote");
  const remoteAis = boolFlag(flags, "remote-ais");
  const panelCmd = stringFlag(flags, "panel-cmd");
  const tmuxSocket = stringFlag(flags, "tmux-socket");
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
    recreate,
    force,
    ...(remote !== undefined ? { remote } : {}),
    remoteAis,
    panelWidth,
    ...(panelCmd !== undefined ? { panelCmd } : {}),
    ...(tmuxSocket !== undefined ? { tmuxSocket } : {}),
  };
}

/** herdr's own panes carry HERDR_* env vars (verified live: HERDR_PANE_ID,
 * HERDR_WORKSPACE_ID, ...). Exported because it decides more than the
 * wrapper's nesting guard: `ais upgrade` pre-checks it before running
 * `herdr update`, which refuses while a herdr client is attached. */
export function insideHerdrPane(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).some((key) => key.startsWith("HERDR_"));
}

/** Nesting guard: tmux inside a herdr pane (or inside tmux) is a foot-gun.
 * herdr's own panes carry HERDR_* env vars (verified live: HERDR_PANE_ID,
 * HERDR_WORKSPACE_ID, ...), tmux sets TMUX. */
export function nestingConflict(env: NodeJS.ProcessEnv): "tmux" | "herdr" | undefined {
  if (env.TMUX) return "tmux";
  if (insideHerdrPane(env)) return "herdr";
  return undefined;
}

/* ------------------------------- pane commands ----------------------------- */

/** Single-quote for /bin/sh, the only consumer of pane commands. Values
 * made only of shell-safe characters (paths, --flags) stay readable; any
 * other character forces quoting. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_\-@%+=:,./~]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

/** The LEFT pane: plain `herdr`, attaching its default session; with
 * `--remote`, the remote form (`herdr --remote <target>`, verified against
 * herdr 0.8.2's own usage). */
export function leftPaneCommand(herdrPath: string, remote?: string): string {
  const argv = remote ? [herdrPath, "--remote", remote] : [herdrPath];
  return shellJoin(argv);
}

/** The RIGHT pane command for the plain (non --panel-cmd) cases. */
export function rightPaneCommand(opts: {
  tuiPath: string;
  panelCmd?: string;
  aisEntrypoint?: string[];
  remoteAis?: boolean;
  remote?: string;
}): string {
  if (opts.panelCmd) return opts.panelCmd;
  if (opts.remoteAis && opts.remote && opts.aisEntrypoint) {
    // The panel subcommand owns the tunnel + env for its aistui child and
    // dies with the pane, so the tunnel never outlives the session.
    return shellJoin([...opts.aisEntrypoint, "__herdr_panel", `--remote=${opts.remote}`]);
  }
  return `${shellQuote(opts.tuiPath)} --overview`;
}

/* -------------------------------- tmux steps ------------------------------- */

export interface TmuxStep {
  label: string;
  args: string[];
}

export function socketArgs(socket?: string): string[] {
  return socket ? ["-L", socket] : [];
}

export function hasSessionArgs(socket?: string): string[] {
  return [...socketArgs(socket), "has-session", "-t", HERDR_SESSION];
}

export function killSessionArgs(socket?: string): string[] {
  return [...socketArgs(socket), "kill-session", "-t", HERDR_SESSION];
}

export function attachArgs(socket?: string): string[] {
  return [...socketArgs(socket), "attach-session", "-t", HERDR_SESSION];
}

export function attachHint(socket?: string): string {
  const prefix = `tmux${socket ? ` -L ${socket}` : ""}`;
  return `${prefix} attach -t ${HERDR_SESSION}`;
}

/** The ordered tmux steps that build the wrapper session: herdr in pane 0
 * (left), the overview split off to the right at the panel width, pane
 * environment carrying the console credentials (never on any argv), the
 * herdr pane kept visible with its dying words if the client exits, and
 * focus left on herdr so the user lands there. */
export function buildCreateSteps(opts: {
  inv: HerdrInvocation;
  left: string;
  right: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}): TmuxStep[] {
  const steps: TmuxStep[] = [
    {
      label: "new-session",
      args: [
        "new-session",
        "-d",
        "-s",
        HERDR_SESSION,
        "-n",
        HERDR_SESSION,
        "-x",
        String(opts.cols),
        "-y",
        String(opts.rows),
        opts.left,
      ],
    },
    // Window option: a dead pane keeps its last output so an honest
    // failure (e.g. `herdr --remote` against a host without herdr) stays
    // readable instead of vanishing with the pane.
    {
      label: "remain-on-exit",
      args: ["set-option", "-w", "-t", `${HERDR_SESSION}:0`, "remain-on-exit", "on"],
    },
  ];
  for (const [name, value] of Object.entries(opts.env)) {
    steps.push({
      label: `set-environment ${name}`,
      args: ["set-environment", "-t", HERDR_SESSION, name, value],
    });
  }
  steps.push({
    label: "split-window",
    args: [
      "split-window",
      "-h",
      "-d",
      "-t",
      `${HERDR_SESSION}:0.0`,
      "-l",
      String(opts.inv.panelWidth),
      opts.right,
    ],
  });
  steps.push({
    label: "select-pane",
    args: ["select-pane", "-t", `${HERDR_SESSION}:0.0`],
  });
  return steps;
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

/* ---------------------------------- deps ----------------------------------- */

export interface TmuxRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface HerdrCommandDeps {
  env: NodeJS.ProcessEnv;
  isInteractive(): boolean;
  terminalSize(): { cols: number; rows: number };
  tmuxPath(): string | null;
  herdrPath(): string | null;
  tuiPath(): string | null;
  /** argv prefix re-invoking this ais process (compiled binary or dev). */
  aisEntrypoint(): Promise<string[]>;
  /** Ensures the local console daemon is up; returns its URL. */
  consoleUrl(): Promise<string>;
  consoleToken(): Promise<string>;
  runTmux(args: string[]): Promise<TmuxRunResult>;
  /** Full-stdio attach; resolves with tmux's exit code. */
  attach(args: string[]): Promise<number>;
  /** Full-stdio raw herdr exec (--raw). */
  execRaw(command: string, args: string[]): Promise<number>;
  log(message: string): void;
}

function realDeps(): HerdrCommandDeps {
  return {
    env: process.env,
    isInteractive: () => process.stdin.isTTY === true,
    terminalSize: () => ({
      cols: process.stdout.columns ?? 200,
      rows: process.stdout.rows ?? 50,
    }),
    tmuxPath: () => Bun.which("tmux"),
    herdrPath: () => resolveHerdrBinary() ?? null,
    tuiPath: () => resolveTuiBinary() ?? null,
    aisEntrypoint: async () => {
      // Same re-invocation contract as web.ts's detached daemon: compiled
      // binaries argv IS [exe, ...]; dev runs under bun with a script path.
      const { aisEntrypoint } = await import("./web.ts");
      return aisEntrypoint();
    },
    consoleUrl: async () => {
      const { ensureConsoleRunning } = await import("./web.ts");
      const port = await ensureConsoleRunning();
      return `http://127.0.0.1:${port}`;
    },
    consoleToken: async () => {
      const { readServerState } = await import("../server/state.ts");
      return (await readServerState())?.token ?? "";
    },
    runTmux: async (args) => {
      const proc = Bun.spawn(["tmux", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const exitCode = await proc.exited;
      return { exitCode, stdout, stderr };
    },
    attach: async (args) => {
      const proc = Bun.spawn(["tmux", ...args], { stdio: ["inherit", "inherit", "inherit"] });
      return await proc.exited;
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

/** `ais herdr`: create-or-attach the wrapper session. Takes the subcommand's
 * own argv (everything after the "herdr" token) so the space form
 * `--remote <target>` can be folded into `--remote=<target>` pre-parse. */
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

  const conflict = nestingConflict(deps.env);
  if (conflict && !inv.force) {
    throw new CliUsageError(
      `refusing to nest: this shell already runs inside ${conflict === "tmux" ? "a tmux session" : "a herdr pane"} ` +
        "and ais herdr would open another nested pane manager. Pass --force if you really mean it.",
    );
  }

  const tmux = requireBinary(deps.tmuxPath(), "tmux", "Install tmux (the wrapper is a tmux layout).");
  const herdr = requireBinary(
    deps.herdrPath(),
    "herdr",
    'Install it with "ais upgrade" (herdr is never bundled with ais), or point AIS_HERDR_BIN at it.',
  );

  const tmuxBin = (args: string[]) => [tmux, ...args];
  const exists = await deps.runTmux(hasSessionArgs(inv.tmuxSocket));
  if (exists.exitCode === 0 && !inv.recreate) {
    const code = await deps.attach(attachArgs(inv.tmuxSocket));
    if (code !== 0) process.exit(code);
    return;
  }
  if (exists.exitCode === 0 && inv.recreate) {
    await deps.runTmux(killSessionArgs(inv.tmuxSocket));
  }

  let right: string;
  const env: Record<string, string> = {};
  if (inv.panelCmd) {
    if (inv.remoteAis) {
      deps.log(yellow("warning: --remote-ais is ignored with --panel-cmd (the custom command owns the panel)"));
    }
    right = inv.panelCmd;
  } else if (inv.remoteAis && inv.remote) {
    // The panel subcommand mirrors the REMOTE console (tunnel inside the
    // pane) and needs no inherited env.
    right = rightPaneCommand({
      tuiPath: "",
      aisEntrypoint: await deps.aisEntrypoint(),
      remoteAis: true,
      remote: inv.remote,
    });
  } else {
    const tui = requireBinary(
      deps.tuiPath(),
      "the aistui binary",
      "Build it with (cd apps/tui && cargo build --release), or install it to ~/.local/bin/aistui.",
    );
    right = rightPaneCommand({ tuiPath: tui });
    env.AIS_CONSOLE_URL = await deps.consoleUrl();
    const token = await deps.consoleToken();
    if (token) env.AIS_CONSOLE_TOKEN = token;
    if (inv.remote) {
      // Honest degradation: the local bridge describes LOCAL panes, which
      // are not the ones on screen, so highlighting would be fabricated.
      env.AIS_OVERVIEW_BRIDGE = "off";
      env.AIS_OVERVIEW_LABEL = `remote:${inv.remote}`;
      env.AIS_OVERVIEW_NOTE =
        `herdr is showing ${inv.remote}; this console is local, so there is no highlight source (use --remote-ais to mirror the remote console)`;
    }
  }

  const size = deps.terminalSize();
  const steps = buildCreateSteps({
    inv,
    left: leftPaneCommand(herdr, inv.remote),
    right,
    env,
    cols: Math.max(80, size.cols),
    rows: Math.max(24, size.rows),
  });
  for (const step of steps) {
    // Socket prefix rides EVERY invocation, including each create step.
    const result = await deps.runTmux([...socketArgs(inv.tmuxSocket), ...step.args]);
    if (result.exitCode !== 0) {
      throw new CliUsageError(
        `tmux ${step.label} failed (exit ${result.exitCode}): ${result.stderr.trim() || "no stderr"}`,
      );
    }
  }

  if (deps.isInteractive()) {
    const code = await deps.attach(attachArgs(inv.tmuxSocket));
    if (code !== 0) process.exit(code);
    return;
  }
  deps.log(
    `ais herdr: tmux session "${HERDR_SESSION}" created detached (stdin is not a terminal). Attach with: ${dim(attachHint(inv.tmuxSocket))}`,
  );
}

/* ------------------------------ panel subcommand --------------------------- */

export interface HerdrPanelDeps {
  log(message: string): void;
  /** ssh-reads the remote console state; throws when ssh fails. */
  readRemoteState(target: string): Promise<string>;
  pickFreePort(): Promise<number>;
  /** Starts the ssh -L tunnel; kill() tears it down. */
  spawnTunnel(target: string, localPort: number, remotePort: number): { kill(): void };
  /** Probes the tunnelled console; short retries absorb tunnel setup. */
  verifyTunnel(localPort: number, token: string): Promise<boolean>;
  /** Local console fallback (ensures the daemon is up). */
  localConsole(): Promise<{ url: string; token: string }>;
  tuiPath(): string | null;
  /** Runs aistui with the given env, full stdio; resolves with its exit. */
  runTui(tuiPath: string, env: Record<string, string>): Promise<number>;
}

function realPanelDeps(): HerdrPanelDeps {
  const tunnels: Array<Bun.Subprocess<"ignore", "ignore", "ignore">> = [];
  return {
    log: (message) => console.log(message),
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
      tunnels.push(proc);
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
    localConsole: async () => {
      const { ensureConsoleRunning } = await import("./web.ts");
      const port = await ensureConsoleRunning();
      const { readServerState } = await import("../server/state.ts");
      return { url: `http://127.0.0.1:${port}`, token: (await readServerState())?.token ?? "" };
    },
    tuiPath: () => resolveTuiBinary() ?? null,
    runTui: async (tuiPath, env) => {
      const { spawnReal } = await import("../shared/exec.ts");
      return await spawnReal(tuiPath, ["--overview"], env);
    },
  };
}

/** Hidden `ais __herdr_panel --remote=<target>`: runs INSIDE the wrapper's
 * right pane. Mirrors the remote machine's console through an ssh -L
 * tunnel (the pane's lifetime bounds the tunnel's), verifies it, and execs
 * `aistui --overview` against it. Any failure degrades to the LOCAL
 * console with an honest note - the panel never fakes a remote view. */
export async function runHerdrPanelCommand(
  rest: string[],
  flags: Record<string, string | true>,
  deps: HerdrPanelDeps = realPanelDeps(),
): Promise<void> {
  if (rest.length > 0) {
    throw new CliUsageError(`unexpected argument "${rest[0]}"`);
  }
  const remote = stringFlag(flags, "remote");
  if (!remote) {
    throw new CliUsageError("__herdr_panel requires --remote=<ssh-target>");
  }
  const label = `remote:${remote}`;
  let env: Record<string, string> | undefined;
  let tunnel: { kill(): void } | undefined;

  let state: { port?: number; token?: string } = {};
  let sshError: string | undefined;
  try {
    state = parseRemoteConsoleState(await deps.readRemoteState(remote));
  } catch (err) {
    sshError = err instanceof Error ? err.message : String(err);
  }

  if (state.port) {
    const localPort = await deps.pickFreePort();
    tunnel = deps.spawnTunnel(remote, localPort, state.port);
    if (await deps.verifyTunnel(localPort, state.token ?? "")) {
      env = {
        AIS_CONSOLE_URL: `http://127.0.0.1:${localPort}`,
        AIS_OVERVIEW_LABEL: label,
        ...(state.token ? { AIS_CONSOLE_TOKEN: state.token } : {}),
      };
    } else {
      tunnel.kill();
      tunnel = undefined;
    }
  }
  if (!env) {
    if (state.port === undefined && sshError) {
      deps.log(yellow(`ais herdr: ${remote} has no readable ais console state (${sshError})`));
    }
    const local = await deps.localConsole();
    env = {
      AIS_CONSOLE_URL: local.url,
      AIS_OVERVIEW_LABEL: label,
      AIS_OVERVIEW_BRIDGE: "off",
      AIS_OVERVIEW_NOTE: `${remote} has no reachable ais console; showing LOCAL data`,
      ...(local.token ? { AIS_CONSOLE_TOKEN: local.token } : {}),
    };
  }

  const tui = requireBinary(
    deps.tuiPath(),
    "the aistui binary",
    "Build it with (cd apps/tui && cargo build --release), or install it to ~/.local/bin/aistui.",
  );
  let code: number;
  try {
    code = await deps.runTui(tui, env);
  } finally {
    tunnel?.kill();
  }
  if (code !== 0) process.exit(code);
}
