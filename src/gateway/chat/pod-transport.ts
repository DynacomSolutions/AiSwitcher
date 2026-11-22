// Pod transport: create an AgentSession, wait for Running, attach to its stdio and send heartbeats.
// Pod output and controller messages are untrusted. Raw controller text never leaves this file.
import { randomUUID } from "node:crypto";
import { redactText } from "../upstream-error.ts";
import { createLineReader } from "./acp.ts";
import { KubeHttpError } from "./kube-http.ts";
import { buildChatSession, sessionName } from "./kube.ts";
import type { AgentRuntimeConfig, KubeApi, KubeConfigEnv, KubeSession, KubeSocket, PodHandle, PodPhaseNotice, PodSpecInput, PodStream, PodTransport } from "./kube.ts";

export const PRE_ATTACH_BEAT_MS = 15_000;
export const ATTACHED_BEAT_MS = 30_000;
export const BEAT_RETRY_MS = 10_000;
const WATCH_RETRY_MS = 2_000;
export const STDERR_LINE_MAX = 4096;
export const STDERR_BUFFER_MAX = 64 * 1024;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realTimers: Timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/** Fixed copy by `status.reason`. */
const NOTICE_TEXT: Record<string, string> = {
  NodeBudget: "The cluster is busy. Your chat starts when memory is free.",
  GPUBusy: "The cluster is busy. Your chat starts when a device is free.",
  WorktreeBusy: "The workspace is busy. Your chat starts when it is free.",
};
const GENERIC_NOTICE = "The agent is starting.";

/** Fixed copy by reason for a start that failed. */
const FAILURE_TEXT: Record<string, string> = {
  StartTimeout: "The agent did not start in time.",
  ResourcesTooLarge: "The agent needs more resources than the cluster can give.",
  InitFailed: "The agent could not start.",
  ClientGone: "The agent ended because the gateway stopped sending heartbeats.",
};
const GENERIC_FAILURE = "The agent could not start.";

/** A reason is a short code. Anything else is replaced, so odd text cannot pass through. */
const reasonCode = (r: string | undefined): string => (r && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(r) ? r : "Unknown");

export class CatalogError extends Error {
  constructor() {
    super("The agent runtime config is not valid JSON.");
    this.name = "CatalogError";
  }
}

const capBytes = (s: string, max: number): string => {
  const b = new TextEncoder().encode(s);
  if (b.length <= max) return s;
  let i = max;
  while (i > 0 && (b[i]! & 0xc0) === 0x80) i--;
  return new TextDecoder().decode(b.subarray(0, i));
};

export class PodStartError extends Error {
  readonly code = "pod_start";
  constructor(readonly reason: string) {
    super(FAILURE_TEXT[reason] ?? GENERIC_FAILURE);
    this.name = "PodStartError";
  }
}

const TERMINAL = new Set(["Failed", "Succeeded"]);

class SocketPodStream implements PodStream {
  private lineCbs: Array<(l: string) => void> = [];
  private queued: string[] = [];
  private stderrCbs: Array<(c: string) => void> = [];
  private closeCbs: Array<(r: string) => void> = [];
  private closedReason: string | undefined;
  private readonly lines;
  private readonly errDecoder = new TextDecoder();
  private errPending = "";

  constructor(private readonly socket: KubeSocket, maxLineBytes?: number) {
    this.lines = createLineReader({
      maxBytes: maxLineBytes,
      onLine: (line) => this.deliverLine(line),
      onOverflow: () => this.finish("line too long"),
    });
    socket.onMessage((d) => this.onFrame(d));
    socket.onClose((reason) => this.finish(reason));
  }

  private deliverLine(line: string): void {
    if (this.lineCbs.length === 0) this.queued.push(line);
    else for (const cb of this.lineCbs) cb(line);
  }

  private onFrame(d: Uint8Array): void {
    if (this.closedReason !== undefined || d.length === 0) return;
    const payload = d.subarray(1);
    switch (d[0]) {
      case 1:
        this.lines.push(payload);
        break;
      case 2:
        this.onStderrBytes(payload);
        break;
      case 3: {
        // The status channel ends the stream. The status text is not forwarded.
        let ok = false;
        try {
          ok = (JSON.parse(new TextDecoder().decode(payload)) as { status?: string }).status === "Success";
        } catch {
          // Not JSON: an error.
        }
        this.finish(ok ? "pod exited" : "pod stream error");
        break;
      }
    }
  }

  private emitStderr(text: string): void {
    const safe = capBytes(redactText(text, STDERR_LINE_MAX), STDERR_LINE_MAX);
    if (safe === "") return;
    for (const cb of this.stderrCbs) cb(safe);
  }

