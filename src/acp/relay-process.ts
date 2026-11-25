/**
 * Runs an ACP agent behind the relay (relay.ts): this process takes the agent's place for the client, starts the real
 * agent and passes both directions line by line (ACP is newline-delimited JSON-RPC on stdin and stdout).
 *
 * - Client to agent: every byte is passed at once and unchanged. A complete line is shown to the relay just before its
 *   last bytes are passed, so the relay can note where the agent's records stand before the agent sees the prompt.
 * - Agent to client: one line at a time, in order. An unchanged line keeps its bytes. Each write is waited for, so
 *   nothing is still pending when this process ends (Bun drops pending stdout at `process.exit`).
 * - stderr is the agent's own: it goes on to this process's stderr unchanged, and a short tail is kept. Signals go to the
 *   agent's process group; this process ends with the agent's exit code.
 * - The agent runs in its own process group (`detached`), so a signal reaches what it started too (an MCP server, a shell
 *   script's child). If this process is killed without a chance to forward (SIGKILL), the agent sees its stdin close and
 *   ends by itself, and the scope the relay runs in (a systemd scope stop) still kills the whole group.
 * - When the agent ends (an exit code, a signal, or no end after a signal sent to this process) while a `session/prompt`
 *   is still open, each open request gets one JSON-RPC error that says why. Without it the client sees only a closed
 *   stream and shows its default text ("Provider turn failed."). A prompt the agent answered is never answered twice.
 *   The relay acts on the agent's `exit`, not on the close of all its streams: a process the agent started can keep
 *   stdout or stderr open for a long time. After `exit` it waits up to STDOUT_DRAIN_MS for the rest of stdout, never for
 *   stderr.
 */
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { redactText } from "../gateway/upstream-error.ts";
import { kimiAdapter, kimiHome } from "./kimi-turn.ts";
import { LimitSnoozer } from "./limit-snooze.ts";
import { AcpRelay, TURN_FAILED_CODE, type RelayAdapter } from "./relay.ts";

/** How often the in-turn limit watch reads the agent's log while a prompt is open. */
export const IN_TURN_WATCH_MS = 3000;

/** Splits a byte stream into lines, keeping each line's bytes. */
export class LineSplitter {
  private pending: Buffer[] = [];
  /** The complete lines in `chunk` (with what was left before it), without their newline. */
  push(chunk: Buffer): Buffer[] {
    const out: Buffer[] = [];
    let start = 0;
    for (let nl = chunk.indexOf(0x0a, start); nl !== -1; nl = chunk.indexOf(0x0a, start)) {
      const part = chunk.subarray(start, nl);
      out.push(this.pending.length > 0 ? Buffer.concat([...this.pending, part]) : part);
      this.pending = [];
      start = nl + 1;
    }
    if (start < chunk.length) this.pending.push(chunk.subarray(start));
    return out;
  }
  /** What is left after the last newline. */
  /** Whether part of a line is waiting for its newline. */
  midLine(): boolean {
    return this.pending.length > 0;
  }
  rest(): Buffer {
    const rest = Buffer.concat(this.pending);
    this.pending = [];
    return rest;
  }
}

/** The adapter for a registry agent id; agents without one get the protocol rules only. */
export function adapterFor(agentId: string, env: Record<string, string | undefined> = process.env): RelayAdapter | undefined {
  return agentId === "kimi-code" ? kimiAdapter(kimiHome(env)) : undefined;
}

/** The longest message the relay puts in an error it sends for an open prompt. */
export const END_MESSAGE_MAX = 4096;
/** How long the agent gets to end after a signal reached this process, before it is stopped and the prompts get their answer. */
export const SIGNAL_GRACE_MS = 3000;
/** How long the relay waits for the rest of the agent's stdout after the agent process ended. */
export const STDOUT_DRAIN_MS = 500;
/** How much of the agent's last stderr output is kept for the error message. */
const STDERR_KEEP = 4000;

