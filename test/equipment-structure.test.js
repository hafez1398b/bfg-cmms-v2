'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { createEquipmentRouter } = require('../server/equipment-routes');
const { createSeleneActions, memoryRepository } = require('../server/selene-actions');
const { applyControlledAction } = require('../server/equipment-commands');

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

const STRUCTURE_PERMISSIONS = [
  'equipment.structure.view', 'equipment.structure.create', 'equipment.structure.update',
  'equipment.structure.move', 'equipment.structure.move_cross_equipment',
  'equipment.structure.archive', 'equipment.structure.suggest', 'equipment.structure.approve_ai'
];

function rolePerms(role) {
  if (role === 'admin') return new Set(['*']);
  if (role === 'mgr') return new Set([...STRUCTURE_PERMISSIONS, 'inventory.view']);
  if (role === 'planner') return new Set(['equipment.structure.view', 'equipment.structure.create', 'equipment.structure.update', 'equipment.structure.move', 'equipment.structure.suggest', 'inventory.view']);
  return new Set();
}

function baseAssets() {
  const make = (id, parent, nodeKind, extra = {}) => ({
    id, parent, code: extra.code || id.toUpperCase(), name: extra.name || id, type: 'eq',
    cls: null, status: 'active', crit: 'B', maker: null, model: null, serial: null,
    ext: { nodeKind, ...(extra.ext || {}) }, row_version: extra.rowVersion || 2,
    deleted_at: extra.deletedAt || null, delete_reason: null, is_active: extra.deletedAt ? false : true,
    sort_order: 0, category_id: null, depth: extra.depth
  });
  return new Map(Object.entries({
    'eq-root': { ...make('eq-root', 'factory-1', 'equipment', { code: 'EQ-ROOT', name: 'ریشه تجهیز', rowVersion: 3 }), depth: 0 },
    'sub-1': { ...make('sub-1', 'eq-root', 'subsystem', { name: 'زیرسیستم یک' }), depth: 1 },
    'comp-1': { ...make('comp-1', 'sub-1', 'main-component', { name: 'قطعه اصلی یک' }), depth: 2 },
    'part-1': { ...make('part-1', 'comp-1', 'sub-component', { name: 'زیرقطعه یک' }), depth: 3 }
  }));
}

