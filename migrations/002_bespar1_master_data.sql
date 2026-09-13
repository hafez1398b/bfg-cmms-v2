BEGIN;

-- Organizational category is intentionally separate from functional location.
-- A factory has many categories; each asset belongs to one category.
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
ALTER TABLE assets ADD COLUMN IF NOT EXISTS requires_coding BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ext JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS recurring BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS source_ref TEXT;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS ext JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Data-quality fields make provisional 1405 values explicit and queryable.
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS confirmation_status TEXT NOT NULL DEFAULT 'confirmed';
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS provisional_fields JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS period_label TEXT;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS asset_spare_parts (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL DEFAULT 'key-spare',
  quantity_required NUMERIC,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(asset_id, item_id)
);

-- A WO can have one primary asset and additional related/candidate assets.
CREATE TABLE IF NOT EXISTS work_order_assets (
  work_order_id TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('primary','related','candidate')),
  is_confirmed BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(work_order_id, asset_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_asset_categories_factory ON asset_categories(factory_asset_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_assets_category ON assets(category_id);
CREATE INDEX IF NOT EXISTS idx_wo_confirmation ON work_orders(confirmation_status) WHERE confirmation_status <> 'confirmed';
CREATE INDEX IF NOT EXISTS idx_wo_period_label ON work_orders(period_label);
CREATE INDEX IF NOT EXISTS idx_wo_assets_asset ON work_order_assets(asset_id);

COMMIT;
