-- Continuous aggregate over the usage ledger: one row per 15 minutes, provider,
-- identity, app and model. Wide-range usage reads sum these rows, not the raw ledger.
-- Real-time aggregation stays on: the part not yet materialised is read from gateway_usage.
-- WITH NO DATA is required, because the migrator runs inside a transaction.
-- The refresh policy re-materialises every invalidated range in all history,
-- so a late insert (for example after a ledger outage) shows within minutes.
-- The migrator runs this file only when gateway_usage is a hypertable.
CREATE MATERIALIZED VIEW IF NOT EXISTS gateway_usage_15m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '15 minutes', ts) AS bucket,
  provider,
  identity,
  app,
  model,
  sum(input_tokens) AS input_tokens,
  sum(output_tokens) AS output_tokens,
  sum(cache_read_tokens) AS cache_read_tokens,
  sum(cache_write_tokens) AS cache_write_tokens,
  sum(est_cost_usd) AS est_cost_usd,
  count(*) AS requests,
  sum(input_tokens) FILTER (WHERE est_cost_usd IS NULL) AS n_input,
  sum(output_tokens) FILTER (WHERE est_cost_usd IS NULL) AS n_output,
  sum(cache_read_tokens) FILTER (WHERE est_cost_usd IS NULL) AS n_cache_read,
  sum(cache_write_tokens) FILTER (WHERE est_cost_usd IS NULL) AS n_cache_write,
  count(*) FILTER (WHERE est_cost_usd IS NULL) AS n_requests,
  min(ts) AS first_ts,
  max(ts) AS last_ts
FROM gateway_usage
GROUP BY time_bucket(INTERVAL '15 minutes', ts), provider, identity, app, model
WITH NO DATA;

-- end_offset keeps the last hour in the real-time tail: a long streamed request
-- is logged with a ts well before its insert time.
SELECT add_continuous_aggregate_policy('gateway_usage_15m',
  start_offset => NULL,
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists => true);