function structurePool(options = {}) {
  const assets = options.assets || baseAssets();
  const items = options.items || new Map(Object.entries({
    'item-1': { id: 'item-1', code: 'SP-1', name: 'یاتاقان', unit: 'عدد', part_type: 'spare', ext: { partNumber: 'P-100', brand: 'SKF', technicalSpecification: 'کلاس C' }, deleted_at: null }
  }));
  const state = { calls: [], audit: [], outbox: [], scoped: options.scoped !== false, users: options.users || [
    { id: 'u-mgr', role: 'mgr', permissions: ['equipment.structure.view'], scopes: [{ scope_type: 'equipment', scope_id: 'eq-root' }] },
    { id: 'u-out', role: 'tech', permissions: ['equipment.structure.view'], scopes: [] }
  ] };

  const resolveRoot = id => {
    let current = assets.get(id);
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      const kind = current.ext && current.ext.nodeKind;
      if (kind === 'equipment' || kind === 'sub-equipment') return current;
      current = assets.get(current.parent);
    }
    return null;
  };

  async function query(sql, values = []) {
    state.calls.push({ sql, values });
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql.trim())) return { rows: [] };
    if (/FROM user_scopes WHERE user_id=\$1/.test(sql)) return { rows: state.scoped ? [{ 1: 1 }] : [] };
    if (/WITH RECURSIVE ancestry AS/.test(sql) && /node_kind IN \('equipment','sub-equipment'\)/.test(sql)) {
      const resolved = resolveRoot(values[0]);
      return { rows: resolved ? [{ id: resolved.id, parent: resolved.parent, type: resolved.type, node_kind: resolved.ext.nodeKind, category_id: resolved.category_id, depth: 0 }] : [] };
    }
    if (/AS factory_id/.test(sql)) return { rows: [{ factory_id: 'factory-1' }] };
    if (/WITH RECURSIVE structure AS/.test(sql)) {
      const includeArchived = values[1] === true;
      const rows = [];
      const walk = (parentId, depth) => {
        for (const row of assets.values()) {
          if (row.parent !== parentId) continue;
          if (row.deleted_at && !includeArchived) continue;
          rows.push({ ...row, parent_id: row.parent, depth, cycle: false, inventory_item: row.ext.inventoryItemId && items.get(row.ext.inventoryItemId) ? { ...items.get(row.ext.inventoryItemId), available: 7 } : null });
          walk(row.id, depth + 1);
        }
      };
      walk(values[0], 1);
      return { rows };
    }
    if (/FROM selene_action_drafts/.test(sql)) return { rows: [] };
    if (/FROM assets WHERE id=\$1$/.test(sql.trim())) {
      const row = assets.get(values[0]);
      return { rows: row ? [row] : [] };
    }
    if (/FROM users u WHERE u\.active IS TRUE/.test(sql)) {
      return { rows: state.users.map(user => ({ id: user.id, role: user.role, permissions: JSON.stringify(user.permissions), scopes: JSON.stringify(user.scopes) })) };
    }
    if (/INSERT INTO event_outbox/.test(sql)) { state.outbox.push({ id: values[0], aggregateId: values[1], payload: values[3], recipients: JSON.parse(values[4]) }); return { rows: [] }; }
    if (/INSERT INTO audit_x/.test(sql)) { state.audit.push({ action: values[4], entity: values[5], note: values[6], before: values[7], after: values[8] }); return { rows: [] }; }
    if (/INSERT INTO assets/.test(sql)) {
      const row = {
        id: values[0], parent: values[1], code: values[2], name: values[3], type: 'eq', cls: values[4],
        status: 'active', crit: values[5], maker: values[6], model: values[7], serial: values[8],
        ext: JSON.parse(values[9] || '{}'), category_id: values[10], sort_order: values[11],
        is_active: true, record_status: 'complete', row_version: 1, deleted_at: null, delete_reason: null
      };
      assets.set(row.id, row);
      return { rows: [row] };
    }
    if (/FROM asset_spare_parts/.test(sql)) return { rows: [] };
    if (/jsonb_array_elements/.test(sql)) return { rows: [] };
    if (/FROM failures WHERE equipment_id/.test(sql)) return { rows: [{ failures: 0 }] };
    if (/FROM asset_categories WHERE id=/.test(sql)) return { rows: [{ name: 'دسته تست' }] };
    if (/SELECT id,type,ext FROM assets WHERE id=\$1 AND deleted_at IS NULL/.test(sql)) {
      const row = assets.get(values[0]);
      return { rows: row && !row.deleted_at ? [row] : [] };
    }
    if (/UPDATE assets SET row_version=row_version\+1,updated_by/.test(sql)) {
      const row = assets.get(values[0]);
      if (!row) return { rows: [] };
      row.row_version += 1;
      return { rows: [{ row_version: row.row_version }] };
    }
    if (/UPDATE assets SET parent=/.test(sql)) {
      const row = assets.get(values[0]);
      if (!row || Number(row.row_version) !== Number(values[5])) return { rows: [] };
      row.parent = values[1];
      row.row_version += 1;
      return { rows: [row] };
    }
    if (/UPDATE assets SET is_active=false/.test(sql)) {
      const row = assets.get(values[0]);
      if (!row || Number(row.row_version) !== Number(values[3])) return { rows: [] };
      row.deleted_at = new Date().toISOString();
      row.delete_reason = values[3];
      row.is_active = false;
      row.row_version += 1;
      return { rows: [row] };
    }
    if (/UPDATE assets SET is_active=true/.test(sql)) {
      const row = assets.get(values[0]);
      if (!row || Number(row.row_version) !== Number(values[2])) return { rows: [] };
      row.deleted_at = null;
      row.delete_reason = null;
      row.is_active = true;
      row.row_version += 1;
      return { rows: [row] };
    }
    if (/UPDATE assets SET /.test(sql) && /ext=COALESCE/.test(sql)) {
      const row = assets.get(values[0]);
      if (!row) return { rows: [] };
      const versionParam = values[values.length - 1];
      if (Number(row.row_version) !== Number(versionParam)) return { rows: [] };
      const extParam = values.find(value => typeof value === 'string' && value.startsWith('{'));
      row.ext = { ...row.ext, ...JSON.parse(extParam || '{}') };
      row.row_version += 1;
      return { rows: [row] };
    }
    if (/SELECT count\(\*\)::int AS count FROM assets WHERE parent=/.test(sql)) {
      const count = [...assets.values()].filter(row => row.parent === values[0] && !row.deleted_at).length;
      return { rows: [{ count }] };
    }
    if (/lower\(code\)=lower/.test(sql)) {
      const found = [...assets.values()].find(row => String(row.code || '').toLowerCase() === String(values[0]).toLowerCase() && (!values[1] || row.id !== values[1]));
      return { rows: found ? [found] : [] };
    }
    if (/FROM items WHERE id=\$1/.test(sql)) {
      const item = items.get(values[0]);
      return { rows: item && !item.deleted_at ? [item] : [] };
    }
    if (/FROM items i\s+WHERE/.test(sql)) {
      const q = values[0];
      const rows = [...items.values()].filter(item => !item.deleted_at && (!q || `${item.code} ${item.name} ${item.ext.partNumber || ''} ${item.ext.brand || ''}`.toLowerCase().includes(String(q).replace(/%/g, '').toLowerCase())));
      return { rows: rows.map(item => ({ ...item, available: 7 })) };
    }
    if (/SELECT id,parent,type,ext,category_id FROM assets/.test(sql)) {
      const row = assets.get(values[0]);
      return { rows: row && !row.deleted_at ? [row] : [] };
    }
    if (/WITH RECURSIVE ancestry AS/.test(sql) && /ARRAY\[id\]::text\[\]/.test(sql)) {
      const [nodeId, ancestorId] = values;
      let current = assets.get(nodeId);
      const seen = new Set();
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        if (current.id === ancestorId) return { rows: [{ 1: 1 }] };
        current = assets.get(current.parent);
      }
      return { rows: [] };
    }
    if (/SELECT id FROM assets WHERE id=ANY/.test(sql)) return { rows: [] };
    if (/SELECT \* FROM assets WHERE id=\$1/.test(sql)) {
      const row = assets.get(values[0]);
      if (!row) return { rows: [] };
      if (row.deleted_at && sql.includes('AND deleted_at IS NULL')) return { rows: [] };
      return { rows: [row] };
    }
    if (/SELECT 1 FROM role_permissions/.test(sql)) {
      const perms = rolePerms(values[0]);
      return { rows: perms.has(values[1]) || perms.has('*') ? [{ 1: 1 }] : [] };
    }
    const error = new Error(`unexpected sql: ${sql}`);
    error.code = 'UNEXPECTED_SQL';
    throw error;
  }

  return {
    state,
    assets,
    items,
    query,
    async connect() { return { query, release() {} }; }
  };
}

