-- Controlled Selene drafts and one-time confirmations. File bytes are not stored.
-- Additive and idempotent. Selene does not write equipment rows from this migration.

BEGIN;

CREATE TABLE IF NOT EXISTS selene_action_drafts (
  id UUID PRIMARY KEY,
  action_type TEXT NOT NULL,
  destination TEXT NOT NULL,
  proposed JSONB NOT NULL,
  source JSONB NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence NUMERIC,
  missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  conflicting_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL,
  record_version BIGINT,
  target_id TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT selene_action_drafts_status CHECK (status IN ('incomplete', 'conflict', 'pending', 'rejected', 'executed'))
);

CREATE INDEX IF NOT EXISTS idx_selene_action_drafts_user
  ON selene_action_drafts(created_by, updated_at DESC);

CREATE TABLE IF NOT EXISTS selene_action_confirmations (
  id UUID PRIMARY KEY,
  draft_id UUID NOT NULL REFERENCES selene_action_drafts(id),
  user_id TEXT NOT NULL,
  record_version BIGINT,
  request_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_selene_action_request
  ON selene_action_confirmations(request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_selene_action_confirmations_draft
  ON selene_action_confirmations(draft_id, created_at DESC);

COMMIT;
