import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Pure parts of the shared browser MCP service: names, the launch headers, their validation and the key file.
 * Light imports only: every agent launch loads this file. The daemon itself is in `mcp-http.ts`.
 */

export const MCP_DEFAULT_PORT = 47150;
export const MCP_PATH = "/mcp";
export const MCP_HEALTH_PATH = "/healthz";
export const MCP_UNIT_NAME = "ais-browser-mcp.service";
/** Env var that carries the key to the launched tool. The key itself never appears in argv. */
export const MCP_KEY_ENV = "AIS_BROWSER_MCP_KEY";

export function mcpPort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.AIS_BROWSER_MCP_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : MCP_DEFAULT_PORT;
}

export const mcpUrl = (port: number): string => `http://127.0.0.1:${port}${MCP_PATH}`;

export function mcpKeyDir(home: string = homedir()): string {
  return join(home, ".ais", "browser-mcp");
}

export function mcpUnitDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user");
}

/** True when the service unit file is installed (Linux only: no other platform installs it). */
export function mcpUnitInstalled(exists: (p: string) => boolean = existsSync, platform: NodeJS.Platform = process.platform, unitDir: string = mcpUnitDir()): boolean {
  return platform === "linux" && exists(join(unitDir, MCP_UNIT_NAME));
}

const KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Reads the key, creating the folder (0700) and the file (0600, 32 random bytes as hex) when missing. Tightens loose modes.
 * Safe when two processes race: the file is created exclusively and the loser reads the winner's key. Never logs the key.
 */