async function withApi(pool, role, run) {
  const app = express();
  app.use(express.json());
  app.use('/api/equipment', createEquipmentRouter({
    pool,
    io: { emit() {} },
    security: { hasPermission: async (user, permission) => rolePerms(user.role).has(permission) || rolePerms(user.role).has('*') },
    authenticateToken(req, _res, next) {
      req.user = { id: `${role}-1`, username: role, name: role, role };
      next();
    }
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}/api/equipment`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('1 structure is served only inside the dossier of the current equipment', async () => {
  const pool = structurePool();
  await withApi(pool, 'mgr', async base => {
    const response = await fetch(`${base}/eq-root/structure`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, 'postgresql');
    assert.equal(body.data.rootEquipmentId, 'eq-root');
    assert.deepEqual(body.data.nodes.map(node => node.id), ['sub-1']);
    assert.equal(body.data.nodes[0].children[0].id, 'comp-1');
    assert.equal(body.data.nodes[0].children[0].children[0].id, 'part-1');
    assert.equal(body.data.nodes[0].level, 1);
    assert.equal(body.data.nodes[0].children[0].level, 2);
    const scopeCall = pool.state.calls.find(call => /FROM user_scopes/.test(call.sql));
    assert.deepEqual(scopeCall.values.slice(0, 2), ['mgr-1', 'eq-root']);
  });
});

test('2 the registry stays a flat comprehensive list without any tree mode', () => {
  const ui = read('public/equipment-v2/equipment-v2.js');
  const routes = read('server/equipment-routes.js');
  assert.match(ui, /فهرست جامع تجهیزات/);
  assert.doesNotMatch(ui, /eqv2View\(['"]tree/);
  assert.doesNotMatch(ui, /درخت تجهیزات/);
  assert.match(ui, /eqv2-structure-rows/);
  assert.match(routes, /router\.get\('\/:id\/structure'/);
  assert.doesNotMatch(read('public/index.html'), /id:'tree'/);
});

test('3 internal components stay filtered out of the comprehensive registry list', async () => {
  const pool = structurePool();
  pool.query = async (sql, values) => {
    pool.state.calls.push({ sql, values });
    if (/count\(\*\)::int total/.test(sql)) return { rows: [{ total: 1 }] };
    if (/FROM assets a/.test(sql)) return { rows: [{ id: 'eq-root', code: 'EQ-ROOT', name: 'ریشه تجهیز' }] };
    return { rows: [] };
  };
  await withApi(pool, 'planner', async base => {
    const response = await fetch(`${base}?limit=10`);
    assert.equal(response.status, 200);
    const listSql = pool.state.calls.map(call => call.sql).find(sql => /COALESCE\(a\.ext->>'nodeKind','equipment'\) NOT IN/.test(sql));
    assert.match(listSql, /'sub-equipment','subsystem','main-component','sub-component'/);
    assert.match(listSql, /NOT EXISTS\(SELECT 1 FROM assets structural_parent/);
  });
});

test('4-6 subsystem, main component and sub component chain is created through the equipment endpoints', async () => {
  const pool = structurePool();
  await withApi(pool, 'mgr', async base => {
    const subsystem = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeKind: 'subsystem', name: 'زیرسیستم دو', code: 'SUB-2', parentId: 'eq-root', parentRowVersion: 3 })
    });
    assert.equal(subsystem.status, 201);
    const created = (await subsystem.json()).data;
    assert.equal(created.parent, 'eq-root');
    assert.equal(created.ext.nodeKind, 'subsystem');
    const componentResponse = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeKind: 'main-component', name: 'قطعه اصلی دو', code: 'COMP-2', parentId: created.id, parentRowVersion: created.row_version, partNumber: 'X-1', requiredQuantity: 4 })
    });
    assert.equal(componentResponse.status, 201);
    const component = (await componentResponse.json()).data;
    const part = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeKind: 'sub-component', name: 'زیرقطعه دو', code: 'PART-2', parentId: component.id, parentRowVersion: component.row_version })
    });
    assert.equal(part.status, 201);
    assert.equal(pool.state.audit.filter(row => row.action === 'structure-create').length, 3);
  });
});

test('7 invalid parent kinds are rejected by the backend', async () => {
  const pool = structurePool();
  await withApi(pool, 'mgr', async base => {
    const response = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeKind: 'subsystem', name: 'غلط', code: 'BAD-1', parentId: 'comp-1', parentRowVersion: 2 })
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, 'STRUCTURE_PARENT_KIND_INVALID');
  });
});

test('8 cycles are prevented when moving a node under its own descendant', async () => {
  const pool = structurePool();
  await withApi(pool, 'mgr', async base => {
    const response = await fetch(`${base}/sub-1/move`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: 'part-1', rowVersion: 2, reason: 'چرخه' })
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, 'TREE_CYCLE');
  });
});

test('9 duplicate structural codes inside the equipment scope are rejected', async () => {
  const pool = structurePool();
  await withApi(pool, 'mgr', async base => {
    const response = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeKind: 'subsystem', name: 'تکراری', code: 'SUB-1', parentId: 'eq-root', parentRowVersion: 3 })
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'DUPLICATE_CODE');
  });
});

test('10-11 structure edits require the current row_version and report conflicts', async () => {
  const pool = structurePool();
  await withApi(pool, 'mgr', async base => {
    const ok = await fetch(`${base}/sub-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rowVersion: 2, name: 'زیرسیستم یک ویرایش شده', technicalSpecification: 'فشار بالا', inventoryItemId: 'item-1' })
    });
    assert.equal(ok.status, 200);
    const saved = (await ok.json()).data;
    assert.equal(saved.ext.technicalSpecification, 'فشار بالا');
    assert.equal(saved.ext.inventoryItemId, 'item-1');
    const stale = await fetch(`${base}/sub-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rowVersion: 2, name: 'تعارض' })
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, 'VERSION_CONFLICT');
  });
});

test('12-13 moves require reason, valid parents and update path inside a transaction', async () => {
  const pool = structurePool();
  await withApi(pool, 'mgr', async base => {
    const missingReason = await fetch(`${base}/part-1/move`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: 'comp-1', rowVersion: 2 })
    });
    assert.equal(missingReason.status, 422);
    assert.equal((await missingReason.json()).error, 'MOVE_REASON_REQUIRED');
    const invalidParent = await fetch(`${base}/part-1/move`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: 'eq-root', rowVersion: 2, reason: 'غلط' })
    });
    assert.equal(invalidParent.status, 422);
    assert.equal((await invalidParent.json()).error, 'STRUCTURE_PARENT_KIND_INVALID');
    const moved = await fetch(`${base}/part-1/move`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: 'comp-1', rowVersion: 2, reason: 'اصحاب بازبینی ساختار' })
    });
    assert.equal(moved.status, 200);
    const audit = pool.state.audit.find(row => row.action === 'structure-move');
    assert.equal(audit.entity, 'part-1');
    assert.match(audit.note, /اصحاب بازبینی ساختار/);
    assert.equal(pool.state.calls.some(call => /DELETE FROM assets/.test(call.sql)), false);
    assert.equal(pool.state.calls.some(call => /UPDATE (work_orders|failures|inventory_ledger)/.test(call.sql)), false);
  });
});

test('cross-equipment moves require the special permission and explicit confirmation', async () => {
  const pool = structurePool();
  pool.assets.set('eq-other', { id: 'eq-other', parent: 'factory-1', code: 'EQ-OTHER', name: 'تجهیز دیگر', type: 'eq', ext: { nodeKind: 'equipment' }, row_version: 1, deleted_at: null, is_active: true, sort_order: 0, category_id: null });
  pool.assets.set('sub-other', { id: 'sub-other', parent: 'eq-other', code: 'SUB-O', name: 'زیرسیستم دیگر', type: 'eq', ext: { nodeKind: 'subsystem' }, row_version: 1, deleted_at: null, is_active: true, sort_order: 0, category_id: null });
  await withApi(pool, 'mgr', async base => {
    const unconfirmed = await fetch(`${base}/sub-1/move`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: 'eq-other', rowVersion: 2, reason: 'انتقال' })
    });
    assert.equal(unconfirmed.status, 422);
    assert.equal((await unconfirmed.json()).error, 'CROSS_EQUIPMENT_CONFIRMATION_REQUIRED');
    const confirmed = await fetch(`${base}/sub-1/move`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: 'eq-other', rowVersion: 2, reason: 'انتقال بین تجهیزات', confirmCrossEquipment: true })
    });
    assert.equal(confirmed.status, 200);
    assert.equal(pool.state.audit.some(row => row.action === 'structure-cross-equipment-move'), true);
    const planner = await withApiDeniedFor(base => fetch(`${base}/sub-other/move`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: 'eq-root', rowVersion: 1, reason: 'انتقال', confirmCrossEquipment: true })
    }), 'planner');
    assert.equal(planner, 403);
  });
  async function withApiDeniedFor(action, role) {
    let status = null;
    await withApi(pool, role, async base => { status = (await action(base)).status; });
    return status;
  }
});

test('15-16 archiving requires a reason and refuses nodes with active children', async () => {
  const pool = structurePool();
  await withApi(pool, 'mgr', async base => {
    const missing = await fetch(`${base}/sub-1`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rowVersion: 2 }) });
    assert.equal(missing.status, 422);
    assert.equal((await missing.json()).error, 'ARCHIVE_REASON_REQUIRED');
    const withChildren = await fetch(`${base}/sub-1`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rowVersion: 2, reason: 'بایگانی' }) });
    assert.equal(withChildren.status, 409);
    assert.equal((await withChildren.json()).error, 'HAS_ACTIVE_CHILDREN');
    const archived = await fetch(`${base}/part-1`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rowVersion: 2, reason: 'از رده خارج شد' }) });
    assert.equal(archived.status, 200);
    const body = await archived.json();
    assert.equal(body.historyPreserved, true);
    assert.equal(pool.assets.get('part-1').deleted_at !== null, true);
    assert.equal(pool.state.audit.some(row => row.action === 'structure-archive'), true);
  });
});

test('17 no physical delete exists for structural records with history', () => {
  const sources = [read('server/equipment-structure.js'), read('server/equipment-routes.js')].join('\n');
  assert.doesNotMatch(sources, /DELETE FROM assets/i);
  assert.match(sources, /deleted_at=now\(\)/);
  assert.match(read('migrations/015_digital_equipment_structure.sql'), /Additive and idempotent/);
});

test('18 controlled restore reopens archived nodes only with permission and reason', async () => {
  const pool = structurePool();
  pool.assets.get('part-1').deleted_at = '2026-01-01T00:00:00.000Z';
  pool.assets.get('part-1').is_active = false;
  await withApi(pool, 'mgr', async base => {
    const missingReason = await fetch(`${base}/part-1/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rowVersion: 2 }) });
    assert.equal(missingReason.status, 422);
    assert.equal((await missingReason.json()).error, 'RESTORE_REASON_REQUIRED');
    const restored = await fetch(`${base}/part-1/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rowVersion: 2, reason: 'بازگشت به سرویس' }) });
    assert.equal(restored.status, 200);
    assert.equal(pool.assets.get('part-1').deleted_at, null);
    assert.equal(pool.state.audit.some(row => row.action === 'structure-restore'), true);
  });
});

test('19 create, edit, move and archive all write audit rows with before and after', async () => {
  const pool = structurePool();
  await withApi(pool, 'mgr', async base => {
    await fetch(`${base}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nodeKind: 'subsystem', name: 'ممیزی', code: 'AUD-1', parentId: 'eq-root', parentRowVersion: 3 }) });
    const createdId = [...pool.assets.values()].find(row => row.code === 'AUD-1').id;
    await fetch(`${base}/${createdId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rowVersion: 1, name: 'ممیزی دو' }) });
    await fetch(`${base}/${createdId}/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parentId: 'eq-root', rowVersion: 2, reason: 'جابه‌جایی ممیزی' }) });
    await fetch(`${base}/${createdId}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rowVersion: 3, reason: 'بایگانی ممیزی' }) });
    const actions = pool.state.audit.map(row => row.action);
    for (const action of ['structure-create', 'structure-edit', 'structure-move', 'structure-archive']) assert.ok(actions.includes(action), action);
    const edit = pool.state.audit.find(row => row.action === 'structure-edit');
    assert.ok(edit.before && edit.after);
  });
});

test('20-21 structure permissions and equipment scope are enforced in the backend', async () => {
  const pool = structurePool();
  await withApi(pool, 'tech', async base => {
    const view = await fetch(`${base}/eq-root/structure`);
    assert.equal(view.status, 403);
    assert.equal((await view.json()).error, 'PERMISSION_DENIED');
    const create = await fetch(`${base}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nodeKind: 'subsystem', name: 'x', code: 'X', parentId: 'eq-root', parentRowVersion: 3 }) });
    assert.equal(create.status, 403);
    assert.equal(pool.state.calls.some(call => /INSERT INTO assets/.test(call.sql)), false);
  });
  const unscoped = structurePool({ scoped: false });
  await withApi(unscoped, 'mgr', async base => {
    const response = await fetch(`${base}/eq-root/structure`);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'EQUIPMENT_SCOPE_DENIED');
  });
});

