/**
 * Pool hold: a streamed Claude request that arrives while every pool member is full is kept open, not refused.
 *
 * Claude Code retries a 429 at most 10 times, and only when `retry-after` is 60 s or less, so a refusal ends a long worker
 * within minutes. The hold answers `200 text/event-stream` at once and sends an SSE `ping` every few seconds. The client
 * has its headers, so its 10 minute request timeout is over, and its stream idle watchdog sees data. The gateway replays
 * the buffered request against the pool from time to time. When a member has room, the replay answer becomes the rest of
 * the stream. When the replay fails for another reason, the stream ends with an SSE `error` event in the provider's shape.
 *
 * A shutdown ends every hold at once with a retryable `overloaded_error` event, so a held request never blocks a drain.
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
    this.held = Math.max(0, this.held - 1);
    this.bytes = Math.max(0, this.bytes - bytes);
  }
}

/** True when the buffered JSON request body asks for a stream. */
export function wantsStream(bytes: Uint8Array): boolean {
  try {
    const j = JSON.parse(new TextDecoder().decode(bytes)) as { stream?: unknown };
    return j.stream === true;
  } catch {
    return false;
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
    input.gate.leave(input.bytes);
    input.onEvent?.(event);
  };
  /** Ends the wait: the client went away or the gateway stops. A stream that is already served ends only when the client goes. */
  const waitSignal = input.drain ? AbortSignal.any([ctrl.signal, input.drain]) : ctrl.signal;
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
              send(sse("error", { type: "error", error: { type: "overloaded_error", message: "gateway is restarting, retry" } }));
              finish("drained");
              return end();
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
            try {
              res = await input.replay(ctrl.signal);
            } catch {
              if (waitSignal.aborted) continue;
              send(sse("error", { type: "error", error: { type: "api_error", message: "gateway error" } }));
              finish("failed");
              return end();
            }
            if (fullPoolAnswers.has(res)) {
              await res.body?.cancel().catch(() => undefined);
              continue;
            }
            if (res.ok && res.body) {
              // The replay is the real answer: its body is the rest of the stream. Its end ends the hold.
              finish("served");
              const reader = res.body.getReader();
              ctrl.signal.addEventListener("abort", () => void reader.cancel().catch(() => undefined), { once: true });
              try {
                for (;;) {
                  const r = await reader.read();
                  if (r.done) break;
                  if (!send(r.value)) {
                    await reader.cancel().catch(() => undefined);
                    break;
                  }
                }
              } catch {
                send(sse("error", { type: "error", error: { type: "api_error", message: "upstream stream failed" } }));
              }
              return end();
            }
            send(sse("error", await errorEvent(res)));
            finish("failed");
            return end();
          }
        } catch {
          finish("failed");
          end();
        }
      })();
    },
    cancel() {
      ctrl.abort();
      finish("cancelled");
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
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
