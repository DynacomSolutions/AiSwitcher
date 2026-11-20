/** Width of one `gateway_usage_15m` bucket. TimescaleDB aligns 15-minute buckets to UTC. */
export const ROLLUP_BUCKET_MS = 15 * 60 * 1000;

export interface RollupPlan {
  /** Aligned middle [start, end) read from the rollup. `end` is null for an open end. */
  start: string;
  end: string | null;
  /** Unaligned edges [start, end) read from the raw ledger. */
  head?: { start: string; end: string };
  tail?: { start: string; end: string };
}

/**
 * Splits [since, until) into an aligned middle (rollup) and raw edges.
 * Returns undefined when no whole bucket fits: the caller then reads the raw ledger.
 */
export function planRollupRange(since: Date, until?: Date): RollupPlan | undefined {
  const s = since.getTime();
  const a = Math.ceil(s / ROLLUP_BUCKET_MS) * ROLLUP_BUCKET_MS;
  const iso = (ms: number): string => new Date(ms).toISOString();
  if (until === undefined) {
    const plan: RollupPlan = { start: iso(a), end: null };
    if (a > s) plan.head = { start: iso(s), end: iso(a) };
    return plan;
  }
  const u = until.getTime();
  const b = Math.floor(u / ROLLUP_BUCKET_MS) * ROLLUP_BUCKET_MS;
  if (!(b > a)) return undefined;
  const plan: RollupPlan = { start: iso(a), end: iso(b) };
  if (a > s) plan.head = { start: iso(s), end: iso(a) };
  if (u > b) plan.tail = { start: iso(b), end: iso(u) };
  return plan;
}

export interface RollupSource {
  text: string;
  params: unknown[];
}

/**
 * One UNION ALL over the rollup middle and the raw edges, with one column set for both.
 * `dayZone` adds a `day` column (local day in that zone), else the source has no day.
 * Sums are numeric and costs are double precision in every piece, so the pieces unite.
 */
export function rollupSource(plan: RollupPlan, dayZone?: string): RollupSource {
  const params: unknown[] = [];
  const p = (v: unknown, cast: string): string => {
    params.push(v);
    return `$${params.length}::${cast}`;
  };
  const zone = dayZone === undefined ? undefined : p(dayZone, "text");
  const dayOf = (col: string): string => (zone === undefined ? "" : `to_char(${col} AT TIME ZONE ${zone}, 'YYYY-MM-DD') AS day, `);
  const pieces: string[] = [];
  const middleFrom = p(plan.start, "timestamptz");
  const middleTo = plan.end === null ? "" : ` AND bucket < ${p(plan.end, "timestamptz")}`;
  pieces.push(`SELECT ${dayOf("bucket")}provider, identity, app, model,
      input_tokens::numeric AS input_tokens, output_tokens::numeric AS output_tokens,
      cache_read_tokens::numeric AS cache_read_tokens, cache_write_tokens::numeric AS cache_write_tokens,
      est_cost_usd, requests::numeric AS requests,
      COALESCE(n_input, 0)::numeric AS n_input, COALESCE(n_output, 0)::numeric AS n_output,
      COALESCE(n_cache_read, 0)::numeric AS n_cache_read, COALESCE(n_cache_write, 0)::numeric AS n_cache_write,
      n_requests::numeric AS n_requests, first_ts, last_ts
    FROM gateway_usage_15m WHERE bucket >= ${middleFrom}${middleTo}`);
  for (const edge of [plan.head, plan.tail]) {
    if (!edge) continue;
    pieces.push(`SELECT ${dayOf("ts")}provider, identity, app, model,
      input_tokens::numeric, output_tokens::numeric, cache_read_tokens::numeric, cache_write_tokens::numeric,
      est_cost_usd, 1::numeric AS requests,
      (CASE WHEN est_cost_usd IS NULL THEN input_tokens ELSE 0 END)::numeric AS n_input,
      (CASE WHEN est_cost_usd IS NULL THEN output_tokens ELSE 0 END)::numeric AS n_output,
      (CASE WHEN est_cost_usd IS NULL THEN cache_read_tokens ELSE 0 END)::numeric AS n_cache_read,
      (CASE WHEN est_cost_usd IS NULL THEN cache_write_tokens ELSE 0 END)::numeric AS n_cache_write,
      (CASE WHEN est_cost_usd IS NULL THEN 1 ELSE 0 END)::numeric AS n_requests, ts AS first_ts, ts AS last_ts
    FROM gateway_usage WHERE ts >= ${p(edge.start, "timestamptz")} AND ts < ${p(edge.end, "timestamptz")}`);
  }
  return { text: pieces.join("\n    UNION ALL\n    "), params };
}

/** Sums every column over the united pieces, grouped by `groupBy` (a column list such as `provider, identity`). */
export function rollupAggregateSql(source: RollupSource, groupBy: string, orderBy: string): RollupSource {
  const text = `SELECT ${groupBy},
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(est_cost_usd), 0) AS est_cost_usd,
      SUM(requests) AS requests,
      SUM(n_input) AS n_input, SUM(n_output) AS n_output,
      SUM(n_cache_read) AS n_cache_read, SUM(n_cache_write) AS n_cache_write,
      SUM(n_requests) AS n_requests,
      MIN(first_ts) AS first_ts, MAX(last_ts) AS last_ts
    FROM (
    ${source.text}
    ) u GROUP BY ${groupBy} ORDER BY ${orderBy}`;
  return { text, params: source.params };
}
