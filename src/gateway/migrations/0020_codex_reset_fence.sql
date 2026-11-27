ALTER TABLE codex_pool_reset_attempts
  ADD COLUMN IF NOT EXISTS credited_id text,
  ADD COLUMN IF NOT EXISTS reservation_id uuid;

CREATE INDEX IF NOT EXISTS codex_pool_reset_reported_credit
  ON codex_pool_reset_attempts (credited_id) WHERE credited_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS codex_auto_reset_reported_credit
  ON codex_auto_reset_claims (credited_id) WHERE credited_id IS NOT NULL;
