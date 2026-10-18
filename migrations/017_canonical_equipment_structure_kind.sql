-- Repair canonical structure kinds for the unique B1BT equipment tree.
--
-- The B1BT code is used only to identify the root. Every row below that root is selected by its
-- real assets.id/parent chain, and its canonical kind comes only from its relative depth. Display
-- names and descendant codes are never used for classification. Disconnected rows are not guessed
-- into this scope; only rows with a proven parent chain from B1BT can be repaired.
--
-- A duplicate/missing root, cycle, depth-four row, or broken chain aborts this migration. Existing
-- wrong non-empty structureKind values are intentionally repaired. The update changes only
-- ext.structureKind, row_version, and updated_at; all identity, relationship, history, and other
-- extension fields remain untouched. A second run is a no-op because already-canonical rows are
-- excluded by IS DISTINCT FROM.

BEGIN;

DO $migration_017_scope_guard$
DECLARE
  root_count bigint;
  root_identifier assets.id%TYPE;
  invalid_scope boolean;
  broken_parent_chain boolean;
BEGIN
  SELECT count(*) INTO root_count
  FROM assets AS root
  WHERE root.code='B1BT' AND root.type='eq' AND root.deleted_at IS NULL;

  IF root_count <> 1 THEN
    RAISE EXCEPTION 'Migration 017 requires exactly one active B1BT equipment root; found %', root_count
      USING ERRCODE='P0001';
  END IF;

  SELECT root.id INTO root_identifier
  FROM assets AS root
  WHERE root.code='B1BT' AND root.type='eq' AND root.deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Migration 017 could not lock the active B1BT equipment root'
      USING ERRCODE='P0001';
  END IF;

  WITH RECURSIVE structure AS (
    SELECT root.id AS root_id,root.id,root.parent,root.type,0::integer AS depth,
           ARRAY[root.id]::text[] AS path,false AS cycle
    FROM assets AS root
    WHERE root.id=root_identifier
    UNION ALL
    SELECT structure.root_id,child.id,child.parent,child.type,structure.depth+1,
           structure.path||child.id,child.id=ANY(structure.path)
    FROM assets AS child
    JOIN structure ON child.parent=structure.id
    WHERE child.type='eq'
      AND structure.depth<4
      AND NOT structure.cycle
  )
  SELECT
    EXISTS(SELECT 1 FROM structure WHERE cycle OR depth>3),
    EXISTS(
      SELECT 1
      FROM structure AS child
      LEFT JOIN structure AS parent
        ON parent.root_id=child.root_id
       AND parent.id=child.parent
       AND parent.depth=child.depth-1
      WHERE child.depth>0
        AND (parent.id IS NULL OR cardinality(child.path)<>child.depth+1)
    )
  INTO invalid_scope,broken_parent_chain;

  IF invalid_scope THEN
    RAISE EXCEPTION 'Migration 017 rejected the B1BT tree: cycle or depth greater than three'
      USING ERRCODE='P0001';
  END IF;

  IF broken_parent_chain THEN
    RAISE EXCEPTION 'Migration 017 rejected the B1BT tree: broken parent chain'
      USING ERRCODE='P0001';
  END IF;
END
$migration_017_scope_guard$;

WITH RECURSIVE root_equipment AS (
  SELECT root.id,root.code,root.parent,root.type,root.ext
  FROM assets AS root
  WHERE root.code='B1BT'
    AND root.type='eq'
    AND root.deleted_at IS NULL
    AND (SELECT count(*) FROM assets AS duplicate_root
         WHERE duplicate_root.code='B1BT'
           AND duplicate_root.type='eq'
           AND duplicate_root.deleted_at IS NULL)=1
), structure AS (
  SELECT root.id AS root_id,root.id,root.parent,root.type,root.ext,
         0::integer AS depth,ARRAY[root.id]::text[] AS path,false AS cycle
  FROM root_equipment AS root
  UNION ALL
  SELECT structure.root_id,child.id,child.parent,child.type,child.ext,
         structure.depth+1,structure.path||child.id,child.id=ANY(structure.path)
  FROM assets AS child
  JOIN structure ON child.parent=structure.id
  WHERE child.type='eq'
    AND structure.depth<4
    AND NOT structure.cycle
), proposed AS (
  SELECT node.id,
         CASE node.depth
           WHEN 0 THEN 'equipment'
           WHEN 1 THEN 'subsystem'
           WHEN 2 THEN 'main-component'
           WHEN 3 THEN 'sub-component'
         END AS canonical_kind
  FROM structure AS node
  WHERE node.type='eq'
    AND node.depth BETWEEN 0 AND 3
    AND NOT node.cycle
)
UPDATE assets AS target
SET ext=COALESCE(target.ext,'{}'::jsonb)||jsonb_build_object('structureKind',proposed.canonical_kind),
    row_version=target.row_version+1,
    updated_at=now()
FROM proposed
WHERE target.id=proposed.id
  AND target.type='eq'
  AND NULLIF(target.ext->>'structureKind','') IS DISTINCT FROM proposed.canonical_kind;

COMMIT;
