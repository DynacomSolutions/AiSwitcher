CREATE TABLE IF NOT EXISTS browser_bindings (
  name text PRIMARY KEY,
  target jsonb NOT NULL,
  profile_label text NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz
);

CREATE TABLE IF NOT EXISTS browser_tokens (
  id bigserial PRIMARY KEY,
  binding text NOT NULL REFERENCES browser_bindings (name),
  prefix text NOT NULL,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS browser_tokens_binding_idx ON browser_tokens (binding);
CREATE INDEX IF NOT EXISTS browser_tokens_prefix_idx ON browser_tokens (prefix);

CREATE TABLE IF NOT EXISTS browser_pairings (
  code text PRIMARY KEY,
  profile_label text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  poll_secret_hash text NOT NULL,
  approved_binding text,
  token_delivered boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS browser_agent_tokens (
  id bigserial PRIMARY KEY,
  identity text NOT NULL,
  prefix text NOT NULL,
  hash text NOT NULL,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS browser_agent_tokens_prefix_idx ON browser_agent_tokens (prefix);
CREATE INDEX IF NOT EXISTS browser_agent_tokens_identity_idx ON browser_agent_tokens (identity);
