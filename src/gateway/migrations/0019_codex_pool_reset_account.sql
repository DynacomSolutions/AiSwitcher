ALTER TABLE codex_pool_reset_attempts ADD COLUMN IF NOT EXISTS account_id text;

CREATE INDEX IF NOT EXISTS codex_pool_reset_attempt_identity
  ON codex_pool_reset_attempts (identity);

CREATE INDEX IF NOT EXISTS codex_pool_reset_attempt_account
  ON codex_pool_reset_attempts (account_id) WHERE account_id IS NOT NULL;
