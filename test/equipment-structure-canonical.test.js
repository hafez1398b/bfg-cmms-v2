'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const structure = require('../server/equipment-structure');
const diagnosis = require('../scripts/diagnose-equipment-structure');

const rootPath = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(rootPath, file), 'utf8');

function asset(id, parent, code, ext = {}, extra = {}) {
  return { id, parent, code, name: code, type: 'eq', cls: extra.cls || null, ext, row_version: 1, depth: extra.depth || 1, ...extra };
}

test('Canonical structure kinds and Persian labels are determined exactly by depth', () => {
  assert.equal(structure.canonicalKindAtDepth(0), 'equipment');
  assert.equal(structure.canonicalKindAtDepth(1), 'subsystem');
  assert.equal(structure.canonicalKindAtDepth(2), 'main-component');
  assert.equal(structure.canonicalKindAtDepth(3), 'sub-component');
  assert.equal(structure.canonicalKindAtDepth(4), null);
  assert.equal(structure.LEVEL_LABELS.equipment, 'تجهیز');
  assert.equal(structure.LEVEL_LABELS.subsystem, 'زیرسیستم تجهیز');
  assert.equal(structure.LEVEL_LABELS['main-component'], 'قطعه اصلی زیرسیستم');
  assert.equal(structure.LEVEL_LABELS['sub-component'], 'زیرقطعه قطعه اصلی');
});

test('tree projection labels legacy direct children and corrects shifted labels without changing position', () => {
  const root = { id: 'root-bt', parent: 'site-1', code: 'B1BT', name: 'B1BT', type: 'eq', ext: { nodeKind: 'equipment' }, row_version: 4 };
  const rows = [
    asset('part', 'main', 'JHBJHV', { nodeKind: 'main-component' }, { depth: 3 }),
    asset('main', 'legacy-subsystem', 'MM.J', { nodeKind: 'subsystem' }, { depth: 2 }),
    asset('legacy-subsystem', 'root-bt', 'B1BT catali', { nodeKind: 'equipment', structureKind: 'subsystem' }, { cls: 'زیرتجهیز', depth: 1 }),
    asset('too-deep', 'part', 'LEVEL-4', { nodeKind: 'sub-component' }, { depth: 4 })
  ];
  const result = structure.buildStructureTree(root, rows);
  const subsystem = result.nodes[0];
  const main = subsystem.children[0];
  const subcomponent = main.children[0];
  const invalid = subcomponent.children[0];
  assert.equal(subsystem.id, 'legacy-subsystem');
  assert.equal(subsystem.nodeKind, 'subsystem');
  assert.equal(subsystem.canonicalKind, 'subsystem');
  assert.equal(subsystem.storedNodeKind, 'equipment');
  assert.equal(subsystem.storedStructureKind, 'subsystem');
  assert.equal(subsystem.legacy, true);
  assert.equal(subsystem.validRelation, true);
  assert.equal(main.nodeKind, 'main-component');
  assert.equal(main.storedNodeKind, 'subsystem');
  assert.equal(main.conflict, true);
  assert.equal(subcomponent.nodeKind, 'sub-component');
  assert.equal(subcomponent.storedNodeKind, 'main-component');
  assert.equal(subcomponent.conflict, true);
  assert.equal(invalid.nodeKind, null);
  assert.equal(invalid.canonicalKind, null);
  assert.equal(invalid.level, 4);
  assert.equal(invalid.validRelation, false);
  assert.ok(result.diagnostics.some(item => item.code === 'STRUCTURE_DEPTH_EXCEEDED' && item.nodeId === 'too-deep'));
  assert.ok(result.diagnostics.some(item => item.code === 'STRUCTURE_KIND_CONFLICT' && item.nodeId === 'main'));
});

