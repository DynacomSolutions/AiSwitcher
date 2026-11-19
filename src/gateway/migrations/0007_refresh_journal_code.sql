-- A dead-grant answer is journalled with its OAuth code (outcome 'dead'). The code is a short public error name, never a token.
ALTER TABLE gateway_refresh_journal ADD COLUMN IF NOT EXISTS code text;