  private onStderrBytes(b: Uint8Array): void {
    this.errPending += this.errDecoder.decode(b, { stream: true });
    for (let nl = this.errPending.indexOf("\n"); nl !== -1; nl = this.errPending.indexOf("\n")) {
      this.emitStderr(this.errPending.slice(0, nl));
      this.errPending = this.errPending.slice(nl + 1);
    }
    // A line with no end is cut at the buffer limit, so memory stays bounded.
    while (this.errPending.length > STDERR_BUFFER_MAX) {
      this.emitStderr(this.errPending.slice(0, STDERR_BUFFER_MAX));
      this.errPending = this.errPending.slice(STDERR_BUFFER_MAX);
    }
  }

  private finish(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    if (this.errPending !== "") this.emitStderr(this.errPending);
    this.errPending = "";
    this.socket.close();
    for (const cb of this.closeCbs) cb(reason);
  }

  write(line: string): void {
    if (this.closedReason !== undefined) return;
    const text = line.endsWith("\n") ? line : `${line}\n`;
    const bytes = new TextEncoder().encode(text);
    const frame = new Uint8Array(bytes.length + 1);
    frame[0] = 0;
    frame.set(bytes, 1);
    this.socket.send(frame);
  }

  onLine(cb: (line: string) => void): void {
    this.lineCbs.push(cb);
    const q = this.queued;
    this.queued = [];
    for (const l of q) cb(l);
  }

  onStderr(cb: (chunk: string) => void): void {
    this.stderrCbs.push(cb);
  }

  onClose(cb: (reason: string) => void): void {
    if (this.closedReason !== undefined) cb(this.closedReason);
    else this.closeCbs.push(cb);
  }

  close(): void {
    this.finish("closed locally");
  }
}

export interface KubePodTransportDeps {
  api: KubeApi;
  env: KubeConfigEnv;
  /** Epoch milliseconds. */
  now?: () => number;
  timers?: Timers;
  /** Test hook: line cap of the attach stdout reader. */
  maxLineBytes?: number;
}

interface Live { name: string; cancelled: boolean; ac: AbortController; stream?: PodStream; stop(): void }

export class KubePodTransport implements PodTransport {
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly live = new Map<string, Set<Live>>();

  constructor(private readonly d: KubePodTransportDeps) {
    this.now = d.now ?? Date.now;
    this.timers = d.timers ?? realTimers;
  }

  private track(chatId: string, l: Live): () => void {
    let set = this.live.get(chatId);
    if (!set) this.live.set(chatId, (set = new Set()));
    set.add(l);
    return () => {
      set!.delete(l);
      if (set!.size === 0) this.live.delete(chatId);
    };
  }

