import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findCodexThreadId } from "./codex-thread.ts";
import { contextFromSpec, handleRpc, sendSessionEnd, type ContextSpec, type ShimContext } from "./mcp-shim.ts";
import { MCP_HEALTH_PATH, MCP_PATH, ensureMcpKey, mcpKeyDir, mcpPort, parseSessionHeaders, type SessionHeaders } from "./mcp-http-config.ts";

/** How often the reaper looks for sessions whose agent process is gone. */
export const REAP_EVERY_MS = 30_000;
/** A session without an owner pid that made no call for this long is ended. */
export const IDLE_SESSION_MS = 30 * 60_000;
const MAX_BODY_BYTES = 1_000_000;

interface RpcMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

interface Entry {
  ctx: ShimContext;
  ownerPid: number | undefined;
  lastUsed: number;
}

export interface DaemonDeps {
  /** The bearer key every MCP request must carry. */
  key: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** True while process `pid` exists. Default: `process.kill(pid, 0)`. */
  pidAlive?: (pid: number) => boolean;
  /** The id Claude Code records for the process, from `<home>/sessions/<pid>.json`. */
  readClaudeSessionId?: (home: string, pid: number) => string | undefined;
  findCodexThread?: (home: string, pid: number, cwd: string) => Promise<string | undefined>;
  makeContext?: (spec: ContextSpec) => ShimContext;
  rpc?: (msg: RpcMessage, ctx: ShimContext) => Promise<object | undefined>;
  endSession?: (ctx: ShimContext) => Promise<void>;
  idleMs?: number;
  log?: (line: string) => void;
}

export interface McpDaemon {
  handle(req: Request): Promise<Response>;
  /** Ends and drops the sessions whose owner process is gone (or that have been idle too long). Returns how many. */
  reap(): Promise<number>;
  /** Runs `reap` on a timer that does not keep the process alive. Returns the stop function. */
  startReaper(everyMs?: number): () => void;
  /** Starts refusing new requests. Resolves when every in-flight request is done. No timers. */
  drain(): Promise<void>;
  readonly sessions: ReadonlyMap<string, { ownerPid: number | undefined; lastUsed: number }>;
  readonly draining: boolean;
}

