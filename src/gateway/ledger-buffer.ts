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
        const msg = err instanceof Error ? err.message : String(err);
        const rejected = batch.length > 1 ? await this.isolate(batch) : undefined;
        if (rejected === undefined) {
          // Store looks down: put the batch back in front of rows pushed meanwhile and wait for the next tick.
          this.rows.unshift(...batch);
          this.trim();
          console.warn(`gateway ledger flush failed: ${msg}`);
          return;
        }
        this.droppedCount += rejected;
        console.warn(`gateway ledger discarded ${rejected} rejected row(s): ${msg}`);
      }
    }
  }

  /**
   * Retries a failed batch row by row so one poison row cannot block good ones.
   * Returns the number of rows the store rejected, or undefined when every row
   * failed (an outage, not poison); in that case nothing is lost and the caller requeues.
   */
  private async isolate(batch: UsageRow[]): Promise<number | undefined> {
    const failed: UsageRow[] = [];
    let ok = 0;
    for (const row of batch) {
      try {
        await this.store.appendUsage([row]);
        ok++;
      } catch {
        failed.push(row);
      }
    }
    if (ok === 0) return undefined;
    return failed.length;
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
