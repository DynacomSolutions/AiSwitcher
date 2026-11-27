-- Automatic reset is a pool setting for every provider. This table holds the rules of providers other than Codex.
CREATE TABLE IF NOT EXISTS auto_reset_settings (
  provider text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL,
  PRIMARY KEY (provider, name)
);

-- Codex pool rules stay in codex_auto_reset_settings. This migration copies and rewrites no rule.
-- Old identity rows stay there too. No query reads them, so they have no effect.

ALTER TABLE codex_auto_reset_claims ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'codex';

CREATE INDEX IF NOT EXISTS auto_reset_claims_provider_pool
  ON codex_auto_reset_claims (provider, pool, started_at DESC, event_key, generation DESC);
CREATE INDEX IF NOT EXISTS auto_reset_claims_provider_identity
  ON codex_auto_reset_claims (provider, identity, started_at DESC, event_key, generation DESC);
