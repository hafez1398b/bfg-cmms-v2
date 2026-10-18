-- Phase 2 correction: backfill ext->>'nodeKind' for real equipment records created before the
-- digital dossier existed.
--
-- Why this is needed:
--   Legacy assets rows with type='eq' never stored ext->>'nodeKind'; only location rows
--   (factory/site/area/line/unit/category) carry an explicit nodeKind. The comprehensive
--   registry has always read those assets as equipment through
--   COALESCE(ext->>'nodeKind','equipment'), but the structure resolver filtered on the raw
--   value, so an existing equipment dossier answered ROOT_EQUIPMENT_NOT_FOUND.
--
-- Guarantees:
--   * Additive: only a missing/empty key is filled, an existing value is never rewritten.
--   * Re-runnable: after one successful run the WHERE clause matches nothing.
--   * Non-destructive: no row is deleted, re-parented or renamed; the parent column is only read.
--   * No fabricated relation: the value is derived from the row's own real type='eq' plus its
--     real existing parent chain. An equipment row that already sits under another equipment row
--     is left untouched, keeps its real position and stays visible through the runtime diagnostics.

BEGIN;

WITH RECURSIVE equipment_ancestry AS (
  -- Anchor: only the assets rows that still need a nodeKind. Existing values are never touched.
  SELECT a.id AS candidate_id,
         a.parent AS current_id,
         0 AS depth,
         ARRAY[a.id]::text[] AS path,
         false AS has_equipment_ancestor
  FROM assets a
  WHERE a.type='eq'
    AND a.deleted_at IS NULL
    AND NULLIF(a.ext->>'nodeKind','') IS NULL
  UNION ALL
  -- Walk the real parent chain and remember whether an equipment ancestor exists.
  SELECT equipment_ancestry.candidate_id,
         p.parent,
         equipment_ancestry.depth+1,
         equipment_ancestry.path||p.id,
         equipment_ancestry.has_equipment_ancestor
           OR (p.type='eq'
               AND COALESCE(NULLIF(p.ext->>'nodeKind',''),'equipment') IN ('equipment','sub-equipment'))
  FROM assets p
  JOIN equipment_ancestry ON equipment_ancestry.current_id=p.id
  WHERE equipment_ancestry.depth<64
    AND NOT p.id=ANY(equipment_ancestry.path)
), root_equipment AS (
  SELECT candidate_id AS id
  FROM equipment_ancestry
  GROUP BY candidate_id
  HAVING bool_or(has_equipment_ancestor)=false
)
UPDATE assets
SET ext=COALESCE(assets.ext,'{}'::jsonb) || jsonb_build_object('nodeKind','equipment'),
    updated_at=now()
FROM root_equipment
WHERE assets.id=root_equipment.id
  AND assets.type='eq'
  AND assets.deleted_at IS NULL
  AND NULLIF(assets.ext->>'nodeKind','') IS NULL;

CREATE INDEX IF NOT EXISTS idx_assets_structure_root_equipment
  ON assets((COALESCE(NULLIF(ext->>'nodeKind',''),'equipment')), parent)
  WHERE deleted_at IS NULL AND type='eq';

COMMIT;
