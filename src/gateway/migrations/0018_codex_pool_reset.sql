CREATE TABLE IF NOT EXISTS codex_pool_reset_attempts (
  credit_id text PRIMARY KEY,
  redeem_request_id uuid NOT NULL UNIQUE,
  identity text,
  consumed_at timestamptz,
  version bigint,
  baseline jsonb
);

ALTER TABLE reset_credit_invalidations
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_version bigint;

CREATE INDEX IF NOT EXISTS codex_pool_reset_awaiting_usage
  ON codex_pool_reset_attempts (identity, consumed_at)
  WHERE baseline IS NOT NULL;
