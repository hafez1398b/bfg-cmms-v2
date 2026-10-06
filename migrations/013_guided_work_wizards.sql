-- Guided request/work-order wizards, server-side drafts and secure request files.
-- Additive and rerunnable: existing operational values and files are not deleted.

BEGIN;

CREATE TABLE IF NOT EXISTS maintenance_wizard_drafts (
  id UUID PRIMARY KEY,
  wizard_type TEXT NOT NULL CHECK (wizard_type IN ('request','work_order')),
  draft JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(draft) = 'object'),
  step_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','cancelled')),
  target_entity_type TEXT,
  target_entity_id TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT REFERENCES users(id),
  row_version BIGINT NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_maintenance_wizard_drafts_owner
  ON maintenance_wizard_drafts(created_by, wizard_type, updated_at DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS failure_type TEXT;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS probable_causes JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS confirmed_root_cause TEXT;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS recommended_action TEXT;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS performed_action TEXT;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS required_parts JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS permit_status TEXT NOT NULL DEFAULT 'not_required';
UPDATE work_orders w SET permit_status=CASE WHEN p.status='active' AND p.approved_at IS NOT NULL
    AND (p.from_at IS NULL OR p.from_at<=now()) AND (p.to_at IS NULL OR p.to_at>=now()) THEN 'issued' ELSE 'pending_issuance' END,
  updated_at=now(),row_version=row_version+1
  FROM permits p WHERE w.ptw IS TRUE AND w.ptw_id=p.id AND w.permit_status='not_required';
UPDATE work_orders SET permit_status='pending_issuance',updated_at=now(),row_version=row_version+1
  WHERE ptw IS TRUE AND permit_status='not_required';

DO $$ BEGIN
  ALTER TABLE work_orders ADD CONSTRAINT work_orders_permit_status_check
    CHECK (permit_status IN ('not_required','pending_issuance','issued'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS request_files (
  id UUID PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL,
  upload_token UUID,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT REFERENCES users(id),
  row_version BIGINT NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_request_files_request
  ON request_files(request_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_request_files_upload_token
  ON request_files(request_id, upload_token)
  WHERE upload_token IS NOT NULL;

-- AI provider policies and routing are intentionally untouched.

COMMIT;
