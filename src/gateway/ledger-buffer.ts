import type { GatewayStore } from "./store.ts";
import type { UsageRow } from "./types.ts";

const BATCH_SIZE = 500;

/** True for Postgres SQLSTATE class 22 (data exception) or 23 (integrity violation). */
export function isDataError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { errno?: unknown; code?: unknown };
  for (const v of [e.errno, e.code]) {
    if (typeof v === "string" && /^2[23][0-9A-Z]{3}$/.test(v)) return true;
  }
  return false;
}

/** Error class and code (SQLSTATE or errno) only: messages can carry connection strings or row values. */
export function errorTag(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; errno?: unknown } | null;
  const parts = [typeof e?.name === "string" ? e.name : "Error"];
  for (const v of [e?.code, e?.errno]) if (typeof v === "string" || typeof v === "number") parts.push(String(v));
  return parts.join(" ");
}

/**
 * In-memory usage buffer that flushes to the store on a timer. A store outage
 * keeps rows for the next flush; once `max` rows are held the oldest are
 * dropped and counted, so the request path never blocks or grows unbounded.
 */
export class LedgerBuffer {
  private rows: UsageRow[] = [];
  private droppedCount = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inflight: Promise<void> | undefined;
  private closed = false;
  private readonly max: number;

  constructor(
    private readonly store: GatewayStore,
    opts: { max: number; flushMs: number } = { max: 50_000, flushMs: 2_000 },
  ) {
    this.max = opts.max;
    this.timer = setInterval(() => void this.flush(), opts.flushMs);
    this.timer.unref?.();
  }

  get depth(): number {
    return this.rows.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  push(row: UsageRow): void {
    if (this.closed) {
      this.droppedCount += 1;
      return;
    }
    this.rows.push(row);
    this.trim();
  }

  private trim(): void {
    const over = this.rows.length - this.max;
    if (over > 0) {
      this.rows.splice(0, over);
      this.droppedCount += over;
    }
  }

  /** Writes everything buffered, in batches. Failures leave the rows queued. */
  flush(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.drain().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async drain(): Promise<void> {
    while (this.rows.length > 0) {
      const batch = this.rows.splice(0, BATCH_SIZE);
      try {
        await this.store.appendUsage(batch);
      } catch (err) {
        const msg = errorTag(err);
        const requeue = isDataError(err) ? await this.isolate(batch) : batch;
        if (requeue.length > 0) {
          // Store looks down: put unwritten rows back in front of rows pushed meanwhile and wait for the next tick.
          this.rows.unshift(...requeue);
          this.trim();
          console.warn(`gateway ledger flush failed: ${msg}`);
          return;
        }
      }
    }
  }

  /**
   * Retries a batch the store rejected with a data error, row by row, so one
   * poison row cannot block good ones. Only rows rejected with a data error are
   * discarded (and counted). Any other error means the store is unwell: the
   * failing row and all untried rows are returned for requeueing, in order.
   */
  private async isolate(batch: UsageRow[]): Promise<UsageRow[]> {
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i] as UsageRow;
      try {
        await this.store.appendUsage([row]);
      } catch (err) {
        if (isDataError(err)) {
          this.droppedCount += 1;
          console.warn(`gateway ledger discarded a rejected row: ${errorTag(err)}`);
        } else {
          return batch.slice(i);
        }
      }
    }
    return [];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
    if (this.rows.length > 0) {
      const lost = this.rows.length;
      this.rows = [];
      this.droppedCount += lost;
      console.warn(`gateway ledger closed with ${lost} unwritten row(s), dropped`);
    }
  }
}
