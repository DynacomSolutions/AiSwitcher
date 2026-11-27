-- Automatic reset is a pool setting for every provider. The old Codex table keeps its name for claims.
CREATE TABLE IF NOT EXISTS auto_reset_settings (
  provider text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL,
  PRIMARY KEY (provider, name)
);

INSERT INTO auto_reset_settings (provider, name, enabled)
  SELECT 'codex', name, enabled FROM codex_auto_reset_settings WHERE kind = 'pool'
  ON CONFLICT DO NOTHING;

-- Identity permissions are gone. This table records which ones existed. They never become pool settings.
CREATE TABLE IF NOT EXISTS auto_reset_dropped_identity_settings (
  provider text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL,
  dropped_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider, name)
);

INSERT INTO auto_reset_dropped_identity_settings (provider, name, enabled)
  SELECT 'codex', name, enabled FROM codex_auto_reset_settings WHERE kind = 'identity'
  ON CONFLICT DO NOTHING;

DELETE FROM codex_auto_reset_settings WHERE kind = 'identity';

ALTER TABLE codex_auto_reset_claims ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'codex';

CREATE INDEX IF NOT EXISTS auto_reset_claims_provider_pool
  ON codex_auto_reset_claims (provider, pool, started_at DESC, event_key, generation DESC);
CREATE INDEX IF NOT EXISTS auto_reset_claims_provider_identity
  ON codex_auto_reset_claims (provider, identity, started_at DESC, event_key, generation DESC);
