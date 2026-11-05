'use strict';

// Mission D4 / Phase 3 — critical spare parts of the equipment dossier.
// The harness emulates the exact SQL contracts of server/equipment-spares.js (and the reused
// structure helpers) against in-memory rows, so permission, scope, versioning, soft-archive,
// audit and realtime behavior are proven without a live PostgreSQL. Stock and last purchase
// are computed from real item_balances / inventory_ledger rows only — never hard-coded.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { createEquipmentRouter } = require('../server/equipment-routes');
const spares = require('../server/equipment-spares');

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

const SPARE_PERMISSIONS = ['equipment.spares.view', 'equipment.spares.create', 'equipment.spares.update', 'equipment.spares.archive', 'equipment.spares.suggest', 'equipment.spares.approve_ai'];

function rolePerms(role) {
  if (role === 'admin') return new Set(['*']);
  if (role === 'mgr') return new Set([...SPARE_PERMISSIONS, 'inventory.view']);
  if (role === 'planner') return new Set(['equipment.spares.view', 'equipment.spares.create', 'equipment.spares.update', 'equipment.spares.suggest', 'inventory.view']);
  if (role === 'store') return new Set(['equipment.spares.view', 'inventory.view']);
  return new Set();
}

function baseAssets() {
  return new Map(Object.entries({
    'factory-1': { id: 'factory-1', parent: null, code: 'B1', name: 'بسپار ۱', type: 'site', cls: 'کارخانه', ext: { nodeKind: 'factory' }, deleted_at: null, category_id: null, row_version: 1 },
    'eq-root': { id: 'eq-root', parent: 'factory-1', code: 'B1P01', name: 'پمپ واقعی', type: 'eq', cls: null, ext: {}, deleted_at: null, category_id: null, row_version: 4 },
    'eq-internal': { id: 'eq-internal', parent: 'eq-root', code: 'SUB-1', name: 'زیرسیستم', type: 'eq', cls: null, ext: { nodeKind: 'subsystem', structureKind: 'subsystem' }, deleted_at: null, category_id: null, row_version: 1 },
    'eq-main': { id: 'eq-main', parent: 'eq-internal', code: 'MC-1', name: 'قطعه اصلی', type: 'eq', cls: null, ext: { nodeKind: 'main-component', structureKind: 'main-component' }, deleted_at: null, category_id: null, row_version: 1 },
    'eq-sub': { id: 'eq-sub', parent: 'eq-main', code: 'SC-1', name: 'زیرقطعه', type: 'eq', cls: null, ext: { nodeKind: 'sub-component', structureKind: 'sub-component' }, deleted_at: null, category_id: null, row_version: 1 },
    'eq-archived': { id: 'eq-archived', parent: 'factory-1', code: 'OLD-1', name: 'تجهیز بایگانی', type: 'eq', cls: null, ext: {}, deleted_at: '2026-01-01T00:00:00Z', category_id: null, row_version: 2 }
  }));
}

function baseItems() {
  return new Map(Object.entries({
    'item-1': { id: 'item-1', code: 'SP-1', name: 'یاتاقان', unit: 'عدد', part_type: 'spare', min_stock: 2, ext: { partNumber: 'P-100', brand: 'SKF' }, deleted_at: null },
    'item-2': { id: 'item-2', code: 'SP-2', name: 'تسمه', unit: 'عدد', part_type: 'spare', min_stock: null, ext: {}, deleted_at: null },
    'item-archived': { id: 'item-archived', code: 'SP-X', name: 'قلم بایگانی', unit: 'عدد', part_type: 'spare', min_stock: null, ext: {}, deleted_at: '2026-01-01T00:00:00Z' }
  }));
}

