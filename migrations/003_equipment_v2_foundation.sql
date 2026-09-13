BEGIN;

-- Phase 1 is additive. Existing columns and records remain untouched.
-- Repeat the non-destructive Equipment prerequisites so this guarded migration is
-- safe even when the canonical-data migration has not yet been applied.
CREATE TABLE IF NOT EXISTS asset_categories (
  id TEXT PRIMARY KEY,
  factory_asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(factory_asset_id, code),
  UNIQUE(factory_asset_id, name)
);
ALTER TABLE assets ADD COLUMN IF NOT EXISTS category_id TEXT REFERENCES asset_categories(id) ON DELETE SET NULL;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE assets ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS delete_reason TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS health_score NUMERIC(5,2) CHECK (health_score IS NULL OR (health_score >= 0 AND health_score <= 100));
ALTER TABLE assets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  rollout_percent SMALLINT NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
  allowed_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO feature_flags(key,enabled,rollout_percent,allowed_roles,metadata)
VALUES('equipment_v2',TRUE,100,'["admin","mgr","planner","tech","op","store","hse","cal"]'::jsonb,
       '{"phase":1,"fallback":"classic-equipment"}'::jsonb)
ON CONFLICT(key) DO NOTHING;

CREATE TABLE IF NOT EXISTS system_restore_points (
  id UUID PRIMARY KEY,
  scope TEXT NOT NULL,
  label TEXT NOT NULL,
  storage_path TEXT,
  checksum TEXT,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('creating','created','verified','failed','restored')),
  table_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_assets_parent_active_order ON assets(parent, is_active, sort_order) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assets_equipment_list ON assets(type, category_id, status, crit) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assets_search_lower_name ON assets(lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assets_updated_at ON assets(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pm_asset_last ON pm_plans(asset_id,last_run DESC);
CREATE INDEX IF NOT EXISTS idx_restore_points_scope_time ON system_restore_points(scope,created_at DESC);

COMMIT;
