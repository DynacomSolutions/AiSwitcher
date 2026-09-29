import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, statSync } from "node:fs";
import { createApp } from "./app.ts";
import { AuthRefreshScheduler, parseRefreshIntervalMs } from "./auth-refresh.ts";
import { loadSpendGuardConfig, SpendGuardScheduler } from "./spend-guard.ts";
import { loadHerdrBridgeConfig, HerdrBridgeScheduler } from "./herdr-bridge.ts";
import { LoginFlowManager } from "./login-flows.ts";
import { clearServerState, consoleWebDir, newConsoleToken, writeServerState } from "./state.ts";
import { ensureUsableCwd } from "../shared/exec.ts";
import type { ConsoleAppDeps } from "./app.ts";

export interface ServeOptions {
  port?: number;
  host?: string;
  distDir?: string;
  /** Test hook: skip writing the state file / signal handlers. */
  managed?: boolean;
  /** Self-terminate after this many ms with no request. Undefined (the
   * default for every explicit `ais web start`/`--foreground` and for the
   * k8s pod's direct `ais web --serve-internal`) means "run forever, until
   * `ais web stop`" — unchanged, explicit-daemon behaviour. Only a caller
   * that spawns the daemon IMPLICITLY on someone's behalf (see
   * cli/web.ts's ensureConsoleRunning) should ever pass this: it is what
   * keeps a console daemon spawned as a side effect (e.g. `ais herdr`'s
   * overview panel) from outliving the session that incidentally needed
   * it, without the client having to track/kill a pid it may not even be
   * the sole user of (another consumer's own request resets the timer). */
  idleShutdownMs?: number;
}

export const DEFAULT_CONSOLE_PORT = 47129;

/** Pure decision behind the idle-shutdown timer, exported so it is
 * unit-testable without booting a real Bun.serve instance or touching
 * process.exit (the real shutdown path). */
export function isIdleTooLong(lastActivityMs: number, nowMs: number, idleShutdownMs: number): boolean {
  return nowMs - lastActivityMs >= idleShutdownMs;
}

/** How often the idle timer polls: frequent enough that a daemon does not
 * linger long past its budget, but never faster than 1s or more than every
 * 30s regardless of how large idleShutdownMs is. */
export function idleCheckIntervalMs(idleShutdownMs: number): number {
  return Math.min(30_000, Math.max(1_000, Math.floor(idleShutdownMs / 4)));
}

/** AIS_WEB_ALLOWED_HOSTS: comma-separated extra vhostnames the guard trusts
 * like loopback peers (e.g. `ais.localhost` in front of a reverse proxy,
 * where every peer address is the proxy). Empty/absent keeps the default
 * loopback-only trust model. */
export function parseAllowedHosts(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0),
  );
}

/** Boots the console HTTP server in THIS process. Used directly by
 * `ais web --foreground` and by the detached daemon spawned by
 * `ais web start`; tests call createApp() instead. */
