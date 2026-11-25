/**
 * Pool hold: a streamed Claude request that arrives while every pool member is full is kept open, not refused.
 *
 * Claude Code retries a 429 at most 10 times, and only when `retry-after` is 60 s or less, so a refusal ends a long worker
 * within minutes. The hold answers `200 text/event-stream` at once and sends an SSE `ping` every few seconds. The client
 * has its headers, so its 10 minute request timeout is over, and its stream idle watchdog sees data. The gateway replays
 * the buffered request against the pool from time to time. When a member has room, the replay answer becomes the rest of
 * the stream. When the replay meets a 429 (a full pool or a provider limit), the hold continues. When the replay fails for
 * another reason, the stream ends with an SSE `error` event in the provider's shape.
 *
 * A shutdown ends every hold at once with a socket reset before any message event. Claude Code retries a reset as a stream.
 * An SSE `error` event before `message_start` would make it resend the request without streaming, and that request is never held.
 */

export interface PoolHoldLimits {
  /** Longest one request is held. Default 6 h. */
  maxMs: number;
  /** Time between two replays against the pool. Default 30 s. */
  checkMs: number;
  /** Time between two SSE pings. Default 15 s. */
  pingMs: number;
  /** Most requests held at once on this replica. Default 200. */
  maxHeld: number;
  /** Most request-body bytes held at once on this replica. Default 256 MiB. */
  maxBytes: number;
}

export const DEFAULT_POOL_HOLD: PoolHoldLimits = { maxMs: 6 * 3_600_000, checkMs: 30_000, pingMs: 15_000, maxHeld: 200, maxBytes: 256 * 1024 * 1024 };

/** The longest `retry-after` Claude Code accepts is 60 s: a pool answer that is not held stays under it. */
export const CLIENT_RETRY_AFTER_CAP_SECONDS = 55;

export function poolHoldFromEnv(env: Record<string, string | undefined> = process.env): PoolHoldLimits {
  const num = (k: string, d: number, scale = 1): number => {
    const n = Number(env[k]);
    return Number.isFinite(n) && n > 0 ? n * scale : d;
  };
  return {
    maxMs: num("AIS_GATEWAY_POOL_HOLD_MAX_S", DEFAULT_POOL_HOLD.maxMs, 1000),
    checkMs: num("AIS_GATEWAY_POOL_HOLD_CHECK_S", DEFAULT_POOL_HOLD.checkMs, 1000),
    pingMs: num("AIS_GATEWAY_POOL_HOLD_PING_S", DEFAULT_POOL_HOLD.pingMs, 1000),
    maxHeld: num("AIS_GATEWAY_POOL_HOLD_MAX_REQUESTS", DEFAULT_POOL_HOLD.maxHeld),
    maxBytes: num("AIS_GATEWAY_POOL_HOLD_MAX_BODY_MB", DEFAULT_POOL_HOLD.maxBytes, 1024 * 1024),
  };
}

/** Answers marked by the proxy as "the pool is full" (not a provider 429 that passes through). */
export const fullPoolAnswers = new WeakSet<Response>();

/** Requests the hold replays: they never start a second hold. */
export const heldReplays = new WeakSet<Request>();

/** Tracks what is held on one replica. */
export class PoolHoldGate {
  held = 0;
  bytes = 0;
  constructor(readonly limits: PoolHoldLimits) {}
  tryEnter(bytes: number): boolean {
    if (this.held >= this.limits.maxHeld || this.bytes + bytes > this.limits.maxBytes) return false;
    this.held++;
    this.bytes += bytes;
    return true;
  }
  leave(bytes: number): void {
    this.leaveHeld();
    this.releaseBytes(bytes);
  }
  /** The request is no longer a hold (a replay serves it), but its body may still be in memory. */
  leaveHeld(): void {
    this.held = Math.max(0, this.held - 1);
  }
  releaseBytes(bytes: number): void {
    this.bytes = Math.max(0, this.bytes - bytes);
  }
}

/**
 * True when the top-level `stream` key of the buffered JSON request body is `true`. A bounded scan, as `scanModel`: it
 * allocates nothing for the body, skips nested values by depth and the last duplicate key wins, as in JSON.parse.
 */
