'use strict';

/**
 * Read-only canonical diagnosis of equipment identity and depth-based dossier structure.
 *
 * It performs SELECT queries only. It never applies a migration or changes any row. It reports
 * the resolved root, real depth, stored and canonical kinds, conflicts, and evidence-limited
 * repair proposals, while retaining the existing registry, parent, permission, and history checks.
 *
 * Usage:
 *   node scripts/diagnose-equipment-structure.js B1BT
 *   node scripts/diagnose-equipment-structure.js B1BT9955   # containing structure root
 *   node scripts/diagnose-equipment-structure.js            # defaults to B1BT
 */

const CANONICAL_DEPTH_KINDS = Object.freeze({ 0: 'equipment', 1: 'subsystem', 2: 'main-component', 3: 'sub-component' });
const INTERNAL_KINDS = new Set(['sub-equipment', 'subsystem', 'main-component', 'sub-component', 'sub', 'sys', 'panel']);
const KNOWN_REPAIRS = Object.freeze({
  'B1BT catali': { kind: 'subsystem', depth: 1, parentCodes: ['B1BT'] },
  B1BT9955: { kind: 'subsystem', depth: 1, parentCodes: ['B1BT'] },
  'MM.J': { kind: 'main-component', depth: 2, parentCodes: ['B1BT catali', 'B1BT9955'] },
  JHBJHV: { kind: 'sub-component', depth: 3, parentCodes: ['MM.J'] }
});
const ROW = '----------------------------------------------------------------------------------------------------------------';

function value(row, key) {
  const raw = row && row[key];
  if (raw === null || raw === undefined) return 'NULL';
  if (typeof raw === 'object') return JSON.stringify(raw);
  return String(raw);
}

