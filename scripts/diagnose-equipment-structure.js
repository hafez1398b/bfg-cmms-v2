'use strict';

/**
 * Read-only diagnosis of the equipment dossier structure for one real record.
 *
 * It changes nothing: no INSERT, no UPDATE, no DELETE, no migration. It only prints what the
 * structure API will see for a real PostgreSQL record, so a live failure such as
 * ROOT_EQUIPMENT_NOT_FOUND can be traced to its exact data cause.
 *
 * Usage:
 *   node scripts/diagnose-equipment-structure.js B1P01
 *   node scripts/diagnose-equipment-structure.js            # first rows + summary
 */

const { Pool } = require('pg');
require('dotenv').config();

const INTERNAL_KINDS = ['subsystem', 'main-component', 'sub-component', 'sub', 'sys', 'panel'];
const ROW = '---------------------------------------------------------------------------';

function value(row, key) {
  const raw = row[key];
  if (raw === null || raw === undefined) return 'NULL';
  if (typeof raw === 'object') return JSON.stringify(raw);
  return String(raw);
}

function nodeKindOf(row) {
  const ext = row.ext && typeof row.ext === 'object' ? row.ext : {};
  const declared = ext.nodeKind;
  return declared == null || declared === '' ? null : String(declared);
}

function effectiveKind(row) {
  return nodeKindOf(row) || (row.type === 'eq' ? 'equipment' : 'location');
}

function registryListsIt(row) {
  if (row.type !== 'eq') return false;
  if (row.deleted_at) return false;
  return !INTERNAL_KINDS.includes(effectiveKind(row));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not configured. Set it in .env and run this script again.');
    process.exitCode = 1;
    return;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const identifier = String(process.argv[2] || '').trim();
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
      for (const required of ['014', '015', '016']) {
        const found = versions.rows.some(row => String(row.version).startsWith(required)
          || String(row.filename || '').startsWith(required));
        console.log(`  migration ${required}: ${found ? 'applied' : 'NOT APPLIED — run: npm run update:apply'}`);
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
        console.log('listed by the comprehensive registry:', registryListsIt(row) ? 'YES' : 'NO');
        console.log('may own a dossier structure:', row.type === 'eq' && !row.deleted_at && !INTERNAL_KINDS.includes(effectiveKind(row)) ? 'YES' : 'NO');
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

        const chain = await pool.query(
          `WITH RECURSIVE ancestry AS (
             SELECT a.id, a.parent, a.code, a.type,
               COALESCE(NULLIF(a.ext->>'nodeKind',''),'equipment') AS node_kind, 0 AS depth,
               ARRAY[a.id]::text[] AS path
             FROM assets a WHERE a.id=$1
             UNION ALL
             SELECT p.id, p.parent, p.code, p.type,
               COALESCE(NULLIF(p.ext->>'nodeKind',''),'equipment'), ancestry.depth+1, ancestry.path||p.id
             FROM assets p JOIN ancestry ON ancestry.parent=p.id
             WHERE ancestry.depth<64 AND NOT p.id=ANY(ancestry.path)
           )
           SELECT id, code, type, node_kind, depth FROM ancestry
           WHERE type='eq' AND node_kind NOT IN ('subsystem','main-component','sub-component','sub','sys','panel')
           ORDER BY CASE WHEN node_kind IN ('equipment','sub-equipment') THEN 0 ELSE 1 END, depth ASC
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
          } else if (registryListsIt(row)) {
            // A row listed by the registry is a structure root on its own: its parent is a
            // location node (factory, site, area, line, unit or category) which is preserved
            // as-is and never forced inside rootEquipmentId.
            console.log('listed by the registry → the API answers 200 with THIS row as the structure root;');
            console.log(`  its parent ${value(row, 'parent')} is a location/grouping node kept outside the internal structure`);
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

main();
