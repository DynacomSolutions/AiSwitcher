-- Imported usage history (host transcript scans from before the gateway kept a ledger).
-- Append-only: rows are never deleted. A new generation (the host snapshot's generation time) adds rows;
-- importing the same generation again replaces exactly the rows of that generation (idempotent), so a
-- correction is a new generation and the older figures stay.
-- A null day is an all-time figure per model; a null model is a figure for all models of the day.
--
-- SOURCES MUST NEVER BE SUMMED TOGETHER. Each source is a different cut of the same usage:
--   host-snapshot-models       all-time totals per model (day is null). Cost and tokens.
--   host-snapshot-daily        cost, tokens and messages per day (model is null).
--   host-snapshot-daily-tokens per day, tokens only, for results the host has no cost per day for.
--                              input_tokens holds the day's total tokens (the split is unknown). Cost is 0, not a real cost.
-- Readers pick one source and, by default, its latest generation.
--
-- first_day and last_day are the first and last day the imported result covers, in the time zone `zone`
-- (the host bucket zone, an IANA name). A reader trims the overlap with the live gateway ledger with them.
CREATE TABLE IF NOT EXISTS gateway_usage_history (
  source text NOT NULL,
  generation timestamptz NOT NULL,
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
  first_day date,
  last_day date,
  zone text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS gateway_usage_history_key_idx
  ON gateway_usage_history (source, generation, provider, identity, (COALESCE(day, 'infinity'::date)), (COALESCE(model, '')));
