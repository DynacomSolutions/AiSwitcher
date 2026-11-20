-- The latest usage reading per provider and identity, shared by every gateway replica.
-- One replica polls the usage API and the others read this row, so a fleet polls each identity about once per TTL.
-- The reading is the PoolUsage figure only: no tokens and no secrets.
-- read_at and claimed_at use the database clock, so replica clock skew does not matter.
-- claimed_at marks the replica that is polling now. A claim row with no reading yet has read_at = epoch.
CREATE TABLE IF NOT EXISTS usage_readings (
  provider text NOT NULL,
  identity text NOT NULL,
  reading jsonb NOT NULL,
  read_at timestamptz NOT NULL,
  claimed_at timestamptz,
  PRIMARY KEY (provider, identity)
);