function sparesPool(options = {}) {
  const assets = options.assets || baseAssets();
  const items = options.items || baseItems();
  const links = options.links || new Map(); // key `${assetId}:${itemId}` -> row
  // Real ledger facts. Nothing is invented when these stay empty.
  const balances = options.balances || [];
  const ledger = options.ledger || [];
  const users = options.users || [
    { id: 'u-mgr', role: 'mgr', active: true, permissions: [...SPARE_PERMISSIONS], scopes: [{ scope_type: 'equipment', scope_id: 'eq-root' }] },
    { id: 'u-admin', role: 'admin', active: true, permissions: ['*'], scopes: [] },
    { id: 'u-out', role: 'mgr', active: true, permissions: [...SPARE_PERMISSIONS], scopes: [{ scope_type: 'equipment', scope_id: 'other-eq' }] },
    { id: 'u-store', role: 'store', active: true, permissions: ['equipment.spares.view'], scopes: [{ scope_type: 'company', scope_id: 'co' }] },
    { id: 'u-tech', role: 'tech', active: true, permissions: [], scopes: [{ scope_type: 'company', scope_id: 'co' }] }
  ];
  // Scopes of the authenticated request users (authenticateToken builds `${role}-1`).
  const requestScopes = options.requestScopes || {
    'mgr-1': [{ scope_type: 'equipment', scope_id: 'eq-root' }],
    'planner-1': [{ scope_type: 'equipment', scope_id: 'eq-root' }],
    'store-1': [{ scope_type: 'company', scope_id: 'co' }],
    'tech-1': [{ scope_type: 'company', scope_id: 'co' }]
  };
  const state = { calls: [], audit: [], outbox: [], transactions: [] };
  const linkKey = (assetId, itemId) => `${assetId}:${itemId}`;

  function stockOf(itemId) {
    let onHand = 0, reserved = 0;
    for (const balance of balances) {
      if (balance.item_id !== itemId) continue;
      if (balance.locationActive === false || balance.warehouseActive === false) continue;
      onHand += Number(balance.on_hand) || 0;
      reserved += Number(balance.reserved) || 0;
    }
    return { on_hand: onHand, reserved, available: onHand - reserved };
  }

  function lastPurchaseOf(itemId) {
    const reversed = new Set(ledger.filter(row => row.reverses_entry_id).map(row => row.reverses_entry_id));
    const receipts = ledger
      .filter(row => row.item_id === itemId && row.movement === 'receipt' && !reversed.has(row.id))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.entry_no).localeCompare(String(a.entry_no)));
    const receipt = receipts[0];
    if (!receipt) return null;
    return {
      at: receipt.created_at, entryNo: receipt.entry_no, qty: receipt.qty, unitCost: receipt.unit_cost,
      note: receipt.note || null, movement: receipt.movement, warehouseId: receipt.warehouse_id
    };
  }

  // The dossier node set: root + internal structure down to depth 3, exactly like DOSSIER_NODES_CTE.
  function dossierNodes(rootId) {
    const nodes = [];
    const walk = (id, depth, path) => {
      const asset = assets.get(id);
      if (!asset || asset.deleted_at || path.includes(id)) return;
      nodes.push({ id: asset.id, code: asset.code, name: asset.name, depth });
      if (depth >= 3) return;
      for (const child of assets.values()) {
        if (child.parent === id && child.type === 'eq') walk(child.id, depth + 1, [...path, id]);
      }
    };
    walk(rootId, 0, []);
    return nodes;
  }

  function listRows(rootId, includeArchived, targetId, itemId) {
    const nodes = new Map(dossierNodes(rootId).map(node => [node.id, node]));
    const rows = [];
    for (const link of links.values()) {
      const node = nodes.get(link.asset_id);
      if (!node) continue; // only links inside this dossier (root or a component) are aggregated
      if (link.deleted_at && !includeArchived) continue;
      if (targetId !== undefined && link.asset_id !== targetId) continue;
      if (itemId !== undefined && link.item_id !== itemId) continue;
      const item = items.get(link.item_id);
      if (!item) continue;
      const stock = stockOf(item.id);
      rows.push({
        ...link,
        target_code: node.code, target_name: node.name, target_depth: node.depth,
        code: item.code, name: item.name, unit: item.unit, part_type: item.part_type,
        min_stock: item.min_stock, item_ext: item.ext, item_deleted_at: item.deleted_at,
        stock_on_hand: stock.on_hand, stock_reserved: stock.reserved, stock_available: stock.available,
        last_purchase: lastPurchaseOf(item.id)
      });
    }
    return rows.sort((a, b) => (a.deleted_at ? 1 : 0) - (b.deleted_at ? 1 : 0) || a.target_depth - b.target_depth || String(a.name).localeCompare(String(b.name)) || String(a.code).localeCompare(String(b.code)));
  }

  function factoryOf(assetId) {
    let current = assets.get(assetId);
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.ext && current.ext.nodeKind === 'factory') return current.id;
      current = assets.get(current.parent);
    }
    return null;
  }

  async function query(sql, values = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    state.calls.push({ sql: text, values });
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) { state.transactions.push(text.split(' ')[0]); return { rows: [] }; }

    // structure.rootEquipmentById
    if (/^SELECT id,parent,code,name,type,cls,category_id,ext,row_version,deleted_at FROM assets WHERE id=\$1$/.test(text)) {
      const row = assets.get(values[0]);
      return { rows: row ? [row] : [] };
    }
    // structure.getFactoryId
    if (/WITH RECURSIVE ancestry AS/.test(text) && /SELECT COALESCE\(c\.factory_asset_id/.test(text)) {
      return { rows: [{ factory_id: factoryOf(values[0]) }] };
    }
    // structure.assertEquipmentScope
    if (/SELECT 1 FROM user_scopes WHERE user_id=\$1/.test(text)) {
      const scopes = requestScopes[values[0]] || [];
      const allowed = scopes.some(scope => scope.scope_type === 'company'
        || (scope.scope_type === 'equipment' && scope.scope_id === values[1])
        || (values[2] && scope.scope_type === 'factory' && scope.scope_id === values[2]));
      return { rows: allowed ? [{ 1: 1 }] : [] };
    }
    if (/SELECT 1 FROM role_permissions/.test(text)) {
      const perms = rolePerms(values[0]);
      return { rows: perms.has(values[1]) || perms.has('*') ? [{ 1: 1 }] : [] };
    }
    // lockRoot
    if (/SELECT id FROM assets WHERE id=\$1 AND deleted_at IS NULL FOR NO KEY UPDATE/.test(text)) {
      const row = assets.get(values[0]);
      return { rows: row && !row.deleted_at ? [{ id: row.id }] : [] };
    }
    // assertRealItem
    if (/SELECT id,code,name,unit,part_type,ext FROM items WHERE id=\$1 AND deleted_at IS NULL FOR KEY SHARE/.test(text)) {
      const item = items.get(values[0]);
      return { rows: item && !item.deleted_at ? [item] : [] };
    }
    // lockLink
    if (/SELECT \* FROM asset_spare_parts WHERE asset_id=\$1 AND item_id=\$2 FOR UPDATE/.test(text)) {
      const link = links.get(linkKey(values[0], values[1]));
      return { rows: link ? [{ ...link }] : [] };
    }
    // spareTargets: the selectable link targets (root + main/sub components).
    if (/SELECT id,code,name,depth FROM dossier_nodes WHERE depth IN \(0,2,3\)/.test(text)) {
      const rows = dossierNodes(values[0]).filter(node => [0, 2, 3].includes(node.depth))
        .sort((a, b) => a.depth - b.depth || String(a.name).localeCompare(String(b.name)) || String(a.code).localeCompare(String(b.code)));
      return { rows };
    }
    // structure.structureDepth: real depth of a node relative to the addressed root.
    if (/WITH RECURSIVE structure_path AS/.test(text)) {
      const node = dossierNodes(values[0]).find(item => item.id === values[1]);
      return { rows: node ? [{ depth: node.depth }] : [] };
    }
    // listSpares / readLinkRow (same read contract; the single-link variant adds $3=target,$4=item)
    if (/SELECT rel\.asset_id,rel\.item_id,rel\.relation_type/.test(text)) {
      const single = values.length >= 4;
      return { rows: listRows(values[0], values[1] === true, single ? values[2] : undefined, single ? values[3] : undefined) };
    }
    // INSERT link
    if (/INSERT INTO asset_spare_parts\(asset_id,item_id,relation_type,quantity_required,notes,created_by,updated_by,updated_at\)/.test(text)) {
      const key = linkKey(values[0], values[1]);
      if (links.has(key)) { const error = new Error('duplicate'); error.code = '23505'; throw error; }
      const row = {
        asset_id: values[0], item_id: values[1], relation_type: values[2], quantity_required: values[3],
        notes: values[4], created_by: values[5], updated_by: values[5], created_at: '2026-11-04T10:00:00Z',
        updated_at: '2026-11-04T10:00:00Z', row_version: 1, deleted_at: null, deleted_by: null, delete_reason: null
      };
      links.set(key, row);
      return { rows: [{ ...row }] };
    }
    // UPDATE link (edit / reactivate / archive / restore)
    if (/UPDATE asset_spare_parts SET/.test(text)) {
      const link = links.get(linkKey(values[0], values[1]));
      if (!link) return { rows: [] };
      const versionParam = values[values.length - 1];
      if (Number(link.row_version) !== Number(versionParam)) return { rows: [] };
      if (/deleted_at=now\(\)/.test(text)) {
        if (link.deleted_at) return { rows: [] };
        link.deleted_at = '2026-11-04T11:00:00Z';
        link.deleted_by = values[2];
        link.delete_reason = values[3];
      } else if (/deleted_at=NULL/.test(text)) {
        const expectsArchived = /AND deleted_at IS NOT NULL/.test(text);
        if (expectsArchived && !link.deleted_at) return { rows: [] };
        if (!expectsArchived && link.deleted_at) return { rows: [] };
        link.deleted_at = null; link.deleted_by = null; link.delete_reason = null;
        if (/relation_type=\$3/.test(text)) { link.relation_type = values[2]; link.quantity_required = values[3]; link.notes = values[4]; }
      } else {
        if (link.deleted_at) return { rows: [] };
        link.relation_type = values[2]; link.quantity_required = values[3]; link.notes = values[4];
      }
      link.updated_by = /deleted_at=now\(\)/.test(text) ? values[2] : values[5] !== undefined ? values[5] : values[2];
      link.updated_at = '2026-11-04T11:00:00Z';
      link.row_version += 1;
      return { rows: [{ ...link }] };
    }
    if (/INSERT INTO audit_x/.test(text)) {
      state.audit.push({ action: values[4], mod: 'equipment-spares', entity: values[5], note: values[6], before: values[7], after: values[8] });
      return { rows: [] };
    }
    if (/SELECT u\.id,u\.role,/.test(text) && /FROM users u WHERE u\.active IS TRUE/.test(text)) {
      return { rows: users.filter(user => user.active).map(user => ({ id: user.id, role: user.role, permissions: user.permissions, scopes: user.scopes })) };
    }
    if (/INSERT INTO event_outbox/.test(text)) {
      state.outbox.push({ eventType: 'equipment.spares.changed', aggregateId: values[1], actorId: values[2], payload: JSON.parse(values[3]), recipients: JSON.parse(values[4]) });
      return { rows: [] };
    }
    const error = new Error(`unexpected sql: ${text}`);
    error.code = 'UNEXPECTED_SQL';
    throw error;
  }

  return {
    state, assets, items, links, balances, ledger, users,
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

function seedLink(pool, overrides = {}) {
  const row = {
    asset_id: 'eq-root', item_id: 'item-1', relation_type: 'key-spare', quantity_required: 2,
    notes: 'یاتاقان سمت پروانه', created_by: 'u-mgr', updated_by: 'u-mgr',
    created_at: '2026-10-01T08:00:00Z', updated_at: '2026-10-01T08:00:00Z',
    row_version: 1, deleted_at: null, deleted_by: null, delete_reason: null, ...overrides
  };
  pool.links.set(`${row.asset_id}:${row.item_id}`, row);
  return row;
}

test('D4 spares list shows only real linked items with ledger stock and real last purchase', async () => {
  const pool = sparesPool({
    balances: [
      { item_id: 'item-1', on_hand: 5, reserved: 1, locationActive: true, warehouseActive: true },
      { item_id: 'item-1', on_hand: 40, reserved: 0, locationActive: true, warehouseActive: false } // inactive warehouse must not count
    ],
    ledger: [
      { id: 'r1', item_id: 'item-1', movement: 'receipt', entry_no: 'RC-1', qty: 5, unit_cost: 120000, created_at: '2026-09-01T08:00:00Z', warehouse_id: 'wh-1', note: 'خرید اول' },
      { id: 'r2', item_id: 'item-1', movement: 'receipt', entry_no: 'RC-2', qty: 2, unit_cost: 130000, created_at: '2026-10-15T08:00:00Z', warehouse_id: 'wh-1', note: null }
    ]
  });
  seedLink(pool);
  await withApi(pool, 'mgr', async base => {
    const response = await fetch(`${base}/eq-root/spares`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, 'postgresql');
    assert.equal(body.data.equipment.id, 'eq-root');
    assert.equal(body.data.parts.length, 1);
    const part = body.data.parts[0];
    assert.equal(part.itemId, 'item-1');
    assert.equal(part.code, 'SP-1');
    assert.equal(part.relationType, 'key-spare');
    assert.equal(part.relationLabel, 'قطعه یدکی حیاتی');
    assert.equal(part.quantityRequired, 2);
    assert.equal(part.stockOnHand, 5);
    assert.equal(part.stockReserved, 1);
    assert.equal(part.stockAvailable, 4);
    assert.equal(part.minStock, 2);
    assert.equal(part.lastPurchase.entryNo, 'RC-2');
    assert.equal(part.lastPurchase.qty, 2);
    assert.equal(part.lastPurchase.supplier, null, 'no supplier column exists; never fabricated');
    assert.equal(part.lastPurchase.source, 'inventory_ledger');
    assert.equal(part.archived, false);
    assert.equal(part.rowVersion, 1);
    assert.deepEqual(body.data.capabilities, { create: true, update: true, archive: true, suggest: true, approveAi: true, inventoryView: true });
    // The dossier aggregates the root and its components; the root itself is a general-only target.
    assert.ok(Array.isArray(body.data.targets));
    const rootTarget = body.data.targets.find(target => target.id === 'eq-root');
    assert.equal(rootTarget.criticalAllowed, false);
    assert.equal(rootTarget.kind, 'equipment');
    const mainTarget = body.data.targets.find(target => target.id === 'eq-main');
    assert.equal(mainTarget.criticalAllowed, true);
    assert.equal(mainTarget.kind, 'main-component');
    assert.equal(body.data.targets.some(target => target.id === 'eq-internal'), false, 'a subsystem is never a spare target');
    const scopeCall = pool.state.calls.find(call => /FROM user_scopes/.test(call.sql));
    assert.deepEqual(scopeCall.values.slice(0, 2), ['mgr-1', 'eq-root']);
  });
});

test('D4 spares: no balance and no receipt means real zero stock and null last purchase, never invented values', async () => {
  const pool = sparesPool();
  seedLink(pool, { item_id: 'item-2', quantity_required: null, notes: null });
  await withApi(pool, 'mgr', async base => {
    const body = await (await fetch(`${base}/eq-root/spares`)).json();
    const part = body.data.parts[0];
    assert.equal(part.stockOnHand, 0);
    assert.equal(part.stockAvailable, 0);
    assert.equal(part.lastPurchase, null);
    assert.equal(part.minStock, null);
    assert.equal(part.quantityRequired, null);
  });
});

test('D4 spares: a fully reversed receipt is not a last purchase', async () => {
  const pool = sparesPool({
    ledger: [
      { id: 'r1', item_id: 'item-1', movement: 'receipt', entry_no: 'RC-1', qty: 5, unit_cost: 1, created_at: '2026-09-01T08:00:00Z', warehouse_id: 'wh-1' },
      { id: 'v1', item_id: 'item-1', movement: 'return', entry_no: 'RV-1', qty: 5, unit_cost: 1, created_at: '2026-09-02T08:00:00Z', warehouse_id: 'wh-1', reverses_entry_id: 'r1' }
    ]
  });
  seedLink(pool);
  await withApi(pool, 'mgr', async base => {
    const body = await (await fetch(`${base}/eq-root/spares`)).json();
    assert.equal(body.data.parts[0].lastPurchase, null);
  });
});

test('D4 spares: view permission and equipment scope are enforced server-side', async () => {
  const pool = sparesPool();
  seedLink(pool);
  await withApi(pool, 'tech', async base => {
    const response = await fetch(`${base}/eq-root/spares`);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'PERMISSION_DENIED');
  });
  const scoped = sparesPool({
    requestScopes: { 'mgr-1': [{ scope_type: 'equipment', scope_id: 'other-eq' }] }
  });
  seedLink(scoped);
  await withApi(scoped, 'mgr', async base => {
    const response = await fetch(`${base}/eq-root/spares`);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'EQUIPMENT_SCOPE_DENIED');
  });
});