export function ensureMcpKey(dir: string = mcpKeyDir()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, "key");
  const read = (): string | undefined => {
    try {
      const text = readFileSync(file, "utf8").trim();
      return KEY_PATTERN.test(text) ? text : undefined;
    } catch {
      return undefined;
    }
  };
  let key = read();
  if (!key) {
    try {
      // A broken file (wrong length) is replaced; a missing one is created exclusively.
      writeFileSync(file, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: existsSync(file) ? "w" : "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    key = read();
    if (!key) throw new Error("cannot create the browser MCP key");
  }
  if ((statSync(file).mode & 0o777) !== 0o600) chmodSync(file, 0o600);
  return key;
}

/** Reads the key without creating it. */
export function readMcpKey(dir: string = mcpKeyDir()): string | undefined {
  try {
    const text = readFileSync(join(dir, "key"), "utf8").trim();
    return KEY_PATTERN.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Header names (lower case, as the daemon reads them). */
export const HEADER = {
  pool: "x-ais-pool",
  tool: "x-ais-tool",
  identity: "x-ais-identity",
  configDir: "x-ais-config-dir",
  home: "x-ais-home",
  gateway: "x-ais-gateway",
  sessionId: "x-ais-session-id",
  t3Thread: "x-ais-t3-thread",
  t3Home: "x-ais-t3-home",
  cwd: "x-ais-cwd",
  ownerPid: "x-ais-owner-pid",
} as const;

export interface LaunchHeaderInput {
  tool: "claude" | "codex";
  pool?: string | undefined;
  identity?: string | undefined;
  /** Folder that holds the identity's browser token (identity mode). */
  configDir?: string | undefined;
  /** The launch's own CLAUDE_CONFIG_DIR / CODEX_HOME: where the session transcript lives. */
  home?: string | undefined;
  gateway?: string | undefined;
  sessionId?: string | undefined;
  t3Thread?: string | undefined;
  t3Home?: string | undefined;
  cwd?: string | undefined;
  ownerPid?: number | undefined;
}

const enc = (v: string): string => encodeURIComponent(v);

/** The session description a launch sends with every request. Path-like values are percent-encoded so that any folder name is a valid header value. */
export function launchHeaders(i: LaunchHeaderInput): Record<string, string> {
  const h: Record<string, string> = { "X-AIS-Tool": i.tool };
  const set = (name: string, v: string | undefined, encode = false): void => {
    if (v) h[name] = encode ? enc(v) : v;
  };
  set("X-AIS-Pool", i.pool);
  set("X-AIS-Identity", i.identity, true);
  set("X-AIS-Config-Dir", i.configDir, true);
  set("X-AIS-Home", i.home, true);
  set("X-AIS-Gateway", i.gateway, true);
  set("X-AIS-Session-Id", i.sessionId);
  set("X-AIS-T3-Thread", i.t3Thread);
  set("X-AIS-T3-Home", i.t3Home, true);
  set("X-AIS-Cwd", i.cwd, true);
  if (i.ownerPid !== undefined) h["X-AIS-Owner-Pid"] = String(i.ownerPid);
  return h;
}

export interface SessionHeaders {
  tool: "claude" | "codex";
  pool?: string;
  identity?: string;
  configDir?: string;
  home?: string;
  gateway?: string;
  sessionId?: string;
  t3Thread?: string;
  t3Home?: string;
  cwd?: string;
  ownerPid?: number;
  /** The client's `Mcp-Session-Id`, the last resort for a session key. */
  mcpSessionId?: string;
}

export type ParsedHeaders = { ok: true; value: SessionHeaders } | { ok: false; error: string };

const NAME = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function decodePath(raw: string, field: string): string {
  let v: string;
  try {
    v = decodeURIComponent(raw);
  } catch {
    throw new Error(`${field}: bad encoding`);
  }
  if (v.length > 1024 || v.includes("\0") || !isAbsolute(v) || v.split("/").includes("..")) throw new Error(`${field}: must be an absolute path without ..`);
  return v;
}

function decodeName(raw: string, field: string): string {
  let v: string;
  try {
    v = decodeURIComponent(raw);
  } catch {
    throw new Error(`${field}: bad encoding`);
  }
  if (!NAME.test(v)) throw new Error(`${field}: invalid name`);
  return v;
}

/** Validates the session headers of one request. Never throws. */
export function parseSessionHeaders(get: (name: string) => string | null | undefined): ParsedHeaders {
  try {
    const raw = (name: string): string | undefined => get(name)?.trim() || undefined;
    const tool = raw(HEADER.tool);
    if (tool !== "claude" && tool !== "codex") throw new Error("x-ais-tool: must be claude or codex");
    const out: SessionHeaders = { tool };
    const pool = raw(HEADER.pool);
    if (pool) out.pool = decodeName(pool, "x-ais-pool");
    const identity = raw(HEADER.identity);
    if (identity) out.identity = decodeName(identity, "x-ais-identity");
    const configDir = raw(HEADER.configDir);
    if (configDir) out.configDir = decodePath(configDir, "x-ais-config-dir");
    const home = raw(HEADER.home);
    if (home) out.home = decodePath(home, "x-ais-home");
    const gateway = raw(HEADER.gateway);
    if (gateway) {
      let url: URL;
      try {
        url = new URL(decodeURIComponent(gateway));
      } catch {
        throw new Error("x-ais-gateway: not a URL");
      }
      if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) throw new Error("x-ais-gateway: must be an http(s) URL without credentials");
      out.gateway = url.origin + url.pathname.replace(/\/+$/, "");
    }
    const sessionId = raw(HEADER.sessionId);
    if (sessionId) {
      if (!ID.test(sessionId)) throw new Error("x-ais-session-id: invalid id");
      out.sessionId = sessionId;
    }
    const t3Thread = raw(HEADER.t3Thread);
    if (t3Thread) {
      if (!ID.test(t3Thread)) throw new Error("x-ais-t3-thread: invalid id");
      out.t3Thread = t3Thread;
    }
    const t3Home = raw(HEADER.t3Home);
    if (t3Home) out.t3Home = decodePath(t3Home, "x-ais-t3-home");
    const cwd = raw(HEADER.cwd);
    if (cwd) out.cwd = decodePath(cwd, "x-ais-cwd");
    const pid = raw(HEADER.ownerPid);
    if (pid) {
      if (!/^\d{1,10}$/.test(pid) || Number(pid) < 2) throw new Error("x-ais-owner-pid: must be a process id");
      out.ownerPid = Number(pid);
    }
    const mcpSession = raw("mcp-session-id");
    if (mcpSession && ID.test(mcpSession)) out.mcpSessionId = mcpSession;
    if (!out.pool && !(out.identity && out.configDir)) throw new Error("x-ais-pool, or x-ais-identity with x-ais-config-dir, is required");
    return { ok: true, value: out };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Value of `--session-id <id>` or `--resume <id>` (also `--flag=id`, `-r <id>`) when it is a UUID; the Claude transcript id of the launch. */
export function claudeSessionIdFromArgv(argv: readonly string[]): string | undefined {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let found: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") break;
    const eq = a.indexOf("=");
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (flag !== "--session-id" && flag !== "--resume" && flag !== "-r") continue;
    const value = eq > 0 ? a.slice(eq + 1) : argv[i + 1];
    if (value && uuid.test(value)) found = value.toLowerCase();
  }
  return found;
}

/** True when something accepts a TCP connection on the loopback port within `timeoutMs`. */
export function portAnswers(port: number, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Starts the service when the port does not answer. Waits at most `timeoutMs` for the connect test and never for the start itself
 * (`systemctl --no-block`), so a launch is never held up by the daemon.
 */
export async function ensureMcpDaemonStarted(port: number, deps: { answers?: (port: number, ms: number) => Promise<boolean>; start?: () => void; timeoutMs?: number } = {}): Promise<boolean> {
  if (await (deps.answers ?? portAnswers)(port, deps.timeoutMs ?? 200)) return true;
  try {
    (deps.start ?? (() => {
      const child = spawn("systemctl", ["--user", "start", "--no-block", MCP_UNIT_NAME], { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
    }))();
  } catch {
    // No systemd: the launch goes on, the tools report the failure.
  }
  return false;
}
