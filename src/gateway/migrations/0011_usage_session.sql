-- The client's own session id and tool family on each ledger row, so the console can show which accounts one session used.
-- Both columns are nullable and have no default: adding them rewrites nothing, and every older row keeps null.
-- No index: session reads are bounded by ts (chunk exclusion) and by session_key IS NOT NULL. An index on a large
-- hypertable would block ledger writes while it builds.
ALTER TABLE gateway_usage ADD COLUMN IF NOT EXISTS session_key text;
ALTER TABLE gateway_usage ADD COLUMN IF NOT EXISTS client text;
