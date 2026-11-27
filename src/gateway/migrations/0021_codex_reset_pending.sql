ALTER TABLE codex_pool_reset_attempts ADD COLUMN IF NOT EXISTS outcome text
  CHECK (outcome IS NULL OR (credited_id IS NOT NULL AND outcome IN ('reset', 'nothing_to_reset', 'no_credit', 'already_redeemed')));

ALTER TABLE codex_auto_reset_claims
  ADD COLUMN IF NOT EXISTS account_id text,
  ADD COLUMN IF NOT EXISTS provider_outcome text
    CHECK (provider_outcome IS NULL OR (credited_id IS NOT NULL AND provider_outcome IN ('reset', 'nothing_to_reset', 'no_credit', 'already_redeemed'))),
  ADD COLUMN IF NOT EXISTS spend_pending boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS codex_auto_reset_pending_identity ON codex_auto_reset_claims (identity) WHERE spend_pending;
CREATE INDEX IF NOT EXISTS codex_auto_reset_pending_account ON codex_auto_reset_claims (account_id) WHERE spend_pending;
