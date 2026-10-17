-- Canonicalize the known B1BT structure without changing registry identity or historical links.
--
-- assets.ext->>'nodeKind' remains the existing registry classification. The canonical dossier
-- kind is stored separately in ext->>'structureKind', so B1BT9955 and B1BT catali remain
-- type='eq' registry records, while their position in B1BT's tree is level 1 (subsystem).
-- MM.J and JHBJHV are only repaired when their real parent chain proves levels 2 and 3.
--
-- Safe to rerun: only rows whose structureKind is missing are changed. Existing non-empty
-- structureKind conflicts, a cycle, or any level-four row blocks that row/scope from repair.
-- No ids, codes, names, type values, parent links, history JSON, or audit rows are deleted or
-- rewritten. Registry nodeKind and all unrelated ext keys are preserved.

BEGIN;

WITH RECURSIVE root_equipment AS (
  SELECT root.id,root.code
  FROM assets root
  WHERE root.code='B1BT' AND root.type='eq' AND root.deleted_at IS NULL
    AND (SELECT count(*) FROM assets duplicate_root
         WHERE duplicate_root.code='B1BT' AND duplicate_root.type='eq' AND duplicate_root.deleted_at IS NULL)=1
), structure AS (
  SELECT root.id AS root_id,root.id,root.parent,root.code,root.type,root.ext,0 AS depth,
         ARRAY[root.id]::text[] AS path,false AS cycle
  FROM root_equipment root
  UNION ALL
  SELECT structure.root_id,child.id,child.parent,child.code,child.type,child.ext,structure.depth+1,
         structure.path||child.id,child.id=ANY(structure.path)
  FROM assets child
  JOIN structure ON child.parent=structure.id
  WHERE child.type='eq'
    AND structure.depth<4 AND NOT structure.cycle
), safe_root AS (
  SELECT root.id
  FROM root_equipment root
  WHERE NOT EXISTS (
    SELECT 1 FROM structure
    WHERE structure.root_id=root.id
      AND (structure.depth>3 OR structure.cycle
        OR (NULLIF(structure.ext->>'structureKind','') IS NOT NULL
          AND NULLIF(structure.ext->>'structureKind','') IS DISTINCT FROM
            CASE structure.depth
              WHEN 0 THEN 'equipment'
              WHEN 1 THEN 'subsystem'
              WHEN 2 THEN 'main-component'
              WHEN 3 THEN 'sub-component'
              ELSE NULL
            END))
  )
), proposed AS (
  SELECT node.id,
         CASE
           WHEN node.code IN ('B1BT catali','B1BT9955') THEN 'subsystem'
           WHEN node.code='MM.J' THEN 'main-component'
           WHEN node.code='JHBJHV' THEN 'sub-component'
         END AS canonical_kind
  FROM structure node
  JOIN structure parent ON parent.id=node.parent AND parent.root_id=node.root_id
  JOIN safe_root ON safe_root.id=node.root_id
  WHERE
    ((node.code IN ('B1BT catali','B1BT9955')
      AND node.depth=1 AND parent.depth=0 AND parent.code='B1BT')
     OR (node.code='MM.J'
      AND node.depth=2 AND parent.depth=1 AND parent.code IN ('B1BT catali','B1BT9955'))
     OR (node.code='JHBJHV'
      AND node.depth=3 AND parent.depth=2 AND parent.code='MM.J'))
    AND (SELECT count(*) FROM structure duplicate
         WHERE duplicate.root_id=node.root_id AND duplicate.depth=node.depth
           AND duplicate.parent IS NOT DISTINCT FROM node.parent AND duplicate.code=node.code)=1
)
UPDATE assets AS target
SET ext=COALESCE(target.ext,'{}'::jsonb)||jsonb_build_object('structureKind',proposed.canonical_kind),
    row_version=target.row_version+1,
    updated_at=now()
FROM proposed
WHERE target.id=proposed.id
  AND target.type='eq'
  AND target.deleted_at IS NULL
  AND NULLIF(target.ext->>'structureKind','') IS DISTINCT FROM proposed.canonical_kind
  AND (NULLIF(target.ext->>'structureKind','') IS NULL
       OR target.ext->>'structureKind'=proposed.canonical_kind);
COMMIT;