test('read-only diagnostic reports exact stored and Canonical kinds and proposes repairs only for the proved B1BT chain', () => {
  const root = { id: 'root', code: 'B1BT' };
  const rows = [
    { id: 'root', parent: null, code: 'B1BT', type: 'eq', depth: 0, ext: { nodeKind: 'equipment' } },
    { id: 'catali', parent: 'root', code: 'B1BT catali', type: 'eq', depth: 1, cls: 'زیرتجهیز', ext: {} },
    { id: 'mmj', parent: 'catali', code: 'MM.J', type: 'eq', depth: 2, ext: { nodeKind: 'subsystem' } },
    { id: 'jhbjhv', parent: 'mmj', code: 'JHBJHV', type: 'eq', depth: 3, ext: { nodeKind: 'main-component' } }
  ];
  const report = diagnosis.classifyRows(root, rows);
  assert.deepEqual(report.map(row => row.canonicalKind), ['equipment', 'subsystem', 'main-component', 'sub-component']);
  assert.equal(report[1].storedNodeKind, null);
  assert.equal(report[1].legacyDirectSubsystem, true);
  assert.equal(report[1].conflict, false);
  assert.match(report[1].proposedRepair, /structureKind='subsystem'/);
  assert.equal(report[2].conflict, true);
  assert.match(report[2].proposedRepair, /structureKind='main-component'/);
  assert.equal(report[3].conflict, true);
  assert.match(report[3].proposedRepair, /structureKind='sub-component'/);

  const fourth = [...rows, { id: 'depth4', parent: 'jhbjhv', code: 'LEVEL-4', depth: 4, ext: {} }];
  const blocked = diagnosis.classifyRows(root, fourth);
  assert.equal(blocked.at(-1).canonicalKind, null);
  assert.match(blocked[1].proposedRepair, /REPORT_ONLY.*level-four/);
  assert.match(blocked.at(-1).proposedRepair, /REPORT_ONLY/);

  const duplicate = [...rows, { id: 'duplicate-mmj', parent: 'catali', code: 'MM.J', depth: 2, ext: {} }];
  const duplicateReport = diagnosis.classifyRows(root, duplicate);
  assert.equal(duplicateReport.find(row => row.id === 'mmj').conflict, true);
  assert.match(duplicateReport.find(row => row.id === 'mmj').proposedRepair, /REPORT_ONLY.*duplicate code/);
  const ambiguousReport = diagnosis.classifyRows({ ...root, ambiguous: true }, rows);
  assert.equal(ambiguousReport[1].conflict, true);
  assert.match(ambiguousReport[1].proposedRepair, /REPORT_ONLY.*multiple active B1BT roots/);
  const structureConflict = rows.map(row => row.id === 'catali'
    ? { ...row, ext: { ...row.ext, structureKind: 'main-component' } } : row);
  const conflictReport = diagnosis.classifyRows(root, structureConflict);
  assert.equal(conflictReport[1].conflict, true);
  assert.match(conflictReport[3].proposedRepair, /REPORT_ONLY.*stored structureKind conflict/);
});