  async catalog(): Promise<AgentRuntimeConfig> {
    const data = await this.d.api.getConfigMap(this.d.env.configMap);
    const raw = data["config.json"];
    if (!raw) return {};
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      throw new CatalogError();
    }
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new CatalogError();
    return v as AgentRuntimeConfig;
  }

  async stop(chatId: string): Promise<void> {
    for (const l of [...(this.live.get(chatId) ?? [])]) l.stop();
    const { group } = this.d.env;
    const sessions = await this.d.api.listSessions(`${group}/created-by=ais-gateway,${group}/chat-id=${chatId}`);
    await Promise.all(sessions.map((s) => this.d.api.deleteSession(s.metadata.name)));
  }

  async stopSession(session: string): Promise<void> {
    for (const set of [...this.live.values()]) for (const l of [...set]) if (l.name === session) l.stop();
    await this.d.api.deleteSession(session);
  }

  async start(input: PodSpecInput, signal: AbortSignal, onPhase: (n: PodPhaseNotice) => void): Promise<PodHandle> {
    const { api, env } = this.d;
    const name = sessionName(input.chatId, input.generation);
    const g = env.group;
    const notes = (attached: boolean): Record<string, string> => {
      const s = String(Math.floor(this.now() / 1000));
      return attached ? { [`${g}/client-seen`]: s, [`${g}/attached`]: s } : { [`${g}/client-seen`]: s };
    };
    const beat = this.heartbeat(name, notes);
    const startId = randomUUID();
    const live: Live = { name, cancelled: false, ac: new AbortController(), stream: undefined, stop: () => { live.cancelled = true; live.ac.abort(); beat.stop(); live.stream?.close(); } };
    const waitSignal = AbortSignal.any([signal, live.ac.signal]);
    const untrack = this.track(input.chatId, live);
    let streamed = false;
    let created = false;
    let createSent = false;
    let conflict = false;
    const check = () => {
      if (live.cancelled) throw new Error("cancelled");
    };
    try {
      if (signal.aborted) throw new Error("aborted");
      createSent = true;
      try {
        await api.createSession(buildChatSession(input, env, Math.floor(this.now() / 1000), startId), signal);
      } catch (e) {
        if (e instanceof KubeHttpError && e.status === 409) conflict = true;
        throw e;
      }
      created = true;
      check();
      beat.begin();
      const ready = await this.waitRunning(name, waitSignal, onPhase);
      check();
      const socket = await api.openAttach(ready.pod, waitSignal);
      if (live.cancelled) {
        socket.close();
        check();
      }
      const stream = new SocketPodStream(socket, this.d.maxLineBytes);
      streamed = true;
      live.stream = stream;
      stream.onClose(() => {
        beat.stop();
        untrack();
      });
      beat.markAttached();
      return { name: ready.pod, session: name, cwd: ready.cwd, stream };
    } catch (e) {
      if (!streamed) {
        beat.stop();
        untrack();
        // Delete only a session that this call made. A failed delete must not hide the first error.
        await this.cleanup(name, startId, created, createSent && !conflict).catch(() => undefined);
      }
      throw live.cancelled ? new Error("cancelled") : e;
    }
  }

  private async cleanup(name: string, startId: string, created: boolean, unknown: boolean): Promise<void> {
    const { api } = this.d;
    const { group } = this.d.env;
    if (created) return api.deleteSession(name);
    if (!unknown) return;
    // The create may have worked although the call failed. Delete only a session that holds our start nonce.
    const s = await api.getSession(name);
    if (s?.metadata.annotations?.[`${group}/start-id`] === startId) await api.deleteSession(name);
  }

  /** client-seen every 15 s before the attach, then client-seen and attached every 30 s. A failed beat repeats after 10 s. */
  private heartbeat(name: string, notes: (attached: boolean) => Record<string, string>) {
    const { api } = this.d;
    const timers = this.timers;
    let attached = false;
    let stopped = false;
    let started = false;
    let busy = false;
    let again = false;
    let handle: unknown;
    const arm = (ms: number) => {
      if (stopped) return;
      handle = timers.setTimeout(() => void run(), ms);
    };
    const run = async (): Promise<void> => {
      if (stopped) return;
      busy = true;
      let ok = true;
      try {
        await api.annotate(name, notes(attached));
      } catch {
        ok = false;
      }
      busy = false;
      if (stopped) return;
      if (again) {
        again = false;
        return void run();
      }
      arm(ok ? (attached ? ATTACHED_BEAT_MS : PRE_ATTACH_BEAT_MS) : BEAT_RETRY_MS);
    };
    return {
      begin() {
        if (started || stopped) return;
        started = true;
        arm(PRE_ATTACH_BEAT_MS);
      },
      markAttached() {
        if (stopped) return;
        attached = true;
        if (busy) again = true;
        else {
          timers.clearTimeout(handle);
          void run();
        }
      },
      stop() {
        stopped = true;
        timers.clearTimeout(handle);
      },
    };
  }

  private waitRunning(name: string, signal: AbortSignal, onPhase: (n: PodPhaseNotice) => void): Promise<{ pod: string; cwd: string }> {
    const { api } = this.d;
    const timers = this.timers;
    return new Promise((resolve, reject) => {
      let done = false;
      let watch: { close(): void } | undefined;
      let retry: unknown;
      let lastReason: string | undefined;
      const cleanup = () => {
        done = true;
        watch?.close();
        timers.clearTimeout(retry);
        signal.removeEventListener("abort", onAbort);
      };
      const finish = (fn: () => void) => {
        if (done) return;
        cleanup();
        fn();
      };
      const onAbort = () => finish(() => reject(new Error("aborted")));
      signal.addEventListener("abort", onAbort, { once: true });
      const handle = (s: KubeSession | undefined) => {
        if (done) return;
        if (!s) return finish(() => reject(new PodStartError("Deleted")));
        const phase = s.status?.phase ?? "";
        const reason = reasonCode(s.status?.reason || undefined);
        if (TERMINAL.has(phase)) return finish(() => reject(new PodStartError(s.status?.reason ? reason : phase === "Succeeded" ? "Ended" : "Unknown")));
        if (phase === "Running") {
          return finish(() => resolve({ pod: s.status?.pod || `agent-${name}`, cwd: s.status?.worktreePath ?? "" }));
        }
        if (!s.status?.reason) lastReason = undefined;
        else if (s.status.reason !== lastReason) {
          lastReason = s.status.reason;
          onPhase({ reason, text: NOTICE_TEXT[reason] ?? GENERIC_NOTICE });
        }
      };
      const connect = () => {
        if (done) return;
        api.getSession(name, signal).then(
          (s) => {
            if (done) return;
            if (!s) return finish(() => reject(new PodStartError("Deleted")));
            handle(s);
            if (done) return;
            watch = api.watchSession(name, handle, () => {
              if (done) return;
              retry = timers.setTimeout(connect, WATCH_RETRY_MS);
            });
          },
          (e: unknown) => {
            if (done) return;
            if (e instanceof KubeHttpError && (e.status === 401 || e.status === 403)) return finish(() => reject(new PodStartError(e.status === 401 ? "Unauthorised" : "Forbidden")));
            retry = timers.setTimeout(connect, WATCH_RETRY_MS);
          },
        );
      };
      connect();
    });
  }
}