export async function startConsoleServer(options: ServeOptions = {}): Promise<{ port: number; token: string; stop: () => void }> {
  // The daemon outlives whatever directory launched it. A deleted cwd makes
  // every child spawn fail with a confusing POSIX permission/ENOENT error
  // (scan workers, sync kick-offs, fix actions), so land on $HOME up front.
  ensureUsableCwd();
  const port = options.port ?? (Number.parseInt(process.env.AIS_WEB_PORT ?? "", 10) || DEFAULT_CONSOLE_PORT);
  const host = options.host ?? process.env.AIS_WEB_HOST ?? "127.0.0.1";
  // Daemon-side credential renewal (Alibaba console cookies today). Managed
  // runs only — tests create the bare app. AIS_AUTH_REFRESH_INTERVAL_MS=0
  // opts out entirely.
  const scheduler = new AuthRefreshScheduler(parseRefreshIntervalMs(process.env.AIS_AUTH_REFRESH_INTERVAL_MS));
  scheduler.hydrate();
  scheduler.start();
  // Daemon-managed per-identity login flows (real CLI logins with piped
  // stdio / a script PTY). AIS_AUTH_REFRESH_INTERVAL_MS=0 does not affect
  // these: a login flow is always user-initiated, never scheduled.
  const loginFlows = new LoginFlowManager();

  // Daemon-side spend guard: periodic account-state cycle, cache writes for
  // the launch gate, and breach-transition session kills. The interval (and
  // kill grace) come from the machine-local spend-guard.json; the CAP never
  // comes from config — it is AUTO from AWS Budgets. AIS_SPEND_GUARD=0
  // opts the daemon out entirely (the launch gate is unaffected: it has no
  // override).
  let spendGuard: SpendGuardScheduler | undefined;
  if (process.env.AIS_SPEND_GUARD !== "0") {
    spendGuard = new SpendGuardScheduler({ config: await loadSpendGuardConfig() });
    await spendGuard.hydrate();
    spendGuard.start();
  }

  // Daemon-side herdr metadata bridge: per-pane AIS limit tokens for
  // herdr's sidebar, via `herdr pane report-metadata --token $ais_*=...`
  // (CALL only; never signals or restarts any herdr process). Interval and
  // categories come from the machine-local herdr-bridge.json;
  // AIS_HERDR_BRIDGE=0 opts the daemon out entirely.
  let herdrBridge: HerdrBridgeScheduler | undefined;
  if (process.env.AIS_HERDR_BRIDGE !== "0") {
    herdrBridge = new HerdrBridgeScheduler({ config: await loadHerdrBridgeConfig() });
    herdrBridge.start();
  }

  const token = newConsoleToken();
  const deps: ConsoleAppDeps = {
    token,
    port,
    startedAt: Date.now(),
    allowedHosts: parseAllowedHosts(process.env.AIS_WEB_ALLOWED_HOSTS),
    authRefresh: scheduler,
    ...(spendGuard ? { spendGuard } : {}),
    ...(herdrBridge ? { herdrBridge } : {}),
    loginFlows,
    ...(options.distDir ? { distDir: options.distDir } : {}),
  };
  const app = createApp(deps);

  // Tracks the last time ANY request hit this daemon, for idleShutdownMs
  // below. Every request counts, from every consumer (WebUI, TUI, herdr's
  // overview panel, another herdr session sharing this same daemon) - the
  // point is "is anything still using this console", not "did the caller
  // that spawned it exit".
  let lastActivityMs = Date.now();

  const server = Bun.serve({
    port,
    hostname: host,
    // Default is 10s, which silently killed any scan slower than that
    // ("empty reply" at exactly T+10s, observed live). Our own deadlines
    // (20-30s worker caps) are the real bound; this just has to sit above
    // them. Bun caps idleTimeout at 255.
    idleTimeout: Math.min(120, 255),
    fetch(req, bunServer) {
      lastActivityMs = Date.now();
      // Stamp the peer address so the guard can distinguish loopback peers
      // from token-carrying remote ones when a non-loopback bind is used.
      const ip = bunServer.requestIP(req);
      (req as unknown as { __remoteAddress?: string }).__remoteAddress = ip?.address;
      return app.fetch(req);
    },
  });

  if (options.managed !== false) {
    const actualPort = server.port ?? port;
    await writeServerState({ pid: process.pid, port: actualPort, token, startedAt: new Date().toISOString() });
    // A detached daemon still belongs to the SPAWNING terminal's process
    // group until it exits; when that terminal/pty closes, SIGHUP takes the
    // daemon down with it (observed live: server "mysteriously" dying every
    // time a launching TUI/browser session ended). Ignoring HUP here is
    // what actually makes `ais web start`'s child survive its parent's
    // whole session.
    process.on("SIGHUP", () => {});
    const shutdown = () => {
      scheduler.stop();
      spendGuard?.stop();
      herdrBridge?.stop();
      loginFlows.stop();
      void clearServerState();
      server.stop(true);
      setTimeout(() => process.exit(0), 50);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    // idleShutdownMs: ONLY set by an implicit spawn (see ServeOptions doc).
    // An explicit `ais web start`/`--foreground`, and the k8s pod's direct
    // `ais web --serve-internal`, never pass it, so they run forever exactly
    // as before - this is opt-in per spawn, not a global behaviour change.
    if (options.idleShutdownMs && options.idleShutdownMs > 0) {
      const idleShutdownMs = options.idleShutdownMs;
      const idleTimer = setInterval(() => {
        if (isIdleTooLong(lastActivityMs, Date.now(), idleShutdownMs)) {
          clearInterval(idleTimer);
          shutdown();
        }
      }, idleCheckIntervalMs(idleShutdownMs));
      idleTimer.unref?.();
    }
  }

  return { port: server.port ?? port, token, stop: () => { scheduler.stop(); spendGuard?.stop(); herdrBridge?.stop(); loginFlows.stop(); server.stop(true); } };
}

/** Best-effort discovery of the built WebUI dist relative to wherever this
 * code is running from: a dev checkout (probed relative to this module),
 * an explicit override, or an installed copy at ~/.ais/web/dist (the
 * installed ais binary has no repo layout around it, so `install:shims`
 * style setups copy apps/web/dist there). */
export function findDistDir(): string | undefined {
  const candidates = [
    process.env.AIS_WEB_DIST,
    join(import.meta.dir, "..", "..", "apps", "web", "dist"),
    join(import.meta.dir, "..", "..", "..", "apps", "web", "dist"),
    join(consoleWebDir(), "dist"),
    // The historical installed-copy location, kept as a final fallback even
    // when AIS_WEB_STATE_DIR relocates consoleWebDir(): the dist dir is
    // install-time STATIC ASSETS, not daemon state, and an override (e.g.
    // someone experimenting with the pod's isolation on the host) must not
    // blind an installed binary's WebUI discovery.
    join(homedir(), ".ais", "web", "dist"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const candidate of candidates) {
    try {
      if (existsSync(join(candidate, "index.html")) && statSync(candidate).isDirectory()) return candidate;
    } catch {
      // keep probing
    }
  }
  return undefined;
}
