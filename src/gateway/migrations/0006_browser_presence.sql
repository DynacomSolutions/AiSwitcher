-- Which replica holds each browser extension socket (one row per binding, refreshed by its replica).
CREATE TABLE IF NOT EXISTS gateway_browser_presence (
  binding           text PRIMARY KEY,
  replica_id        text NOT NULL,
  replica_url       text NOT NULL,
  binding_json      jsonb NOT NULL,
  extension_version text,
  paused            boolean,
  attached_at       timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
