CREATE TABLE IF NOT EXISTS gateway_apps (
  name text PRIMARY KEY,
  owner text NOT NULL,
  namespace text NOT NULL,
  provider text NOT NULL,
  style text NOT NULL,
  target jsonb NOT NULL,
  models jsonb,
  daily_tokens bigint,
  reserve_percent double precision,
  state text NOT NULL,
  created_at timestamptz NOT NULL,
  last_used_at timestamptz
);

CREATE TABLE IF NOT EXISTS gateway_tokens (
  id bigserial PRIMARY KEY,
  app text NOT NULL REFERENCES gateway_apps (name),
  prefix text NOT NULL,
  hash text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz
);

CREATE INDEX IF NOT EXISTS gateway_tokens_app_idx ON gateway_tokens (app);
CREATE INDEX IF NOT EXISTS gateway_tokens_hash_idx ON gateway_tokens (hash);

-- No primary key: a hypertable unique index must include the partition column.
-- The usage ledger is append-only and the app is not a foreign key so that a
-- buffered row can still be written after its app is removed.
CREATE TABLE IF NOT EXISTS gateway_usage (
  ts timestamptz NOT NULL,
  app text NOT NULL,
  provider text NOT NULL,
  identity text NOT NULL,
  model text,
  input_tokens bigint NOT NULL,
  output_tokens bigint NOT NULL,
  cache_read_tokens bigint NOT NULL,
  cache_write_tokens bigint NOT NULL,
  est_cost_usd double precision,
  status text NOT NULL,
  http_status integer NOT NULL,
  latency_ms integer NOT NULL,
  streamed boolean NOT NULL
);

CREATE INDEX IF NOT EXISTS gateway_usage_app_ts_idx ON gateway_usage (app, ts DESC);
