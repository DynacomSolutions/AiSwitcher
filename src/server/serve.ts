import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { createApp } from "./app.ts";
import { clearServerState, consoleWebDir, newConsoleToken, writeServerState } from "./state.ts";
import type { ConsoleAppDeps } from "./app.ts";

export interface ServeOptions {
  port?: number;
  host?: string;
  distDir?: string;
  /** Test hook: skip writing the state file / signal handlers. */
  managed?: boolean;
}

export const DEFAULT_CONSOLE_PORT = 47129;

/** Boots the console HTTP server in THIS process. Used directly by
 * `ais web --foreground` and by the detached daemon spawned by
 * `ais web start`; tests call createApp() instead. */
export async function startConsoleServer(options: ServeOptions = {}): Promise<{ port: number; token: string; stop: () => void }> {
  const port = options.port ?? (Number.parseInt(process.env.AIS_WEB_PORT ?? "", 10) || DEFAULT_CONSOLE_PORT);
  const host = options.host ?? process.env.AIS_WEB_HOST ?? "127.0.0.1";  const token = newConsoleToken();
  const deps: ConsoleAppDeps = {
    token,
    port,
    startedAt: Date.now(),
    ...(options.distDir ? { distDir: options.distDir } : {}),
  };
  const app = createApp(deps);

  const server = Bun.serve({
    port,
    hostname: host,
    fetch(req, bunServer) {
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
    const shutdown = () => {
      void clearServerState();
      server.stop(true);
      setTimeout(() => process.exit(0), 50);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  }

  return { port: server.port ?? port, token, stop: () => server.stop(true) };
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
