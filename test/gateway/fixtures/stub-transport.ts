// A PodTransport for broker tests. It runs the stub ACP agent as a local process, with no cluster.
import { join } from "node:path";
import { createLineReader } from "../../../src/gateway/chat/acp.ts";
import { sessionName } from "../../../src/gateway/chat/kube.ts";
import type { PodHandle, PodPhaseNotice, PodSpecInput, PodStream, PodTransport, AgentRuntimeConfig } from "../../../src/gateway/chat/kube.ts";

const STUB = join(import.meta.dir, "stub-acp-agent.ts");

export interface StubTransportOptions {
  /** start() rejects with this error. */
  failStart?: Error;
  /** start() waits until its signal aborts. */
  hang?: boolean;
  /** The agent prints to stderr and exits at once. */
  exitAtOnce?: boolean;
  /** The agent reads input and never answers. */
  silent?: boolean;
  /** Extra environment for the stub agent. */
  env?: Record<string, string>;
  /** Phase notices to send before the stream opens. */
  phases?: PodPhaseNotice[];
  /** Runs inside start(), before the agent process begins. Tests use it to move clocks or to hold a start. */
  beforeSpawn?: () => Promise<void>;
  /** The names of the live sessions. Share one set between transports to model one cluster. */
  cluster?: Set<string>;
  /** stopSession rejects. */
  failStopSession?: boolean;
  /** stopSession never finishes. */
  hangStopSession?: boolean;
  /** stopSession waits this long before it deletes the session. */
  stopSessionDelayMs?: number;
}

export class StubPodTransport implements PodTransport {
  readonly starts: PodSpecInput[] = [];
  readonly signals: AbortSignal[] = [];
  /** Every line the broker wrote to the agent. */
  readonly written: string[] = [];
  readonly stopped: string[] = [];
  readonly closedStreams: string[] = [];
  readonly stoppedSessions: string[] = [];
  readonly cluster: Set<string>;
  private readonly procs = new Set<{ kill(): void }>();

  constructor(readonly opts: StubTransportOptions = {}) {
    this.cluster = opts.cluster ?? new Set();
  }

  async start(input: PodSpecInput, signal: AbortSignal, onPhase: (n: PodPhaseNotice) => void): Promise<PodHandle> {
    this.starts.push(input);
    this.signals.push(signal);
    if (this.opts.failStart) throw this.opts.failStart;
    for (const p of this.opts.phases ?? []) onPhase(p);
    if (this.opts.hang) {
      await new Promise<void>((_, reject) => {
        if (signal.aborted) return reject(new Error("aborted"));
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    await this.opts.beforeSpawn?.();
    this.cluster.add(sessionName(input.chatId, input.generation));
    const cmd = this.opts.exitAtOnce
      ? [process.execPath, "-e", "process.stderr.write('boom-from-pod leak-marker-xyz\\n'); process.exit(3)"]
      : this.opts.silent
        ? [process.execPath, "-e", "process.stdin.resume(); setInterval(() => {}, 1000)"]
        : [process.execPath, STUB];
    const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...this.opts.env } });
    this.procs.add(proc);
    const lineCbs: Array<(l: string) => void> = [];
    const stderrCbs: Array<(c: string) => void> = [];
    const closeCbs: Array<(r: string) => void> = [];
    const queued: string[] = [];
    let closed: string | undefined;
    const finish = (reason: string) => {
      if (closed !== undefined) return;
      closed = reason;
      for (const cb of closeCbs) cb(reason);
    };
    const reader = createLineReader({
      onLine: (line) => (lineCbs.length === 0 ? queued.push(line) : lineCbs.forEach((cb) => cb(line))),
      onOverflow: () => finish("line too long"),
    });
    const out = (async () => {
      for await (const c of proc.stdout) reader.push(c);
    })();
    const err = (async () => {
      const dec = new TextDecoder();
      for await (const c of proc.stderr) for (const cb of stderrCbs) cb(dec.decode(c));
    })();
    void Promise.all([proc.exited, out, err]).then(() => finish("pod exited"));
    const stream: PodStream = {
      write: (line) => {
        this.written.push(line);
        if (closed !== undefined) return;
        proc.stdin.write(`${line}\n`);
        proc.stdin.flush();
      },
      onLine: (cb) => {
        lineCbs.push(cb);
        for (const l of queued.splice(0)) cb(l);
      },
      onStderr: (cb) => void stderrCbs.push(cb),
      onClose: (cb) => (closed !== undefined ? cb(closed) : void closeCbs.push(cb)),
      close: () => {
        this.closedStreams.push(input.chatId);
        proc.kill();
        finish("closed locally");
      },
    };
    return { name: `pod-${input.chatId.slice(0, 8)}`, session: sessionName(input.chatId, input.generation), cwd: "/work", stream };
  }

  async stop(chatId: string): Promise<void> {
    this.stopped.push(chatId);
    const prefix = sessionName(chatId, 0).slice(0, -1);
    for (const n of [...this.cluster]) if (n.startsWith(prefix)) this.cluster.delete(n);
  }

  async stopSession(session: string): Promise<void> {
    this.stoppedSessions.push(session);
    if (this.opts.stopSessionDelayMs) await new Promise((r) => setTimeout(r, this.opts.stopSessionDelayMs));
    if (this.opts.hangStopSession) await new Promise<void>(() => undefined);
    if (this.opts.failStopSession) throw new Error("stop failed");
    this.cluster.delete(session);
  }

  async catalog(): Promise<AgentRuntimeConfig> {
    return {};
  }

  /** Kill every agent process. Call it after each test. */
  killAll(): void {
    for (const p of this.procs) p.kill();
    this.procs.clear();
  }
}
