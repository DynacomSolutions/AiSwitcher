import type { BrowserTool, CallRequest, CallResult, ExtToGateway, GatewayToExt } from "../../browser/protocol.ts";
import type { BrowserBinding } from "../../browser/types.ts";
import { noopMetrics, type GatewayMetrics } from "../metrics.ts";

/** The part of a server WebSocket the hub needs (Bun's ServerWebSocket satisfies it). */
export interface HubSocket {
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
}

export const HELLO_TIMEOUT_MS = 10_000;
export const SILENCE_TIMEOUT_MS = 60_000;
const SESSION_TTL_MS = 10 * 60_000;

interface Conn {
  ws: HubSocket;
  binding?: BrowserBinding;
  paused: boolean;
  helloTimer?: ReturnType<typeof setTimeout>;
  silenceTimer?: ReturnType<typeof setTimeout>;
}

interface Pending {
  ws: HubSocket;
  tool: BrowserTool;
  started: number;
  timer: ReturnType<typeof setTimeout>;
  resolve(r: CallResult): void;
}

export interface HubOptions {
  /** Maps a browser token to its active binding. */
  authToken(token: string): Promise<BrowserBinding | undefined>;
  metrics?: GatewayMetrics;
  helloTimeoutMs?: number;
  silenceTimeoutMs?: number;
  now?: () => number;
}

/**
 * Relay state: one authenticated socket per binding, in memory (single replica).
 * Call arguments and results only pass through; nothing about their content is stored or logged.
 */
export class BrowserHub {
  private readonly conns = new Map<HubSocket, Conn>();
  private readonly byBinding = new Map<string, Conn>();
  private readonly pending = new Map<string, Pending>();
  private readonly sessions = new Map<string, number>();
  private readonly metrics: GatewayMetrics;
  private readonly now: () => number;

  constructor(private readonly opts: HubOptions) {
    this.metrics = opts.metrics ?? noopMetrics;
    this.now = opts.now ?? Date.now;
  }

  /** Socket opened: it must send `hello` before the timeout. */
  open(ws: HubSocket): void {
    const conn: Conn = { ws, paused: false };
    conn.helloTimer = setTimeout(() => this.drop(conn, 4408, "hello timeout"), this.opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    this.conns.set(ws, conn);
  }

  /** Raw text frame from a socket. Anything but a valid `hello` first closes the socket. */
  async message(ws: HubSocket, raw: string): Promise<void> {
    const conn = this.conns.get(ws);
    if (!conn) return;
    let msg: ExtToGateway;
    try {
      const v: unknown = JSON.parse(raw);
      if (typeof v !== "object" || v === null || typeof (v as { t?: unknown }).t !== "string") throw new Error("shape");
      msg = v as ExtToGateway;
    } catch {
      this.drop(conn, 4400, "bad message");
      return;
    }
    if (!conn.binding) {
      if (msg.t !== "hello" || typeof msg.token !== "string") {
        this.drop(conn, 4401, "hello required");
        return;
      }
      if (conn.helloTimer) clearTimeout(conn.helloTimer);
      conn.helloTimer = undefined;
      let binding: BrowserBinding | undefined;
      try {
        binding = await this.opts.authToken(msg.token);
      } catch {
        this.drop(conn, 1011, "auth error");
        return;
      }
      if (!binding) {
        this.drop(conn, 4401, "unauthorised");
        return;
      }
      if (!this.conns.has(ws)) return; // closed while authenticating
      this.attach(ws, binding);
      this.send(ws, { t: "welcome", binding: binding.name, target: binding.target });
      return;
    }
    this.touch(conn);
    switch (msg.t) {
      case "ping":
        this.send(ws, { t: "pong" });
        return;
      case "state":
        conn.paused = msg.paused === true;
        return;
      case "result": {
        const id = msg.result?.id;
        const p = typeof id === "string" ? this.pending.get(id) : undefined;
        if (p && p.ws === ws) this.settle(id as string, msg.result);
        return;
      }
      default:
        return;
    }
  }

  /** Binds an authenticated socket. A previous socket of the same binding is closed with 4409. */
  attach(ws: HubSocket, binding: BrowserBinding): void {
    let conn = this.conns.get(ws);
    if (!conn) {
      conn = { ws, paused: false };
      this.conns.set(ws, conn);
    }
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = undefined;
    const old = this.byBinding.get(binding.name);
    if (old && old !== conn) this.drop(old, 4409, "replaced by a newer connection");
    conn.binding = binding;
    this.byBinding.set(binding.name, conn);
    this.touch(conn);
  }

  detach(ws: HubSocket): void {
    const conn = this.conns.get(ws);
    if (!conn) return;
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    if (conn.silenceTimer) clearTimeout(conn.silenceTimer);
    this.conns.delete(ws);
    if (conn.binding && this.byBinding.get(conn.binding.name) === conn) this.byBinding.delete(conn.binding.name);
    for (const [id, p] of [...this.pending]) {
      if (p.ws === ws) this.settle(id, { id, ok: false, error: "browser_disconnected", message: "The browser disconnected during the call." });
    }
  }

  connected(): BrowserBinding[] {
    return [...this.byBinding.values()].map((c) => c.binding as BrowserBinding);
  }

  /** Distinct agent sessions that called within the last ten minutes. */
  activeSessions(): number {
    const cutoff = this.now() - SESSION_TTL_MS;
    for (const [id, at] of this.sessions) if (at < cutoff) this.sessions.delete(id);
    return this.sessions.size;
  }

  call(binding: string, req: CallRequest, timeoutMs: number): Promise<CallResult> {
    const started = this.now();
    this.sessions.set(req.session.id, started);
    const finish = (r: CallResult): CallResult => {
      this.metrics.browserCall(req.tool, r.ok ? "ok" : r.error, (this.now() - started) / 1000);
      return r;
    };
    const conn = this.byBinding.get(binding);
    if (!conn) return Promise.resolve(finish({ id: req.id, ok: false, error: "no_browser", message: "That browser is not connected." }));
    if (conn.paused) return Promise.resolve(finish({ id: req.id, ok: false, error: "paused_by_user", message: "The user paused browser control." }));
    return new Promise<CallResult>((resolve) => {
      const timer = setTimeout(() => {
        this.send(conn.ws, { t: "abort", id: req.id });
        this.settle(req.id, { id: req.id, ok: false, error: "timeout", message: `No result within ${Math.round(timeoutMs / 1000)} s.` });
      }, timeoutMs);
      this.pending.set(req.id, { ws: conn.ws, tool: req.tool, started, timer, resolve: (r) => resolve(finish(r)) });
      try {
        conn.ws.send(JSON.stringify({ t: "call", req } satisfies GatewayToExt));
      } catch {
        this.settle(req.id, { id: req.id, ok: false, error: "browser_disconnected", message: "The browser connection failed." });
      }
    });
  }

  closeAll(code: number): void {
    for (const conn of [...this.conns.values()]) this.drop(conn, code, "service restart");
  }

  private settle(id: string, r: CallResult): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(r);
  }

  private touch(conn: Conn): void {
    if (conn.silenceTimer) clearTimeout(conn.silenceTimer);
    conn.silenceTimer = setTimeout(() => this.drop(conn, 4408, "silent"), this.opts.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS);
  }

  private send(ws: HubSocket, m: GatewayToExt): void {
    try {
      ws.send(JSON.stringify(m));
    } catch {
      // the close handler cleans up
    }
  }

  private drop(conn: Conn, code: number, reason: string): void {
    this.detach(conn.ws);
    try {
      conn.ws.close(code, reason);
    } catch {
      // already closed
    }
  }
}
