CREATE TABLE IF NOT EXISTS codex_auto_reset_settings (
  kind text NOT NULL CHECK (kind IN ('pool', 'identity')),
  name text NOT NULL,
  enabled boolean NOT NULL,
  PRIMARY KEY (kind, name)
);

CREATE TABLE IF NOT EXISTS codex_auto_reset_claims (
  event_key text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  pool text NOT NULL,
  identity text NOT NULL,
  credit_id text NOT NULL UNIQUE,
  credit_expires_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  provider_429_at timestamptz,
  redeem_request_id uuid NOT NULL UNIQUE,
  members text[] NOT NULL,
  usage_evidence jsonb NOT NULL,
  credit_evidence jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reset', 'rejected', 'unknown')),
  credited_id text,
  outcome text,
  finished_at timestamptz,
  recovered_at timestamptz,
  PRIMARY KEY (event_key, generation)
);

CREATE INDEX IF NOT EXISTS codex_auto_reset_recent ON codex_auto_reset_claims (recorded_at);
CREATE INDEX IF NOT EXISTS codex_auto_reset_pool_latest ON codex_auto_reset_claims (pool, started_at DESC, event_key, generation DESC);
CREATE INDEX IF NOT EXISTS codex_auto_reset_identity_latest ON codex_auto_reset_claims (identity, started_at DESC, event_key, generation DESC);
