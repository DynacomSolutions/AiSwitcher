import { BROWSER_ERROR_CODES, MAX_ERROR_MESSAGE, SESSION_END_TOOL, type BrowserErrorCode, type BrowserTool, type CallRequest, type CallResult, type ExtToGateway, type GatewayToExt } from "../../browser/protocol.ts";
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

/** A well-formed result from untrusted input, or undefined. Unknown error codes become "internal"; messages are capped. */
export function sanitiseResult(v: unknown): CallResult | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.ok !== "boolean") return undefined;
  if (r.ok) {
    if (!Array.isArray(r.content)) return undefined;
    const content: Extract<CallResult, { ok: true }>["content"] = [];
    for (const c of r.content as unknown[]) {
      if (typeof c !== "object" || c === null) return undefined;
      const x = c as Record<string, unknown>;
      if (x.type === "text" && typeof x.text === "string") content.push({ type: "text", text: x.text });
      else if (x.type === "image" && (x.mimeType === "image/jpeg" || x.mimeType === "image/png") && typeof x.data === "string") content.push({ type: "image", mimeType: x.mimeType, data: x.data });
      else return undefined;
    }
    return { id: r.id, ok: true, content };
  }
  const error: BrowserErrorCode = (BROWSER_ERROR_CODES as readonly unknown[]).includes(r.error) ? (r.error as BrowserErrorCode) : "internal";
  const message = typeof r.message === "string" ? r.message.slice(0, MAX_ERROR_MESSAGE) : "";
  return { id: r.id, ok: false, error, message };
}

interface Conn {
  ws: HubSocket;
  binding?: BrowserBinding;
  paused: boolean;
  extensionVersion?: string;
  authenticating?: boolean;
  attachedAt?: number;
  helloTimer?: ReturnType<typeof setTimeout>;
  silenceTimer?: ReturnType<typeof setTimeout>;
}

interface Pending {
  ws: HubSocket;
  tool: BrowserTool | typeof SESSION_END_TOOL;
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
  /** Called after a binding attaches or detaches, or its paused state changes (cluster presence hook). */
  onChange?: () => void;
}

/** A locally connected binding as shown to the cluster presence table. */
export interface LocalPresence {
  binding: BrowserBinding;
  extensionVersion?: string;
  paused: boolean;
  /** Epoch ms of the attach (hello accepted). */
  attachedAt: number;
}

/**
 * Relay state: one authenticated socket per binding, in memory. With several replicas, ClusterBrowserHub (cluster.ts) shares presence and relays calls.
 * Call arguments and results only pass through; nothing about their content is stored or logged.
 */
export class BrowserHub {
  private readonly conns = new Map<HubSocket, Conn>();
  private readonly byBinding = new Map<string, Conn>();
  private readonly pending = new Map<string, Pending>();
  private readonly sessions = new Map<string, number>();
  private readonly metrics: GatewayMetrics;
  private readonly now: () => number;
  /** Settable after construction so a cluster wrapper can hook in. Never allowed to throw into the hub. */
  onChange?: () => void;

  constructor(private readonly opts: HubOptions) {
    this.metrics = opts.metrics ?? noopMetrics;
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange;
  }

  private changed(): void {
    try {
      this.onChange?.();
    } catch {
      // presence is best effort
    }
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
      // While the token is being checked nothing else is processed; the hello timer keeps running.
      if (conn.authenticating) return;
      if (msg.t !== "hello" || typeof msg.token !== "string") {
        this.drop(conn, 4401, "hello required");
        return;
      }
      conn.authenticating = true;
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
      conn.paused = msg.paused === true;
      const v = (msg as { version?: unknown }).version;
      if (typeof v === "string" && /^[0-9A-Za-z.+_-]{1,40}$/.test(v)) conn.extensionVersion = v;
      conn.authenticating = false;
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
        this.changed();
        return;
      case "result": {
        const result = sanitiseResult(msg.result);
        if (!result) return;
        const p = this.pending.get(result.id);
        if (p && p.ws === ws) this.settle(result.id, result);
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
    conn.attachedAt = this.now();
    this.touch(conn);
    this.changed();
  }

  detach(ws: HubSocket): void {
    const conn = this.conns.get(ws);
    if (!conn) return;
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    if (conn.silenceTimer) clearTimeout(conn.silenceTimer);
    this.conns.delete(ws);
    const wasBound = conn.binding && this.byBinding.get(conn.binding.name) === conn;
    if (wasBound) this.byBinding.delete((conn.binding as BrowserBinding).name);
    for (const [id, p] of [...this.pending]) {
      if (p.ws === ws) this.settle(id, { id, ok: false, error: "browser_disconnected", message: "The browser disconnected during the call." });
    }
    if (wasBound) this.changed();
  }

  /** Extension version reported in `hello` by the live connection of `binding`, if any. */
  extensionVersion(binding: string): string | undefined {
    return this.byBinding.get(binding)?.extensionVersion;
  }

  /** Live local connections with the data the cluster publishes. */
  localPresence(): LocalPresence[] {
    return [...this.byBinding.values()].map((c) => ({
      binding: c.binding as BrowserBinding,
      paused: c.paused,
      attachedAt: c.attachedAt ?? this.now(),
      ...(c.extensionVersion ? { extensionVersion: c.extensionVersion } : {}),
    }));
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

  /** Gives up on a call the agent no longer waits for: tells the extension and settles it. */
  abort(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.send(p.ws, { t: "abort", id });
    // Labelled "timeout" (the caller gave up waiting) so it does not inflate the "internal" outcome metric.
    this.settle(id, { id, ok: false, error: "timeout", message: "The caller went away." });
  }

  call(binding: string, req: CallRequest, timeoutMs: number): Promise<CallResult> {
    const started = this.now();
    this.activeSessions();
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
        // Bun's ServerWebSocket.send returns 0 when the message was dropped and -1 under backpressure.
        const sent = conn.ws.send(JSON.stringify({ t: "call", req } satisfies GatewayToExt));
        if (sent === 0 || sent === -1) this.settle(req.id, { id: req.id, ok: false, error: "browser_disconnected", message: "The browser connection failed." });
      } catch {
        this.settle(req.id, { id: req.id, ok: false, error: "browser_disconnected", message: "The browser connection failed." });
      }
    });
  }

  /** Closes the live socket of a revoked binding (code 4401). */
  revoke(binding: string): void {
    this.closeBinding(binding, 4401, "binding revoked");
  }

  /** Closes the live local socket of `binding` with `code`, if there is one. */
  closeBinding(binding: string, code: number, reason: string): void {
    const conn = this.byBinding.get(binding);
    if (conn) this.drop(conn, code, reason);
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
