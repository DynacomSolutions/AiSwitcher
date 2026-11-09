/** A SQL tagged-template function whose result can be awaited and, when the driver allows it, cancelled. */
export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<Array<Record<string, unknown>>> & { cancel?: () => unknown };

/**
 * Counts one side or served request for `app` on `day` and returns the day's total. If `signal` aborts (the caller gave up),
 * the query is cancelled so a slow database does not accumulate work.
 */
export async function bumpSideCountOn(sql: SqlTag, app: string, day: string, signal?: AbortSignal): Promise<number> {
  const query = sql`
    INSERT INTO gateway_side_counts (app, day, n) VALUES (${app}, ${day}::date, 1)
    ON CONFLICT (app, day) DO UPDATE SET n = gateway_side_counts.n + 1
    RETURNING n`;
  signal?.addEventListener("abort", () => void query.cancel?.(), { once: true });
  const rows = await query;
  return Number(rows[0]?.n ?? 0);
}

/**
 * The replica's own count while the database cannot answer: entries for other days are dropped first (a day-old count would
 * otherwise live as long as the process), then this app's count for `day` is incremented and returned.
 */
export function fallbackCount(counts: Map<string, number>, app: string, day: string): number {
  for (const k of [...counts.keys()]) if (!k.endsWith(`\u0000${day}`)) counts.delete(k);
  const key = `${app}\u0000${day}`;
  const n = (counts.get(key) ?? 0) + 1;
  counts.set(key, n);
  return n;
}

/** A counting gate: at most `max` holders; the others queue in order and give up after their own deadline. */
export class Gate {
  private held = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  /** A release function once a slot is free, or undefined if none freed within `ms`. */
  acquire(ms: number): Promise<(() => void) | undefined> {
    if (this.held < this.max) {
      this.held += 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve) => {
      const grant = (): void => {
        clearTimeout(timer);
        resolve(this.releaser()); // the releasing holder handed its slot over: held is unchanged
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(undefined);
      }, Math.max(0, ms));
      this.waiters.push(grant);
    });
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.held -= 1;
    };
  }
}
