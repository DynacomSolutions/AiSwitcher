/**
 * Runs an ACP agent behind the relay (relay.ts): this process takes the agent's place for the client, starts the real
 * agent and passes both directions line by line (ACP is newline-delimited JSON-RPC on stdin and stdout).
 *
 * - Client to agent: every byte is passed at once and unchanged; complete lines are also shown to the relay.
 * - Agent to client: one line at a time, in order. An unchanged line keeps its bytes.
 * - stderr is the agent's own. Signals go to the agent; this process ends with the agent's exit code.
 */
import { spawn } from "node:child_process";
import { kimiAdapter, kimiHome } from "./kimi-turn.ts";
import { AcpRelay, type RelayAdapter } from "./relay.ts";

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

export interface RelayProcessOptions {
  command: string;
  args: string[];
  adapter?: RelayAdapter;
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  /** Where relay notes go (the agent's stderr stream by default). */
  log?: (line: string) => void;
}

/** Starts the agent and relays until it exits. Resolves with the exit code this process should end with. */
export function runAcpRelay(opts: RelayProcessOptions): Promise<number> {
  const stdin: NodeJS.ReadableStream = opts.stdin ?? process.stdin;
  const stdout: NodeJS.WritableStream = opts.stdout ?? process.stdout;
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const relay = new AcpRelay({ ...(opts.adapter ? { adapter: opts.adapter } : {}), log });
  const child = spawn(opts.command, opts.args, { stdio: ["pipe", "pipe", "inherit"], env: opts.env ?? process.env });

  return new Promise<number>((resolve) => {
    let done = false;
    const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    const handlers = signals.map((s) => [s, () => forward(s)] as const);
    for (const [s, h] of handlers) process.on(s, h);
    const finish = (code: number) => {
      if (done) return;
      done = true;
      for (const [s, h] of handlers) process.off(s, h);
      resolve(code);
    };

    // Client to agent.
    const fromClient = new LineSplitter();
    stdin.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (child.stdin.writable) child.stdin.write(bytes);
      for (const line of fromClient.push(bytes)) {
        try {
          relay.fromClient(line.toString("utf8"));
        } catch {
          // Tracking a prompt must never stop it from being sent.
        }
      }
    });
    stdin.on("end", () => child.stdin.end());
    child.stdin.on("error", () => {}); // the agent closed its stdin: nothing more to send

    // Agent to client, in order.
    const fromAgent = new LineSplitter();
    let chain: Promise<void> = Promise.resolve();
    const write = (bytes: Buffer | string): void => {
      stdout.write(bytes);
      stdout.write("\n");
    };
    const pass = (line: Buffer): void => {
      chain = chain.then(async () => {
        let out: string[] | undefined;
        const text = line.toString("utf8");
        try {
          out = await relay.fromAgent(text);
        } catch {
          out = undefined;
        }
        if (!out || (out.length === 1 && out[0] === text)) write(line);
        else for (const o of out) write(o);
      });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of fromAgent.push(chunk)) pass(line);
    });
    stdout.on("error", () => child.kill("SIGTERM")); // the client is gone

    child.on("error", (err) => {
      log(`acp-relay: cannot start ${opts.command}: ${err.message}`);
      finish(127);
    });
    child.on("close", (code, signal) => {
      const rest = fromAgent.rest();
      void chain.then(() => {
        if (rest.length > 0) stdout.write(rest);
        finish(code ?? (signal ? 128 + (signalNumber(signal) ?? 15) : 1));
      });
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  return ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[signal];
}
