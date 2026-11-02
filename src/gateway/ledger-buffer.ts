import type { GatewayStore } from "./store.ts";
import type { UsageRow } from "./types.ts";

const BATCH_SIZE = 500;

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
        // Put the batch back in front of rows pushed meanwhile, then stop until the next tick.
        this.rows.unshift(...batch);
        this.trim();
        console.warn(`gateway ledger flush failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }
}