/** Context for the methods that never reach the gateway. Its readers are never called. */
const STATIC_CONTEXT: ShimContext = {
  gatewayUrl: async () => undefined,
  token: async () => undefined,
  session: { id: "", identity: "", label: "" },
  fetch: (async () => { throw new Error("no gateway call without a session"); }) as unknown as typeof fetch,
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function hostName(hostHeader: string): string {
  if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1);
  return hostHeader.split(":")[0] ?? "";
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** DNS rebinding guard: the Host header, and the Origin when present, must name the loopback interface. */
export function isLoopbackRequest(host: string | null, origin: string | null): boolean {
  if (!host || !LOOPBACK.has(hostName(host.toLowerCase()))) return false;
  if (origin === null) return true;
  try {
    return LOOPBACK.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Constant-time check of `Authorization: Bearer <key>`. */
export function keyMatches(authorization: string | null, key: string): boolean {
  const m = /^Bearer (.+)$/.exec(authorization ?? "");
  const presented = digest(m?.[1] ?? "");
  const ok = timingSafeEqual(presented, digest(key));
  return ok && m !== null;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultReadClaudeSessionId(home: string, pid: number): string | undefined {
  try {
    const id = (JSON.parse(readFileSync(join(home, "sessions", `${pid}.json`), "utf8")) as { sessionId?: unknown }).sessionId;
    return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export function createMcpDaemon(deps: DaemonDeps): McpDaemon {
  const now = deps.now ?? Date.now;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const readClaudeId = deps.readClaudeSessionId ?? defaultReadClaudeSessionId;
  const codexThread = deps.findCodexThread ?? findCodexThreadId;
  const makeContext = deps.makeContext ?? contextFromSpec;
  const rpc = deps.rpc ?? handleRpc;
  const endSession = deps.endSession ?? sendSessionEnd;
  const idleMs = deps.idleMs ?? IDLE_SESSION_MS;
  const log = deps.log ?? (() => {});
  const sessions = new Map<string, Entry>();
  let active = 0;
  let draining = false;
  let idle: (() => void) | undefined;

  /** The key of the session a request belongs to. Claude Code's own record of the process wins, then the launch's id, then the agent pid. */
  function sessionIdOf(h: SessionHeaders): string {
    const fromProcess = h.tool === "claude" && h.home && h.ownerPid ? readClaudeId(h.home, h.ownerPid) : undefined;
    return fromProcess ?? h.sessionId ?? (h.ownerPid ? `agent-${h.ownerPid}` : h.mcpSessionId ?? "agent");
  }
  const keyOf = (h: SessionHeaders, id: string): string => [h.tool, h.pool ?? h.identity ?? "", id].join("\u0000");

  function specOf(h: SessionHeaders, id: string): ContextSpec {
    const env: NodeJS.ProcessEnv = {
      ...(h.t3Thread ? { T3CODE_THREAD_ID: h.t3Thread } : {}),
      ...(h.t3Home ? { T3CODE_HOME: h.t3Home } : {}),
      ...(h.gateway ? { AIS_GATEWAY_PROXY_URL: h.gateway } : {}),
      ...(h.home ? (h.tool === "codex" ? { CODEX_HOME: h.home } : { CLAUDE_CONFIG_DIR: h.home }) : {}),
    };
    const home = h.home ?? h.configDir ?? join(homedir(), h.tool === "codex" ? ".codex" : ".claude");
    const configDirs = [...new Set([h.configDir, h.home].filter((d): d is string => !!d))];
    let lookup: ContextSpec["lookup"];
    if (h.tool === "codex") {
      if (h.ownerPid && h.cwd) lookup = () => codexThread(home, h.ownerPid!, h.cwd!);
    } else if (!id.startsWith("agent-")) {
      lookup = id;
    } else if (h.home && h.ownerPid) {
      lookup = async () => readClaudeId(h.home!, h.ownerPid!);
    }
    return {
      id,
      identity: h.identity ?? "agent",
      tool: h.tool,
      ...(h.configDir ? { configDir: h.configDir } : {}),
      configDirs,
      ...(h.gateway ? { gateway: h.gateway } : {}),
      ...(h.pool ? { pool: h.pool, poolTool: h.tool } : {}),
      ...(lookup ? { lookup } : {}),
      ...(h.cwd ? { cwd: h.cwd } : {}),
      env,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    };
  }

  function contextFor(h: SessionHeaders): { key: string; entry: Entry } {
    const id = sessionIdOf(h);
    const key = keyOf(h, id);
    let entry = sessions.get(key);
    if (!entry) {
      entry = { ctx: makeContext(specOf(h, id)), ownerPid: h.ownerPid, lastUsed: now() };
      sessions.set(key, entry);
    }
    entry.lastUsed = now();
    if (h.ownerPid) entry.ownerPid = h.ownerPid;
    return { key, entry };
  }

  async function post(req: Request, headers: SessionHeaders): Promise<Response> {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return json(413, { error: "request too large" });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    const messages = Array.isArray(body) ? body : [body];
    if (messages.length === 0 || messages.some((m) => typeof m !== "object" || m === null || Array.isArray(m))) {
      return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
    }
    // Registration (initialize, tools/list, ping) must stay cheap under load: no registry, T3 database or file read.
    // The session context, which reads those lazily, is built only for a call or a cancel.
    const needsContext = (messages as RpcMessage[]).some((m) => m.method === "tools/call" || m.method === "notifications/cancelled");
    const entry: Entry = needsContext ? contextFor(headers).entry : { ctx: STATIC_CONTEXT, ownerPid: undefined, lastUsed: now() };
    const replies: object[] = [];
    await Promise.all((messages as RpcMessage[]).map(async (msg) => {
      // A client that drops the connection cancels its own call.
      const onAbort = (): void => {
        if (msg.method === "tools/call" && msg.id !== undefined && msg.id !== null) entry.ctx.inflight?.get(msg.id)?.abort();
      };
      req.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const out = await rpc(msg, entry.ctx).catch((e: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }));
        if (out) replies.push(out);
      } finally {
        req.signal.removeEventListener("abort", onAbort);
      }
    }));
    if (needsContext) entry.lastUsed = now();
    if (replies.length === 0) return new Response(null, { status: 202 });
    return json(200, Array.isArray(body) ? replies : replies[0]);
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (!isLoopbackRequest(req.headers.get("host") ?? url.host, req.headers.get("origin"))) return json(403, { error: "forbidden host or origin" });
    if (url.pathname === MCP_HEALTH_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "method not allowed" }, { allow: "GET, HEAD" });
      return draining ? json(503, { status: "draining" }) : json(200, { status: "ok" });
    }
    if (url.pathname !== MCP_PATH) return json(404, { error: "not found" });
    if (!keyMatches(req.headers.get("authorization"), deps.key)) return json(401, { error: "unauthorised" }, { "www-authenticate": "Bearer" });
    if (req.method === "GET") return json(405, { error: "this server has no event stream" }, { allow: "POST, DELETE" });
    if (req.method !== "POST" && req.method !== "DELETE") return json(405, { error: "method not allowed" }, { allow: "POST, DELETE" });
    if (draining) return json(503, { error: "shutting down" }, { "retry-after": "1" });
    const parsed = parseSessionHeaders((name) => req.headers.get(name));
    if (!parsed.ok) return json(400, { error: parsed.error });
    active++;
    try {
      if (req.method === "DELETE") {
        const id = sessionIdOf(parsed.value);
        const key = keyOf(parsed.value, id);
        const entry = sessions.get(key);
        if (entry) {
          sessions.delete(key);
          await endSession(entry.ctx);
        }
        return new Response(null, { status: 204 });
      }
      return await post(req, parsed.value);
    } finally {
      active--;
      if (active === 0) idle?.();
    }
  }

  async function reap(): Promise<number> {
    const t = now();
    const gone: Array<[string, Entry]> = [];
    for (const [key, entry] of sessions) {
      const dead = entry.ownerPid !== undefined ? !pidAlive(entry.ownerPid) : t - entry.lastUsed > idleMs;
      if (dead) gone.push([key, entry]);
    }
    for (const [key] of gone) sessions.delete(key);
    await Promise.all(gone.map(([, entry]) => endSession(entry.ctx).catch((e: unknown) => log(`session end failed: ${e instanceof Error ? e.message : String(e)}`))));
    return gone.length;
  }

  return {
    handle,
    reap,
    startReaper(everyMs = REAP_EVERY_MS) {
      const timer = setInterval(() => { void reap(); }, everyMs);
      timer.unref();
      return () => clearInterval(timer);
    },
    drain() {
      draining = true;
      return active === 0 ? Promise.resolve() : new Promise<void>((resolve) => { idle = resolve; });
    },
    sessions,
    get draining() { return draining; },
  };
}

/**
 * `ais browser mcp-serve`: the one shared MCP server for every agent session on this machine (loopback only).
 * SIGTERM stops accepting, lets in-flight calls finish and exits. It never sends session end for live sessions: a restart is invisible to clients.
 */
export async function runMcpServe(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = (l) => console.error(l)): Promise<void> {
  const port = mcpPort(env);
  const key = ensureMcpKey(env.AIS_BROWSER_MCP_KEY_DIR || mcpKeyDir());
  const daemon = createMcpDaemon({ key, log });
  const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 255, fetch: (req) => daemon.handle(req) });
  daemon.startReaper();
  log(`browser mcp: listening on 127.0.0.1:${server.port}`);
  const stop = (): void => {
    void (async () => {
      const drained = daemon.drain();
      await server.stop();
      await drained;
      process.exit(0);
    })();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await new Promise<void>(() => {});
}
