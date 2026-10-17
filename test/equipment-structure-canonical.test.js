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

test('migration 017 is additive, idempotent, guarded against level four and mirrored in schema.sql', () => {
  const migration = read('migrations/017_canonical_equipment_structure_kind.sql');
  const schema = read('schema.sql');
  const extract = sql => {
    const start = sql.indexOf('WITH RECURSIVE root_equipment AS');
    const end = sql.indexOf('\nCOMMIT;', start);
    assert.ok(start >= 0 && end > start);
    return sql.slice(start, end).trim();
  };
  assert.equal(extract(migration), extract(schema));
  assert.match(migration, /root\.code='B1BT' AND root\.type='eq'/);
  assert.match(migration, /duplicate_root\.code='B1BT'.*\)=1/s);
  assert.match(migration, /node\.code IN \('B1BT catali','B1BT9955'\)/);
  assert.match(migration, /node\.code='MM\.J'/);
  assert.match(migration, /node\.code='JHBJHV'/);
  assert.match(migration, /structure\.depth>3 OR structure\.cycle/);
  assert.match(migration, /structureKind.*IS DISTINCT FROM\s+CASE structure\.depth/s);
  assert.match(migration, /duplicate\.parent IS NOT DISTINCT FROM node\.parent/);
  assert.match(migration, /NULLIF\(target\.ext->>'structureKind',''\) IS DISTINCT FROM proposed\.canonical_kind/);
  assert.match(migration, /NULLIF\(target\.ext->>'structureKind',''\) IS NULL\s+OR target\.ext->>'structureKind'=proposed\.canonical_kind/);
  assert.match(migration, /jsonb_build_object\('structureKind',proposed\.canonical_kind\)/);
  assert.match(migration, /row_version=target\.row_version\+1/);
  assert.doesNotMatch(migration, /\b(DELETE|TRUNCATE|DROP)\b/i);
  assert.doesNotMatch(migration, /SET\s+(type|parent|id|code|name|history)\s*=/i);
  assert.doesNotMatch(migration, /jsonb_build_object\('nodeKind'/);
});