test('D4 spares: missing, archived and internal-structure equipment are rejected like the dossier itself', async () => {
  const pool = sparesPool();
  await withApi(pool, 'mgr', async base => {
    assert.equal((await fetch(`${base}/no-such-eq/spares`)).status, 404);
    assert.equal((await fetch(`${base}/eq-archived/spares`)).status, 404);
    const internal = await fetch(`${base}/eq-internal/spares`);
    assert.equal(internal.status, 404);
    assert.equal((await internal.json()).error, 'ROOT_EQUIPMENT_NOT_FOUND');
  });
});

test('D4 link: POST creates a real link with audit and scoped realtime event, and ignores typed stock', async () => {
  const pool = sparesPool({
    balances: [{ item_id: 'item-1', on_hand: 3, reserved: 0, locationActive: true, warehouseActive: true }]
  });
  await withApi(pool, 'mgr', async base => {
    const response = await fetch(`${base}/eq-root/spares`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: 'item-1', targetId: 'eq-main', relationType: 'key-spare', quantityRequired: 2, notes: 'حیاتی', stockOnHand: 999, minStock: 50, price: 1 })
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.committed, true);
    assert.equal(body.data.itemId, 'item-1');
    assert.equal(body.data.targetId, 'eq-main');
    assert.equal(body.data.target.kind, 'main-component');
    assert.equal(body.data.stockOnHand, 3, 'stock comes from the ledger, not the request body');
    assert.equal(body.data.rowVersion, 1);
    const stored = pool.links.get('eq-main:item-1');
    assert.equal(stored.quantity_required, 2);
    assert.equal(Object.prototype.hasOwnProperty.call(stored, 'stockOnHand'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(stored, 'price'), false);
    const audit = pool.state.audit.find(row => row.action === 'spare-link');
    assert.ok(audit, 'link creation must be audited');
    assert.equal(audit.entity, 'eq-root:item-1');
    assert.equal(pool.state.outbox.length, 1);
    const event = pool.state.outbox[0];
    assert.equal(event.payload.action, 'link');
    assert.equal(event.aggregateId, 'eq-root');
    // u-out has the permission but not the scope; u-tech has scope but not the permission.
    assert.deepEqual(event.recipients.sort(), ['u-admin', 'u-mgr', 'u-store']);
    assert.deepEqual(pool.state.transactions.filter(item => item === 'COMMIT').length, 1);
  });
});

