-- Version-bound Selene confirmations and per-command review evidence. No asset backfill.
BEGIN;
ALTER TABLE selene_action_confirmations ADD COLUMN IF NOT EXISTS draft_version bigint;
ALTER TABLE selene_action_confirmations ADD COLUMN IF NOT EXISTS state_hash text;
ALTER TABLE audit_x ADD COLUMN IF NOT EXISTS review jsonb;
COMMIT;
