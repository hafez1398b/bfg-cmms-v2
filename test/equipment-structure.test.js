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
  // Real stock and real purchase rows, keyed by inventory item id. Both stay empty by default
  // so the tests prove nothing is invented when the ledger has no data.
  const balances = options.balances || new Map();
  const purchases = options.purchases || new Map();
  const state = { calls: [], audit: [], outbox: [], scoped: options.scoped !== false, users: options.users || [
    { id: 'u-mgr', role: 'mgr', permissions: ['equipment.structure.view'], scopes: [{ scope_type: 'equipment', scope_id: 'eq-root' }] },
    { id: 'u-out', role: 'tech', permissions: ['equipment.structure.view'], scopes: [] }
  ] };

  // Mirrors the production SQL exactly: COALESCE(NULLIF(ext->>'nodeKind',''),'equipment').
  // Legacy real equipment rows carry no nodeKind at all and must still resolve to themselves,
  // which is the regression that produced ROOT_EQUIPMENT_NOT_FOUND on a live database.
  const resolveRoot = id => {
    let current = assets.get(id);
    const seen = new Set();
    let best = null;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      const raw = current.ext && current.ext.nodeKind;
      const kind = raw == null || raw === '' ? 'equipment' : raw;
      if (kind === 'equipment' || kind === 'sub-equipment') {
        if (!best || kind === 'equipment') best = { row: current, kind };
      }
      current = assets.get(current.parent);
    }
    return best ? best.row : null;
  };

  async function query(sql, values = []) {
    state.calls.push({ sql, values });
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql.trim())) return { rows: [] };
    if (/FROM user_scopes WHERE user_id=\$1/.test(sql)) return { rows: state.scoped ? [{ 1: 1 }] : [] };
    if (/WITH RECURSIVE ancestry AS/.test(sql) && /node_kind IN \('equipment','sub-equipment'\)/.test(sql)) {
      assert.match(sql, /COALESCE\(NULLIF\([ap]\.ext->>'nodeKind',''\),'equipment'\)/);
      const resolved = resolveRoot(values[0]);
      if (!resolved) return { rows: [] };
      const raw = resolved.ext && resolved.ext.nodeKind;
      return { rows: [{ id: resolved.id, parent: resolved.parent, type: resolved.type, node_kind: raw == null || raw === '' ? 'equipment' : raw, category_id: resolved.category_id, depth: 0 }] };
    }
    if (/AS factory_id/.test(sql)) return { rows: [{ factory_id: 'factory-1' }] };
    if (/WITH RECURSIVE structure AS/.test(sql)) {
      const includeArchived = values[1] === true;
      const rows = [];
      const walk = (parentId, depth) => {
        for (const row of assets.values()) {
          if (row.parent !== parentId) continue;
          if (row.deleted_at && !includeArchived) continue;
          const item = row.ext.inventoryItemId && items.get(row.ext.inventoryItemId) ? items.get(row.ext.inventoryItemId) : null;
          const balance = item ? balances.get(item.id) : null;
          const purchase = item ? purchases.get(item.id) : null;
          rows.push({
            ...row, parent_id: row.parent, depth, cycle: false,
            inventory_item: item ? { ...item, available: balance ? balance.available : 0 } : null,
            stock_on_hand: item && balance ? balance.onHand : null,
            stock_reserved: item && balance ? balance.reserved : null,
            stock_available: item && balance ? balance.available : null,
            last_purchase: item && purchase ? purchase : null
          });
          walk(row.id, depth + 1);
        }
      };
      walk(values[0], 1);
      return { rows };
    }
    if (/WHERE code=\$1 AND type='eq'/.test(sql)) {
      const found = [...assets.values()].find(row => String(row.code || '') === String(values[0])
        && row.type === 'eq' && !row.deleted_at
        && ['equipment', 'sub-equipment'].includes(row.ext && row.ext.nodeKind ? row.ext.nodeKind : 'equipment'));
      return { rows: found ? [{ id: found.id }] : [] };
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
      return { rows: rows.map(item => ({
        ...item,
        available: balances.get(item.id) ? balances.get(item.id).available : 0,
        last_purchase_at: purchases.get(item.id) ? purchases.get(item.id).at : null
      })) };
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
  // The structure lives only inside the dossier and is rendered as an expandable hierarchy table.
  assert.match(ui, /eqv2-structure-table/);
  assert.match(ui, /eqv2-structure-toggle/);
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
  // Real item_balances rows: 9 on hand, 2 reserved, therefore 7 available. The structure
  // must read these numbers instead of accepting a typed stock value.
  const pool = structurePool({
    balances: new Map([['item-1', { onHand: 9, reserved: 2, available: 7 }]]),
    purchases: new Map([['item-1', {
      at: '2026-09-18T07:30:00.000Z', entryNo: 'RCV-1042', qty: 12, unitCost: 350000,
      note: 'رسید انبار مرکزی', movement: 'receipt', warehouseId: 'wh-1'
    }]])
  });
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
    assert.equal(component.stockOnHand, 9);
    assert.equal(component.stockReserved, 2);
    assert.equal(component.stockAvailable, 7);
    assert.equal(component.lastPurchase.entryNo, 'RCV-1042');
    assert.equal(component.lastPurchase.qty, 12);
    assert.equal(component.lastPurchase.unitCost, 350000);
    assert.equal(component.lastPurchase.at, '2026-09-18T07:30:00.000Z');
    assert.equal(component.lastPurchase.source, 'inventory_ledger');
    // No supplier column exists on a real receipt, so none may be invented.
    assert.equal(component.lastPurchase.supplier, null);
    const search = await fetch(`${base}/inventory-items?q=یاتاقان`);
    assert.equal(search.status, 200);
    const found = (await search.json()).data;
    assert.equal(found[0].partNumber, 'P-100');
    assert.equal(found[0].available, 7);
    assert.equal(found[0].lastPurchaseAt, '2026-09-18T07:30:00.000Z');
    assert.equal(found[0].source, 'inventory_master_data');
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

/* ---------- Phase 2 correction: ROOT_EQUIPMENT_NOT_FOUND on real legacy data ---------- */

// Real pre-dossier equipment rows (type='eq') never stored ext->>'nodeKind'; only location rows
// did. These tests reproduce that data shape so the regression cannot come back silently.
function legacyAssets() {
  const make = (id, parent, extra = {}) => ({
    id, parent, code: extra.code || id.toUpperCase(), name: extra.name || id, type: extra.type || 'eq',
    cls: null, status: 'active', crit: extra.crit || 'B', maker: extra.maker || null,
    model: extra.model || null, serial: null, ext: extra.ext === undefined ? {} : extra.ext,
    row_version: extra.rowVersion || 4, deleted_at: extra.deletedAt || null, delete_reason: null,
    is_active: !extra.deletedAt, sort_order: 0, category_id: null
  });
  return new Map(Object.entries({
    // Location hierarchy carries an explicit nodeKind, exactly like the seeded legacy data.
    'factory-1': make('factory-1', null, { type: 'site', name: 'کارخانه بسپار ۱', ext: { nodeKind: 'factory' } }),
    'line-1': make('line-1', 'factory-1', { type: 'unit', name: 'خط یک', ext: { nodeKind: 'line' } }),
    // The real equipment: no nodeKind at all. This is B1P01 in the local environment.
    'b1p01': make('b1p01', 'line-1', { code: 'B1P01', name: 'پمپ ورودی', maker: 'Grundfos', model: 'NK-80', crit: 'A' }),
    'b1p02-childless': make('b1p02-childless', 'line-1', { code: 'B1P02', name: 'پمپ ذخیره' }),
    'archived-eq': make('archived-eq', 'line-1', { code: 'B1P09', name: 'پمپ از رده خارج', deletedAt: '2026-08-01T00:00:00.000Z' })
  }));
}

function legacyPool(extra = {}) {
  return structurePool({
    assets: legacyAssets(),
    users: [
      { id: 'u-mgr', role: 'mgr', permissions: ['equipment.structure.view', 'inventory.view'], scopes: [{ scope_type: 'company' }] },
      { id: 'u-out', role: 'tech', permissions: ['equipment.structure.view'], scopes: [] }
    ],
    ...extra
  });
}

test('33 an existing legacy equipment row without nodeKind opens its dossier structure', async () => {
  const pool = legacyPool();
  await withApi(pool, 'mgr', async base => {
    const response = await fetch(`${base}/b1p01/structure`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, 'postgresql');
    assert.equal(body.data.rootEquipmentId, 'b1p01');
    assert.equal(body.data.root.code, 'B1P01');
    assert.equal(body.data.root.nodeKind, 'equipment');
    assert.deepEqual(body.data.nodes, []);
  });
  // The resolver must apply the same fallback the registry always applied.
  assert.match(read('server/equipment-structure.js'), /COALESCE\(NULLIF\(a\.ext->>'nodeKind',''\),'equipment'\)/);
});

test('34 an existing equipment root without any child never answers ROOT_EQUIPMENT_NOT_FOUND', async () => {
  const pool = legacyPool();
  await withApi(pool, 'mgr', async base => {
    const response = await fetch(`${base}/b1p02-childless/structure`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.root.code, 'B1P02');
    assert.deepEqual(body.data.nodes, []);
    assert.equal(body.data.rootEquipmentId, 'b1p02-childless');
    assert.equal(body.data.root.id, 'b1p02-childless');
    assert.equal(body.data.nodeCount, 0);
  });
});

test('35 only a genuinely missing equipment row receives 404', async () => {
  const pool = legacyPool();
  await withApi(pool, 'mgr', async base => {
    const missing = await fetch(`${base}/no-such-equipment/structure`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'EQUIPMENT_NOT_FOUND');

    const archived = await fetch(`${base}/archived-eq/structure`);
    assert.equal(archived.status, 404);
    assert.equal((await archived.json()).error, 'EQUIPMENT_NOT_FOUND');

    // A real location node exists but can never own an equipment structure.
    const location = await fetch(`${base}/factory-1/structure`);
    assert.equal(location.status, 404);
    assert.equal((await location.json()).error, 'ROOT_EQUIPMENT_NOT_FOUND');
  });
});

test('36 the dossier always sends the real PostgreSQL id, never the equipment code', async () => {
  const ui = read('public/equipment-v2/equipment-v2.js');
  // Row click, hero button and structure queue all use the record id from the list payload.
  assert.match(ui, /data-equipment-detail="\$\{escText\(a\.id\)\}"/);
  assert.match(ui, /eqv2OpenDetail\('\$\{escText\(a\.id\)\}'\)/);
  assert.match(ui, /queueStructureLoad\(a\.id\)/);
  assert.doesNotMatch(ui, /queueStructureLoad\(\s*a\.code/);
  assert.doesNotMatch(ui, /eqv2OpenDetail\('\$\{escText\(a\.code\)\}'\)/);
  const adapter = read('public/equipment-v2/equipment-adapter.js');
  assert.match(adapter, /structure:\(id,options\)=>api\('\/'\+encodeURIComponent\(id\)\+'\/structure'/);

  // Sending the code where the id belongs must fail loudly instead of falling back locally.
  const pool = legacyPool();
  await withApi(pool, 'mgr', async base => {
    const byCodeAsId = await fetch(`${base}/B1P01/structure`);
    assert.equal(byCodeAsId.status, 404);
    assert.equal((await byCodeAsId.json()).error, 'EQUIPMENT_NOT_FOUND');
  });
  assert.doesNotMatch(ui, /localStorage[^;]{0,80}structure/i);
  assert.doesNotMatch(adapter, /localStorage/);
});

test('37 addressing the structure by code is explicit, validated and permission-checked', async () => {
  const pool = legacyPool();
  await withApi(pool, 'mgr', async base => {
    const explicit = await fetch(`${base}/B1P01/structure?by=code`);
    assert.equal(explicit.status, 200);
    assert.equal((await explicit.json()).data.rootEquipmentId, 'b1p01');

    const unknown = await fetch(`${base}/NO-CODE/structure?by=code`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'EQUIPMENT_NOT_FOUND');

    const badMode = await fetch(`${base}/b1p01/structure?by=slug`);
    assert.equal(badMode.status, 422);
    assert.equal((await badMode.json()).error, 'EQUIPMENT_ID_INVALID');
  });
  await withApi(legacyPool(), 'tech', async base => {
    const denied = await fetch(`${base}/B1P01/structure?by=code`);
    assert.equal(denied.status, 403);
  });
});

test('38 the structure tab keeps scope and permission checks for legacy equipment', async () => {
  await withApi(legacyPool(), 'tech', async base => {
    const denied = await fetch(`${base}/b1p01/structure`);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, 'PERMISSION_DENIED');
  });
  const unscoped = legacyPool({ scoped: false });
  await withApi(unscoped, 'mgr', async base => {
    const response = await fetch(`${base}/b1p01/structure`);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'EQUIPMENT_SCOPE_DENIED');
  });
});

test('39 migration 016 backfills legacy equipment without rewriting or inventing anything', () => {
  const backfill = read('migrations/016_structure_root_equipment_backfill.sql');
  assert.match(backfill, /a\.type='eq'\s+AND a\.deleted_at IS NULL\s+AND NULLIF\(a\.ext->>'nodeKind',''\) IS NULL/);
  assert.match(backfill, /jsonb_build_object\('nodeKind','equipment'\)/);
  assert.match(backfill, /AND NULLIF\(assets\.ext->>'nodeKind',''\) IS NULL/);
  assert.match(backfill, /HAVING bool_or\(has_equipment_ancestor\)=false/);
  // An equipment row under another equipment row keeps its real position.
  assert.match(backfill, /COALESCE\(NULLIF\(p\.ext->>'nodeKind',''\),'equipment'\) IN \('equipment','sub-equipment'\)/);
  assert.match(backfill, /CREATE INDEX IF NOT EXISTS idx_assets_structure_root_equipment/);
  // Non-destructive and re-runnable: nothing is dropped, truncated, deleted or re-parented.
  assert.doesNotMatch(backfill, /\b(DROP|TRUNCATE|DELETE)\b/i);
  assert.doesNotMatch(backfill, /SET\s+(parent|code|name|type|row_version)\s*=/i);
  // The runtime must not depend on the backfill having been applied.
  const service = read('server/equipment-structure.js');
  assert.match(service, /COALESCE\(NULLIF\(p\.ext->>'nodeKind',''\),'equipment'\)/);
  assert.match(read('schema.sql'), /idx_assets_structure_root_equipment/);
});

test('40 stock and purchase values cannot be typed and are never written into structure fields', async () => {
  const pool = legacyPool({ balances: new Map([['item-1', { onHand: 4, reserved: 1, available: 3 }]]) });
  await withApi(pool, 'mgr', async base => {
    const created = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodeKind: 'subsystem', name: 'زیرسیستم انبار', code: 'LEG-SUB', parentId: 'b1p01', parentRowVersion: 4,
        inventoryItemId: 'item-1', stockOnHand: 999, stockAvailable: 999, lastPurchase: { entryNo: 'FAKE' }
      })
    });
    assert.equal(created.status, 201);
    const ext = (await created.json()).data.ext;
    assert.equal(ext.inventoryItemId, 'item-1');
    // Whitelisted ext fields only: no typed stock and no fabricated purchase survives.
    assert.equal(ext.stockOnHand, undefined);
    assert.equal(ext.stockAvailable, undefined);
    assert.equal(ext.lastPurchase, undefined);
    assert.equal(ext.supplier, undefined);
  });
  const service = read('server/equipment-structure.js');
  assert.match(service, /FROM item_balances balance/);
  assert.match(service, /receipt\.movement='receipt'/);
  // The schema stores no supplier on a real receipt, so the value must be exactly null.
  assert.match(service, /supplier: null,/);
  assert.doesNotMatch(service, /supplier\s*:\s*(?:row|source|ext|purchase|[A-Za-z_$][\w$]*\.)/);
});

