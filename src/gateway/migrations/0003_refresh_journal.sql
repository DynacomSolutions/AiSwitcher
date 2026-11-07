-- Refresh journal: one row per refresh claim. Only refresh-token fingerprints are stored, never a token.
CREATE TABLE IF NOT EXISTS gateway_refresh_journal (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  provider text NOT NULL,
  identity text NOT NULL,
  holder text NOT NULL,
  old_fp text NOT NULL,
  new_fp text,
  outcome text,
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS gateway_refresh_journal_account_idx ON gateway_refresh_journal (provider, identity, id DESC);
CREATE INDEX IF NOT EXISTS gateway_refresh_journal_fp_idx ON gateway_refresh_journal (provider, identity, old_fp);
