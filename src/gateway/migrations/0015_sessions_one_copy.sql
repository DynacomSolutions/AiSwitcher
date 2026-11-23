-- One copy per session. A session is named by its tool and its session id, not by the host path that held it.
-- The same session in two folders (swap pool copies, sync copies, two nodes) is stored once.
-- ais_session_path records every path that held it. The node, root and rel_path columns of ais_session_file stay
-- as the path that stored the session first.
CREATE TABLE IF NOT EXISTS ais_session_path (
  file_id       bigint NOT NULL REFERENCES ais_session_file (id) ON DELETE CASCADE,
  node          text NOT NULL,
  root          text NOT NULL,
  rel_path      text NOT NULL,
  origin        text NOT NULL,
  pool          text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, node, root, rel_path)
);
CREATE INDEX IF NOT EXISTS ais_session_path_where ON ais_session_path (node, root, rel_path);

INSERT INTO ais_session_path (file_id, node, root, rel_path, origin, pool, first_seen_at, last_seen_at)
  SELECT id, node, root, rel_path, origin, pool, last_ingest_at, last_ingest_at FROM ais_session_file
ON CONFLICT DO NOTHING;

-- Rows of one session and generation that exist already (no writer made any before this migration): keep the one with
-- the most bytes, move its twins' paths to it, and drop the twins.
WITH ranked AS (
  SELECT id,
         first_value(id) OVER w AS keep_id,
         row_number() OVER w AS rn
    FROM ais_session_file
  WINDOW w AS (PARTITION BY kind, session_ref, generation ORDER BY committed_bytes DESC, id DESC)
)
UPDATE ais_session_path p SET file_id = r.keep_id FROM ranked r WHERE p.file_id = r.id AND r.rn > 1;

DELETE FROM ais_session_file f
 USING (
   SELECT id, row_number() OVER (PARTITION BY kind, session_ref, generation ORDER BY committed_bytes DESC, id DESC) AS rn
     FROM ais_session_file
 ) r
 WHERE f.id = r.id AND r.rn > 1;

ALTER TABLE ais_session_file DROP CONSTRAINT IF EXISTS ais_session_file_node_root_rel_path_generation_key;
CREATE UNIQUE INDEX IF NOT EXISTS ais_session_file_session_generation ON ais_session_file (kind, session_ref, generation);

-- One node per session: the newest generation, then the most bytes.
DROP VIEW IF EXISTS ais_session_tree;
CREATE VIEW ais_session_tree AS
  SELECT DISTINCT ON (kind, session_ref) *
  FROM ais_session_file
  ORDER BY kind, session_ref, generation DESC, committed_bytes DESC, updated_at DESC NULLS LAST, id DESC;
