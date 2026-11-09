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
