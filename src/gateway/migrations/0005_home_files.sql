-- Encrypted mirror of the gateway's login files (registries, account credential files, heartbeat, revoked markers),
-- keyed by their HOME-relative path. src/gateway/home-store.ts.
CREATE SEQUENCE IF NOT EXISTS gateway_home_files_version;

CREATE TABLE IF NOT EXISTS gateway_home_files (
  path text PRIMARY KEY,
  -- "tool/identity" for an account's login files, NULL otherwise.
  account text,
  kind text NOT NULL,
  -- AES-256-GCM: 12-byte nonce || ciphertext || 16-byte tag; AAD is the path.
  cipher bytea NOT NULL,
  -- sha256 of the plaintext (hex), to compare without decrypting.
  sha256 text NOT NULL,
  version bigint NOT NULL DEFAULT nextval('gateway_home_files_version'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL
);

CREATE INDEX IF NOT EXISTS gateway_home_files_account ON gateway_home_files (account);
CREATE INDEX IF NOT EXISTS gateway_home_files_version_idx ON gateway_home_files (version);
