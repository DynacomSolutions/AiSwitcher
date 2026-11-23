-- Session store: one row per transcript file (a tree node) and one row per stored part of its bytes.
-- Additive. The bodies live in object storage; Postgres holds the index and the cursor of each file.
CREATE TABLE IF NOT EXISTS ais_session_file (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  node            text NOT NULL,
  root            text NOT NULL,
  rel_path        text NOT NULL,
  generation      integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  kind            text NOT NULL,
  origin          text NOT NULL,
  pool            text,
  identity        text,
  session_ref     text NOT NULL,
  parent_ref      text,
  agent_name      text,
  title           text,
  cwd             text,
  project         text,
  model           text,
  started_at      timestamptz,
  updated_at      timestamptz,
  message_count   integer,
  -- The cursor. Always on a line end. Only SessionStore.ingest moves it.
  committed_bytes bigint NOT NULL DEFAULT 0 CHECK (committed_bytes >= 0),
  committed_lines bigint NOT NULL DEFAULT 0 CHECK (committed_lines >= 0),
  -- SHA-256 of the first min(4096, committed_bytes) bytes. A different value for a full 4 KiB head means a rewrite.
  head_sha256     text NOT NULL,
  indexed_bytes   bigint NOT NULL DEFAULT 0 CHECK (indexed_bytes >= 0),
  scan_state      jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_ingest_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (node, root, rel_path, generation)
);
CREATE INDEX IF NOT EXISTS ais_session_file_updated ON ais_session_file (updated_at DESC);
CREATE INDEX IF NOT EXISTS ais_session_file_kind_identity ON ais_session_file (kind, identity, updated_at DESC);
CREATE INDEX IF NOT EXISTS ais_session_file_session_ref ON ais_session_file (session_ref);
CREATE INDEX IF NOT EXISTS ais_session_file_parent_ref ON ais_session_file (parent_ref) WHERE parent_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS ais_session_file_project ON ais_session_file (project, updated_at DESC);
-- The enrichment queue: files whose new bytes the indexer has not read yet.
CREATE INDEX IF NOT EXISTS ais_session_file_unindexed ON ais_session_file (last_ingest_at) WHERE indexed_bytes < committed_bytes;

-- One row per part object. Parts of a file are contiguous: each start_offset equals the end_offset of the part before.
CREATE TABLE IF NOT EXISTS ais_session_part (
  file_id      bigint NOT NULL REFERENCES ais_session_file (id) ON DELETE CASCADE,
  start_offset bigint NOT NULL CHECK (start_offset >= 0),
  end_offset   bigint NOT NULL,
  lines        integer NOT NULL CHECK (lines >= 0),
  plain_bytes  bigint NOT NULL,
  object_bytes bigint NOT NULL CHECK (object_bytes >= 0),
  plain_sha256 text NOT NULL,
  object_key   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, start_offset),
  CHECK (end_offset > start_offset),
  CHECK (plain_bytes = end_offset - start_offset)
);

-- One node per session: the same session id in two folders (swap pool copies, sync copies) shows once.
CREATE OR REPLACE VIEW ais_session_tree AS
  SELECT DISTINCT ON (kind, identity, session_ref) *
  FROM ais_session_file
  ORDER BY kind, identity, session_ref, generation DESC, committed_bytes DESC, updated_at DESC NULLS LAST, id DESC;