test('41 without a real receipt the last purchase stays empty instead of invented', async () => {
  const items = new Map([['item-1', { id: 'item-1', code: 'SP-1', name: 'یاتاقان', unit: 'عدد', part_type: 'spare', ext: { partNumber: 'P-100' }, deleted_at: null }]]);
  const assets = baseAssets();
  assets.get('comp-1').ext = { ...assets.get('comp-1').ext, inventoryItemId: 'item-1' };
  const pool = structurePool({ assets, items });
  await withApi(pool, 'mgr', async base => {
    const view = await fetch(`${base}/eq-root/structure`);
    const component = (await view.json()).data.nodes[0].children[0];
    assert.equal(component.code, 'COMP-1');
    assert.equal(component.inventoryItem.code, 'SP-1');
    assert.equal(component.lastPurchase, null);
    assert.equal(component.stockAvailable, null);
  });
  assert.match(read('public/equipment-v2/equipment-v2.js'), /ثبت نشده/);
});

test('42 the structure tab renders a real hierarchy table with every required column', () => {
  const ui = read('public/equipment-v2/equipment-v2.js');
  for (const column of ['نام', 'کد', 'نوع', 'برند', 'مدل', 'شماره قطعه', 'تعداد', 'وضعیت', 'بحرانیت',
    'قلم انبار', 'موجودی', 'آخرین خرید', 'تأمین‌کننده', 'عملیات']) {
    assert.ok(ui.includes(column), `structure table is missing the column ${column}`);
  }
  for (const action of ['افزودن فرزند', 'ویرایش', 'جزئیات', 'جابه‌جایی', 'بایگانی']) {
    assert.ok(ui.includes(action), `structure row is missing the action ${action}`);
  }
  // Expandable rows, breadcrumb and the Persian empty state with the add-subsystem button.
  assert.match(ui, /eqv2StructureToggle/);
  assert.match(ui, /eqv2-structure-crumbs/);
  assert.match(ui, /افزودن زیرسیستم/);
  // No raw backend code may reach the user: every structure error has a Persian message.
  for (const code of ['ROOT_EQUIPMENT_NOT_FOUND', 'EQUIPMENT_NOT_FOUND', 'EQUIPMENT_ID_INVALID',
    'EQUIPMENT_SCOPE_DENIED', 'PERMISSION_DENIED', 'STRUCTURE_NODE_NOT_FOUND']) {
    assert.match(ui, new RegExp(`${code}:\\s*'[^']+'`), `${code} has no Persian UI message`);
  }
  assert.match(ui, /STRUCTURE_MESSAGES\[st\.error\]\|\|/);
  assert.doesNotMatch(ui, /escText\(st\.error\)\|\|st\.error\)/);
});

