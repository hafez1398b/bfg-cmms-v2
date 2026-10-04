-- Selene equipment-intake conversations. File bytes are not stored.
-- Additive and idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS equipment_import_sessions (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  equipment_id TEXT,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_equipment_import_sessions_user
  ON equipment_import_sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS equipment_import_messages (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES equipment_import_sessions(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  body TEXT NOT NULL,
  attachment JSONB,
  draft JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_equipment_import_messages_session
  ON equipment_import_messages(session_id, created_at);

UPDATE ai_provider_policies
SET allowed_purposes = allowed_purposes || '["equipment_intake"]'::jsonb
WHERE provider IN ('deepseek', 'local')
  AND NOT (allowed_purposes @> '["equipment_intake"]'::jsonb);

COMMIT;