test('D4 link: unknown or archived inventory items are rejected and nothing is written', async () => {
  const pool = sparesPool();
  await withApi(pool, 'mgr', async base => {
    for (const itemId of ['no-item', 'item-archived']) {
      const response = await fetch(`${base}/eq-root/spares`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId, targetId: 'eq-main' })
      });
      assert.equal(response.status, 422);
      assert.equal((await response.json()).error, 'INVENTORY_ITEM_NOT_FOUND');
    }
    assert.equal(pool.links.size, 0);
    assert.equal(pool.state.audit.length, 0);
    assert.equal(pool.state.outbox.length, 0);
    assert.ok(pool.state.transactions.includes('ROLLBACK'));
  });
});

test('D4 link: duplicate active link is 409; an archived link is explicitly reactivated with its own audit', async () => {
  const pool = sparesPool();
  seedLink(pool, { asset_id: 'eq-main' });
  await withApi(pool, 'mgr', async base => {
    const duplicate = await fetch(`${base}/eq-root/spares`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId: 'item-1', targetId: 'eq-main' })
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error, 'SPARE_LINK_EXISTS');
  });
  const archivedPool = sparesPool();
  seedLink(archivedPool, { deleted_at: '2026-11-01T00:00:00Z', delete_reason: 'قدیمی', row_version: 3 });
  await withApi(archivedPool, 'mgr', async base => {
    const response = await fetch(`${base}/eq-root/spares`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: 'item-1', relationType: 'general-spare', quantityRequired: 1 })
    });
    assert.equal(response.status, 201);
    const stored = archivedPool.links.get('eq-root:item-1');
    assert.equal(stored.deleted_at, null);
    assert.equal(stored.relation_type, 'general-spare');
    assert.equal(stored.row_version, 4);
    assert.ok(archivedPool.state.audit.some(row => row.action === 'spare-link-reactivate'));
    assert.equal(archivedPool.state.outbox[0].payload.action, 'reactivate');
  });
});

