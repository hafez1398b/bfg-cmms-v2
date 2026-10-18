-- Digital equipment profile foundation. Additive only: existing assets/ext/history are preserved.
-- The legacy `install` text column remains readable for compatibility; new wizard dates
-- are stored as DATE in `install_date` without rewriting existing text values.

BEGIN;

ALTER TABLE assets ADD COLUMN IF NOT EXISTS activity_type TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS manufacturer_country TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS install_date DATE;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS operational_status TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS responsible_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS general_notes TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS record_status TEXT NOT NULL DEFAULT 'complete';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS updated_by TEXT REFERENCES users(id) ON DELETE SET NULL;

DO $$ BEGIN
  ALTER TABLE assets ADD CONSTRAINT assets_record_status_check
    CHECK (record_status IN ('draft','complete'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_assets_record_status_active
  ON assets(record_status, updated_at DESC)
  WHERE deleted_at IS NULL;

COMMIT;