function structureUiHarness(repository, asset) {
  const bodies = {};
  const host = {
    innerHTML: '', ownerDocument: null, listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    removeEventListener(name) { delete this.listeners[name]; },
    querySelector() { return null; }, contains() { return true; }, replaceChildren() { this.innerHTML = ''; }
  };
  const document = {
    getElementById: id => {
      if (id === 'eqv2StructureWizardHost') return host;
      if (!bodies[id]) bodies[id] = { innerHTML: '', classList: { toggle() {}, remove() {}, add() {} }, setAttribute() {} };
      return bodies[id];
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}
  };
  host.ownerDocument = document;
  const context = {
    MENU: [{ g: 'دارایی‌ها' }, { id: 'equipment', ic: '⚙️', t: 'فهرست جامع تجهیزات' }],
    pgTree: () => '<div>فهرست جامع تجهیزات</div>', doLogin() {}, ME: { id: 'u-mgr', role: 'mgr' }, CUR: 'equipment', buildMenu() {},
    EquipmentRepository: { current: () => repository },
    sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null, setItem() {} },
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {}, requestAnimationFrame: fn => fn(),
    can: () => true, esc: value => String(value ?? ''), fa: value => String(value ?? ''), money: value => String(value ?? ''),
    jDate: value => String(value ?? ''), jDateTime: value => String(value ?? ''), AS_ST: { active: ['فعال', 'b-green'] },
    document, location: { pathname: '/equipment/B1P01', search: '', hash: '' },
    history: { pushState() {}, replaceState() {} }, CSS: { escape: value => String(value) },
    scrollY: 0, scrollTo() {}, addEventListener() {}, modal(html) { context.modalHtml = html; },
    mhead: title => `<div class="modal-title">${title}</div>`, closeModal() { context.EQV2.wizard = null; },
    confirm: () => true, toast: message => { context.toasts = (context.toasts || []).concat(message); },
    prompt: () => 'دلیل', console, crypto: { randomUUID: () => 'req-1' }, Intl
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('public/platform-v2/step-wizard.js'), context);
  vm.runInContext(read('public/platform-v2/equipment-wizard-adapter.js'), context);
  vm.runInContext(read('public/equipment-v2/equipment-v2.js'), context);
  context.EQV2.tab = 'structure';
  context.EQV2.detail = true;
  context.EQV2.detailKey = asset.id;
  return { context, bodies, host };
}

