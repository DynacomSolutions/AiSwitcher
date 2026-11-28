-- Response and request metadata on each ledger row: time to first byte, why the model stopped, and tool-call counts.
-- Metadata only. The ledger never holds a prompt, an answer, a tool input or a tool result.
-- Every column is nullable and has no default: adding them rewrites nothing, and every older row keeps null.
-- tool_names is a JSON array of at most 32 distinct names, each at most 64 characters, stored as text (read it with tool_names::jsonb).
-- No index: reads are bounded by ts (chunk exclusion). An index on a large hypertable would block ledger writes while it builds.
ALTER TABLE gateway_usage ADD COLUMN IF NOT EXISTS ttfb_ms integer;
ALTER TABLE gateway_usage ADD COLUMN IF NOT EXISTS stop_reason text;
ALTER TABLE gateway_usage ADD COLUMN IF NOT EXISTS tool_calls integer;
ALTER TABLE gateway_usage ADD COLUMN IF NOT EXISTS tool_names text;
ALTER TABLE gateway_usage ADD COLUMN IF NOT EXISTS tool_errors integer;