test('D4 link: relation type and quantity are validated server-side', async () => {
  const pool = sparesPool();
  await withApi(pool, 'mgr', async base => {
    const badType = await fetch(`${base}/eq-root/spares`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId: 'item-1', relationType: 'made-up' })
    });
    assert.equal(badType.status, 422);
    const badQuantity = await fetch(`${base}/eq-root/spares`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId: 'item-1', quantityRequired: -3 })
    });
    assert.equal(badQuantity.status, 422);
    const missingItem = await fetch(`${base}/eq-root/spares`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: 'بدون قلم' })
    });
    assert.equal(missingItem.status, 422);
    assert.equal(pool.links.size, 0);
  });
  const { errors } = spares.validateLinkInput({ itemId: 'item-1', quantityRequired: 1000000001 });
  assert.ok(errors.some(item => item.code === 'REQUIRED_QUANTITY_INVALID'));
  const zero = spares.validateLinkInput({ itemId: 'item-1', quantityRequired: 0 });
  assert.equal(zero.errors.length, 0);
  assert.equal(zero.values.quantityRequired, 0);
});

test('D4 edit: PATCH uses row_version, keeps the item immutable and audits before/after', async () => {
  const pool = sparesPool();
  seedLink(pool, { row_version: 5 });
  await withApi(pool, 'mgr', async base => {
    const conflict = await fetch(`${base}/eq-root/spares/item-1`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowVersion: 4, quantityRequired: 9 })
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error, 'VERSION_CONFLICT');
    const response = await fetch(`${base}/eq-root/spares/item-1`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowVersion: 5, quantityRequired: 9, itemId: 'item-2', notes: 'به‌روزرسانی' })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.committed, true);
    assert.equal(body.data.quantityRequired, 9);
    assert.equal(body.data.itemId, 'item-1', 'the linked item never changes through PATCH');
    assert.equal(body.data.rowVersion, 6);
    const audit = pool.state.audit.find(row => row.action === 'spare-link-edit');
    assert.ok(audit.before && audit.after);
    assert.equal(JSON.parse(audit.before).quantity_required, 2);
    assert.equal(JSON.parse(audit.after).quantity_required, 9);
    assert.equal(pool.state.outbox[0].payload.action, 'edit');
  });
});

