-- Phase 2: internal equipment structure (subsystem / main-component / sub-component).
-- Additive and idempotent only: no historical row is deleted, rewritten or re-parented.
-- Structural nodes reuse the existing `assets` registry rows (type='eq') with
-- ext->>'nodeKind' in ('subsystem','main-component','sub-component'); structural
-- profile fields live in the existing jsonb column `assets.ext`:
--   componentType, partNumber, brand, manufacturer, technicalSpecification,
--   structureNotes, requiredQuantity, inventoryItemId, nodeKind
-- No new table and no new column is required, so this migration only grants the
-- specialized structure permissions and adds read-side indexes.

BEGIN;

INSERT INTO role_permissions(role, permission) VALUES
  ('mgr','equipment.structure.view'),
  ('mgr','equipment.structure.create'),
  ('mgr','equipment.structure.update'),
  ('mgr','equipment.structure.move'),
  ('mgr','equipment.structure.move_cross_equipment'),
  ('mgr','equipment.structure.archive'),
  ('mgr','equipment.structure.suggest'),
  ('mgr','equipment.structure.approve_ai'),
  ('planner','equipment.structure.view'),
  ('planner','equipment.structure.create'),
  ('planner','equipment.structure.update'),
  ('planner','equipment.structure.move'),
  ('planner','equipment.structure.suggest'),
  ('store','equipment.structure.view'),
  ('op','equipment.structure.view'),
  ('hse','equipment.structure.view'),
  ('cal','equipment.structure.view')
ON CONFLICT (role, permission) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_assets_structure_parent
  ON assets(parent, sort_order, name)
  WHERE deleted_at IS NULL AND type='eq';

CREATE INDEX IF NOT EXISTS idx_assets_structure_kind
  ON assets((COALESCE(ext->>'nodeKind','equipment')), parent)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_assets_structure_inventory_item
  ON assets((ext->>'inventoryItemId'))
  WHERE deleted_at IS NULL AND ext->>'inventoryItemId' IS NOT NULL;

COMMIT;