test('22 structure events are delivered only to authorized scoped recipients', async () => {
  const pool = structurePool();
  await withApi(pool, 'mgr', async base => {
    await fetch(`${base}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nodeKind: 'subsystem', name: 'رویداد', code: 'EV-1', parentId: 'eq-root', parentRowVersion: 3 }) });
    assert.equal(pool.state.outbox.length, 1);
    const event = pool.state.outbox[0];
    assert.equal(event.aggregateId, 'eq-root');
    assert.deepEqual(event.recipients, ['u-mgr']);
    const payload = JSON.parse(event.payload);
    assert.equal(payload.action, 'create');
    assert.equal(payload.rootEquipmentId, 'eq-root');
  });
});

test('23-25 inventory master data links real items and stock is read from the backend ledger', async () => {
  const pool = structurePool();
  await withApi(pool, 'mgr', async base => {
    const linked = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeKind: 'main-component', name: 'قطعه انباری', code: 'INV-1', parentId: 'sub-1', parentRowVersion: 2, inventoryItemId: 'item-1' })
    });
    assert.equal(linked.status, 201);
    assert.equal((await linked.json()).data.ext.inventoryItemId, 'item-1');
    const missingItem = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeKind: 'main-component', name: 'قطعه ناموجود', code: 'INV-2', parentId: 'sub-1', parentRowVersion: 2, inventoryItemId: 'no-item' })
    });
    assert.equal(missingItem.status, 422);
    assert.equal((await missingItem.json()).error, 'INVENTORY_ITEM_NOT_FOUND');
    assert.equal(pool.state.calls.some(call => /INSERT INTO items/.test(call.sql)), false);
    const view = await fetch(`${base}/eq-root/structure`);
    const nodes = (await view.json()).data.nodes;
    const component = nodes[0].children.find(node => node.code === 'INV-1');
    assert.equal(component.inventoryItem.code, 'SP-1');
    assert.equal(component.inventoryItem.available, 7);
    const search = await fetch(`${base}/inventory-items?q=یاتاقان`);
    assert.equal(search.status, 200);
    const found = (await search.json()).data;
    assert.equal(found[0].partNumber, 'P-100');
    assert.equal(found[0].available, 7);
    assert.match(read('public/equipment-v2/equipment-adapter.js'), /inventoryItems:/);
  });
});

test('26-27 the shared step wizard creates structure nodes and returns to the structure tab', async () => {
  const calls = [];
  const host = {
    innerHTML: '', ownerDocument: null, listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    removeEventListener(name) { delete this.listeners[name]; },
    querySelector() { return null; }, contains() { return true; }, replaceChildren() { this.innerHTML = ''; }
  };
  const repository = {
    source: 'postgresql',
    feature: async () => ({ enabled: true }),
    filters: async () => ({ factories: [], categories: [], locations: [], responsibleUsers: [] }),
    list: async () => ({ data: [], pagination: { page: 1, pages: 1, total: 0, limit: 50 } }),
    get: async () => ({ data: { id: 'eq-root', code: 'EQ-ROOT', name: 'ریشه', row_version: 3, path: [], children: [], pm_plans: [], ext: {} } }),
    structure: async () => ({ data: {
      rootEquipmentId: 'eq-root', root: { id: 'eq-root', code: 'EQ-ROOT', name: 'ریشه', rowVersion: 3 },
      nodes: [{ id: 'sub-1', code: 'SUB-1', name: 'زیرسیستم یک', nodeKind: 'subsystem', rowVersion: 2, children: [], path: [{ id: 'sub-1' }] }],
      capabilities: { create: true, update: true, move: true, archive: true, suggest: true, approveAi: true }, suggestions: []
    } }),
    structureCreate: async payload => { calls.push(['create', payload]); return { data: { id: 'sub-new', ...payload }, committed: true }; },
    inventoryItems: async () => ({ data: [{ id: 'item-1', code: 'SP-1', name: 'یاتاقان', unit: 'عدد', available: 7 }] })
  };
  const document = {
    getElementById: id => id === 'eqv2StructureWizardHost' ? host : id === 'content' ? { innerHTML: '' } : null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}
  };
  host.ownerDocument = document;
  const context = {
    MENU: [{ g: 'دارایی‌ها' }, { id: 'equipment', ic: '⚙️', t: 'فهرست جامع تجهیزات' }],
    pgTree: () => '<div>فهرست جامع تجهیزات</div>', doLogin() {}, ME: null, CUR: 'equipment', buildMenu() {},
    EquipmentRepository: { current: () => repository },
    sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null, setItem() {} },
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {}, requestAnimationFrame: fn => fn(),
    can: () => true, esc: value => String(value ?? ''), fa: value => String(value ?? ''), money: value => String(value ?? ''),
    jDate: value => String(value ?? ''), jDateTime: value => String(value ?? ''), AS_ST: { active: ['فعال', 'b-green'] },
    document, location: { pathname: '/equipment/EQ-ROOT', search: '', hash: '' },
    history: { pushState() {}, replaceState() {} }, CSS: { escape: value => String(value) },
    scrollY: 0, scrollTo() {}, addEventListener() {}, modal(html) { context.modalHtml = html; },
    mhead: title => `<div class="modal-title">${title}</div>`, closeModal() { context.EQV2.wizard = null; },
    confirm: () => true, toast: message => { context.toasts = (context.toasts || []).concat(message); },
    prompt: () => 'دلیل', console, crypto: { randomUUID: () => 'req-1' }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('public/platform-v2/step-wizard.js'), context);
  vm.runInContext(read('public/platform-v2/equipment-wizard-adapter.js'), context);
  vm.runInContext(read('public/equipment-v2/equipment-v2.js'), context);
  context.EQV2.structure = {
    rootEquipmentId: 'eq-root', root: { id: 'eq-root', code: 'EQ-ROOT', name: 'ریشه', rowVersion: 3 },
    nodes: [], capabilities: { create: true, update: true, move: true, archive: true, suggest: true, approveAi: true }, suggestions: []
  };
  assert.equal(context.EQV2.structure.rootEquipmentId, 'eq-root');
  context.EQV2.tab = 'structure';
  await context.eqv2StructureAdd('eq-root');
  const wizard = context.EQV2.wizard.instance;
  assert.equal(wizard.getCurrentStep().id, 'structureNode');
  assert.match(host.innerHTML, /ساختار داخلی/);
  assert.match(host.innerHTML, /زیرسیستم/);
  assert.doesNotMatch(host.innerHTML, /value="main-component"/);
  await wizard.setAnswer('name', 'زیرسیستم ویزاردی');
  await wizard.setAnswer('code', 'SUB-W');
  wizard.state.reviewConfirmed = true;
  await host.listeners.click({ target: { closest: selector => (selector === '[data-sw-action]' ? { dataset: { swAction: 'submit' } } : null), matches: () => false } });
  for (let tick = 0; tick < 40 && (!calls.length || !(context.toasts || []).length); tick++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(calls[0][0], 'create');
  assert.equal(calls[0][1].parentId, 'eq-root');
  assert.equal(calls[0][1].parentRowVersion, 3);
  assert.equal(calls[0][1].nodeKind, 'subsystem');
  assert.ok((context.toasts || []).some(message => String(message).includes('پس از commit')));
  assert.equal(context.EQV2.tab, 'structure');
});

test('28-30 Selene structure suggestions remain drafts until a human confirms them', async () => {
  const user = { id: 'u-1', name: 'Selene', role: 'mgr' };
  const applied = [];
  const api = createSeleneActions({
    repository: memoryRepository(),
    commands: { async apply(client, actor, draft) { applied.push(draft.actionType); return { id: 'node-1' }; } },
    authorize: () => true
  });
  const draft = await api.createDraft(user, {
    actionType: 'equipment.structure.add',
    proposed: { rootEquipmentId: 'eq-root', nodeKind: 'subsystem', name: 'پیشنهاد سلن', parentId: 'eq-root' },
    source: { kind: 'document', ref: 'run-1', verified: false },
    evidence: [{ field: 'name', value: 'پیشنهاد سلن', origin: 'provider-suggestion' }],
    confidence: 0.7
  });
  assert.equal(draft.status, 'pending');
  assert.equal(draft.destination, 'equipment.structure');
  assert.equal(applied.length, 0);
  await assert.rejects(() => api.executeDraft(user, draft.id, {}), error => error.code === 'CONFIRMATION_REQUIRED');
  const incomplete = await api.createDraft(user, {
    actionType: 'equipment.structure.add',
    proposed: { rootEquipmentId: 'eq-root', nodeKind: 'subsystem', name: 'ناقص' },
    source: { kind: 'document', ref: 'run-2', verified: false }, evidence: []
  });
  assert.equal(incomplete.status, 'incomplete');
  assert.ok(incomplete.missingFields.includes('parentId'));
  assert.ok(incomplete.missingFields.includes('evidence'));
  await assert.rejects(() => api.confirmDraft(user, incomplete.id), error => error.code === 'DRAFT_INCOMPLETE');
  const confirmation = await api.confirmDraft(user, draft.id);
  const result = await api.executeDraft(user, draft.id, { confirmationId: confirmation.id, requestId: 'req-structure-1' });
  assert.equal(result.committed, true);
  assert.equal(result.actionType, 'equipment.structure.add');
  assert.deepEqual(applied, ['equipment.structure.add']);
});

test('29 the controlled action path rechecks the approval permission before writing', async () => {
  const checked = [];
  const client = structurePool();
  const security = { hasPermission: async (user, permission) => { checked.push(permission); return permission === 'equipment.structure.approve_ai'; } };
  const row = await applyControlledAction(client, { id: 'u-1', role: 'mgr', name: 'mgr' }, {
    actionType: 'equipment.structure.add',
    proposed: { rootEquipmentId: 'eq-root', nodeKind: 'subsystem', name: 'تأیید شده', code: 'APR-1', parentId: 'eq-root' },
    recordVersion: 3
  }, { pool: client, security });
  assert.equal(row.ext.nodeKind, 'subsystem');
  assert.ok(checked.includes('equipment.structure.approve_ai'));
  assert.equal(checked.includes('equipment.structure.create'), false);
  const denied = structurePool();
  await assert.rejects(
    () => applyControlledAction(denied, { id: 'u-2', role: 'mgr', name: 'mgr' }, {
      actionType: 'equipment.structure.add',
      proposed: { rootEquipmentId: 'eq-root', nodeKind: 'subsystem', name: 'بدون مجوز', parentId: 'eq-root' },
      recordVersion: 3
    }, { pool: denied, security: { hasPermission: async () => false } }),
    error => error.code === 'PERMISSION_DENIED'
  );
});

test('31 without an active provider the manual structure flow stays fully available', async () => {
  const pool = structurePool();
  await withApi(pool, 'mgr', async base => {
    const suggestion = await fetch(`${base}/eq-root/structure/suggestions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(suggestion.status, 201);
    const body = await suggestion.json();
    assert.equal(body.data.provider, null);
    assert.equal(body.data.notice, 'NO_CAPABLE_PROVIDER');
    assert.deepEqual(body.data.suggestions, []);
    const manual = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeKind: 'subsystem', name: 'دستی', code: 'MAN-1', parentId: 'eq-root', parentRowVersion: 3 })
    });
    assert.equal(manual.status, 201);
  });
});

test('32 the phase 2 migration preserves existing data and mirrors schema.sql', () => {
  const migration = read('migrations/015_digital_equipment_structure.sql');
  const schema = read('schema.sql');
  assert.doesNotMatch(migration, /\b(DROP|TRUNCATE|DELETE)\b/i);
  assert.doesNotMatch(migration, /UPDATE assets/i);
  assert.match(migration, /ON CONFLICT \(role, permission\) DO NOTHING/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_assets_structure_parent/);
  for (const permission of STRUCTURE_PERMISSIONS.slice(0, 6)) assert.match(schema, new RegExp(permission.replace('.', '\\.')));
  assert.match(schema, /equipment\.structure\.move_cross_equipment/);
  const ui = read('public/equipment-v2/equipment-v2.js');
  assert.match(ui, /ساختار/);
  assert.doesNotMatch(ui, /localStorage\.setItem/);
});