test('D4 edit: no editable field and missing version are rejected', async () => {
  const pool = sparesPool();
  seedLink(pool);
  await withApi(pool, 'mgr', async base => {
    const noVersion = await fetch(`${base}/eq-root/spares/item-1`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: 'x' })
    });
    assert.equal(noVersion.status, 422);
    assert.equal((await noVersion.json()).error, 'ROW_VERSION_REQUIRED');
    const noFields = await fetch(`${base}/eq-root/spares/item-1`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rowVersion: 1 })
    });
    assert.equal(noFields.status, 422);
    assert.equal((await noFields.json()).error, 'NO_EDITABLE_FIELDS');
    const missingLink = await fetch(`${base}/eq-root/spares/item-2`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rowVersion: 1, notes: 'x' })
    });
    assert.equal(missingLink.status, 404);
  });
});

test('D4 archive: reason is mandatory, delete is soft, and restore needs its own reason', async () => {
  const pool = sparesPool();
  seedLink(pool);
  await withApi(pool, 'mgr', async base => {
    const noReason = await fetch(`${base}/eq-root/spares/item-1`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rowVersion: 1 })
    });
    assert.equal(noReason.status, 422);
    assert.equal((await noReason.json()).error, 'ARCHIVE_REASON_REQUIRED');
    const response = await fetch(`${base}/eq-root/spares/item-1`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rowVersion: 1, reason: 'قطعه از رده خارج شد' })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.archived, true);
    assert.equal(body.historyPreserved, true);
    const stored = pool.links.get('eq-root:item-1');
    assert.ok(stored.deleted_at, 'the link row must survive as a soft-archive');
    assert.equal(stored.delete_reason, 'قطعه از رده خارج شد');
    assert.ok(pool.state.audit.some(row => row.action === 'spare-link-archive'));
    // Hidden from the active list, visible with includeArchived.
    const active = await (await fetch(`${base}/eq-root/spares`)).json();
    assert.equal(active.data.parts.length, 0);
    const archived = await (await fetch(`${base}/eq-root/spares?includeArchived=true`)).json();
    assert.equal(archived.data.parts.length, 1);
    assert.equal(archived.data.parts[0].archived, true);
    assert.equal(archived.data.parts[0].deleteReason, 'قطعه از رده خارج شد');
    // Restore without reason fails; with reason it returns the link.
    const noRestoreReason = await fetch(`${base}/eq-root/spares/item-1/restore`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rowVersion: 2 })
    });
    assert.equal(noRestoreReason.status, 422);
    const restored = await fetch(`${base}/eq-root/spares/item-1/restore`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rowVersion: 2, reason: 'بازگشت به سرویس' })
    });
    assert.equal(restored.status, 200);
    const restoredBody = await restored.json();
    assert.equal(restoredBody.restored, true);
    assert.equal(restoredBody.historyPreserved, true);
    assert.equal(pool.links.get('eq-root:item-1').deleted_at, null);
    assert.ok(pool.state.audit.some(row => row.action === 'spare-link-restore'));
  });
});

