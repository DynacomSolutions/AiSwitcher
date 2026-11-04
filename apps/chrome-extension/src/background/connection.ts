import type { CallRequest, CallResult, ExtToGateway, GatewayToExt } from "../../../../src/browser/protocol.ts";
import { connectUrl, validateGatewayUrl } from "./pairing.ts";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "signed_out" | "replaced";

export interface SocketLike {
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: (() => void) | null;
}

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ConnectionDeps {
  createSocket(url: string): SocketLike;
  version: string;
  isPaused(): boolean;
  onCall(req: CallRequest): Promise<CallResult>;
  onAbort(id: string): void;
  onStatus(status: ConnectionStatus): void;
  /** Close 4401: token revoked or bad. Caller clears the stored token. */
  onSignedOut(): void;
  scheduler?: Scheduler;
}

export const PING_INTERVAL_MS = 20_000;
export const BACKOFF_START_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;

const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: h => clearInterval(h as ReturnType<typeof setInterval>),
};

export class Connection {
  status: ConnectionStatus = "idle";
  private socket: SocketLike | null = null;
  private welcomed = false;
  private url = "";
  private token = "";
  private backoff = BACKOFF_START_MS;
  private retryTimer: unknown;
  private pingTimer: unknown;
  private generation = 0;
  private readonly sched: Scheduler;

  constructor(private readonly deps: ConnectionDeps) {
    this.sched = deps.scheduler ?? realScheduler;
  }

  get ready(): boolean { return this.welcomed; }

  /** Throws if the URL is not wss:// (or ws:// on localhost). */
  start(url: string, token: string): void {
    const normalised = validateGatewayUrl(url);
    const same = normalised === this.url && token === this.token;
    this.url = normalised;
    this.token = token;
    this.teardown();
    if (!same) this.backoff = BACKOFF_START_MS; // a keepalive restart must not reset backoff
    this.open();
  }

  stop(): void {
    this.teardown();
    if (this.status !== "signed_out") this.setStatus("idle");
  }

  /** True when the keepalive alarm may call start(): nothing is connecting, waiting or connected. */
  needsRestart(): boolean {
    if (this.status === "idle") return true;
    return this.status === "reconnecting" && this.socket === null && this.retryTimer === undefined;
  }

  sendState(paused: boolean): void {
    if (this.welcomed) this.send({ t: "state", paused });
  }

  private setStatus(s: ConnectionStatus): void {
    this.status = s;
    this.deps.onStatus(s);
  }

  private teardown(): void {
    this.generation++;
    this.welcomed = false;
    if (this.retryTimer !== undefined) this.sched.clearTimeout(this.retryTimer);
    if (this.pingTimer !== undefined) this.sched.clearInterval(this.pingTimer);
    this.retryTimer = undefined;
    this.pingTimer = undefined;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try { s.close(1000); } catch { /* already closed */ }
    }
  }

  private open(retry = false): void {
    this.setStatus(retry ? "reconnecting" : "connecting");
    const gen = ++this.generation;
    const socket = this.deps.createSocket(connectUrl(this.url));
    this.socket = socket;
    socket.onopen = () => {
      if (gen !== this.generation) return;
      this.send({ t: "hello", token: this.token, version: this.deps.version, paused: this.deps.isPaused() });
    };
    socket.onmessage = ev => {
      if (gen === this.generation) this.handle(ev.data);
    };
    socket.onerror = () => { /* close follows */ };
    socket.onclose = ev => {
      if (gen !== this.generation) return;
      this.onClosed(ev.code);
    };
  }

  private onClosed(code: number): void {
    this.welcomed = false;
    this.socket = null;
    if (this.pingTimer !== undefined) this.sched.clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    if (code === 4401) {
      this.setStatus("signed_out");
      this.deps.onSignedOut();
      return;
    }
    if (code === 4409) {
      this.setStatus("replaced");
      return;
    }
    this.setStatus("reconnecting");
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.retryTimer = this.sched.setTimeout(() => { this.retryTimer = undefined; this.open(true); }, delay);
  }

  private send(msg: ExtToGateway): void {
    try { this.socket?.send(JSON.stringify(msg)); } catch { /* close handler reconnects */ }
  }

  private handle(raw: unknown): void {
    if (typeof raw !== "string") return;
    let msg: GatewayToExt;
    try { msg = JSON.parse(raw) as GatewayToExt; } catch { return; }
    switch (msg.t) {
      case "welcome":
        this.welcomed = true;
        this.backoff = BACKOFF_START_MS;
        this.pingTimer = this.sched.setInterval(() => this.send({ t: "ping" }), PING_INTERVAL_MS);
        this.setStatus("connected");
        if (this.deps.isPaused()) this.send({ t: "state", paused: true });
        return;
      case "call": {
        if (!this.welcomed) return; // commands are rejected until a token-authenticated hello succeeded
        const gen = this.generation;
        void this.deps.onCall(msg.req).then(result => {
          if (gen === this.generation) this.send({ t: "result", result });
        });
        return;
      }
      case "abort":
        if (this.welcomed) this.deps.onAbort(msg.id);
        return;
      case "pong":
        return;
    }
  }
}
