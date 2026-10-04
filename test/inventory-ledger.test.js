'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('os');
const path = require('path');
const express = require('express');
const filePolicy = require('../server/file-policy');
const service = require('../server/inventory-service');
const { createInventoryRouter } = require('../server/inventory-routes');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function norm(sql){ return String(sql).replace(/\s+/g, ' ').trim(); }
function splitList(list){
  const parts = [];
  let current = '', depth = 0, quote = false;
  for (const ch of list) {
    if (ch === "'" && !quote) { quote = true; current += ch; continue; }
    if (ch === "'" && quote) { quote = false; current += ch; continue; }
    if (!quote && ch === '(') depth += 1;
    if (!quote && ch === ')') depth -= 1;
    if (!quote && depth === 0 && ch === ',') { parts.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
function valueOf(token, params){
  if (token.startsWith('$')) return params[Number(token.slice(1)) - 1];
  if (token === 'now()') return new Date().toISOString();
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
  if (token.startsWith("'")) return token.slice(1, token.lastIndexOf("'"));
  return token;
}

function memoryPool(){
  const db = {
    items:[], warehouses:[{ id:'wh-main', code:'MAIN', name:'انبار مرکزی', deleted_at:null, row_version:1, active:true, factory_asset_id:null }],
    locations:[{ id:'loc-main', warehouse_id:'wh-main', code:'A-01', name:'قفسه اصلی', deleted_at:null, row_version:1 }],
    balances:[], ledger:[], reservations:[], parts:[], costs:[], files:[], audit:[], outbox:[], counters:{},
    workOrders:[{ id:'wo-1', no:'WO-1', status:'closed', asset_id:'eq-1', req_id:'rq-1', row_version:3, deleted_at:null, requester_confirmed_at:null }],
    requests:[{ id:'rq-1', requester_id:'u-op' }],
    assets:[{ id:'eq-1', factory_asset_id:'factory-1' }],
    users:[
      { id:'u-admin', role:'admin', active:true, permissions:['*'], scopes:[] },
      { id:'u-empty', role:'store', active:true, permissions:['inventory.view','cost.view','work_order.view'], scopes:[] },
      { id:'u-company', role:'mgr', active:true, permissions:['inventory.view','cost.view','work_order.view'], scopes:[{ scope_type:'company', scope_id:'co-1' }] },
      { id:'u-op', role:'op', active:true, permissions:['work_order.confirm'], scopes:[{ scope_type:'company', scope_id:'co-1' }] }
    ]
  };
  let snapshot = null;
  function table(name){
    return { items:db.items, warehouses:db.warehouses, storage_locations:db.locations, item_balances:db.balances, inventory_ledger:db.ledger, inventory_reservations:db.reservations, work_order_parts:db.parts, work_order_costs:db.costs, work_order_files:db.files, audit_x:db.audit, event_outbox:db.outbox, work_orders:db.workOrders, requests:db.requests }[name];
  }
  function insert(text, params){
    if (text.includes('INSERT INTO maintenance_counters')) {
      db.counters[params[0]] = (db.counters[params[0]] || 0) + 1;
      return { rows:[{ value:db.counters[params[0]] }], rowCount:1 };
    }
    const statement = text.split(/\s+ON CONFLICT/i)[0];
    const match = statement.match(/^INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\((.+)\)(?:\s+RETURNING \*)?$/i);
    if (!match) throw new Error('unparsed insert: ' + text);
    const rows = table(match[1]);
    const columns = splitList(match[2]);
    const refs = splitList(match[3]);
    const row = { row_version:1, deleted_at:null, created_at:new Date().toISOString(), voided_at:null };
    columns.forEach((column, index) => { row[column] = valueOf(refs[index], params); });
    if (match[1] === 'item_balances' && rows.some(item => item.item_id === row.item_id && item.location_id === row.location_id)) return { rows:[], rowCount:0 };
    rows.push(row);
    return { rows:text.includes('RETURNING') ? [{ ...row }] : [], rowCount:1 };
  }
  async function query(sql, params = []){
    const text = norm(sql);
    if (text === 'BEGIN') { snapshot = JSON.parse(JSON.stringify(db)); return { rows:[] }; }
    if (text === 'COMMIT') { snapshot = null; return { rows:[] }; }
    if (text === 'ROLLBACK') {
      if (snapshot) { Object.keys(db).forEach(key => delete db[key]); Object.assign(db, snapshot); }
      snapshot = null;
      return { rows:[] };
    }
    if (text.startsWith('INSERT INTO')) return insert(text, params);
    if (text.startsWith('UPDATE item_balances')) {
      const current = db.balances.find(item => item.item_id === params[0] && item.location_id === params[1]);
      if (!current) return { rows:[], rowCount:0 };
      current.on_hand = Number(params[2]);
      current.reserved = Number(params[3]);
      current.row_version += 1;
      return { rows:[{ ...current }], rowCount:1 };
    }
    if (text.startsWith('UPDATE items SET stock=')) {
      const current = db.items.find(item => item.id === params[0] && Number(item.row_version) === Number(params[4]) && !item.deleted_at);
      if (!current) return { rows:[], rowCount:0 };
      current.stock = Number(params[1]);
      current.price = Number(params[2]);
      current.row_version += 1;
      return { rows:[{ ...current }], rowCount:1 };
    }
    if (text.startsWith('UPDATE items SET name=')) {
      const current = db.items.find(item => item.id === params[0] && Number(item.row_version) === Number(params[8]) && !item.deleted_at);
      if (!current) return { rows:[], rowCount:0 };
      current.name = params[1];
      current.unit = params[2];
      current.min_stock = Number(params[3]);
      current.price = Number(params[4]);
      current.loc = params[5];
      current.cat = params[6];
      current.row_version += 1;
      return { rows:[{ ...current }], rowCount:1 };
    }
    if (text.startsWith('UPDATE items SET deleted_at')) {
      const current = db.items.find(item => item.id === params[0] && Number(item.row_version) === Number(params[1]) && !item.deleted_at);
      if (!current) return { rows:[], rowCount:0 };
      current.deleted_at = new Date().toISOString();
      current.row_version += 1;
      return { rows:[{ ...current }], rowCount:1 };
    }
    if (text.startsWith('UPDATE inventory_reservations SET remaining=$2')) {
      const current = db.reservations.find(item => item.id === params[0]);
      if (!current) return { rows:[], rowCount:0 };
      current.remaining = Number(params[1]);
      current.status = params[2];
      current.row_version += 1;
      return { rows:[{ ...current }], rowCount:1 };
    }
    if (text.startsWith('UPDATE inventory_reservations SET remaining=0')) {
      const current = db.reservations.find(item => item.id === params[0] && Number(item.row_version) === Number(params[1]));
      if (!current) return { rows:[], rowCount:0 };
      current.remaining = 0;
      current.status = 'released';
      current.row_version += 1;
      return { rows:[{ ...current }], rowCount:1 };
    }
    if (text.startsWith('UPDATE work_orders SET requester_confirmed_at')) {
      const current = db.workOrders.find(item => item.id === params[0] && Number(item.row_version) === Number(params[4]) && !item.requester_confirmed_at);
      if (!current) return { rows:[], rowCount:0 };
      current.requester_confirmed_at = new Date().toISOString();
      current.requester_confirmed_by = params[1];
      current.requester_confirmed_name = params[2];
      current.requester_confirmation_note = params[3];
      current.row_version += 1;
      return { rows:[{ ...current }], rowCount:1 };
    }
    if (text.includes('SUM(on_hand),0) AS on_hand, COALESCE(SUM(reserved)')) {
      const rows = db.balances.filter(item => item.item_id === params[0]);
      return { rows:[{ on_hand:rows.reduce((sum, item) => sum + Number(item.on_hand), 0), reserved:rows.reduce((sum, item) => sum + Number(item.reserved), 0) }] };
    }
    if (text.includes('SUM(on_hand),0) AS on_hand FROM item_balances')) {
      const rows = db.balances.filter(item => item.item_id === params[0]);
      return { rows:[{ on_hand:rows.reduce((sum, item) => sum + Number(item.on_hand), 0) }] };
    }
    if (text.includes('AS returned')) {
      const returned = db.ledger.filter(item => item.reverses_entry_id === params[0] && item.movement === 'return').reduce((sum, item) => sum + Number(item.qty), 0);
      return { rows:[{ returned }] };
    }
    if (text.includes('AS entries')) {
      const entries = db.ledger.filter(item => item.item_id === params[0] && ['consume','issue','return'].includes(item.movement)).length;
      return { rows:[{ entries }] };
    }
    if (text.includes('FROM items i')) return { rows:db.items.filter(item => !item.deleted_at).map(item => ({ ...item })) };
    if (text.includes('FROM item_balances bal')) {
      return { rows:db.balances.filter(item => item.item_id === params[0]).map(item => ({ ...item, warehouse_id:'wh-main', location_code:'A-01' })) };
    }
    if (text.includes('FROM work_order_costs c')) {
      return { rows:db.costs.filter(item => !item.voided_at && (!params[0] || item.work_order_id === params[0])).map(item => ({ ...item, work_order_no:'WO-1' })) };
    }
    if (text.includes('FROM work_order_costs WHERE work_order_id=$1')) {
      return { rows:db.costs.filter(item => item.work_order_id === params[0] && !item.voided_at).map(item => ({ ...item })) };
    }
    if (text.includes('FROM inventory_ledger') && text.includes('$1::text')) {
      return { rows:db.ledger.filter(item => (!params[0] || item.item_id === params[0]) && (!params[1] || item.work_order_id === params[1])).map(item => ({ ...item })) };
    }
    if (text.includes('FROM work_order_files WHERE work_order_id=$1')) return { rows:db.files.filter(item => item.work_order_id === params[0] && !item.deleted_at) };
    if (text.includes('FROM work_order_files WHERE id=$1')) return { rows:db.files.filter(item => item.id === params[0] && item.work_order_id === params[1] && !item.deleted_at) };
    if (text.includes('SELECT * FROM')) {
      const name = text.match(/FROM (\w+)/)[1];
      const rows = table(name).filter(item => text.includes('item_id=$1 AND location_id=$2') ? item.item_id === params[0] && item.location_id === params[1] : item.id === params[0]);
      return { rows:rows.map(item => ({ ...item })) };
    }
    if (text.includes('factory_asset_id')) return { rows:[{ factory_asset_id:'factory-1' }] };
    if (text.includes('FROM users u WHERE u.active=true')) return { rows:db.users.filter(item => item.active).map(item => ({ ...item })) };
    if (text.includes('FROM requests WHERE id=$1')) return { rows:db.requests.filter(item => item.id === params[0]) };
    if (text.includes('FROM warehouses WHERE deleted_at IS NULL ORDER')) return { rows:db.warehouses.filter(item => !item.deleted_at) };
    if (text.includes('FROM storage_locations WHERE deleted_at IS NULL ORDER')) return { rows:db.locations.filter(item => !item.deleted_at) };
    throw new Error('unexpected sql: ' + text);
  }
  return { db, query, async connect(){ return { query, release(){} }; } };
}

const user = { id:'u-store', name:'انباردار', username:'store', role:'store' };
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test('file policy rejects dangerous names and mismatched content', () => {
  assert.throws(() => filePolicy.validate({ name:'tool.exe', buffer:png }), error => error.code === 'DANGEROUS_FILE_REJECTED');
  assert.throws(() => filePolicy.validate({ name:'photo.png.exe', buffer:png }), error => error.code === 'DANGEROUS_FILE_REJECTED');
  assert.throws(() => filePolicy.validate({ name:'../secret.pdf', buffer:Buffer.from('%PDF-1.7') }), error => error.code === 'FILE_NAME_REJECTED');
  assert.throws(() => filePolicy.validate({ name:'note.html', buffer:Buffer.from('<html>') }), error => error.code === 'DANGEROUS_FILE_REJECTED');
  assert.throws(() => filePolicy.validate({ name:'photo.png', buffer:Buffer.from('MZ') }), error => error.code === 'FILE_TYPE_REJECTED');
  assert.throws(() => filePolicy.validate({ name:'big.pdf', buffer:Buffer.alloc(filePolicy.MAX_BYTES + 1, 0x25) }), error => error.code === 'FILE_TOO_LARGE');
  const accepted = filePolicy.validate({ name:'photo.png', buffer:png });
  assert.equal(accepted.mediaType, 'image/png');
  assert.equal(accepted.sha256.length, 64);
});

test('ledger rejects negative stock, preserves history, and prices parts on the server', async () => {
  const pool = memoryPool();
  const created = await service.createItem(pool, user, { name:'سیل', unit:'عدد', price:1500, initialQty:2, locationId:'loc-main' });
  assert.equal(created.stock, 2);
  await assert.rejects(() => service.issue(pool, user, { itemId:created.id, rowVersion:created.rowVersion, qty:3, locationId:'loc-main' }), error => error.code === 'NEGATIVE_STOCK_NOT_ALLOWED');
  assert.equal(pool.db.items[0].stock, 2);
  assert.equal(pool.db.ledger.filter(entry => entry.movement === 'issue').length, 0);
  const consumed = await service.consume(pool, user, { itemId:created.id, rowVersion:pool.db.items[0].row_version, qty:2, locationId:'loc-main', workOrderId:'wo-1' });
  assert.equal(consumed.entry.workOrderId, 'wo-1');
  assert.equal(consumed.entry.equipmentId, 'eq-1');
  assert.equal(consumed.cost.amount, 3000);
  assert.equal(consumed.cost.source, 'server');
  assert.equal(pool.db.parts.length, 1);
  assert.equal(pool.db.items[0].stock, 0);
  await assert.rejects(() => service.archiveItem(pool, user, created.id, { rowVersion:pool.db.items[0].row_version, reason:'حذف' }), error => error.code === 'CONSUMPTION_HISTORY_CANNOT_BE_DELETED');
  const returned = await service.returnParts(pool, user, { entryId:consumed.entry.id, rowVersion:pool.db.items[0].row_version, qty:1 });
  assert.equal(returned.item.stock, 1);
  await assert.rejects(() => service.returnParts(pool, user, { entryId:consumed.entry.id, rowVersion:returned.item.rowVersion, qty:2 }), error => error.code === 'RETURN_EXCEEDS_ISSUE');
  const labor = await service.addCost(pool, user, 'wo-1', { kind:'labor', hours:2, rate:100, amount:999999 });
  assert.equal(labor.line.amount, 200);
  assert.equal(labor.totals.parts, 1500);
  assert.equal(labor.totals.labor, 200);
  assert.equal(labor.totals.total, 1700);
  assert.equal(pool.db.outbox.every(event => {
    const recipients = JSON.parse(event.recipient_ids);
    return recipients.includes('u-admin') && recipients.includes('u-company') && !recipients.includes('u-empty');
  }), true);
  assert.doesNotMatch(read('server/inventory-service.js'), /DELETE FROM (items|inventory_ledger|work_order_parts|work_order_costs)/i);
  assert.match(read('migrations/008_inventory_ledger.sql'), /inventory_ledger_immutable/);
  assert.match(read('migrations/008_inventory_ledger.sql'), /CHECK \(on_hand >= 0\)/);
});

test('delivery confirmation is limited to the requester and attachments stay out of the browser', async () => {
  const pool = memoryPool();
  await assert.rejects(() => service.confirmDelivery(pool, user, 'wo-1', { rowVersion:3 }), error => error.code === 'REQUESTER_CONFIRMATION_REQUIRED');
  const confirmed = await service.confirmDelivery(pool, { id:'u-op', name:'اپراتور', role:'op' }, 'wo-1', { rowVersion:3, note:'تحویل شد' });
  assert.equal(confirmed.requesterOK.by, 'اپراتور');
  assert.equal(confirmed.status, 'closed');
  await assert.rejects(() => service.confirmDelivery(pool, { id:'u-op', name:'اپراتور', role:'op' }, 'wo-1', { rowVersion:confirmed.rowVersion }), error => error.code === 'DELIVERY_ALREADY_CONFIRMED');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfg-files-'));
  const app = express();
  app.use('/api', createInventoryRouter({
    pool, security:{
      authenticateToken(req, _res, next){ req.user = { id:'u-mgr', name:'مدیر', role:'mgr' }; next(); },
      authorize(permission){ return (_req, res, next) => permission === 'work_order.attach' || permission === 'work_order.view' ? next() : res.status(403).json({ error:'PERMISSION_DENIED' }); }
    },
    storageDir:dir
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const rejected = await fetch(`http://127.0.0.1:${server.address().port}/api/work-orders/wo-1/attachments`, {
      method:'POST', headers:{ 'content-type':'application/octet-stream', 'x-file-name':'tool.exe' }, body:Buffer.from('MZ')
    });
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).error, 'DANGEROUS_FILE_REJECTED');
    assert.equal(fs.readdirSync(dir).length, 0);
    const accepted = await fetch(`http://127.0.0.1:${server.address().port}/api/work-orders/wo-1/attachments`, {
      method:'POST', headers:{ 'content-type':'application/octet-stream', 'x-file-name':'photo.png', 'x-file-phase':'before' }, body:png
    });
    assert.equal(accepted.status, 201);
    const payload = await accepted.json();
    const downloaded = await fetch(`http://127.0.0.1:${server.address().port}/api/work-orders/wo-1/attachments/${payload.data.id}`);
    assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(Buffer.from(await downloaded.arrayBuffer()).equals(png), true);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive:true, force:true });
  }
});

test('inventory client and generic routes do not keep stock or files locally', () => {
  const client = read('public/platform-v2/inventory-client.js');
  const server = read('server.js');
  assert.match(client, /\/api\/inventory\/consumptions/);
  assert.match(client, /\/api\/work-orders\/.+\/attachments/);
  assert.match(client, /LOCAL_INVENTORY_WRITE_BLOCKED/);
  assert.doesNotMatch(client, /localStorage|readAsDataURL|toDataURL|btoa/);
  assert.match(server, /USE_INVENTORY_API/);
  assert.match(server, /createInventoryRouter/);
  assert.doesNotMatch(server, /RECORD_DOMAINS=\{[^}]*items:/);
  assert.match(read('public/index.html'), /inventory-client\.js/);
  assert.match(read('schema.sql'), /CREATE TABLE IF NOT EXISTS inventory_ledger/);
});
