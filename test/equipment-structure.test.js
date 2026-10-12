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
  const state = { calls: [], audit: [], outbox: [], idempotency: new Map(), scoped: options.scoped !== false, users: options.users || [
    { id: 'u-mgr', role: 'mgr', permissions: ['equipment.structure.view'], scopes: [{ scope_type: 'equipment', scope_id: 'eq-root' }] },
    { id: 'u-out', role: 'tech', permissions: ['equipment.structure.view'], scopes: [] }
  ] };

  // Mirrors the production SQL exactly: COALESCE(NULLIF(ext->>'nodeKind',''),'equipment').
  // Legacy real equipment rows carry no nodeKind at all and must still resolve to themselves,
  // which is the regression that produced ROOT_EQUIPMENT_NOT_FOUND on a live database.
  const INTERNAL_TEST_KINDS = ['subsystem', 'main-component', 'sub-component', 'sub', 'sys', 'panel'];
  // Every equipment candidate in the ancestry chain, with its real depth, so the harness obeys
  // the ORDER BY direction of the SQL under test instead of hard-coding an outcome.
  // registryRule mirrors the NOT internal_child predicate of the SQL under test: a row is a root
  // equipment only when its immediate parent is not a live type='eq' row (the registry definition).
  const rootCandidates = (id, { registryRule = false } = {}) => {
    let current = assets.get(id);
    const seen = new Set();
    const found = [];
    let depth = 0;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      const raw = current.ext && current.ext.nodeKind;
      const kind = raw == null || raw === '' ? 'equipment' : raw;
      const parentRow = current.parent ? assets.get(current.parent) : null;
      const internalChild = !registryRule ? false : !!(parentRow && parentRow.type === 'eq' && !parentRow.deleted_at);
      if (current.type === 'eq' && !internalChild && !INTERNAL_TEST_KINDS.includes(kind)) found.push({ row: current, kind, depth });
      current = assets.get(current.parent);
      depth += 1;
    }
    return found;
  };
  // Nearest equipment row wins, exactly like ORDER BY depth ASC in the corrected SQL, because the
  // comprehensive registry defines a root equipment by looking at its immediate parent only.
  const resolveRoot = id => rootCandidates(id, { registryRule: true }).sort((a, b) => a.depth - b.depth)[0]?.row || null;

  async function query(sql, values = []) {
    state.calls.push({ sql, values });
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql.trim())) return { rows: [] };
    if (/DELETE FROM idempotency_keys/.test(sql)) return { rows: [] };
    if (/INSERT INTO idempotency_keys/.test(sql)) {
      const key=`${values[0]}:${values[1]}`;
      if(state.idempotency.has(key))return{rows:[]};
      state.idempotency.set(key,{user_id:values[0],idempotency_key:values[1],request_hash:values[2],response_status:null,response_body:null});
      return{rows:[{idempotency_key:values[1]}]};
    }
    if (/SELECT request_hash,response_status,response_body FROM idempotency_keys/.test(sql)) {
      const row=state.idempotency.get(`${values[0]}:${values[1]}`);
      return{rows:row?[{...row}]:[]};
    }
    if (/UPDATE idempotency_keys SET response_status=201/.test(sql)) {
      const row=state.idempotency.get(`${values[0]}:${values[1]}`);
      if(row&&row.request_hash===values[3]){row.response_status=201;row.response_body=JSON.parse(values[2]);}
      return{rows:[]};
    }
    if (/FROM user_scopes WHERE user_id=\$1/.test(sql)) return { rows: state.scoped ? [{ 1: 1 }] : [] };
    if (/WITH RECURSIVE ancestry AS/.test(sql) && /node_kind NOT IN \('subsystem','main-component','sub-component','sub','sys','panel'\)/.test(sql)) {
      assert.match(sql, /COALESCE\(NULLIF\([ap]\.ext->>'nodeKind',''\),'equipment'\)/);
      assert.match(sql, /ORDER BY depth (ASC|DESC) LIMIT 1/);
      // The harness obeys the SQL under test: the registry rule (NOT internal_child) and the
      // direction. ASC = nearest root equipment (correct); DESC = topmost ancestor (the bug that
      // produced PARENT_OUTSIDE_ROOT_EQUIPMENT on a plain read).
      const registryRule = /NOT internal_child/.test(sql);
      assert.equal(registryRule, true, 'the resolver must use the registry immediate-parent rule');
      const desc = /ORDER BY depth DESC LIMIT 1/.test(sql);
      const candidates = rootCandidates(values[0], { registryRule })
        .sort((a, b) => desc ? b.depth - a.depth : a.depth - b.depth);
      const resolved = candidates[0]?.row || null;
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
        status: values[5], crit: values[6], maker: values[7], model: values[8], serial: values[9],
        ext: JSON.parse(values[10] || '{}'), category_id: values[11], sort_order: values[12],
        is_active: true, record_status: 'complete', row_version: 1, deleted_at: null, delete_reason: null
      };
      assets.set(row.id, row);
      return { rows: [row] };
    }
    // The dossier detail endpoint: it must keep resolving the location and the category of a root
    // equipment whose parent is a location node, exactly like the comprehensive registry list does.
    if (/SELECT a\.\*,c\.name category_name/.test(sql)) {
      const detailRow = assets.get(values[0])
        || [...assets.values()].find(row => String(row.code || '').toLowerCase() === String(values[0] || '').toLowerCase());
      if (!detailRow || detailRow.deleted_at) return { rows: [] };
      const detailParent = detailRow.parent ? assets.get(detailRow.parent) : null;
      return { rows: [{ ...detailRow, category_name: 'دسته تست', factory_id: 'factory-1', factory_name: 'کارخانه بسپار ۱',
        parent_name: detailParent ? detailParent.name : null, location_name: detailParent ? detailParent.name : null,
        pm_plans: [], work_orders: [], maintenance_history: [], requests: [], spare_parts: [], children: [],
        calibration_instruments: [], failures: [], checklist_executions: [], documents: [], instructions: [], movements: [] }] };
    }
    // The dossier breadcrumb: walk the real parent chain upwards, location nodes included.
    if (/FROM ancestry ORDER BY depth DESC/.test(sql)) {
      const chain = [];
      let walk = assets.get(values[0]);
      const guard = new Set();
      let walkDepth = 0;
      while (walk && !guard.has(walk.id) && walkDepth < 64) {
        guard.add(walk.id);
        chain.push({ id: walk.id, parent: walk.parent, code: walk.code, name: walk.name, type: walk.type,
          nodeKind: walk.ext && walk.ext.nodeKind ? walk.ext.nodeKind : null, depth: walkDepth });
        walk = walk.parent ? assets.get(walk.parent) : null;
        walkDepth += 1;
      }
      return { rows: chain };
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
    const subsystemInput={nodeKind:'subsystem',name:'زیرسیستم دو',code:'SUB-2',parentId:'eq-root',parentRowVersion:3,requestId:'create-subsystem-once'};
    const subsystem = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(subsystemInput)
    });
    assert.equal(subsystem.status, 201);
    const created = (await subsystem.json()).data;
    assert.equal(created.parent, 'eq-root');
    const replay=await fetch(`${base}/`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(subsystemInput)});
    assert.equal(replay.status,201,'a retry of a committed structure create keeps the create status');
    const replayBody=await replay.json();
    assert.equal(replayBody.idempotentReplay,true);
    assert.equal(replayBody.data.id,created.id);
    const reused=await fetch(`${base}/`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...subsystemInput,name:'متن متفاوت'})});
    assert.equal(reused.status,409);
    assert.equal((await reused.json()).error,'IDEMPOTENCY_KEY_REUSED');
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

