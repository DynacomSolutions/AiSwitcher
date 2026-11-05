import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aisStateDir } from "../shared/ais-home.ts";

/**
 * Live sessions the host-level profile-sync daemon should watch. Each session
 * sidecar writes one small file here when the session starts and removes it
 * after the tool exits; the daemon reads the directory every poll. One file per
 * session means no shared file, no locking and no read-modify-write races.
 * A session whose process is gone (sidecar killed, host crash) is pruned by
 * the next reader, matched by PID plus start time so a reused PID never keeps a
 * dead entry alive.
 */

export interface RegisteredSession {
  v: 1;
  toolName: string;
  identityName: string;
  /** The identity's configDir as the session saw it (may contain `~`). */
  configDir: string;
  cwd: string;
  /** Per-session project dotdir for crush-backed tools (`<cwd>/.crush`). */
  crushRoot?: string;
  /** The real tool's PID (the wrapper's PID, which the tool takes over via execve). */
  pid: number;
  startTime?: string;
}

export type IsRunning = (pid: number, startTime?: string) => boolean;

const EXT = ".json";

export function sessionRegistryDir(): string {
  return join(aisStateDir(), "profile-sync", "sessions");
}

function entryName(pid: number, startTime?: string): string {
  return `${pid}-${(startTime ?? "na").replace(/[^0-9A-Za-z]/g, "_")}${EXT}`;
}

/** Records a live session. Best effort: callers ignore failures, so a broken
 * state dir can never affect the AI CLI (the post-exit sync still runs). */
export function registerSession(session: Omit<RegisteredSession, "v">, dir = sessionRegistryDir()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, entryName(session.pid, session.startTime));
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ v: 1, ...session }), { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* nothing left behind */ }
    throw error;
  }
  return file;
}

export function unregisterSession(pid: number, startTime: string | undefined, dir = sessionRegistryDir()): void {
  try { unlinkSync(join(dir, entryName(pid, startTime))); } catch { /* already gone */ }
}

function parse(raw: string): RegisteredSession | undefined {
  try {
    const value = JSON.parse(raw) as Partial<RegisteredSession>;
    if (
      value.v !== 1 ||
      typeof value.pid !== "number" ||
      typeof value.toolName !== "string" ||
      typeof value.identityName !== "string" ||
      typeof value.configDir !== "string" ||
      typeof value.cwd !== "string"
    ) {
      return undefined;
    }
    return value as RegisteredSession;
  } catch {
    return undefined;
  }
}

/** Live registered sessions; removes entries whose process is gone or which
 * cannot be parsed. A missing directory means no sessions. */
export function listLiveSessions(isRunning: IsRunning, dir = sessionRegistryDir()): RegisteredSession[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const live: RegisteredSession[] = [];
  for (const name of names) {
    if (!name.endsWith(EXT)) continue;
    const file = join(dir, name);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const session = parse(raw);
    if (session && isRunning(session.pid, session.startTime)) {
      live.push(session);
    } else {
      try { unlinkSync(file); } catch { /* raced with another reader */ }
    }
  }
  return live;
}
