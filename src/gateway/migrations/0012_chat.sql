-- Side-panel chats: one row per chat, plus an ordered event log. A replica owns a chat through its lease. The epoch grows on each acquire and fences stale owners.
CREATE TABLE IF NOT EXISTS gateway_chats (
  id             text PRIMARY KEY,
  binding        text NOT NULL,
  window_id      integer NOT NULL,
  name           text NOT NULL,
  color          text NOT NULL,
  selection      jsonb NOT NULL,
  state          text NOT NULL DEFAULT 'starting',
  tab_ids        jsonb NOT NULL DEFAULT '[]'::jsonb,
  acp_session_id text,
  pod_session    text,
  can_load       boolean,
  owner_replica  text,
  lease_until    timestamptz,
  epoch          bigint NOT NULL DEFAULT 0,
  last_seq       bigint NOT NULL DEFAULT 0,
  generation     integer NOT NULL DEFAULT 0,
  created_at     bigint NOT NULL,
  updated_at     bigint NOT NULL,
  closed_at      bigint
);
CREATE INDEX IF NOT EXISTS gateway_chats_binding_state ON gateway_chats (binding, state);

CREATE TABLE IF NOT EXISTS gateway_chat_events (
  chat_id text NOT NULL REFERENCES gateway_chats (id) ON DELETE CASCADE,
  seq     bigint NOT NULL,
  ts      bigint NOT NULL,
  body    jsonb NOT NULL,
  PRIMARY KEY (chat_id, seq)
);