function extOf(row) {
  if (row && row.ext && typeof row.ext === 'object' && !Array.isArray(row.ext)) return row.ext;
  if (row && typeof row.ext === 'string') {
    try { const parsed = JSON.parse(row.ext); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
    catch (_) { return {}; }
  }
  return {};
}

function registryKindOf(row) {
  const raw = extOf(row).nodeKind;
  return raw == null || raw === '' ? null : String(raw);
}

function storedStructureKindOf(row) {
  const raw = extOf(row).structureKind;
  return raw == null || raw === '' ? null : String(raw);
}

function nodeKindOf(row) { return registryKindOf(row); }
function effectiveKind(row) { return nodeKindOf(row) || (row && row.type === 'eq' ? 'equipment' : 'location'); }

function registryListsIt(row, parentRow = null) {
  if (!row || row.type !== 'eq' || row.deleted_at) return false;
  const internalKind = INTERNAL_KINDS.has(effectiveKind(row));
  const directEquipmentParent = !!(parentRow && parentRow.type === 'eq' && !parentRow.deleted_at);
  const parentKind = parentRow
    ? String(parentRow.node_kind || registryKindOf(parentRow) || (parentRow.type === 'eq' ? 'equipment' : 'location')) : '';
  const legacyDirectSubsystem = String(row.cls || '').trim() === 'زیرتجهیز'
    && directEquipmentParent && !INTERNAL_KINDS.has(parentKind);
  return (!internalKind || legacyDirectSubsystem) && (!directEquipmentParent || legacyDirectSubsystem);
}

function canonicalKindAtDepth(depth) {
  const parsed = Number(depth);
  return Number.isInteger(parsed) ? CANONICAL_DEPTH_KINDS[parsed] || null : null;
}

function repairScopeBlockReason(root, rows) {
  if (root.ambiguous === true) return 'multiple active B1BT roots share this code';
  if ((rows || []).some(item => item.cycle === true || Number(item.depth) > 3)) {
    return 'level-four row or cycle exists in the B1BT scope';
  }
  if ((rows || []).some(item => {
    const stored = storedStructureKindOf(item);
    return stored && stored !== canonicalKindAtDepth(Number(item.depth));
  })) return 'a stored structureKind conflict exists in the B1BT scope';
  return null;
}

function proposedRepair(root, row, parent, rows) {
  const depth = Number(row.depth);
  const code = String(row.code || '');
  const known = KNOWN_REPAIRS[code];
  if (!known || String(root.code || '') !== 'B1BT') return 'REPORT_ONLY — no approved mapping for this row';
  const blockReason = repairScopeBlockReason(root, rows);
  if (blockReason) return `REPORT_ONLY — ${blockReason}`;
  if (depth !== known.depth || !parent || !known.parentCodes.includes(String(parent.code || ''))) {
    return `REPORT_ONLY — expected depth ${known.depth} under ${known.parentCodes.join(' or ')}`;
  }
  const samePosition = (rows || []).filter(item => Number(item.depth) === depth
    && String(item.parent || item.parent_id || '') === String(row.parent || row.parent_id || '')
    && String(item.code || '') === code);
  if (samePosition.length !== 1) return 'REPORT_ONLY — duplicate code at the expected parent and depth';
  const stored = storedStructureKindOf(row);
  if (stored && stored !== known.kind) return `REPORT_ONLY — stored structureKind conflict (${stored})`;
  if (stored === known.kind) return 'NONE — already canonical';
  return `SET ext.structureKind='${known.kind}' only; preserve nodeKind, type, id, code, parent, history and Audit`;
}

function classifyRows(root, rows) {
  const rowList = rows || [];
  const byId = new Map(rowList.map(row => [String(row.id), row]));
  return rowList.map(row => {
    const depth = Number(row.depth);
    const canonicalKind = canonicalKindAtDepth(depth);
    const parent = byId.get(String(row.parent || row.parent_id || '')) || null;
    const storedNodeKind = registryKindOf(row);
    const storedStructureKind = storedStructureKindOf(row);
    const duplicateAtPosition = row.code != null && row.code !== '' && rowList.filter(item =>
      Number(item.depth) === depth && String(item.parent || item.parent_id || '') === String(row.parent || row.parent_id || '')
        && String(item.code || '') === String(row.code)).length > 1;
    let conflict = root.ambiguous === true || row.cycle === true || !canonicalKind || duplicateAtPosition;
    let conflictReason = root.ambiguous === true ? 'multiple active B1BT roots share this code'
      : row.cycle === true ? 'cycle'
        : (!canonicalKind && depth > 3 ? 'depth exceeds 3'
          : duplicateAtPosition ? 'duplicate code at the same parent and depth' : null);
    if (!conflict && storedStructureKind && storedStructureKind !== canonicalKind) {
      conflict = true;
      conflictReason = 'stored structureKind differs from canonical depth';
    }
    if (!conflict && !storedStructureKind && storedNodeKind && INTERNAL_KINDS.has(storedNodeKind)
      && storedNodeKind !== canonicalKind && !(depth === 1 && storedNodeKind === 'sub-equipment')) {
      conflict = true;
      conflictReason = 'legacy nodeKind differs from canonical depth';
    }
    return {
      rootId: String(root.id), rootCode: String(root.code || ''), id: String(row.id), code: row.code == null ? null : String(row.code),
      name: row.name == null ? null : String(row.name), type: row.type || null, cls: row.cls || null,
      legacyDirectSubsystem: depth === 1 && row.type === 'eq' && String(row.cls || '').trim() === 'زیرتجهیز',
      parentId: row.parent || row.parent_id || null,
      parentCode: parent && parent.code != null ? String(parent.code) : null,
      depth, storedNodeKind, storedStructureKind, canonicalKind,
      conflict, conflictReason,
      proposedRepair: proposedRepair(root, row, parent, rowList)
    };
  });
}

function printStructureReport(root, rows) {
  console.log(`\n== Canonical structure report: root ${root.code || '(no code)'} (id=${root.id}) ==`);
  console.log('depth | id | code | parent | stored nodeKind | stored structureKind | canonical kind | conflict | proposed repair');
  const classified = classifyRows(root, rows);
  for (const row of classified) {
    console.log(ROW);
    console.log(`depth=${row.depth} | id=${row.id} | code=${row.code || 'NULL'} | parent=${row.parentCode || row.parentId || 'NULL'}`);
    console.log(`type=${row.type || 'NULL'} | cls=${row.cls || 'NULL'} | legacy direct subsystem=${row.legacyDirectSubsystem ? 'YES' : 'NO'}`);
    console.log(`stored nodeKind=${row.storedNodeKind || '(absent)'} | stored structureKind=${row.storedStructureKind || '(absent)'}`);
    console.log(`canonical=${row.canonicalKind || 'INVALID'} | conflict=${row.conflict ? 'YES' : 'NO'}${row.conflictReason ? ` (${row.conflictReason})` : ''}`);
    console.log(`proposed repair: ${row.proposedRepair}`);
  }
  const levelFour = classified.filter(row => row.depth > 3);
  const conflicts = classified.filter(row => row.conflict);
  console.log(ROW);
  console.log(`rows=${classified.length} | conflicts=${conflicts.length} | level-four-or-deeper=${levelFour.length}`);
  if (levelFour.length) console.log('Migration guard: no automatic B1BT repair is safe until level-four rows are reviewed.');
  if (root.ambiguous === true) console.log('Migration guard: multiple active B1BT roots exist; all repair proposals are report-only.');
  if (classified.some(row => row.storedStructureKind && row.storedStructureKind !== row.canonicalKind)) {
    console.log('Migration guard: a stored structureKind conflict exists; all repair proposals are report-only.');
  }
  return classified;
}

async function resolveRootEquipment(pool, assetId) {
  const { rows } = await pool.query(
    `WITH RECURSIVE ancestry AS (
       SELECT a.id,a.parent,a.type,a.code,COALESCE(NULLIF(a.ext->>'nodeKind',''),'equipment') AS node_kind,
         a.category_id,0 AS depth,ARRAY[a.id]::text[] AS path,
         EXISTS(SELECT 1 FROM assets structural_parent WHERE structural_parent.id=a.parent
           AND structural_parent.type='eq' AND structural_parent.deleted_at IS NULL) AS internal_child
       FROM assets a WHERE a.id=$1
       UNION ALL
       SELECT p.id,p.parent,p.type,p.code,COALESCE(NULLIF(p.ext->>'nodeKind',''),'equipment'),p.category_id,
         ancestry.depth+1,ancestry.path||p.id,
         EXISTS(SELECT 1 FROM assets structural_parent WHERE structural_parent.id=p.parent
           AND structural_parent.type='eq' AND structural_parent.deleted_at IS NULL)
       FROM assets p JOIN ancestry ON ancestry.parent=p.id
       WHERE ancestry.depth<64 AND NOT p.id=ANY(ancestry.path)
     )
     SELECT id,parent,type,code,node_kind,category_id,depth FROM ancestry
     WHERE type='eq' AND (code='B1BT' OR (NOT internal_child
       AND node_kind NOT IN ('subsystem','main-component','sub-component','sub','sys','panel')))
     ORDER BY CASE WHEN code='B1BT' THEN 0 ELSE 1 END,depth ASC LIMIT 1`,
    [assetId]
  );
  return rows[0] || null;
}

async function readOnlyStructureRows(pool, rootId) {
  const { rows } = await pool.query(
    `WITH RECURSIVE structure AS (
       SELECT a.id,a.parent,a.code,a.name,a.type,a.cls,a.ext,a.row_version,a.deleted_at,
         0 AS depth,ARRAY[a.id]::text[] AS path,false AS cycle
       FROM assets a WHERE a.id=$1
       UNION ALL
       SELECT child.id,child.parent,child.code,child.name,child.type,child.cls,child.ext,child.row_version,
         child.deleted_at,structure.depth+1,structure.path||child.id,child.id=ANY(structure.path)
       FROM assets child JOIN structure ON child.parent=structure.id
       WHERE child.type='eq' AND structure.depth<64 AND NOT structure.cycle
     )
     SELECT structure.*,parent.code AS parent_code
     FROM structure
     LEFT JOIN assets parent ON parent.id=structure.parent
     ORDER BY structure.depth,structure.code,structure.id`,
    [rootId]
  );
  return rows;
}

async function main() {
  require('dotenv').config();
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not configured. No live diagnosis was possible. Set it in .env and run this read-only tool again.');
    process.exitCode = 1;
    return;
  }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const identifier = String(process.argv[2] || 'B1BT').trim();
  try {
    const schema = await pool.query(
      `SELECT to_regclass('public.assets') assets, to_regclass('public.role_permissions') role_permissions,
        to_regclass('public.item_balances') item_balances, to_regclass('public.inventory_ledger') inventory_ledger`
    );
    console.log('== schema ==');
    console.log('assets:', value(schema.rows[0], 'assets'), '| role_permissions:', value(schema.rows[0], 'role_permissions'),
      '| item_balances:', value(schema.rows[0], 'item_balances'), '| inventory_ledger:', value(schema.rows[0], 'inventory_ledger'));

    const applied = await pool.query(
      `SELECT to_regclass('public.schema_migrations') ok`
    );
    if (applied.rows[0].ok) {
      const versions = await pool.query(
        `SELECT version, filename, applied_at FROM schema_migrations ORDER BY version`
      );
      console.log('applied migrations:', versions.rows.map(row => row.version).join(', ') || '(none)');
      for (const required of ['014', '015', '016', '017']) {
        const found = versions.rows.some(row => String(row.version).startsWith(required)
          || String(row.filename || '').startsWith(required));
        console.log(`  migration ${required}: ${found ? 'applied' : 'not applied — review the diagnosis before any migration'}`);
      }
    } else {
      console.log('schema_migrations table is missing — migrations were never tracked here.');
    }

    const grants = await pool.query(
      `SELECT role, permission FROM role_permissions
       WHERE granted=true AND (permission LIKE 'equipment.structure.%' OR permission='*')
       ORDER BY role, permission`
    );
    console.log('\n== equipment.structure permissions ==');
    console.log(grants.rows.length ? grants.rows.map(row => `${row.role}: ${row.permission}`).join('\n') : '(no grant — migration 015 is not applied)');

    if (identifier) {
      const found = await pool.query(
        `SELECT id, code, name, type, parent, cls, status, crit, maker, model, ext, row_version,
           deleted_at, category_id
         FROM assets WHERE id=$1 OR lower(code)=lower($1) LIMIT 5`,
        [identifier]
      );
      console.log(`\n== lookup for "${identifier}" — ${found.rows.length} row(s) ==`);
      if (!found.rows.length) {
        console.log('No assets row matches this id or code. The structure API would answer 404 EQUIPMENT_NOT_FOUND.');
        return;
      }
      for (const row of found.rows) {
        console.log(ROW);
        console.log('id (what GET /api/equipment/:id/structure expects):', value(row, 'id'));
        console.log('code:', value(row, 'code'), '| name:', value(row, 'name'));
        console.log('type:', value(row, 'type'), '| parent:', value(row, 'parent'));
        console.log("ext->>'nodeKind' (raw):", nodeKindOf(row) === null ? 'NULL/absent' : nodeKindOf(row));
        console.log('effective kind used by the resolver:', effectiveKind(row));
        console.log('deleted_at:', value(row, 'deleted_at'), '| row_version:', value(row, 'row_version'));
        const parentRow = row.parent
          ? await pool.query(
            `SELECT id,code,name,type,cls,deleted_at,COALESCE(NULLIF(ext->>'nodeKind',''),'') AS node_kind
             FROM assets WHERE id=$1`, [row.parent])
          : { rows: [] };
        const parentInfo = parentRow.rows[0] || null;
        console.log('listed by the comprehensive registry:', registryListsIt(row, parentInfo) ? 'YES' : 'NO');
        console.log('may own a dossier structure:', row.type === 'eq' && !row.deleted_at
          && (!INTERNAL_KINDS.has(effectiveKind(row)) || String(row.cls || '').trim() === 'زیرتجهیز') ? 'YES' : 'NO');
        if (String(row.id) !== identifier) {
          console.log(`NOTE: the argument matched the CODE, not the id. The frontend must send id="${row.id}".`);
        }

        const children = await pool.query(
          `SELECT count(*)::int total,
             count(*) FILTER (WHERE deleted_at IS NULL)::int active
           FROM assets WHERE parent=$1`,
          [row.id]
        );
        console.log('children (all / active):', children.rows[0].total, '/', children.rows[0].active);

        // Why the structure is empty: the tab reads only assets rows that are type='eq' children of
        // this equipment, so this breakdown separates "no data exists" from "data exists but lives
        // where the internal structure does not read it".
        const breakdown = await pool.query(
          `SELECT count(*)::int total,
             count(*) FILTER (WHERE type='eq' AND deleted_at IS NULL)::int active_equipment,
             count(*) FILTER (WHERE type<>'eq')::int other_type,
             count(*) FILTER (WHERE type='eq'
               AND COALESCE(NULLIF(ext->>'nodeKind',''),'equipment')
                   IN ('subsystem','main-component','sub-component'))::int internal_kinded,
             count(*) FILTER (WHERE type='eq' AND ext->>'nodeKind' IS NULL)::int without_node_kind
           FROM assets WHERE parent=$1`,
          [row.id]
        );
        const counts = breakdown.rows[0] || {};
        console.log('children breakdown -> active type=eq:', counts.active_equipment,
          '| other type:', counts.other_type,
          '| with an internal nodeKind:', counts.internal_kinded,
          '| without nodeKind:', counts.without_node_kind);

        if (parentInfo) {
          console.log('parent row:', parentInfo.id, '| type=' + parentInfo.type,
            '| nodeKind=' + (parentInfo.node_kind || 'NULL/absent'), '|', parentInfo.name);
          console.log(parentInfo.type === 'eq'
            ? '  -> the parent is an equipment row; cls=زیرتجهیز is a registry exception only for a direct child of an equipment root'
            : '  -> the parent is a location/category node: preserved as-is, outside the internal structure');
        } else {
          console.log('parent row: none (this equipment has no parent)');
        }

        const spares = await pool.query(
          `SELECT count(*)::int total FROM asset_spare_parts rel WHERE rel.asset_id=$1`,
          [row.id]
        );
        const keyParts = Array.isArray(row.ext && row.ext.keyParts) ? row.ext.keyParts.length : 0;
        console.log('linked spare parts (asset_spare_parts):', spares.rows[0] ? spares.rows[0].total : 0,
          '| ext.keyParts entries:', keyParts);
        console.log('  -> both belong to the critical spare parts section of the dossier;');
        console.log('     they are never converted into structure rows automatically.');

        if (!Number(counts.active_equipment)) {
          console.log('CONCLUSION: this equipment has no child assets row, so');
          console.log('  GET /api/equipment/:id/structure answers 200 with nodes: [] and the UI shows');
          console.log('  the Persian empty state. That is the truthful content of the database, not a');
          console.log('  query defect - nothing is invented to fill the tab.');
        }

        const resolvedRoot = await resolveRootEquipment(pool, row.id);
        if (resolvedRoot) {
          const rootRowResult = await pool.query(
            'SELECT id,parent,code,name,type,cls,ext,row_version,deleted_at FROM assets WHERE id=$1', [resolvedRoot.id]
          );
          if (rootRowResult.rows[0]) {
            const treeRows = await readOnlyStructureRows(pool, resolvedRoot.id);
            const reportRoot = { ...rootRowResult.rows[0] };
            if (String(reportRoot.code || '') === 'B1BT') {
              const roots = await pool.query(
                "SELECT id FROM assets WHERE code='B1BT' AND type='eq' AND deleted_at IS NULL"
              );
              reportRoot.ambiguous = roots.rows.length !== 1;
              if (reportRoot.ambiguous) console.log(`Ambiguous root: found ${roots.rows.length} active equipment rows with code B1BT.`);
            }
            printStructureReport(reportRoot, treeRows);
            if (String(row.id) !== String(resolvedRoot.id)) {
              console.log(`Selected row id=${row.id}, code=${row.code || 'NULL'} → structure root id=${resolvedRoot.id}, code=${resolvedRoot.code || 'NULL'}`);
            }
          }
        }

        const chain = await pool.query(
          `WITH RECURSIVE ancestry AS (
             SELECT a.id, a.parent, a.code, a.type,
               COALESCE(NULLIF(a.ext->>'nodeKind',''),'equipment') AS node_kind, 0 AS depth,
               ARRAY[a.id]::text[] AS path,
               EXISTS(SELECT 1 FROM assets structural_parent WHERE structural_parent.id=a.parent
                 AND structural_parent.type='eq' AND structural_parent.deleted_at IS NULL) AS internal_child
             FROM assets a WHERE a.id=$1
             UNION ALL
             SELECT p.id, p.parent, p.code, p.type,
               COALESCE(NULLIF(p.ext->>'nodeKind',''),'equipment'), ancestry.depth+1, ancestry.path||p.id,
               EXISTS(SELECT 1 FROM assets structural_parent WHERE structural_parent.id=p.parent
                 AND structural_parent.type='eq' AND structural_parent.deleted_at IS NULL)
             FROM assets p JOIN ancestry ON ancestry.parent=p.id
             WHERE ancestry.depth<64 AND NOT p.id=ANY(ancestry.path)
           )
           SELECT id, code, type, node_kind, depth, internal_child FROM ancestry
           WHERE type='eq' AND (code='B1BT' OR (NOT internal_child
             AND node_kind NOT IN ('subsystem','main-component','sub-component','sub','sys','panel')))
           ORDER BY CASE WHEN code='B1BT' THEN 0 ELSE 1 END,depth ASC
           LIMIT 1`,
          [row.id]
        );
        if (!chain.rows.length) {
          console.log('resolver result: NONE → the API answers 404 ROOT_EQUIPMENT_NOT_FOUND for this row');
        } else {
          const resolved = chain.rows[0];
          console.log('resolver result: id=' + resolved.id, '| code=' + value(resolved, 'code'), '| kind=' + resolved.node_kind);
          if (String(resolved.id) === String(row.id)) {
            console.log('self-resolution OK → the API answers 200 with this row as the structure root');
          } else if (registryListsIt(row, parentInfo) && String(row.cls || '').trim() !== 'زیرتجهیز') {
            // A registry-listed root keeps its real parent outside its dossier structure.
            console.log('listed by the registry → the API answers 200 with THIS row as the structure root;');
            console.log(`  its parent ${value(row, 'parent')} is a location/grouping node kept outside the internal structure`);
          } else if (String(row.cls || '').trim() === 'زیرتجهیز' && registryListsIt(row, parentInfo)) {
            console.log(`legacy direct child stays in the registry and is a level-1 subsystem under ${resolved.id}; its type, id and history remain unchanged`);
          } else {
            console.log(`internal node → it belongs to the structure of ${resolved.id}`);
          }
        }
      }
      return;
    }

    const summary = await pool.query(
      `SELECT
         count(*) FILTER (WHERE type='eq' AND deleted_at IS NULL)::int equipment_rows,
         count(*) FILTER (WHERE type='eq' AND deleted_at IS NULL AND NULLIF(ext->>'nodeKind','') IS NULL)::int without_node_kind,
         count(*) FILTER (WHERE type='eq' AND deleted_at IS NULL
           AND NULLIF(ext->>'nodeKind','') IS NOT NULL
           AND ext->>'nodeKind' NOT IN ('equipment','sub-equipment','subsystem','main-component','sub-component'))::int unexpected_node_kind
       FROM assets`
    );
    console.log('\n== equipment data summary ==');
    console.log('active type=eq rows:', summary.rows[0].equipment_rows);
    console.log('  without any nodeKind (legacy):', summary.rows[0].without_node_kind);
    console.log('  with an unexpected nodeKind value:', summary.rows[0].unexpected_node_kind);

    const kinds = await pool.query(
      `SELECT COALESCE(NULLIF(ext->>'nodeKind',''),'(absent)') node_kind, count(*)::int total
       FROM assets WHERE type='eq' AND deleted_at IS NULL
       GROUP BY 1 ORDER BY total DESC LIMIT 20`
    );
    console.log('\n== distinct nodeKind values on type=eq rows ==');
    for (const row of kinds.rows) console.log(' ', row.node_kind, '=', row.total);

    const sample = await pool.query(
      `SELECT id, code, type, parent, ext->>'nodeKind' node_kind
       FROM assets WHERE type='eq' AND deleted_at IS NULL ORDER BY code LIMIT 15`
    );
    console.log('\n== first rows (send one of these ids to this script for a full trace) ==');
    for (const row of sample.rows) {
      console.log(`  id=${row.id} | code=${value(row, 'code')} | parent=${value(row, 'parent')} | nodeKind=${row.node_kind === null ? '(absent)' : row.node_kind}`);
    }
  } catch (error) {
    console.error('Diagnosis failed:', error.message || error.code || String(error));
    if (/ECONNREFUSED/.test(String(error.message || ''))) console.error('PostgreSQL is unreachable. Start the database and run this again.');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main();

module.exports = { CANONICAL_DEPTH_KINDS, KNOWN_REPAIRS, canonicalKindAtDepth, classifyRows, proposedRepair, printStructureReport, registryListsIt };
