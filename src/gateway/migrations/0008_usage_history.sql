-- Imported usage history (host transcript scans from before the gateway kept a ledger).
-- Append-only: rows are never deleted, and a re-import only raises a figure, never lowers it.
-- A null day is an all-time figure per model; a null model is a figure for all models of the day.
CREATE TABLE IF NOT EXISTS gateway_usage_history (
  source text NOT NULL,
  provider text NOT NULL,
  identity text NOT NULL,
  day date,
  model text,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  messages bigint NOT NULL DEFAULT 0,
  est_cost_usd double precision NOT NULL DEFAULT 0,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS gateway_usage_history_key_idx
  ON gateway_usage_history (source, provider, identity, (COALESCE(day, 'infinity'::date)), (COALESCE(model, '')));