test('D4 archive: planner cannot archive, and includeArchived is ignored without the archive permission', async () => {
  const pool = sparesPool();
  seedLink(pool, { deleted_at: '2026-11-01T00:00:00Z', delete_reason: 'قدیمی' });
  await withApi(pool, 'planner', async base => {
    const response = await fetch(`${base}/eq-root/spares/item-1`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rowVersion: 1, reason: 'تست' })
    });
    assert.equal(response.status, 403);
    const list = await (await fetch(`${base}/eq-root/spares?includeArchived=true`)).json();
    assert.equal(list.data.includeArchived, false);
    assert.equal(list.data.parts.length, 0);
    assert.equal(list.data.capabilities.archive, false);
  });
});

test('D4 spares: the dossier detail query and all spare consumers exclude archived links', () => {
  const routes = read('server/equipment-routes.js');
  assert.match(routes, /WHERE rel\.asset_id=a\.id AND rel\.deleted_at IS NULL AND i\.deleted_at IS NULL/);
  assert.match(read('server/ai-service.js'), /FROM asset_spare_parts rel JOIN items i ON i\.id=rel\.item_id WHERE rel\.asset_id=\$1 AND rel\.deleted_at IS NULL/);
  assert.match(read('server/equipment-health-service.js'), /FROM asset_spare_parts r JOIN items i ON i\.id=r\.item_id WHERE r\.asset_id=\$1 AND r\.deleted_at IS NULL/);
  assert.match(read('server/structure-suggestions.js'), /WHERE rel\.asset_id=\$1 AND rel\.deleted_at IS NULL/);
});

test('D4 spares: writes never touch the equipment row_version and stay inside one transaction', async () => {
  const pool = sparesPool();
  await withApi(pool, 'mgr', async base => {
    await fetch(`${base}/eq-root/spares`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId: 'item-1', targetId: 'eq-main' })
    });
    assert.equal(pool.assets.get('eq-root').row_version, 4, 'spare links have their own versioning');
    const assetUpdates = pool.state.calls.filter(call => /UPDATE assets/.test(call.sql));
    assert.equal(assetUpdates.length, 0);
    const sequence = pool.state.transactions;
    assert.equal(sequence[0], 'BEGIN');
    assert.equal(sequence.at(-1), 'COMMIT');
  });
});

test('D4 spares: service requires the real dossier root and validates input shape', async () => {
  const pool = sparesPool();
  await assert.rejects(
    spares.listSpares({ pool, security: { hasPermission: async () => true }, user: { id: 'u-mgr', role: 'mgr' }, equipmentId: 'eq-internal' }),
    error => error.code === 'ROOT_EQUIPMENT_NOT_FOUND'
  );
  const partial = spares.validateLinkInput({ notes: '  یادداشت  ' }, { partial: true });
  assert.equal(partial.errors.length, 0);
  assert.equal(partial.values.notes, 'یادداشت');
  assert.equal(Object.prototype.hasOwnProperty.call(partial.values, 'itemId'), false);
});

test('D4 critical target: a key-spare on the equipment root or a subsystem is rejected with 422 and nothing is written', async () => {
  const pool = sparesPool();
  await withApi(pool, 'mgr', async base => {
    const onRoot = await fetch(`${base}/eq-root/spares`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: 'item-1', relationType: 'key-spare' })
    });
    assert.equal(onRoot.status, 422);
    assert.equal((await onRoot.json()).error, 'SPARE_CRITICAL_TARGET_INVALID');
    const onSubsystem = await fetch(`${base}/eq-root/spares`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: 'item-1', targetId: 'eq-internal', relationType: 'key-spare' })
    });
    assert.equal(onSubsystem.status, 422);
    assert.equal((await onSubsystem.json()).error, 'SPARE_TARGET_KIND_INVALID');
    const generalOnSubsystem = await fetch(`${base}/eq-root/spares`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: 'item-1', targetId: 'eq-internal', relationType: 'general-spare' })
    });
    assert.equal(generalOnSubsystem.status, 422, 'a subsystem is never a spare target, even general');
    assert.equal((await generalOnSubsystem.json()).error, 'SPARE_TARGET_KIND_INVALID');
    assert.equal(pool.links.size, 0);
    assert.equal(pool.state.audit.length, 0);
    assert.equal(pool.state.outbox.length, 0);
  });
});