export function wantsStream(b: Uint8Array): boolean {
  const n = b.length;
  let i = 0;
  const ws = (): void => {
    while (i < n && (b[i] === 0x20 || b[i] === 0x0a || b[i] === 0x0d || b[i] === 0x09)) i++;
  };
  /** Index of the closing quote of the string that opens at `from`, or -1. */
  const str = (from: number): number => {
    let j = from + 1;
    while (j < n) {
      const c = b[j];
      if (c === 0x5c) j += 2;
      else if (c === 0x22) return j;
      else j++;
    }
    return -1;
  };
  /** Moves `i` past one JSON value. */
  const skip = (): boolean => {
    const c = b[i];
    if (c === 0x22) {
      const e = str(i);
      if (e < 0) return false;
      i = e + 1;
      return true;
    }
    if (c === 0x7b || c === 0x5b) {
      let depth = 0;
      while (i < n) {
        const d = b[i];
        if (d === 0x22) {
          const e = str(i);
          if (e < 0) return false;
          i = e + 1;
          continue;
        }
        if (d === 0x7b || d === 0x5b) depth++;
        else if (d === 0x7d || d === 0x5d) {
          depth--;
          if (depth === 0) {
            i++;
            return true;
          }
        }
        i++;
      }
      return false;
    }
    const from = i;
    while (i < n && b[i] !== 0x2c && b[i] !== 0x7d && b[i] !== 0x20 && b[i] !== 0x0a && b[i] !== 0x0d && b[i] !== 0x09) i++;
    return i > from;
  };
  ws();
  if (b[i] !== 0x7b) return false;
  i++;
  let stream = false;
  for (;;) {
    ws();
    if (b[i] === 0x7d) return stream;
    if (b[i] === 0x2c) {
      i++;
      continue;
    }
    if (b[i] !== 0x22) return false;
    const ke = str(i);
    if (ke < 0) return false;
    let isStream = false;
    let escaped = false;
    for (let k = i + 1; k < ke; k++) if (b[k] === 0x5c) escaped = true;
    if (escaped) {
      try {
        isStream = JSON.parse(new TextDecoder().decode(b.subarray(i, ke + 1))) === "stream"; // only the key text, never the body
      } catch {
        return false;
      }
    } else isStream = ke - i === 7 && b[i + 1] === 0x73 && b[i + 2] === 0x74 && b[i + 3] === 0x72 && b[i + 4] === 0x65 && b[i + 5] === 0x61 && b[i + 6] === 0x6d;
    i = ke + 1;
    ws();
    if (b[i] !== 0x3a) return false;
    i++;
    ws();
    const from = i;
    if (!skip()) return false;
    if (isStream) stream = i - from === 4 && b[from] === 0x74 && b[from + 1] === 0x72 && b[from + 2] === 0x75 && b[from + 3] === 0x65;
  }
}

const enc = new TextEncoder();
const sse = (event: string, data: unknown): Uint8Array => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

export interface HeldStreamInput {
  limits: PoolHoldLimits;
  gate: PoolHoldGate;
  bytes: number;
  now(): Date;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** Aborts when the gateway stops. */
  drain?: AbortSignal | undefined;
  /** Sends the buffered request through the proxy again. */
  replay(signal: AbortSignal): Promise<Response>;
  /** The text of the limit answer that started the hold, for the final error event. */
  limitMessage: string;
  onEvent?(event: "held" | "served" | "failed" | "timeout" | "drained" | "cancelled"): void;
}

