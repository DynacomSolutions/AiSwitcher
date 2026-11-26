CREATE TABLE IF NOT EXISTS reset_credit_invalidations (
  provider text NOT NULL,
  identity text NOT NULL,
  version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, identity)
);
