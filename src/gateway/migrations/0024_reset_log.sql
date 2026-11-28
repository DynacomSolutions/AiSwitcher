-- Append-only log of every reset attempt, for every provider and trigger (manual and automatic).
-- No code deletes or rewrites a row, except one fill of `after` and `after_at` per row. Nothing prunes this table.
-- It holds no token, cookie or secret: `grant_id` is a credit or grant ID only.
CREATE TABLE IF NOT EXISTS reset_log (
  id bigserial PRIMARY KEY,
  -- When the attempt ended and the row was made.
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- When the attempt started. Null when unknown.
  started_at timestamptz,
  provider text NOT NULL CHECK (provider IN ('claude', 'codex')),
  trigger text NOT NULL CHECK (trigger IN ('manual', 'auto')),
  actor text NOT NULL,
  identity text NOT NULL,
  account text,
  pool text,
  grant_id text,
  -- A JSON array of usage windows from the latest reading before the reset: {key, label, percent, resetsAt}.
  before jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcome text NOT NULL CHECK (outcome IN ('reset', 'no_credit', 'already_redeemed', 'rejected', 'error')),
  message text,
  resets_left_after integer,
  -- The windows of the first usage reading that arrives after `at`. It is set once.
  after jsonb,
  after_at timestamptz
);

CREATE INDEX IF NOT EXISTS reset_log_at ON reset_log (at DESC, id DESC);
CREATE INDEX IF NOT EXISTS reset_log_identity_at ON reset_log (identity, at DESC, id DESC);
-- A partial index keeps the fill of `after` cheap. Only `reset` rows get an `after`.
CREATE INDEX IF NOT EXISTS reset_log_pending_after ON reset_log (provider, identity) WHERE after IS NULL AND outcome = 'reset';
