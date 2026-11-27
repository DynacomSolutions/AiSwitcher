import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { PollCache } from "./expensive.ts";

const HEARTBEAT_MS = 15_000;
// Leave time to deliver the final frame before the public ingress closes the request at 30 s.
const ROLLOVER_MS = 25_000;
const CHECK_MS = 1_000;

export type ConsoleTopic = "limits" | "usage" | "pools-usage" | "gateway-usage" | "usage-projects" | "codex-auto-reset";

interface ReadSource {
  load: () => unknown | Promise<unknown>;
  intervalMs: number;
  pendingIntervalMs?: number;
}

type ReadResult = { ok: true; value: unknown } | { ok: false; error: unknown };
const FAILED = Symbol("failed");

interface ObservedRead {
  source: ReadSource;
  cache: PollCache;
  intervalMs: number;
  nextCheck: number;
  generation: number;
  fingerprint?: string | typeof FAILED;
  inFlight?: Promise<unknown>;
}

interface Listener {
  change(topics: readonly ConsoleTopic[]): void;
  tick(now: number, heartbeatDue: boolean): void;
  close(): void;
}

/** Ignore envelope timestamps and cache hits. Timestamps inside rows are data. */
function fingerprint(value: unknown): string {
  const { fetchedAt: _fetchedAt, generatedAt: _generatedAt, cached: _cached, ...data } = value as Record<string, unknown>;
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(data)).digest("hex");
}

/** One set of reads for the daemon. The same cached reads serve the JSON routes and the observer. */
export class ConsoleEvents {
  private readonly reads: Map<ConsoleTopic, ObservedRead>;
  private readonly listeners = new Set<Listener>();
  private timer?: ReturnType<typeof setInterval>;
  private lastHeartbeat = 0;

  constructor(sources: Record<ConsoleTopic, ReadSource>, private readonly signal?: AbortSignal) {
    this.reads = new Map((Object.keys(sources) as ConsoleTopic[]).map((topic) => {
      const source = sources[topic];
      return [topic, {
        source,
        cache: new PollCache(source.intervalMs),
        intervalMs: source.intervalMs,
        nextCheck: 0,
        generation: 0,
      }];
    }));
    signal?.addEventListener("abort", () => {
      for (const listener of this.listeners) listener.close();
    }, { once: true });
  }

  async read(topic: ConsoleTopic): Promise<unknown> {
    const entry = this.reads.get(topic)!;
    for (;;) {
      const generation = entry.generation;
      const { value: result, cached } = await entry.cache.get(topic, () => this.load(topic, entry, generation), entry.intervalMs);
      if (generation !== entry.generation) continue;
      if (!result.ok) throw result.error;
      return topic === "limits" && cached ? { ...(result.value as object), cached: true } : result.value;
    }
  }

  private async load(topic: ConsoleTopic, entry: ObservedRead, generation: number): Promise<ReadResult> {
    // A mutation can clear the cache during a read. Wait for that read before starting its replacement.
    if (entry.inFlight) await entry.inFlight.catch(() => undefined);
    if (generation !== entry.generation) return { ok: true, value: undefined };
    const inFlight = Promise.resolve().then(entry.source.load);
    entry.inFlight = inFlight;
    try {
      const value = await inFlight;
      const pending = (value as { pending?: boolean }).pending;
      const intervalMs = pending ? entry.source.pendingIntervalMs ?? entry.source.intervalMs : entry.source.intervalMs;
      this.observe(topic, entry, generation, fingerprint(value), intervalMs);
      return { ok: true, value };
    } catch (error) {
      this.observe(topic, entry, generation, FAILED, entry.source.intervalMs);
      return { ok: false, error };
    } finally {
      entry.inFlight = undefined;
    }
  }

  private observe(topic: ConsoleTopic, entry: ObservedRead, generation: number, next: ObservedRead["fingerprint"], intervalMs: number): void {
    if (entry.generation !== generation) return;
    const changed = entry.fingerprint !== undefined && entry.fingerprint !== next;
    entry.fingerprint = next;
    entry.intervalMs = intervalMs;
    entry.nextCheck = Date.now() + intervalMs;
    if (changed) this.notify([topic]);
  }

  /** A mutation completed in this console. Discard any reads that started before it. */
  invalidate(...topics: ConsoleTopic[]): void {
    for (const topic of topics) {
      const entry = this.reads.get(topic)!;
      entry.cache.clear();
      entry.generation += 1;
      entry.fingerprint = undefined;
      entry.nextCheck = 0;
    }
    this.notify(topics);
  }

  private notify(topics: readonly ConsoleTopic[]): void {
    for (const listener of this.listeners) listener.change(topics);
  }

  private check = (): void => {
    const now = Date.now();
    const monotonicNow = performance.now();
    const heartbeatDue = monotonicNow - this.lastHeartbeat >= HEARTBEAT_MS;
    if (heartbeatDue) this.lastHeartbeat = monotonicNow;
    for (const listener of this.listeners) listener.tick(monotonicNow, heartbeatDue);
    for (const [topic, entry] of this.reads) {
      if (now >= entry.nextCheck && !entry.inFlight) void this.read(topic).catch(() => undefined);
    }
  };

  private subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (!this.timer) {
      this.lastHeartbeat = performance.now();
      this.timer = setInterval(this.check, CHECK_MS);
      this.timer.unref?.();
      this.check();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }

  stream(c: Context): Response {
    c.header("X-Accel-Buffering", "no");
    const response = streamSSE(c, async (stream) => {
      if (this.signal?.aborted || c.req.raw.signal.aborted) return;

      // Each socket keeps at most one pending event per topic, even if its writes stall.
      const pending = new Set<ConsoleTopic>();
      const rolloverAt = performance.now() + ROLLOVER_MS;
      let heartbeat = false;
      let rollover = false;
      let wake: (() => void) | undefined;
      const abort = () => stream.abort();
      const unsubscribe = this.subscribe({
        change(topics) {
          for (const topic of topics) pending.add(topic);
          wake?.();
        },
        tick(now, heartbeatDue) {
          if (now >= rolloverAt) rollover = true;
          if (heartbeatDue) heartbeat = true;
          if (rollover || heartbeat) wake?.();
        },
        close: abort,
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      const signal = c.req.raw.signal;
      signal.addEventListener("abort", abort, { once: true });
      try {
        await stream.writeSSE({ event: "ready", data: "{}" });
        while (!stream.aborted) {
          if (rollover) {
            await stream.writeSSE({ event: "rollover", data: "{}" });
            return;
          }
          if (pending.size > 0) {
            const data = JSON.stringify([...pending]);
            pending.clear();
            await stream.writeSSE({ event: "change", data });
          } else if (heartbeat) {
            heartbeat = false;
            await stream.writeSSE({ event: "heartbeat", data: "{}" });
          } else {
            await new Promise<void>((resolve) => { wake = resolve; });
            wake = undefined;
          }
        }
      } finally {
        signal.removeEventListener("abort", abort);
        unsubscribe();
      }
    });
    response.headers.set("Cache-Control", "no-store, no-transform");
    return response;
  }
}