test('26-27 an independent structure drawer creates a subsystem and returns to the structure tab', async () => {
  const calls = [];
  class DrawerRoot {
    constructor(html) {
      this.innerHTML = html;
      this.listeners = {};
      this.fields = [...html.matchAll(/data-structure-field="([^"]+)"/g)].map((match) => ({
        dataset: { structureField: match[1] }, value: match[1] === 'status' ? 'active' : '',
        focus() {}, isConnected: true
      }));
      this.saveButton = { dataset: { structureAction: 'save' }, disabled: false, textContent: 'ذخیره' };
      this.errorNode = { hidden: true, textContent: '' };
    }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    removeEventListener(name) { delete this.listeners[name]; }
    querySelector(selector) {
      if (selector === '[data-structure-error]') return this.errorNode;
      if (selector === '[data-structure-action="save"]') return this.saveButton;
      if (selector === '[data-autofocus]') return null;
      if (selector.includes('.eqv2-structure-form input')) return this.fields[0] || null;
      return null;
    }
    querySelectorAll(selector) {
      if (selector === '[data-structure-field]') return this.fields;
      return [];
    }
    contains() { return true; }
    remove() { this.removed = true; }
    clickSave() {
      const target = {
        dataset: { structureAction: 'save' },
        closest: selector => selector === '[data-structure-action]' ? this.saveButton : null
      };
      this.listeners.click({ target, preventDefault() {} });
    }
  }
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
    structureCreate: async payload => { calls.push(['create', payload]); return { httpStatus: 201, data: { id: 'sub-new', ...payload }, committed: true }; },
    inventoryItems: async () => ({ data: [{ id: 'item-1', code: 'SP-1', name: 'یاتاقان', unit: 'عدد', available: 7 }] })
  };
  const document = {
    body: { insertAdjacentHTML(_where, html) { document.drawerRoot = new DrawerRoot(html); } },
    activeElement: { isConnected: true, focus() {} },
    getElementById: id => id === 'eqv2StructureDrawer' ? document.drawerRoot : id === 'content' ? { innerHTML: '' } : null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}
  };
  const context = {
    MENU: [{ g: 'دارایی‌ها' }, { id: 'equipment', ic: '⚙️', t: 'فهرست جامع تجهیزات' }],
    pgTree: () => '<div>فهرست جامع تجهیزات</div>', doLogin() {}, ME: null, CUR: 'equipment', buildMenu() {},
    EquipmentRepository: { current: () => repository },
    sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null, setItem() {} },
    setTimeout: fn => { fn(); return 0; }, clearTimeout() {}, requestAnimationFrame: fn => fn(),
    can: () => true, esc: value => String(value ?? ''), fa: value => String(value ?? ''), money: value => String(value ?? ''),
    jDate: value => String(value ?? ''), jDateTime: value => String(value ?? ''), AS_ST: { active: ['فعال', 'b-green'] },
    document, location: { pathname: '/equipment/EQ-ROOT', search: '', hash: '' },
    history: { pushState() {}, replaceState() {} }, CSS: { escape: value => String(value) },
    scrollY: 0, scrollTo() {}, addEventListener() {}, modal() { throw new Error('structure CRUD must not use the shared modal'); },
    mhead: title => `<div class="modal-title">${title}</div>`, closeModal() {},
    confirm: () => true, toast: message => { context.toasts = (context.toasts || []).concat(message); },
    prompt: () => 'دلیل', console, crypto: { randomUUID: () => 'req-1' }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('public/platform-v2/step-wizard.js'), context);
  vm.runInContext(read('public/platform-v2/equipment-wizard-adapter.js'), context);
  vm.runInContext(read('public/equipment-v2/structure-drawer-controller.js'), context);
  vm.runInContext(read('public/equipment-v2/equipment-v2.js'), context);
  context.EQV2.structure = {
    rootEquipmentId: 'eq-root', rootId: 'eq-root', root: { id: 'eq-root', code: 'EQ-ROOT', name: 'ریشه', rowVersion: 3 },
    nodes: [], rootAllowedChildren: ['subsystem'],
    capabilities: { create: true, update: true, move: true, archive: true, suggest: true, approveAi: true }, suggestions: []
  };
  context.EQV2.tab = 'structure';
  await context.eqv2StructureAdd('eq-root');
  assert.equal(context.EQV2.structureDrawerView.kind, 'subsystem');
  assert.match(document.drawerRoot.innerHTML, /پرونده تجهیز · ساختار/);
  assert.match(document.drawerRoot.innerHTML, /والد از پیش انتخاب‌شده/);
  assert.match(document.drawerRoot.innerHTML, /ریشه/);
  assert.doesNotMatch(document.drawerRoot.innerHTML, /data-sw-action/);
  const name = document.drawerRoot.fields.find(field => field.dataset.structureField === 'name');
  const code = document.drawerRoot.fields.find(field => field.dataset.structureField === 'code');
  name.value = 'زیرسیستم مستقل';
  code.value = 'SUB-DRAWER';
  document.drawerRoot.clickSave();
  for (let tick = 0; tick < 40 && (!calls.length || !(context.toasts || []).length); tick++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0][0], 'create');
  assert.equal(calls[0][1].parentId, 'eq-root');
  assert.equal(calls[0][1].parentRowVersion, 3);
  assert.equal(calls[0][1].rootEquipmentId, 'eq-root');
  assert.equal(calls[0][1].nodeKind, 'subsystem');
  assert.equal(calls[0][1].requestId, 'req-1');
  assert.ok((context.toasts || []).some(message => String(message).includes('پس از پاسخ 201')));
  assert.equal(context.EQV2.tab, 'structure');
  assert.equal(context.EQV2.structureDrawerView, null);
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
  // The dossier routing key may be the code, but the structure call must use the real record id.
  assert.match(ui, /E\.detailId=a\.id/);
  assert.match(ui, /const structureId=E\.detailId\|\|a\.id;/);
  assert.match(ui, /queueStructureLoad\(structureId\)/);
  assert.doesNotMatch(ui, /queueStructureLoad\(\s*a\.code/);
  assert.doesNotMatch(ui, /queueStructureLoad\(\s*E\.detailKey/);
  assert.doesNotMatch(ui, /R\(\)\.structure\(E\.detailKey/);
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

test('44 the whole subsystem / main-component / sub-component chain is operational on real legacy equipment', async () => {
  // The exact local acceptance scenario: an existing equipment row with no nodeKind and no
  // child, then adding all three levels through the existing equipment endpoints.
  const pool = legacyPool();
  await withApi(pool, 'mgr', async base => {
    const before = await fetch(`${base}/b1p01/structure`);
    assert.equal(before.status, 200);
    assert.deepEqual((await before.json()).data.nodes, []);

    // 13 — افزودن زیرسیستم زیر تجهیز واقعی
    const subsystem = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeKind: 'subsystem', name: 'زیرسیستم هیدرولیک', code: 'B1P01-SUB', parentId: 'b1p01', parentRowVersion: 4, requiredQuantity: 1 })
    });
    assert.equal(subsystem.status, 201);
    const subBody = await subsystem.json();
    assert.equal(subBody.committed, true);
    const subId = subBody.data.id;
    assert.equal(subBody.data.parent, 'b1p01');
    assert.equal(subBody.data.ext.nodeKind, 'subsystem');
    assert.equal(subBody.data.rootEquipmentId, 'b1p01');

    // 14 — افزودن قطعه اصلی زیر زیرسیستم
    const component = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeKind: 'main-component', name: 'مکانیکال سیل', code: 'B1P01-CMP', parentId: subId, parentRowVersion: subBody.data.row_version, partNumber: 'MS-40', brand: 'SKF', model: 'MS-40', requiredQuantity: 2 })
    });
    assert.equal(component.status, 201);
    const compBody = await component.json();
    const compId = compBody.data.id;
    assert.equal(compBody.data.ext.nodeKind, 'main-component');
    assert.equal(compBody.data.ext.partNumber, 'MS-40');
    assert.equal(compBody.data.ext.brand, 'SKF');

    // 15 — افزودن زیرقطعه زیر قطعه اصلی
    const subComponent = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeKind: 'sub-component', name: 'اورینگ', code: 'B1P01-ORT', parentId: compId, parentRowVersion: compBody.data.row_version, requiredQuantity: 4 })
    });
    assert.equal(subComponent.status, 201);
    assert.equal((await subComponent.json()).data.ext.nodeKind, 'sub-component');

    // A rejected level: a sub-component may not sit directly under the equipment root.
    const invalid = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeKind: 'sub-component', name: 'غلط', code: 'B1P01-BAD', parentId: 'b1p01', parentRowVersion: 99 })
    });
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error, 'STRUCTURE_PARENT_KIND_INVALID');

    // 7 — the real hierarchy now reads back as تجهیز ← زیرسیستم ← قطعه اصلی ← زیرقطعه
    const after = await fetch(`${base}/b1p01/structure`);
    assert.equal(after.status, 200);
    const data = (await after.json()).data;
    assert.equal(data.rootEquipmentId, 'b1p01');
    assert.equal(data.root.code, 'B1P01');
    assert.equal(data.nodeCount, 3);
    assert.deepEqual(data.nodes.map(node => node.code), ['B1P01-SUB']);
    assert.equal(data.nodes[0].level, 1);
    assert.equal(data.nodes[0].children[0].code, 'B1P01-CMP');
    assert.equal(data.nodes[0].children[0].level, 2);
    assert.equal(data.nodes[0].children[0].children[0].code, 'B1P01-ORT');
    assert.equal(data.nodes[0].children[0].children[0].level, 3);
    assert.equal(data.nodes[0].children[0].partNumber, 'MS-40');
    assert.equal(data.nodes[0].children[0].brand, 'SKF');

    // 21 — every write is recorded in audit_x
    const actions = pool.state.audit.map(row => row.action);
    assert.equal(actions.filter(action => action === 'structure-create').length, 3);

    // 20 — row_version is mandatory and a stale version is rejected
    const stale = await fetch(`${base}/${subId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ویرایش با نسخهٔ قدیمی', rowVersion: 1 })
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, 'VERSION_CONFLICT');
    const missingVersion = await fetch(`${base}/${subId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'بدون نسخه' })
    });
    assert.equal(missingVersion.status, 422);
    assert.equal((await missingVersion.json()).error, 'ROW_VERSION_REQUIRED');

    // 16 — editing with the current version works
    const current = (await (await fetch(`${base}/b1p01/structure`)).json()).data.nodes[0];
    const edited = await fetch(`${base}/${subId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'زیرسیستم هیدرولیک اصلاح‌شده', rowVersion: current.rowVersion })
    });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).committed, true);

    // 3 — the internal components never appear in the flat comprehensive registry
    assert.match(read('server/equipment-routes.js'), /NOT IN \('sub-equipment','subsystem','main-component','sub-component','sub','sys','panel'\)/);
  });
});

test('45 an equipment row with an unexpected legacy nodeKind still opens its dossier', async () => {
  // The registry defines an equipment row as type='eq' whose effective nodeKind is not an
  // internal component kind. A real record carrying a stray legacy value must therefore open
  // its dossier and accept a first-level child, instead of answering ROOT_EQUIPMENT_NOT_FOUND.
  const assets = legacyAssets();
  assets.get('b1p01').ext = { nodeKind: 'machine' };
  const pool = structurePool({
    assets,
    users: [{ id: 'u-mgr', role: 'mgr', permissions: ['equipment.structure.view'], scopes: [{ scope_type: 'company' }] }]
  });
  await withApi(pool, 'mgr', async base => {
    const view = await fetch(`${base}/b1p01/structure`);
    assert.equal(view.status, 200);
    const data = (await view.json()).data;
    assert.equal(data.rootEquipmentId, 'b1p01');
    assert.equal(data.root.code, 'B1P01');
    assert.deepEqual(data.nodes, []);

    const created = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeKind: 'subsystem', name: 'زیرسیستم سازگار', code: 'B1P01-SUB2', parentId: 'b1p01', parentRowVersion: 4 })
    });
    assert.equal(created.status, 201);

    // An internal component kind can never own a dossier.
    assets.set('comp-root', {
      id: 'comp-root', parent: 'line-1', code: 'CMP-ROOT', name: 'قطعه داخلی', type: 'eq',
      cls: null, status: 'active', crit: 'B', maker: null, model: null, serial: null,
      ext: { nodeKind: 'main-component' }, row_version: 1, deleted_at: null, delete_reason: null,
      is_active: true, sort_order: 0, category_id: null
    });
    const internal = await fetch(`${base}/comp-root/structure`);
    assert.equal(internal.status, 404);
    assert.equal((await internal.json()).error, 'ROOT_EQUIPMENT_NOT_FOUND');
  });
  // The tolerant rule must be the registry rule, not an invented whitelist.
  assert.match(read('server/equipment-structure.js'), /function isRegistryEquipment\(row\)/);
  assert.match(read('server/equipment-structure.js'), /REGISTRY_INTERNAL_KINDS = Object\.freeze\(\[\s*'sub-equipment', 'subsystem', 'main-component', 'sub-component', 'sub', 'sys', 'panel'/);
});

test('46 the dossier keeps the code as its routing key and the real id for the structure API', async () => {
  // Deep links use /equipment/<code>, so openDetail is entered with a code and the detail
  // endpoint resolves it. The structure tab must still send the real PostgreSQL id.
  const sent = [];
  const repository = {
    source: 'postgresql',
    feature: async () => ({ enabled: true }),
    filters: async () => ({ factories: [], categories: [], locations: [], responsibleUsers: [] }),
    list: async () => ({ data: [], pagination: { page: 1, pages: 1, total: 0, limit: 50 } }),
    get: async key => {
      assert.equal(String(key), 'B1P01', 'the dossier is keyed by its code for routing');
      return { data: { id: 'b1p01', code: 'B1P01', name: 'پمپ ورودی', row_version: 4, path: [], children: [], pm_plans: [], ext: {} } };
    },
    structure: async (id) => {
      sent.push(String(id));
      return { data: { rootEquipmentId: id, root: { id, code: 'B1P01', name: 'پمپ ورودی', nodeKind: 'equipment', rowVersion: 4 }, nodes: [], capabilities: { create: true }, suggestions: [] } };
    },
    inventoryItems: async () => ({ data: [] })
  };
  const harness = structureUiHarness(repository, { id: 'b1p01' });
  harness.context.location.pathname = '/equipment/B1P01';
  await harness.context.eqv2OpenDetail('B1P01');
  assert.equal(harness.context.EQV2.detailKey, 'B1P01');
  assert.equal(harness.context.EQV2.detailId, 'b1p01');
  await harness.context.eqv2DetailTab('structure');
  await harness.context.eqv2DetailTab('structure');
  assert.ok(sent.length > 0, 'the structure API was never called');
  assert.deepEqual([...new Set(sent)], ['b1p01'], 'the structure API must receive the real assets.id, never the code');
  assert.ok(!sent.some(value => value === 'B1P01'), 'the equipment code was sent to the structure API');
  assert.doesNotMatch(harness.bodies.eqv2DetailBody.innerHTML, /در حال دریافت ساختار تجهیز/);
});

test('47 the read-only diagnosis script exists and cannot change any data', () => {
  const script = read('scripts/diagnose-equipment-structure.js');
  assert.match(script, /Read-only diagnosis of the equipment dossier structure/);
  assert.match(script, /GET \/api\/equipment\/:id\/structure expects/);
  // It must never be able to mutate the live database.
  assert.doesNotMatch(script, /\b(INSERT\s+INTO|UPDATE\s+assets|DELETE\s+FROM|DROP|TRUNCATE|ALTER\s+TABLE)\b/i);
  // It reports the exact causes instead of guessing: identifier, kind, resolver outcome.
  assert.match(script, /ROOT_EQUIPMENT_NOT_FOUND/);
  assert.match(script, /EQUIPMENT_NOT_FOUND/);
  assert.match(script, /COALESCE\(NULLIF\(a\.ext->>'nodeKind',''\),'equipment'\)/);
  // Its resolver query must stay identical to the runtime one (nearest equipment row).
  assert.match(script, /ORDER BY depth ASC/);
  assert.match(script, /NOT internal_child/);
  assert.match(script, /registryListsIt\(row\)/);
  // A registry-listed root is answered 200; the location parent stays outside the structure.
  assert.match(script, /the API answers 200 with THIS row as the structure root/);
  assert.match(script, /location\/grouping node kept outside the internal structure/);
  // It must also separate "the database really has no structure rows" from "a query lost them".
  assert.match(script, /children breakdown -> active type=eq:/);
  assert.match(script, /linked spare parts \(asset_spare_parts\):/);
  assert.match(script, /CONCLUSION: this equipment has no child assets row/);
  assert.match(script, /the Persian empty state/);
  assert.match(script, /FROM asset_spare_parts rel WHERE rel\.asset_id=\$1/);
  assert.match(script, /npm run update:apply/);
  assert.match(script, /DATABASE_URL is not configured/);
});

test('48 the backend publishes the valid root levels and the UI offers them', async () => {
  const structureService = require('../server/equipment-structure');
  // Backend: a legacy equipment row with an unexpected nodeKind still accepts a subsystem.
  const assets = legacyAssets();
  assets.get('b1p01').ext = { nodeKind: 'machine' };
  const pool = structurePool({
    assets,
    users: [{ id: 'u-mgr', role: 'mgr', permissions: ['equipment.structure.view'], scopes: [{ scope_type: 'company' }] }]
  });
  const data = await structureService.getStructure({
    pool,
    security: { hasPermission: async () => true },
    user: { id: 'u-mgr', role: 'mgr' },
    rootEquipmentId: 'b1p01'
  });
  assert.equal(data.rootEquipmentId, 'b1p01');
  assert.deepEqual(data.rootAllowedChildren, ['subsystem']);
  assert.match(read('server/equipment-structure.js'), /rootAllowedChildren: allowedChildKinds\('equipment', root\)/);

  // UI: the row action and the wizard must not be disabled by the client-side kind map.
  const ui = read('public/equipment-v2/equipment-v2.js');
  assert.match(ui, /Array\.isArray\(st\.rootAllowedChildren\)/);
  assert.match(ui, /structureAllowedChildren\(node\.nodeKind,node\)/);
  assert.match(ui, /structureAllowedChildren\(parent\.nodeKind,parent\)/);
  assert.match(ui, /openStructureForm\(\{mode:'create',kind:childKind,parent\}\)/);

  const repository = legacyStructureRepository({
    rootEquipmentId: 'b1p01',
    root: { id: 'b1p01', code: 'B1P01', name: 'پمپ ورودی', nodeKind: 'equipment', rowVersion: 4 },
    rootAllowedChildren: ['subsystem'],
    nodes: [{
      id: 'sub-legacy', code: 'B1P01-SUB', name: 'زیرسیستم سازگار', nodeKind: 'subsystem', level: 1,
      rowVersion: 1, status: 'active', crit: 'B', validRelation: true, archived: false,
      path: [{ id: 'sub-legacy' }], children: []
    }],
    orphaned: [], diagnostics: [], nodeCount: 1, includeArchived: false,
    capabilities: { create: true, update: true, move: true, archive: true, suggest: true, approveAi: true }, suggestions: []
  });
  const harness = structureUiHarness(repository, { id: 'b1p01' });
  harness.context.EQV2.detailId = 'b1p01';
  harness.context.EQV2.detailKey = 'B1P01';
  await harness.context.eqv2DetailTab('structure');
  await harness.context.eqv2DetailTab('structure');
  const body = harness.bodies.eqv2DetailBody.innerHTML;
  assert.doesNotMatch(body, /در حال دریافت ساختار تجهیز/);
  assert.match(body, /زیرسیستم سازگار/);
  assert.match(body, /افزودن فرزند/);
  assert.match(body, /eqv2-structure-table/);
});

/* ---------- Real parent model: factory -> line -> equipment (B1P01) -> internal levels ---------- */

function realParentAssets() {
  const make = (id, parent, extra = {}) => ({
    id, parent, code: extra.code || id.toUpperCase(), name: extra.name || id,
    type: extra.type || 'eq', cls: null, status: 'active', crit: extra.crit || 'B',
    maker: extra.maker || null, model: extra.model || null, serial: null,
    ext: extra.ext === undefined ? {} : extra.ext, row_version: extra.rowVersion || 1,
    deleted_at: extra.deletedAt || null, delete_reason: null, is_active: !extra.deletedAt,
    sort_order: 0, category_id: extra.categoryId === undefined ? null : extra.categoryId
  });
  return new Map(Object.entries({
    // Location hierarchy: a real equipment root always sits inside it.
    'factory-1': make('factory-1', null, { type: 'site', name: 'کارخانه بسپار ۱', ext: { nodeKind: 'factory' } }),
    'line-1': make('line-1', 'factory-1', { type: 'unit', name: 'خط یک', ext: { nodeKind: 'line' } }),
    // Older data may also contain an equipment grouping row above the real equipment.
    'eq-group-1': make('eq-group-1', 'line-1', { code: 'EQG-1', name: 'گروه تجهیز قدیمی', ext: { nodeKind: 'equipment' } }),
    // The real equipment: B1P01, parent is a location/equipment grouping row, not an internal node.
    'eq-real': make('eq-real', 'eq-group-1', { code: 'B1P01', name: 'پمپ ورودی', maker: 'Grundfos', model: 'NK-80', crit: 'A', ext: { nodeKind: 'equipment' }, categoryId: 'cat-1' }),
    'eq-real-other': make('eq-real-other', 'line-1', { code: 'B1P02', name: 'پمپ ذخیره', ext: { nodeKind: 'equipment' } })
  }));
}

// The live rule the user stated: location or category -> root equipment -> internal structure.
function realLocationAssets() {
  const assets = realParentAssets();
  assets.get('eq-real').parent = 'line-1';
  return assets;
}

function realParentPool(extra = {}) {
  return structurePool({
    assets: realParentAssets(),
    users: [
      { id: 'u-mgr', role: 'mgr', permissions: ['equipment.structure.view'], scopes: [{ scope_type: 'company' }] },
      { id: 'u-out', role: 'tech', permissions: ['equipment.structure.view'], scopes: [] }
    ],
    ...extra
  });
}

test('49 a real equipment root with a location parent opens its structure without PARENT_OUTSIDE_ROOT_EQUIPMENT', async () => {
  const pool = realParentPool();
  await withApi(pool, 'mgr', async base => {
    const response = await fetch(`${base}/eq-real/structure`);
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    assert.equal(data.rootEquipmentId, 'eq-real');
    assert.equal(data.root.code, 'B1P01');
    assert.deepEqual(data.nodes, []);
    assert.equal(JSON.stringify(data).includes('PARENT_OUTSIDE_ROOT_EQUIPMENT'), false);
  });
  // The root must never be re-resolved upwards into its own parent chain.
  const service = read('server/equipment-structure.js');
  assert.doesNotMatch(service, /if \(String\(resolved\.id\) !== String\(identifier\)\) throw coded\(404, 'PARENT_OUTSIDE_ROOT_EQUIPMENT'\)/);
  assert.match(service, /async function assertInsideRootBoundary\(client, parentId, rootId, parentRow = null\)/);
});

test('50 the same equipment root with an active equipment ancestor above it still answers 200', async () => {
  // This is the exact live regression: the registry lists a root by looking at its immediate
  // parent only, while the resolver walked the whole chain and returned the ancestor instead.
  const assets = realParentAssets();
  assert.equal(assets.get('eq-real').parent, 'eq-group-1');
  assert.equal(assets.get('eq-group-1').type, 'eq');
  const pool = structurePool({
    assets,
    users: [{ id: 'u-mgr', role: 'mgr', permissions: ['equipment.structure.view'], scopes: [{ scope_type: 'company' }] }]
  });
  await withApi(pool, 'mgr', async base => {
    const response = await fetch(`${base}/eq-real/structure`);
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    assert.equal(data.rootEquipmentId, 'eq-real');
    assert.equal(data.root.code, 'B1P01');
    // Transparent reporting instead of rejection.
    assert.equal(data.diagnostics.some(item => item.code === 'ROOT_PARENT_OUTSIDE_STRUCTURE'), true);
  });
  const structureService = require('../server/equipment-structure');
  const built = structureService.buildStructureTree(
    { id: 'eq-real', code: 'B1P01', name: 'پمپ ورودی', parent: 'eq-group-1', row_version: 1, ext: {} },
    []
  );
  const diagnostic = built.diagnostics.find(item => item.code === 'ROOT_PARENT_OUTSIDE_STRUCTURE');
  assert.ok(diagnostic, 'the location parent of the root must be reported, not silently dropped');
  assert.equal(diagnostic.parentId, 'eq-group-1');
  assert.match(diagnostic.message, /حفظ شده است/);
});

test('51 subsystems under a real equipment root render and adding a subsystem directly under it is valid', async () => {
  const assets = realParentAssets();
  assets.set('sub-real', { ...assets.get('eq-real'), id: 'sub-real', parent: 'eq-real', code: 'B1P01-SUB', name: 'زیرسیستم هیدرولیک', ext: { nodeKind: 'subsystem' }, row_version: 2 });
  const pool = structurePool({
    assets,
    users: [{ id: 'u-mgr', role: 'mgr', permissions: ['equipment.structure.view'], scopes: [{ scope_type: 'company' }] }]
  });
  await withApi(pool, 'mgr', async base => {
    const view = await fetch(`${base}/eq-real/structure`);
    assert.equal(view.status, 200);
    const data = (await view.json()).data;
    assert.deepEqual(data.nodes.map(node => node.code), ['B1P01-SUB']);
    assert.equal(data.nodes[0].level, 1);
    assert.deepEqual(data.rootAllowedChildren, ['subsystem']);

    const created = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // The dossier UI always sends the root it is displaying (equipment-v2.js: rootEquipmentId),
      // so the boundary is checked against that root and never re-derived from the ancestry.
      body: JSON.stringify({ nodeKind: 'subsystem', name: 'زیرسیستم برق', code: 'B1P01-EL', parentId: 'eq-real', parentRowVersion: 1, rootEquipmentId: 'eq-real' })
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.committed, true);
    assert.equal(body.data.parent, 'eq-real');
    assert.equal(body.data.rootEquipmentId, 'eq-real');
    assert.equal(body.data.ext.nodeKind, 'subsystem');
  });
});

test('52 an internal node whose parent is outside the root equipment is still rejected', async () => {
  const pool = realParentPool();
  await withApi(pool, 'mgr', async base => {
    const outside = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeKind: 'subsystem', name: 'خارج از مرز', code: 'OUT-1', parentId: 'eq-real-other', parentRowVersion: 1, rootEquipmentId: 'eq-real' })
    });
    assert.equal(outside.status, 422);
    assert.equal((await outside.json()).error, 'PARENT_OUTSIDE_ROOT_EQUIPMENT');
    assert.equal(pool.state.calls.some(call => /INSERT INTO assets/.test(call.sql)), false);

    // A location node can never be the parent of an internal component either.
    const location = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeKind: 'subsystem', name: 'زیر خط تولید', code: 'OUT-2', parentId: 'line-1', parentRowVersion: 1, rootEquipmentId: 'eq-real' })
    });
    assert.equal(location.status, 422);
    assert.equal((await location.json()).error, 'STRUCTURE_PARENT_KIND_INVALID');
  });
});

test('53 moving an internal node to another equipment needs no cycle but does need confirmation, and the root relation is preserved', async () => {
  const assets = realParentAssets();
  assets.set('sub-real', { ...assets.get('eq-real'), id: 'sub-real', parent: 'eq-real', code: 'B1P01-SUB', name: 'زیرسیستم هیدرولیک', ext: { nodeKind: 'subsystem' }, row_version: 2 });
  const pool = structurePool({
    assets,
    users: [{ id: 'u-mgr', role: 'mgr', permissions: ['equipment.structure.view'], scopes: [{ scope_type: 'company' }] }]
  });
  const rootBefore = { parent: pool.assets.get('eq-real').parent, categoryId: pool.assets.get('eq-real').category_id };
  await withApi(pool, 'mgr', async base => {
    const unconfirmed = await fetch(`${base}/sub-real/move`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: 'eq-real-other', rowVersion: 2, reason: 'انتقال' })
    });
    assert.equal(unconfirmed.status, 422);
    assert.equal((await unconfirmed.json()).error, 'CROSS_EQUIPMENT_CONFIRMATION_REQUIRED');

    const confirmed = await fetch(`${base}/sub-real/move`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: 'eq-real-other', rowVersion: 2, reason: 'انتقال بین تجهیزات', confirmCrossEquipment: true })
    });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).committed, true);
    assert.equal(pool.assets.get('sub-real').parent, 'eq-real-other');
    assert.equal(pool.state.audit.some(row => row.action === 'structure-cross-equipment-move'), true);
  });
  // The location/category relation of the equipment root is never touched by structure writes.
  assert.equal(pool.assets.get('eq-real').parent, rootBefore.parent);
  assert.equal(pool.assets.get('eq-real').category_id, rootBefore.categoryId);
  assert.equal(pool.assets.get('eq-real').ext.nodeKind, 'equipment');
  // The registry still resolves the location and the category of the root.
  assert.match(read('server/equipment-routes.js'), /COALESCE\(c\.factory_asset_id,ancestry_factory\.id\) factory_id,f\.name factory_name/);
  assert.match(read('server/equipment-routes.js'), /COALESCE\(NULLIF\(a\.ext->>'locationDescription',''\),p\.name\) location_name/);
});

test('54 the structure tab of a real equipment with a location parent shows the empty state, not an error', async () => {
  // Full real scenario in the UI: the registry opens the dossier by code, the location parent
  // (factory -> line -> category) stays outside the internal structure, and the tab must render
  // the Persian empty state instead of PARENT_OUTSIDE_ROOT_EQUIPMENT.
  const sent = [];
  const requestedKeys = [];
  const repository = {
    source: 'postgresql',
    feature: async () => ({ enabled: true }),
    filters: async () => ({ factories: [], categories: [], locations: [], responsibleUsers: [] }),
    list: async () => ({ data: [], pagination: { page: 1, pages: 1, total: 0, limit: 50 } }),
    get: async key => {
      requestedKeys.push(String(key));
      return { data: { id: 'eq-real', code: 'B1P01', name: 'پمپ ورودی', row_version: 1, maker: 'Grundfos', model: 'NK-80', crit: 'A', status: 'active', parent: 'eq-group-1', category_id: 'cat-1', factory_id: 'factory-1', path: [], children: [], pm_plans: [], ext: { nodeKind: 'equipment' } } };
    },
    structure: async id => {
      sent.push(String(id));
      return { data: {
        rootEquipmentId: 'eq-real', root: { id: 'eq-real', code: 'B1P01', name: 'پمپ ورودی', nodeKind: 'equipment', rowVersion: 1 },
        rootAllowedChildren: ['subsystem'],
        nodes: [], orphaned: [],
        diagnostics: [{ code: 'ROOT_PARENT_OUTSIDE_STRUCTURE', parentId: 'line-1', message: 'والد این تجهیز یک گره مکانی/دسته‌بندی است و خارج از ساختار داخلی حفظ شده است.' }],
        nodeCount: 0, includeArchived: false,
        capabilities: { create: true, update: true, move: true, archive: true, suggest: true, approveAi: true }, suggestions: []
      } };
    },
    inventoryItems: async () => ({ data: [] })
  };
  const harness = structureUiHarness(repository, { id: 'eq-real' });
  harness.context.location.pathname = '/equipment/B1P01';
  await harness.context.eqv2OpenDetail('B1P01');
  assert.equal(harness.context.EQV2.detailKey, 'B1P01');
  assert.equal(harness.context.EQV2.detailId, 'eq-real');
  await harness.context.eqv2DetailTab('structure');
  await harness.context.eqv2DetailTab('structure');
  const body = harness.bodies.eqv2DetailBody.innerHTML;
  assert.doesNotMatch(body, /در حال دریافت ساختار تجهیز/);
  assert.doesNotMatch(body, /eqv2-structure-table/);
  // Persian empty state with the add-subsystem action.
  assert.match(body, /هنوز زیرسیستم، قطعه اصلی یا زیرقطعه‌ای ثبت نشده/);
  assert.match(body, /افزودن زیرسیستم/);
  // An empty structure must not look like missing data: the equipment's real spare parts live in
  // their own section and are never turned into structure rows automatically.
  assert.match(body, /قطعات یدکی حیاتی/);
  assert.match(body, /خودکار به ساختار داخلی تبدیل نمی‌شوند/);
  // The preserved location parent is explained in Persian; no raw backend code ever reaches the UI.
  assert.match(body, /خارج از ساختار داخلی حفظ شده است/);
  assert.doesNotMatch(body, /ROOT_PARENT_OUTSIDE_STRUCTURE/);
  assert.doesNotMatch(body, /PARENT_OUTSIDE_ROOT_EQUIPMENT/);
  // The structure request is sent with the real assets.id, never with the code.
  assert.ok(sent.length > 0, 'the structure API was never called');
  assert.deepEqual([...new Set(sent)], ['eq-real']);
  assert.equal(requestedKeys[0], 'B1P01');
});

test('55 the registry keeps showing the location and the category of a root equipment that has a location parent', async () => {
  const assets = realLocationAssets();
  assets.set('sub-real', { ...assets.get('eq-real'), id: 'sub-real', parent: 'eq-real', code: 'B1P01-SUB', name: 'زیرسیستم هیدرولیک', ext: { nodeKind: 'subsystem' }, row_version: 2 });
  const pool = structurePool({
    assets,
    users: [{ id: 'u-mgr', role: 'mgr', permissions: ['equipment.view', 'equipment.structure.view'], scopes: [{ scope_type: 'company' }] }]
  });
  await withApi(pool, 'mgr', async base => {
    // The structure tab of the same equipment answers 200 with its real subsystem.
    const view = await fetch(`${base}/eq-real/structure`);
    assert.equal(view.status, 200);
    const data = (await view.json()).data;
    assert.deepEqual(data.nodes.map(node => node.code), ['B1P01-SUB']);

    // The dossier endpoint still resolves and returns the location and the category of the root.
    const detail = await fetch(`${base}/eq-real`, { headers: { accept: 'application/json' } });
    assert.equal(detail.status, 200);
    const body = (await detail.json()).data;
    assert.equal(body.parent, 'line-1');
    assert.equal(body.parent_name, 'خط یک');
    assert.equal(body.location_name, 'خط یک');
    assert.equal(body.category_id, 'cat-1');
    assert.equal(body.category_name, 'دسته تست');
    assert.equal(body.factory_id, 'factory-1');
    assert.equal(body.factory_name, 'کارخانه بسپار ۱');
  });
  // Nothing about the location relation of the root was changed by the structure operations.
  const rootRow = pool.assets.get('eq-real');
  assert.equal(rootRow.parent, 'line-1');
  assert.equal(rootRow.category_id, 'cat-1');
  assert.equal(rootRow.ext.nodeKind, 'equipment');
  assert.equal(rootRow.deleted_at, null);
  assert.equal(pool.state.calls.some(call => /UPDATE assets SET parent=/.test(call.sql) && call.values.includes('eq-real')), false);
  assert.equal(pool.state.calls.some(call => /UPDATE asset_categories/.test(call.sql)), false);
  // The registry list and the dossier endpoint both keep their immediate-parent rule untouched.
  const routes = read('server/equipment-routes.js');
  assert.match(routes, /NOT EXISTS\(SELECT 1 FROM assets structural_parent WHERE structural_parent\.id=a\.parent/);
  assert.equal((routes.match(/NOT EXISTS\(SELECT 1 FROM assets structural_parent/g) || []).length, 2);
});

test('56 internal descendants still answer ROOT_EQUIPMENT_NOT_FOUND and never PARENT_OUTSIDE_ROOT_EQUIPMENT on a read', async () => {
  const assets = realParentAssets();
  assets.set('sub-real', { ...assets.get('eq-real'), id: 'sub-real', parent: 'eq-real', code: 'B1P01-SUB', name: 'زیرسیستم هیدرولیک', ext: { nodeKind: 'subsystem' }, row_version: 2 });
  const pool = structurePool({
    assets,
    users: [{ id: 'u-mgr', role: 'mgr', permissions: ['equipment.structure.view'], scopes: [{ scope_type: 'company' }] }]
  });
  await withApi(pool, 'mgr', async base => {
    const internal = await fetch(`${base}/sub-real/structure`);
    assert.equal(internal.status, 404);
    assert.equal((await internal.json()).error, 'ROOT_EQUIPMENT_NOT_FOUND');
    const missing = await fetch(`${base}/no-such-equipment/structure`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'EQUIPMENT_NOT_FOUND');
    const locationRoot = await fetch(`${base}/line-1/structure`);
    assert.equal(locationRoot.status, 404);
    assert.equal((await locationRoot.json()).error, 'ROOT_EQUIPMENT_NOT_FOUND');
  });
  // A plain read must never answer the write-side boundary error again.
  const bodies = pool.state.calls.map(call => call.sql).join('\n');
  assert.ok(bodies.length > 0);
  const service = read('server/equipment-structure.js');
  assert.equal((service.match(/PARENT_OUTSIDE_ROOT_EQUIPMENT/g) || []).length >= 2, true);
  assert.match(service, /async function assertInsideRootBoundary\(client, parentId, rootId, parentRow = null\)/);
  assert.doesNotMatch(service, /resolved\.id\) !== String\(identifier\)/);
});

/* ---------- The canonical Bespar 1 dataset, exactly as scripts/seed-besepar1.js writes it ---------- */

// Real shape: the factory row is type='site'; every category tree node is type='unit' with
// ext.nodeKind='category'; every equipment row is type='eq' with NO ext.nodeKind at all; a
// sub-equipment row differs only by cls='زیرتجهیز' and by pointing at another equipment parent.
function seedShape() {
  const dataset = JSON.parse(read('public/data/besepar1.seed.json'));
  const make = (id, parent, extra = {}) => ({
    id, parent, code: extra.code == null ? null : extra.code, name: extra.name || id,
    type: extra.type || 'eq', cls: extra.cls === undefined ? null : extra.cls, status: 'active',
    crit: extra.crit === undefined ? null : extra.crit, maker: extra.maker || null,
    model: extra.model || null, serial: null, ext: extra.ext === undefined ? {} : extra.ext,
    row_version: extra.rowVersion || 1, deleted_at: null, delete_reason: null, is_active: true,
    sort_order: 0, category_id: extra.categoryId === undefined ? null : extra.categoryId
  });
  const category = dataset.categories[0];
  const b1p01 = dataset.equipment.find(item => item.code === 'B1P01');
  const bt = dataset.equipment.find(item => item.id === 'b1-eq-bt');
  const btChildren = dataset.equipment.filter(item => item.parentEquipment === bt.id);
  const assets = new Map();
  assets.set(dataset.factory.id, make(dataset.factory.id, 'bfg-plants',
    { type: 'site', code: dataset.factory.code, name: dataset.factory.name, cls: 'کارخانه' }));
  assets.set(category.id, make(category.id, dataset.factory.id,
    { type: 'unit', code: category.code, name: category.name, cls: category.name, ext: { nodeKind: 'category' } }));
  assets.set(b1p01.id, make(b1p01.id, category.id, { code: b1p01.code, name: b1p01.name, cls: b1p01.category,
    crit: b1p01.criticality, maker: b1p01.maker, model: b1p01.model, categoryId: category.id,
    ext: { factory: 'بسپار ۱', keyParts: b1p01.keyParts || [], locationDescription: b1p01.location || '' } }));
  assets.set(bt.id, make(bt.id, category.id, { code: bt.code, name: bt.name, cls: bt.category,
    categoryId: category.id, ext: { factory: 'بسپار ۱' } }));
  for (const child of btChildren) {
    assets.set(child.id, make(child.id, bt.id, { code: child.code, name: child.name, cls: 'زیرتجهیز',
      categoryId: category.id, ext: { factory: 'بسپار ۱' } }));
  }
  return { dataset, assets, category, b1p01, bt, btChildren };
}

function seedShapePool(seed) {
  return structurePool({
    assets: seed.assets,
    users: [{ id: 'u-mgr', role: 'mgr', permissions: ['equipment.view', 'equipment.structure.view'], scopes: [{ scope_type: 'company' }] }]
  });
}

test('57 B1P01 from the canonical dataset has a category parent and genuinely no structure rows', async () => {
  const seed = seedShape();
  // The dataset itself is the evidence: no equipment row points at B1P01 as its parent.
  assert.equal(seed.b1p01.id, 'b1-eq-p01');
  assert.equal(seed.b1p01.parentEquipment, undefined);
  assert.deepEqual(seed.dataset.equipment.filter(item => item.parentEquipment === seed.b1p01.id), []);
  assert.equal(seed.assets.get(seed.b1p01.id).parent, seed.category.id);
  assert.equal(seed.assets.get(seed.category.id).type, 'unit');
  assert.equal(seed.assets.get(seed.category.id).ext.nodeKind, 'category');
  // Real data carries no nodeKind anywhere, so the effective kind decides.
  assert.equal(seed.dataset.equipment.some(item => 'nodeKind' in item), false);

  const pool = seedShapePool(seed);
  await withApi(pool, 'mgr', async base => {
    const response = await fetch(`${base}/${seed.b1p01.id}/structure`);
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    assert.equal(data.rootEquipmentId, seed.b1p01.id);
    assert.equal(data.root.code, 'B1P01');
    // Empty because the database is empty — nothing is invented to fill the tab.
    assert.deepEqual(data.nodes, []);
    assert.equal(data.nodeCount, 0);
    assert.deepEqual(data.orphaned, []);
    assert.equal(data.nodes.length, 0);
    assert.equal(JSON.stringify(data.nodes).includes(seed.b1p01.keyParts ? seed.b1p01.keyParts[0] : '—'), false);
    // The category parent is reported, preserved and outside the internal structure.
    const note = data.diagnostics.find(item => item.code === 'ROOT_PARENT_OUTSIDE_STRUCTURE');
    assert.ok(note, 'the preserved category parent must be reported');
    assert.equal(note.parentId, seed.category.id);
    assert.equal(data.diagnostics.some(item => item.code === 'PARENT_OUTSIDE_ROOT_EQUIPMENT'), false);
    // The first level is still offered, so the tab is usable instead of a dead end.
    assert.deepEqual(data.rootAllowedChildren, ['subsystem']);
    assert.equal(data.capabilities.create, true);
  });
  // Reading the structure never writes anything at all.
  assert.equal(pool.state.calls.some(call => /^(INSERT|UPDATE|DELETE)/i.test(call.sql.trim())), false);
  assert.equal(pool.assets.get(seed.b1p01.id).parent, seed.category.id);
  assert.equal(pool.assets.get(seed.b1p01.id).category_id, seed.category.id);
});

test('58 the real legacy sub-equipment rows of B1BT are shown and preserved, never dropped', async () => {
  const seed = seedShape();
  assert.equal(seed.btChildren.length, 2);
  const pool = seedShapePool(seed);
  await withApi(pool, 'mgr', async base => {
    const response = await fetch(`${base}/${seed.bt.id}/structure`);
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    assert.equal(data.rootEquipmentId, seed.bt.id);
    assert.equal(data.nodeCount, 2);
    assert.deepEqual(data.nodes.map(node => node.code).sort(), ['B1BT catali', 'B1BT9955'].sort());
    for (const node of data.nodes) {
      // Real rows carry no nodeKind: they are readable legacy sub-equipment, not invalid records.
      assert.equal(node.nodeKind, 'sub-equipment');
      assert.equal(node.level, 1);
      assert.equal(node.legacy, true);
      assert.equal(node.archived, false);
      assert.equal(node.parentId, seed.bt.id);
      assert.equal(node.rootEquipmentId, seed.bt.id);
    }
    assert.equal(data.diagnostics.filter(item => item.code === 'LEGACY_SUB_EQUIPMENT').length, 2);
    assert.equal(data.diagnostics.some(item => item.code === 'STRUCTURE_PARENT_KIND_INVALID'), false);
    assert.equal(data.orphaned.length, 0);
    // The legacy rows keep offering their real first level.
    assert.deepEqual(data.rootAllowedChildren, ['subsystem']);
  });
  // Nothing was rewritten, re-parented or archived to make the rows fit the new model.
  assert.equal(pool.state.calls.some(call => /^(INSERT|UPDATE|DELETE)/i.test(call.sql.trim())), false);
  for (const child of seed.btChildren) {
    const row = pool.assets.get(child.id);
    assert.equal(row.parent, seed.bt.id);
    assert.equal(row.cls, 'زیرتجهیز');
    assert.equal(row.type, 'eq');
    assert.equal(row.deleted_at, null);
    assert.equal(row.ext.nodeKind, undefined);
  }
});

test('59 a subsystem can be added under B1P01 and under a real legacy sub-equipment row', async () => {
  const seed = seedShape();
  const pool = seedShapePool(seed);
  const legacyChild = seed.btChildren[0].id;
  await withApi(pool, 'mgr', async base => {
    const underRoot = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootEquipmentId: seed.b1p01.id, nodeKind: 'subsystem', name: 'زیرسیستم هیدرولیک',
        code: 'B1P01-HYD', parentId: seed.b1p01.id, parentRowVersion: 1 })
    });
    assert.equal(underRoot.status, 201);
    const createdRoot = (await underRoot.json()).data;
    assert.equal(createdRoot.parent, seed.b1p01.id);
    assert.equal(createdRoot.rootEquipmentId, seed.b1p01.id);
    assert.equal(createdRoot.ext.nodeKind, 'subsystem');

    // The boundary question is only "self or descendant": a legacy sub-equipment row is inside
    // B1BT's boundary, so it stays usable as a parent instead of answering a boundary error.
    const underLegacy = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootEquipmentId: seed.bt.id, nodeKind: 'subsystem', name: 'زیرسیستم کاتالیست',
        code: 'B1BT-CAT-SUB', parentId: legacyChild, parentRowVersion: 1 })
    });
    assert.equal(underLegacy.status, 201);
    assert.equal((await underLegacy.json()).data.parent, legacyChild);

    // A category or factory node can still never be the parent of an internal component.
    const underCategory = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootEquipmentId: seed.b1p01.id, nodeKind: 'subsystem', name: 'زیر دسته',
        code: 'B1-CAT-SUB', parentId: seed.category.id, parentRowVersion: 1 })
    });
    assert.equal(underCategory.status, 422);
    assert.equal((await underCategory.json()).error, 'STRUCTURE_PARENT_KIND_INVALID');

    // Another equipment's node is outside the boundary and is still rejected.
    const outside = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootEquipmentId: seed.b1p01.id, nodeKind: 'subsystem', name: 'خارج از مرز',
        code: 'B1P01-OUT', parentId: legacyChild, parentRowVersion: 1 })
    });
    assert.equal(outside.status, 422);
    assert.equal((await outside.json()).error, 'PARENT_OUTSIDE_ROOT_EQUIPMENT');
  });
  // The category relation of the root is untouched by every write above.
  assert.equal(pool.assets.get(seed.b1p01.id).parent, seed.category.id);
  assert.equal(pool.assets.get(seed.b1p01.id).category_id, seed.category.id);
});

test('60 the resolver attributes every real row to the same root equipment the registry lists', async () => {
  const seed = seedShape();
  const pool = seedShapePool(seed);
  const service = require('../server/equipment-structure');
  const legacyChild = seed.btChildren[0].id;

  // A root equipment resolves to itself even though its parent is a category node.
  assert.equal((await service.resolveRootEquipment(pool, seed.b1p01.id)).id, seed.b1p01.id);
  assert.equal((await service.resolveRootEquipment(pool, seed.bt.id)).id, seed.bt.id);

  // A legacy sub-equipment row carries no nodeKind, so only the registry's immediate-parent rule
  // can tell it apart from a root. Nearest-by-depth alone returned the row itself and detached it
  // from its real equipment; the topmost-ancestor rule returned the wrong equipment for deeper
  // chains. Both are wrong, the registry rule is not.
  assert.equal((await service.resolveRootEquipment(pool, legacyChild)).id, seed.bt.id);

  // A category node is never a root equipment.
  assert.equal(await service.resolveRootEquipment(pool, seed.category.id), null);

  // The same holds for nodes created through the API.
  await withApi(pool, 'mgr', async base => {
    const created = await fetch(`${base}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootEquipmentId: seed.bt.id, nodeKind: 'subsystem', name: 'زیرسیستم بلندینگ',
        code: 'B1BT-SUB', parentId: legacyChild, parentRowVersion: 1 })
    });
    assert.equal(created.status, 201);
    const nodeId = (await created.json()).data.id;
    assert.equal((await service.resolveRootEquipment(pool, nodeId)).id, seed.bt.id);
  });

  // The resolver query and the registry list use the very same predicate.
  const resolverSql = pool.state.calls.map(call => call.sql).find(sql => /WITH RECURSIVE ancestry AS/.test(sql) && /NOT internal_child/.test(sql));
  assert.ok(resolverSql, 'the resolver must apply the registry immediate-parent rule');
  assert.match(resolverSql, /structural_parent\.type='eq' AND structural_parent\.deleted_at IS NULL/);
  assert.match(read('server/equipment-routes.js'), /structural_parent\.id=a\.parent\s*\n?\s*AND structural_parent\.type='eq' AND structural_parent\.deleted_at IS NULL/);
});