test('migration 017 SQL contract repairs B1BT rows from actual depth, not display names or codes', () => {
  const migration = read('migrations/017_canonical_equipment_structure_kind.sql');
  const schema = read('schema.sql');
  const schemaMarker = '-- Repair canonical structure kinds for the unique B1BT equipment tree.';
  const schemaStart = schema.indexOf(schemaMarker);
  assert.ok(schemaStart >= 0, 'schema.sql must contain the complete migration 017 block');
  assert.equal(schema.slice(schemaStart).trim(), migration.trim(), 'schema.sql and migration 017 must be identical');

  // This catches the production failure: structure reads these fields from root_equipment.
  assert.match(migration,
    /root_equipment AS \(\s*SELECT root\.id,root\.code,root\.parent,root\.type,root\.ext/s);
  assert.match(migration, /root_count <> 1[\s\S]*RAISE EXCEPTION/);
  assert.match(migration, /JOIN structure ON child\.parent=structure\.id/);
  assert.match(migration, /parent\.id=child\.parent[\s\S]*parent\.depth=child\.depth-1/);

  // B1BT is the only code lookup (to identify the root); no descendant's user-facing name/code
  // participates in classification or repair selection.
  assert.match(migration, /root\.code='B1BT'/);
  assert.doesNotMatch(migration, /\b(?:node|child|parent|structure)\.(?:code|name)\s*(?:=|IN\b)/i);
  assert.doesNotMatch(migration, /MM\.J|JHBJHV/);
  assert.match(migration,
    /CASE node\.depth\s+WHEN 0 THEN 'equipment'\s+WHEN 1 THEN 'subsystem'\s+WHEN 2 THEN 'main-component'\s+WHEN 3 THEN 'sub-component'/s);

  // Unsafe topology rejects the migration; a stored kind mismatch is not an unsafe-scope gate.
  assert.match(migration, /EXISTS\(SELECT 1 FROM structure WHERE cycle OR depth>3\)/);
  assert.match(migration, /IF invalid_scope THEN[\s\S]*RAISE EXCEPTION/);
  assert.match(migration, /IF broken_parent_chain THEN[\s\S]*RAISE EXCEPTION/);
  assert.doesNotMatch(migration, /safe_root|structureKind[\s\S]{0,100}IS DISTINCT FROM\s+CASE/i);

  const updateSet = migration.match(/UPDATE assets AS target\s+SET([\s\S]*?)\nFROM proposed/);
  assert.ok(updateSet, 'migration must update from the ID-linked proposed rows');
  const updatedColumns = [...updateSet[1].matchAll(/^\s*([a-z_]+)\s*=/gm)].map(match => match[1]);
  assert.deepEqual(updatedColumns, ['ext', 'row_version', 'updated_at']);
  assert.match(migration, /jsonb_build_object\('structureKind',proposed\.canonical_kind\)/);
  assert.match(migration, /NULLIF\(target\.ext->>'structureKind',''\) IS DISTINCT FROM proposed\.canonical_kind/);
  assert.doesNotMatch(migration, /\bDELETE\b/i);
  assert.doesNotMatch(migration, /SET\s+(id|code|name|parent|type|history)\s*=/i);

  // SQL-contract fixture: real display names are not their encoded codes. The reference result
  // demonstrates the required depth mapping and that wrong non-empty values get repaired once.
  const depthKind = { 0: 'equipment', 1: 'subsystem', 2: 'main-component', 3: 'sub-component' };
  const original = [
    { id: 'bt-id', code: 'B1BT', name: 'Blending equipment', parent: 'site-id', type: 'eq',
      ext: { structureKind: 'subsystem' }, row_version: 4, history: [{ id: 'h0' }] },
    { id: 'sub-id', code: 'B1BT-S01', name: 'Catalyst tanks', parent: 'bt-id', type: 'eq',
      ext: { structureKind: 'main-component' }, row_version: 7, history: [{ id: 'h1' }] },
    { id: 'main-id', code: 'HJLKL', name: 'MM.J', parent: 'sub-id', type: 'eq',
      ext: { structureKind: 'subsystem' }, row_version: 9, history: [{ id: 'h2' }] },
    { id: 'part-id', code: 'BKMM1223', name: 'JHBJHV', parent: 'main-id', type: 'eq',
      ext: { structureKind: 'main-component' }, row_version: 12, history: [{ id: 'h3' }] },
    // Same display name/code pair as a known in-scope row, but no real parent chain from B1BT.
    { id: 'orphan-id', code: 'BKMM1223', name: 'JHBJHV', parent: 'missing-parent', type: 'eq',
      ext: { structureKind: 'equipment' }, row_version: 2, history: [{ id: 'orphan-history' }] }
  ];
  assert.notEqual(original[2].name, original[2].code);
  assert.notEqual(original[3].name, original[3].code);
  const repairModel = rows => {
    const roots = rows.filter(row => row.code === 'B1BT' && row.type === 'eq' && !row.deleted_at);
    if (roots.length !== 1) throw new Error('ambiguous root');
    const byParent = new Map();
    for (const row of rows) {
      if (row.type !== 'eq') continue;
      const parentId = String(row.parent || '');
      if (!byParent.has(parentId)) byParent.set(parentId, []);
      byParent.get(parentId).push(row);
    }
    const depthById = new Map();
    const visit = (row, depth, path) => {
      if (path.has(String(row.id))) throw new Error('cycle');
      if (depth > 3) throw new Error('depth greater than three');
      depthById.set(String(row.id), depth);
      const nextPath = new Set(path).add(String(row.id));
      for (const child of byParent.get(String(row.id)) || []) visit(child, depth + 1, nextPath);
    };
    visit(roots[0], 0, new Set());
    let writes = 0;
    const result = rows.map(row => {
      const depth = depthById.get(String(row.id));
      if (depth == null) return row;
      const canonical = depthKind[depth];
      if (!canonical || row.ext.structureKind === canonical) return row;
      writes += 1;
      return { ...row, ext: { ...row.ext, structureKind: canonical }, row_version: row.row_version + 1,
        updated_at: 'migration-time' };
    });
    return { rows: result, writes };
  };
  const firstRun = repairModel(original);
  assert.deepEqual(firstRun.rows.slice(0, 4).map(row => row.ext.structureKind),
    ['equipment', 'subsystem', 'main-component', 'sub-component']);
  assert.equal(firstRun.writes, 4, 'wrong non-empty structureKind values at valid depths must be repaired');
  assert.deepEqual(firstRun.rows[4], original[4], 'a disconnected row is not guessed into the B1BT scope');
  const secondRun = repairModel(firstRun.rows);
  assert.equal(secondRun.writes, 0, 'an already-canonical second run must not write');
  assert.deepEqual(secondRun.rows, firstRun.rows);
  for (let index = 0; index < original.length; index += 1) {
    for (const key of ['id', 'code', 'name', 'parent', 'type', 'history']) {
      assert.deepEqual(firstRun.rows[index][key], original[index][key], `${key} remains unchanged`);
    }
  }
  const cyclic = original.slice(0, 4).map(row => ({ ...row }));
  cyclic[0].parent = 'part-id';
  assert.throws(() => repairModel(cyclic), /cycle/);
  const depthFour = [...original.slice(0, 4),
    { id: 'depth-four', code: 'L4', name: 'deep row', parent: 'part-id', type: 'eq', ext: {}, row_version: 1 }];
  assert.throws(() => repairModel(depthFour), /depth greater than three/);
});