/** The held answer: an SSE response that waits for room in the pool. The caller has already entered the gate. */
export function heldStreamResponse(input: HeldStreamInput): Response {
  const ctrl = new AbortController();
  const startedMs = input.now().getTime();
  let done = false;
  const finish = (event: Parameters<NonNullable<HeldStreamInput["onEvent"]>>[0]): void => {
    if (done) return;
    done = true;
    input.drain?.removeEventListener("abort", onDrain);
    // A served hold stops counting as held at once, but its body stays in the byte count until the stream ends: the
    // request closure keeps the body alive while the served stream runs, so the cap on held bytes stays true.
    if (event === "served") input.gate.leaveHeld();
    else input.gate.leave(input.bytes);
    input.onEvent?.(event);
  };
  let bytesReleased = false;
  const releaseServedBytes = (): void => {
    if (bytesReleased || !served) return;
    bytesReleased = true;
    input.gate.releaseBytes(input.bytes);
  };
  let served = false;
  /** Ends the wait: the client went away or the gateway stops. A stream that is already served ends only when the client goes. */
  const waitSignal = input.drain ? AbortSignal.any([ctrl.signal, input.drain]) : ctrl.signal;
  /** Ends a replay that has not answered yet when the gateway stops. After the answer the served stream runs on. */
  const replayCtrl = new AbortController();
  let replaying = false;
  const onDrain = (): void => {
    if (replaying) replayCtrl.abort();
  };
  input.drain?.addEventListener("abort", onDrain, { once: true });
  input.onEvent?.("held");
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const send = (chunk: Uint8Array): boolean => {
        try {
          c.enqueue(chunk);
          return true;
        } catch {
          return false;
        }
      };
      /** A socket reset before any message event: Claude Code retries it as a stream, an SSE error event it would not. */
      const reset = (): void => {
        try {
          c.error(new Error("gateway is restarting"));
        } catch {
          // already closed by a cancel
        }
      };
      const end = (): void => {
        try {
          c.close();
        } catch {
          // already closed by a cancel
        }
      };
      void (async () => {
        let sinceCheck = 0;
        try {
          for (;;) {
            if (input.drain?.aborted) {
              finish("drained");
              return reset();
            }
            if (ctrl.signal.aborted) {
              finish("cancelled");
              return end();
            }
            if (input.now().getTime() - startedMs >= input.limits.maxMs) {
              send(sse("error", { type: "error", error: { type: "rate_limit_error", message: input.limitMessage } }));
              finish("timeout");
              return end();
            }
            await input.sleep(input.limits.pingMs, waitSignal).catch(() => undefined);
            if (waitSignal.aborted) continue;
            if (!send(sse("ping", { type: "ping" }))) {
              finish("cancelled");
              return end();
            }
            sinceCheck += input.limits.pingMs;
            if (sinceCheck < input.limits.checkMs) continue;
            sinceCheck = 0;
            let res: Response;
            replaying = true;
            // The pings go on while the replay is in flight: a replay may wait long for a member, and the client's idle
            // watchdog must see data. This timer is real time, apart from the injected `sleep` that paces the hold loop.
            let replayDone = false;
            const pingTimer = setInterval(() => {
              if (replayDone || waitSignal.aborted || !send(sse("ping", { type: "ping" }))) clearInterval(pingTimer);
            }, input.limits.pingMs);
            try {
              res = await input.replay(AbortSignal.any([ctrl.signal, replayCtrl.signal]));
            } catch {
              if (waitSignal.aborted) continue;
              send(sse("error", { type: "error", error: { type: "api_error", message: "gateway error" } }));
              finish("failed");
              return end();
            } finally {
              replaying = false;
              replayDone = true;
              clearInterval(pingTimer);
            }
            if (input.drain?.aborted && !res.ok) {
              // The shutdown aborted the replay: the proxy turns that into an error answer. The loop top resets the stream.
              await res.body?.cancel().catch(() => undefined);
              continue;
            }
            // A 429 of any kind (a full pool, a provider limit) means the pool is still full: the hold goes on.
            if (res.status === 429 || fullPoolAnswers.has(res)) {
              await res.body?.cancel().catch(() => undefined);
              continue;
            }
            if (res.ok && res.body) {
              // The replay is the real answer: its body is the rest of the stream. Its end ends the hold.
              served = true;
              finish("served");
              const note = replayNote(res.headers);
              if (note) send(note);
              const reader = res.body.getReader();
              let gotChunk = false;
              ctrl.signal.addEventListener("abort", () => void reader.cancel().catch(() => undefined), { once: true });
              try {
                for (;;) {
                  const r = await reader.read();
                  if (r.done) break;
                  gotChunk = true;
                  if (!send(r.value)) {
                    await reader.cancel().catch(() => undefined);
                    break;
                  }
                }
              } catch {
                // No answer byte went out yet, or the gateway is stopping: a reset, which Claude Code retries as a stream.
                if (!gotChunk || input.drain?.aborted) {
                  releaseServedBytes();
                  return reset();
                }
                send(sse("error", { type: "error", error: { type: "api_error", message: "upstream stream failed" } }));
              }
              releaseServedBytes();
              return end();
            }
            send(sse("error", await errorEvent(res)));
            finish("failed");
            return end();
          }
        } catch {
          finish("failed");
          releaseServedBytes();
          end();
        }
      })();
    },
    cancel() {
      ctrl.abort();
      finish("cancelled");
      releaseServedBytes();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
}

/**
 * The 200 headers went out when the hold began, so the real answer's `request-id` and rate-limit headers cannot be sent as
 * headers. They go as one SSE comment line, which every SSE parser skips and a person reading a trace can still find.
 */
function replayNote(h: Headers): Uint8Array | undefined {
  const parts: string[] = [];
  for (const [k, v] of h) if (k === "request-id" || k === "x-request-id" || k.startsWith("anthropic-ratelimit-unified-")) parts.push(`${k}=${v.replace(/[\r\n]/g, " ").slice(0, 200)}`);
  return parts.length > 0 ? enc.encode(`: ais-replay ${parts.join(" ")}\n\n`) : undefined;
}

/** The SSE error event for a replay answer that is not a stream: the provider's own error object when it has one. */
async function errorEvent(res: Response): Promise<unknown> {
  let message = "gateway error";
  try {
    const text = (await res.text()).slice(0, 64 * 1024);
    const j = JSON.parse(text) as { error?: { type?: unknown; message?: unknown } };
    if (j.error && typeof j.error.type === "string") return { type: "error", error: { type: j.error.type, message: typeof j.error.message === "string" ? j.error.message : message } };
  } catch {
    // not JSON: keep the generic message
  }
  return { type: "error", error: { type: "api_error", message } };
}
