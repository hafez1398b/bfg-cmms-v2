-- Mission D4 / Phase 3: critical spare parts lifecycle in the equipment dossier.
-- Additive and idempotent only: existing asset_spare_parts links keep their data and gain
-- optimistic-concurrency + soft-archive (حذف نرم) lifecycle columns. No row is removed or
-- rewritten, no inventory item is created, and stock stays in item_balances/inventory_ledger.

BEGIN;

ALTER TABLE asset_spare_parts ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE asset_spare_parts ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id);
ALTER TABLE asset_spare_parts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE asset_spare_parts ADD COLUMN IF NOT EXISTS updated_by TEXT REFERENCES users(id);
ALTER TABLE asset_spare_parts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE asset_spare_parts ADD COLUMN IF NOT EXISTS deleted_by TEXT REFERENCES users(id);
ALTER TABLE asset_spare_parts ADD COLUMN IF NOT EXISTS delete_reason TEXT;

INSERT INTO role_permissions(role, permission) VALUES
  ('mgr','equipment.spares.view'),
  ('mgr','equipment.spares.create'),
  ('mgr','equipment.spares.update'),
  ('mgr','equipment.spares.archive'),
  ('mgr','equipment.spares.suggest'),
  ('mgr','equipment.spares.approve_ai'),
  ('planner','equipment.spares.view'),
  ('planner','equipment.spares.create'),
  ('planner','equipment.spares.update'),
  ('planner','equipment.spares.suggest'),
  ('store','equipment.spares.view'),
  ('op','equipment.spares.view'),
  ('hse','equipment.spares.view'),
  ('cal','equipment.spares.view')
ON CONFLICT (role, permission) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_asset_spare_parts_active
  ON asset_spare_parts(asset_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_asset_spare_parts_item
  ON asset_spare_parts(item_id);

COMMIT;