export interface AgentEnd {
  agent: string;
  /** The exit code, when the agent ended by itself. */
  code: number | null;
  /** The signal that ended the agent, when it ended by one. */
  signal: NodeJS.Signals | null;
  /** The first signal this process received, when it did. */
  relaySignal?: NodeJS.Signals;
  /**
   * The agent did not finish in `graceMs` after that signal and was stopped by the relay. `agentEnded` says that its
   * process had ended but its output stayed open (so what it started kept it open).
   */
  timedOut?: { graceMs: number; agentEnded?: boolean };
  /** The agent could not start. */
  startError?: string;
  /** The last agent stderr text (raw; redacted here). */
  stderrTail?: string;
  /** The start of `stderrTail` was cut off, so its first line may be partial. */
  stderrCut?: boolean;
}

/** The text a client shows for a turn that ended because the agent process ended. Under END_MESSAGE_MAX characters. */
export function agentEndMessage(e: AgentEnd): string {
  if (e.startError !== undefined) return redactText(`The ACP agent ${e.agent} could not start: ${e.startError}`, END_MESSAGE_MAX);
  const parts = [`The ACP agent ${e.agent} stopped during the turn:`];
  if (e.timedOut) {
    const secs = Number((e.timedOut.graceMs / 1000).toFixed(1));
    const span = `${secs} ${secs === 1 ? "second" : "seconds"}`;
    const signal = e.relaySignal ?? "a signal";
    if (e.timedOut.agentEnded) parts.push(`its process ended, but its output stayed open for more than ${span} after the relay received ${signal}, so the relay stopped what was left.`);
    else parts.push(`it did not end within ${span} after the relay received ${signal}, so the relay stopped it.`);
  }
  else if (e.signal) parts.push(`it was ended by ${e.signal}.`);
  else parts.push(e.code === 0 ? "it exited with code 0 before it answered." : `it exited with code ${e.code ?? "unknown"}.`);
  if (e.relaySignal) parts.push(`The relay received ${e.relaySignal} first, so something outside the agent stopped its process group or systemd scope.`);
  else if (e.signal) parts.push("The relay received no signal, so only the agent process was stopped.");
  const tailLines = (e.stderrTail ?? "").split(/\r?\n/);
  if (e.stderrCut) tailLines.shift(); // cut at an arbitrary character: the first line is partial
  const tail = tailLines
    .map((l) => redactText(l, 300))
    .filter((l) => l !== "")
    .slice(-5)
    .join(" | ");
  if (tail !== "") parts.push(`Last agent output: ${tail}`);
  return redactText(parts.join(" "), END_MESSAGE_MAX);
}

export interface RelayProcessOptions {
  command: string;
  args: string[];
  adapter?: RelayAdapter;
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  /** Where relay notes go (the agent's stderr stream by default). */
  log?: (line: string) => void;
  /** Snooze and resume on a usage limit through the T3 MCP server of each session. On by default. */
  limit?: LimitSnoozer | false;
  /** See RelayOptions.answerIdlePermissions. */
  answerIdlePermissions?: boolean;
  /** The in-turn limit watch interval. Default IN_TURN_WATCH_MS. Only used when the adapter has inTurnLimit. */
  inTurnWatchMs?: number;
  /** The agent's name in error messages. Default: the executable's file name. */
  agentName?: string;
  /** Where the agent's stderr goes. Default process.stderr. */
  stderr?: NodeJS.WritableStream;
  /** See SIGNAL_GRACE_MS. */
  signalGraceMs?: number;
}