function legacyStructureRepository(structurePayload) {
  return {
    source: 'postgresql',
    feature: async () => ({ enabled: true }),
    filters: async () => ({ factories: [], categories: [], locations: [], responsibleUsers: [] }),
    list: async () => ({ data: [], pagination: { page: 1, pages: 1, total: 0, limit: 50 } }),
    get: async () => ({ data: { id: 'b1p01', code: 'B1P01', name: 'پمپ ورودی', row_version: 4, maker: 'Grundfos', model: 'NK-80', crit: 'A', status: 'active', path: [], children: [], pm_plans: [], ext: {} } }),
    structure: async () => ({ data: structurePayload }),
    inventoryItems: async () => ({ data: [] })
  };
}

test('43 the structure tab renders the real hierarchy with every column and the empty state', async () => {
  const payload = {
    // Exactly what GET /api/equipment/:id/structure returns for real legacy equipment:
    // rootEquipmentId is present and there is no rootId field at all.
    rootEquipmentId: 'b1p01',
    root: { id: 'b1p01', code: 'B1P01', name: 'پمپ ورودی', nodeKind: 'equipment', rowVersion: 4 },
    nodes: [{
      id: 'sub-1', code: 'B1P01-SUB', name: 'زیرسیستم هیدرولیک', nodeKind: 'subsystem', level: 1,
      rowVersion: 2, status: 'active', crit: 'A', maker: 'Grundfos', model: 'HX-2', partNumber: 'P-900',
      requiredQuantity: 2, unit: 'عدد', brand: 'Grundfos', inventoryItemId: 'item-1',
      inventoryItem: { id: 'item-1', code: 'SP-1', name: 'یاتاقان', unit: 'عدد', available: 7, partNumber: 'P-900', manufacturer: 'SKF' },
      stockOnHand: 9, stockReserved: 2, stockAvailable: 7,
      lastPurchase: { at: '2026-09-18T07:30:00.000Z', entryNo: 'RCV-1042', qty: 12, unitCost: 350000, supplier: null, source: 'inventory_ledger' },
      validRelation: true, archived: false, path: [{ id: 'sub-1' }],
      children: [{
        id: 'comp-1', code: 'B1P01-CMP', name: 'قطعه اصلی مکانیکال سیل', nodeKind: 'main-component', level: 2,
        rowVersion: 1, status: 'active', crit: 'B', model: 'MS-40', requiredQuantity: 1,
        inventoryItemId: null, inventoryItem: null, stockAvailable: null, lastPurchase: null,
        validRelation: true, archived: false, path: [{ id: 'sub-1' }, { id: 'comp-1' }], children: []
      }]
    }],
    orphaned: [], diagnostics: [], nodeCount: 2, includeArchived: false,
    capabilities: { create: true, update: true, move: true, moveAcrossEquipment: false, archive: true, suggest: true, approveAi: true, inventoryView: true },
    suggestions: []
  };
  const harness = structureUiHarness(legacyStructureRepository(payload), { id: 'b1p01' });
  harness.context.EQV2.detailKey = 'B1P01';
  // Real render path: the tab entry point, first pass queues the load, second pass paints it.
  await harness.context.eqv2DetailTab('structure');
  await harness.context.eqv2DetailTab('structure');
  const body = harness.bodies.eqv2DetailBody.innerHTML;
  assert.ok(body.length > 0, 'the structure tab produced no markup');
  // Root id normalization: the tab must not stay on the loading placeholder.
  assert.doesNotMatch(body, /در حال دریافت ساختار تجهیز/);
  assert.equal(harness.context.EQV2.structure.rootId, 'b1p01');
  assert.match(body, /eqv2-structure-table/);
  for (const column of ['نام', 'کد', 'نوع', 'برند / سازنده', 'مدل', 'شماره قطعه', 'تعداد', 'وضعیت', 'بحرانیت',
    'قلم انبار مرتبط', 'موجودی واقعی', 'آخرین خرید', 'تأمین‌کننده آخرین خرید', 'عملیات']) {
    assert.ok(body.includes(column), `rendered table is missing the column ${column}`);
  }
  // تجهیز ← زیرسیستم ← قطعه اصلی ← زیرقطعه, both levels visible with an expand control.
  assert.match(body, /زیرسیستم هیدرولیک/);
  assert.match(body, /قطعه اصلی مکانیکال سیل/);
  assert.match(body, /eqv2-structure-toggle/);
  assert.match(body, /SP-1/);
  assert.match(body, /RCV-1042/);
  // Real purchase carries no supplier, so the cell says "ثبت نشده" instead of inventing one.
  assert.match(body, /ثبت نشده/);
  // Row actions.
  for (const action of ['افزودن فرزند', 'ویرایش', 'مشاهده جزئیات', 'جابه‌جایی', 'بایگانی']) {
    assert.ok(body.includes(action), `rendered row is missing the action ${action}`);
  }
  assert.match(body, /eqv2-structure-crumbs/);

  // Collapsing a row hides its children; expanding brings them back.
  harness.context.eqv2StructureToggle('sub-1');
  await harness.context.eqv2DetailTab('structure');
  assert.doesNotMatch(harness.bodies.eqv2DetailBody.innerHTML, /قطعه اصلی مکانیکال سیل/);
  harness.context.eqv2StructureToggle('sub-1');
  await harness.context.eqv2DetailTab('structure');
  assert.match(harness.bodies.eqv2DetailBody.innerHTML, /قطعه اصلی مکانیکال سیل/);

  // Empty state for an existing equipment without any child: Persian text plus the add button.
  const emptyHarness = structureUiHarness(legacyStructureRepository({
    rootEquipmentId: 'b1p01', root: { id: 'b1p01', code: 'B1P01', name: 'پمپ ورودی', nodeKind: 'equipment', rowVersion: 4 },
    nodes: [], orphaned: [], diagnostics: [], nodeCount: 0, includeArchived: false,
    capabilities: { create: true, update: true, move: true, archive: true, suggest: true, approveAi: true }, suggestions: []
  }), { id: 'b1p01' });
  emptyHarness.context.EQV2.detailKey = 'B1P01';
  await emptyHarness.context.eqv2DetailTab('structure');
  await emptyHarness.context.eqv2DetailTab('structure');
  const emptyBody = emptyHarness.bodies.eqv2DetailBody.innerHTML;
  assert.doesNotMatch(emptyBody, /در حال دریافت ساختار تجهیز/);
  assert.doesNotMatch(emptyBody, /eqv2-structure-table/);
  assert.match(emptyBody, /هنوز زیرسیستم، قطعه اصلی یا زیرقطعه‌ای ثبت نشده/);
  assert.match(emptyBody, /افزودن زیرسیستم/);
  assert.match(emptyBody, /eqv2StructureAddRoot/);

  // A backend failure must surface a Persian sentence, never the raw code.
  const failing = legacyStructureRepository({});
  failing.structure = async () => { throw Object.assign(new Error('ROOT_EQUIPMENT_NOT_FOUND'), { payload: { error: 'ROOT_EQUIPMENT_NOT_FOUND' } }); };
  const failHarness = structureUiHarness(failing, { id: 'b1p01' });
  failHarness.context.EQV2.detailKey = 'B1P01';
  await failHarness.context.eqv2DetailTab('structure');
  await failHarness.context.eqv2DetailTab('structure');
  const failBody = failHarness.bodies.eqv2DetailBody.innerHTML;
  assert.match(failBody, /این رکورد تجهیز ریشه‌ای نیست/);
  assert.doesNotMatch(failBody, />ROOT_EQUIPMENT_NOT_FOUND</);
});
