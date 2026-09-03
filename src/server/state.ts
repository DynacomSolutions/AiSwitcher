import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/** On-disk lifecycle state for the console server: ~/.ais/web/server.json.
 * The TUI (and any local client) reads `token` from here; the pid lets
 * `ais web status/stop` manage a detached server without an RPC. */

export interface ConsoleServerState {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

export function consoleWebDir(home: string = homedir()): string {
  return join(home, ".ais", "web");
}

export function consoleServerStatePath(home: string = homedir()): string {
  return join(consoleWebDir(home), "server.json");
}

export function newConsoleToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function readServerState(path = consoleServerStatePath()): Promise<ConsoleServerState | undefined> {
  try {
    const raw = await Bun.file(path).json();
    if (typeof raw?.pid === "number" && typeof raw?.port === "number" && typeof raw?.token === "string") {
      return raw as ConsoleServerState;
    }
  } catch {
    // Missing or corrupt state simply means "not running".
  }
  return undefined;
}

export async function writeServerState(state: ConsoleServerState, path = consoleServerStatePath()): Promise<void> {
  const dir = consoleWebDir();
  await Bun.$`mkdir -p ${dir}`.quiet();
  await Bun.write(path, `${JSON.stringify(state, null, 2)}\n`);
}

export async function clearServerState(path = consoleServerStatePath()): Promise<void> {
  await Bun.$`rm -f ${path}`.quiet();
}

/** True when the recorded pid belongs to a live process. Not a guarantee it
 * is still OUR server, but combined with the health check below it is the
 * cheap first filter. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