/** Starts the agent and relays until it exits. Resolves with the exit code this process should end with. */
export function runAcpRelay(opts: RelayProcessOptions): Promise<number> {
  const stdin: NodeJS.ReadableStream = opts.stdin ?? process.stdin;
  const stdout: NodeJS.WritableStream = opts.stdout ?? process.stdout;
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const stderr: NodeJS.WritableStream = opts.stderr ?? process.stderr;
  const agentName = opts.agentName ?? basename(opts.command);
  const graceMs = opts.signalGraceMs ?? SIGNAL_GRACE_MS;
  // Own process group (not on Windows): a signal then reaches what the agent started too.
  const child = spawn(opts.command, opts.args, { stdio: ["pipe", "pipe", "pipe"], env: opts.env ?? process.env, detached: process.platform !== "win32" });
  /** Signals the agent's process group, or the agent alone when that fails. */
  const signalAgent = (signal: NodeJS.Signals): void => {
    if (child.pid !== undefined && process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // the group is gone or not ours: signal the process itself
      }
    }
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  };
  // The agent's stderr goes on unchanged (the client logs it); a short tail is kept for the error message.
  let stderrTail = "";
  let stderrCut = false;
  stderr.on("error", () => {});
  child.stderr.on("data", (chunk: Buffer) => {
    const joined = stderrTail + chunk.toString("utf8");
    if (joined.length > STDERR_KEEP) stderrCut = true;
    stderrTail = joined.slice(-STDERR_KEEP);
    stderr.write(chunk);
  });
  child.stderr.on("error", () => {});
  // The relay's own lines to the agent go between the client's lines, never inside one.
  const fromClient = new LineSplitter();
  let held: string[] = [];
  const flushHeld = () => {
    if (held.length === 0 || fromClient.midLine() || !child.stdin.writable) return;
    child.stdin.write(held.map((l) => `${l}\n`).join(""));
    held = [];
  };
  const toAgent = (line: string) => {
    held.push(line);
    flushHeld();
  };
  const limit = opts.limit === false ? undefined : (opts.limit ?? new LimitSnoozer({ log }));
  const relay = new AcpRelay({ ...(opts.adapter ? { adapter: opts.adapter } : {}), log, toAgent, ...(limit ? { limit } : {}), ...(opts.answerIdlePermissions === false ? { answerIdlePermissions: false } : {}) });

  return new Promise<number>((resolve) => {
    let done = false;
    let watchTimer: ReturnType<typeof setTimeout> | undefined;
    let watchBusy = false;
    const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
    let relaySignal: NodeJS.Signals | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let ending = false;
    let sealed = false; // the open prompts were answered: nothing more goes to the client
    let agentClosed = false; // the agent is gone: no more of its lines are taken
    let agentExited = false; // the agent process ended
    const forward = (signal: NodeJS.Signals) => {
      relaySignal ??= signal;
      signalAgent(signal);
      // The agent gets a short moment to end. If it does not, its group is stopped and its open prompts are answered here.
      graceTimer ??= setTimeout(() => {
        signalAgent("SIGKILL");
        void end({ agent: agentName, code: null, signal: null, ...(relaySignal ? { relaySignal } : {}), timedOut: { graceMs, ...(agentExited ? { agentEnded: true } : {}) }, stderrTail, ...(stderrCut ? { stderrCut } : {}) }, 128 + (signalNumber(relaySignal ?? "SIGTERM") ?? 15));
      }, graceMs);
    };
    const handlers = signals.map((s) => [s, () => forward(s)] as const);
    for (const [s, h] of handlers) process.on(s, h);
    const finish = (code: number) => {
      if (done) return;
      done = true;
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      stopWatch();
      for (const [s, h] of handlers) process.off(s, h);
      resolve(code);
    };

    // Client to agent.
    stdin.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      for (const line of fromClient.push(bytes)) {
        try {
          relay.fromClient(line.toString("utf8"));
        } catch {
          // Tracking a prompt must never stop it from being sent.
        }
      }
      scheduleWatch(); // a prompt may have opened
      if (child.stdin.writable) child.stdin.write(bytes);
      flushHeld();
    });
    stdin.on("end", () => child.stdin.end());
    child.stdin.on("error", () => {}); // the agent closed its stdin: nothing more to send

    // Agent to client, in order.
    const fromAgent = new LineSplitter();
    let chain: Promise<void> = Promise.resolve();
    let clientGone = false;
    /** Resolves when the bytes are written (or the client is gone). */
    const write = (bytes: Buffer): Promise<void> =>
      new Promise<void>((done) => {
        if (clientGone || sealed) return done();
        stdout.write(bytes, () => done());
      });
    const NEWLINE = Buffer.from("\n");
    const pass = (line: Buffer): void => {
      if (agentClosed) return; // the agent's end was taken: no agent line follows the error answer
      chain = chain.then(async () => {
        let out: string[] | undefined;
        const text = line.toString("utf8");
        try {
          out = await relay.fromAgent(text);
        } catch {
          out = undefined;
        }
        if (!out || (out.length === 1 && out[0] === text)) await write(Buffer.concat([line, NEWLINE]));
        else await write(Buffer.from(out.map((o) => `${o}\n`).join(""), "utf8"));
        if (relay.hasOpenPrompts()) scheduleWatch();
        else stopWatch(); // the last prompt was answered: no poll work
      });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of fromAgent.push(chunk)) pass(line);
    });
    stdout.on("error", () => {
      clientGone = true; // nothing more can be written
      signalAgent("SIGTERM");
    });

    // In-turn limit watch: read the agent's log only while a prompt is open. kimi-code sleeps through a long limit retry.
    const watchMs = opts.inTurnWatchMs ?? IN_TURN_WATCH_MS;
    function stopWatch(): void {
      if (watchTimer !== undefined) {
        clearTimeout(watchTimer);
        watchTimer = undefined;
      }
    }
    function scheduleWatch(): void {
      if (done || watchBusy || watchTimer !== undefined || !opts.adapter?.inTurnLimit || !relay.hasOpenPrompts()) return;
      watchTimer = setTimeout(() => {
        watchTimer = undefined;
        if (!done && relay.hasOpenPrompts()) void watchPass();
      }, watchMs);
    }
    async function watchPass(): Promise<void> {
      watchBusy = true;
      try {
        const lines = await relay.watchInTurnLimits();
        if (lines.length > 0) chain = chain.then(() => write(Buffer.from(lines.map((l) => `${l}\n`).join(""), "utf8")));
      } catch {
        // the watch never breaks the relay
      }
      watchBusy = false;
      scheduleWatch();
    }

    /**
     * The agent is gone. Each prompt it did not answer gets one error that says why, written and flushed before this
     * process ends. Runs once. A prompt the agent answered is not open any more, so it is never answered twice.
     */
    async function end(why: AgentEnd, code: number): Promise<void> {
      if (ending) return;
      ending = true;
      agentClosed = true; // before the wait: a line the agent writes now must not follow the answer
      await chain;
      const ids = relay.openPromptIds();
      if (ids.length > 0) {
        const message = agentEndMessage(why);
        const data = { source: "ais-acp-relay", reason: "agent_ended", ...(why.code !== null ? { exitCode: why.code } : {}), ...(why.signal ? { signal: why.signal } : {}), ...(why.relaySignal ? { relaySignal: why.relaySignal } : {}) };
        log(`acp-relay: the agent ended with ${ids.length} prompt(s) open; each was answered with an error`);
        await write(Buffer.from(ids.map((id) => `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: TURN_FAILED_CODE, message, data } })}\n`).join(""), "utf8"));
      }
      sealed = true;
      finish(code);
    }

    child.on("error", (err) => {
      log(`acp-relay: cannot start ${opts.command}: ${err.message}`);
      void end({ agent: agentName, code: null, signal: null, startError: err.message }, 127);
    });
    // Act on the agent's exit, not on the close of its streams: a process it started can hold stdout or stderr open.
    let stdoutEnded = false;
    child.stdout.on("end", () => {
      stdoutEnded = true;
    });
    child.stdout.on("error", () => {
      stdoutEnded = true;
    });
    child.on("exit", (code, signal) => {
      agentExited = true;
      let proceeded = false;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const proceed = () => {
        if (proceeded) return;
        proceeded = true;
        if (drainTimer !== undefined) clearTimeout(drainTimer);
        const rest = fromAgent.rest();
        chain = chain.then(() => (rest.length > 0 ? write(rest) : undefined));
        void end({ agent: agentName, code, signal, ...(relaySignal ? { relaySignal } : {}), stderrTail, ...(stderrCut ? { stderrCut } : {}) }, code ?? (signal ? 128 + (signalNumber(signal) ?? 15) : 1));
      };
      if (stdoutEnded) return proceed();
      // The last bytes of stdout can arrive after `exit`: wait for them, but only a short time.
      drainTimer = setTimeout(proceed, STDOUT_DRAIN_MS);
      child.stdout.once("end", proceed);
      child.stdout.once("error", proceed);
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  return ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[signal];
}