test('D4 critical target: a key-spare is accepted on a main-component and a sub-component; general spare on the root is accepted', async () => {
  const pool = sparesPool();
  await withApi(pool, 'mgr', async base => {
    const onMain = await fetch(`${base}/eq-root/spares`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: 'item-1', targetId: 'eq-main', relationType: 'key-spare' })
    });
    assert.equal(onMain.status, 201);
    assert.equal((await onMain.json()).data.target.kind, 'main-component');
    const onSub = await fetch(`${base}/eq-root/spares`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: 'item-2', targetId: 'eq-sub', relationType: 'key-spare' })
    });
    assert.equal(onSub.status, 201);
    assert.equal((await onSub.json()).data.target.kind, 'sub-component');
    const generalOnRoot = await fetch(`${base}/eq-root/spares`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: 'item-1', relationType: 'general-spare' })
    });
    assert.equal(generalOnRoot.status, 201);
    assert.equal((await generalOnRoot.json()).data.target.kind, 'equipment');
    // The dossier list aggregates the root and component links together.
    const list = await (await fetch(`${base}/eq-root/spares`)).json();
    assert.equal(list.data.parts.length, 3);
    assert.ok(list.data.parts.some(part => part.targetId === 'eq-main'));
    assert.ok(list.data.parts.some(part => part.targetId === 'eq-sub'));
    assert.ok(list.data.parts.some(part => part.targetId === 'eq-root'));
  });
});

test('D4 critical target: a target outside the dossier is rejected; the same item can link to two different targets', async () => {
  const pool = sparesPool();
  await withApi(pool, 'mgr', async base => {
    const outside = await fetch(`${base}/eq-root/spares`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: 'item-1', targetId: 'eq-archived', relationType: 'key-spare' })
    });
    assert.equal(outside.status, 422);
    assert.equal((await outside.json()).error, 'SPARE_TARGET_NOT_FOUND');
    // Same item on two distinct component targets is two distinct links (PK is asset_id,item_id).
    const first = await fetch(`${base}/eq-root/spares`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: 'item-1', targetId: 'eq-main', relationType: 'key-spare' })
    });
    assert.equal(first.status, 201);
    const second = await fetch(`${base}/eq-root/spares`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: 'item-1', targetId: 'eq-sub', relationType: 'key-spare' })
    });
    assert.equal(second.status, 201);
    assert.equal(pool.links.size, 2);
  });
});

test('D4 critical target: a legacy root key-spare stays editable for quantity/notes but cannot be re-designated critical via PATCH', async () => {
  const pool = sparesPool();
  seedLink(pool, { relation_type: 'key-spare', row_version: 2 }); // grandfathered legacy root link
  await withApi(pool, 'mgr', async base => {
    const quantityOnly = await fetch(`${base}/eq-root/spares/item-1`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowVersion: 2, quantityRequired: 7 })
    });
    assert.equal(quantityOnly.status, 200, 'legacy critical root links remain editable for quantity/notes');
    const redesignate = await fetch(`${base}/eq-root/spares/item-1`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowVersion: 3, relationType: 'key-spare' })
    });
    assert.equal(redesignate.status, 422);
    assert.equal((await redesignate.json()).error, 'SPARE_CRITICAL_TARGET_INVALID');
    const toGeneral = await fetch(`${base}/eq-root/spares/item-1`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowVersion: 3, relationType: 'general-spare' })
    });
    assert.equal(toGeneral.status, 200, 'downgrading a legacy critical root link to general is allowed');
  });
});

test('D4 critical target: the service enforces the rule directly (resolveTarget + assertCriticalTarget)', async () => {
  const pool = sparesPool();
  const client = await pool.connect();
  const root = { id: 'eq-root' };
  const rootTarget = await spares.resolveTarget(client, root, null);
  assert.equal(rootTarget.kind, 'equipment');
  assert.equal(rootTarget.criticalAllowed, false);
  const mainTarget = await spares.resolveTarget(client, root, 'eq-main');
  assert.equal(mainTarget.kind, 'main-component');
  assert.equal(mainTarget.criticalAllowed, true);
  await assert.rejects(spares.resolveTarget(client, root, 'eq-internal'), error => error.code === 'SPARE_TARGET_KIND_INVALID');
  await assert.rejects(spares.resolveTarget(client, root, 'no-such-node'), error => error.code === 'SPARE_TARGET_NOT_FOUND');
  assert.deepEqual(spares.CRITICAL_TARGET_KINDS, ['main-component', 'sub-component']);
  client.release();
});
