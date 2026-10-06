'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const service = require('../server/maintenance-service');
const { createMaintenanceRouter } = require('../server/maintenance-routes');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const user = { id:'u-mgr', name:'مدیر نت', username:'planner', role:'mgr', unit:'نت' };

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
  if (token.includes('::jsonb')) return JSON.parse(token.slice(1, token.indexOf("'", 1)));
  if (token.startsWith("'")) return token.slice(1, token.lastIndexOf("'"));
  return token;
}

function memoryPool(){
  const db = {
    assets:[{ id:'eq-1', code:'P-01', name:'پمپ انتقال', deleted_at:null, factory_asset_id:'factory-1' }],
    requests:[], work_orders:[], pm_plans:[], work_order_assets:[],
    audit_x:[], event_outbox:[], corrections:[], counters:{},
    users:[
      { id:'u-admin', role:'admin', active:true, permissions:['*'], scopes:[] },
      { id:'u-empty', role:'mgr', active:true, permissions:['request.view','work_order.view','pm.view'], scopes:[] },
      { id:'u-company', role:'mgr', active:true, permissions:['request.view','work_order.view','pm.view'], scopes:[{ scope_type:'company', scope_id:'co-1' }] },
      { id:'u-factory', role:'tech', active:true, permissions:['request.view','work_order.view','pm.view'], scopes:[{ scope_type:'factory', scope_id:'factory-1' }] },
      { id:'u-other', role:'tech', active:true, permissions:['request.view','work_order.view','pm.view'], scopes:[{ scope_type:'factory', scope_id:'other-factory' }] },
      { id:'u-op', role:'op', active:true, permissions:['request.create'], scopes:[{ scope_type:'company', scope_id:'co-1' }] },
      { id:'u-tech', role:'tech', active:true, permissions:['work_order.execute','work_order.view'], scopes:[{ scope_type:'equipment', scope_id:'eq-1' }] }
    ]
  };
  function table(name){
    if (name === 'requests') return db.requests;
    if (name === 'work_orders') return db.work_orders;
    if (name === 'pm_plans') return db.pm_plans;
    if (name === 'work_order_assets') return db.work_order_assets;
    if (name === 'audit_x') return db.audit_x;
    if (name === 'event_outbox') return db.event_outbox;
    if (name === 'maintenance_corrections') return db.corrections;
    return null;
  }
  async function query(sql, params = []){
    const text = norm(sql);
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows:[], rowCount:0 };
    if (text.includes('INSERT INTO maintenance_counters')) {
      const name = params[0];
      db.counters[name] = (db.counters[name] || 0) + 1;
      return { rows:[{ value:db.counters[name] }], rowCount:1 };
    }
    if (text.startsWith('INSERT INTO')) {
      const statement = text.split(/\s+ON CONFLICT/i)[0];
      const match = statement.match(/^INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\((.+)\)(?:\s+RETURNING \*)?$/i);
      if (!match) throw new Error('unparsed insert: ' + text);
      const rows = table(match[1]);
      const columns = splitList(match[2]);
      const refs = splitList(match[3]);
      const row = { row_version:1, deleted_at:null, created_at:new Date().toISOString() };
      columns.forEach((column, index) => { row[column] = valueOf(refs[index], params); });
      if (match[1] === 'work_order_assets' && rows.some(item => item.work_order_id === row.work_order_id && item.asset_id === row.asset_id && item.relation_type === row.relation_type)) {
        return { rows:[], rowCount:0 };
      }
      rows.push(row);
      return { rows:text.includes('RETURNING') ? [{ ...row }] : [], rowCount:1 };
    }
    if (text.startsWith('UPDATE')) {
      const match = text.match(/^UPDATE (\w+) SET (.+) WHERE id=\$1 AND row_version=\$2/i);
      if (!match) throw new Error('unparsed update: ' + text);
      const rows = table(match[1]);
      const current = rows.find(item => item.id === params[0] && !item.deleted_at);
      if (!current || Number(current.row_version) !== Number(params[1])) return { rows:[], rowCount:0 };
      splitList(match[2]).forEach(assignment => {
        const eq = assignment.indexOf('=');
        const column = assignment.slice(0, eq).trim();
        const token = assignment.slice(eq + 1).trim();
        if (column === 'row_version') return;
        if (token.startsWith('$') || token === 'now()' || token.startsWith("'") || token.includes('::jsonb') || /^-?\d/.test(token)) current[column] = valueOf(token, params);
      });
      current.row_version = Number(current.row_version) + 1;
      current.updated_at = new Date().toISOString();
      return { rows:[{ ...current }], rowCount:1 };
    }
    if (text.includes('FROM work_order_parts')) return { rows: [] };
    if (text.includes('FROM assets WHERE id=$1')) {
      return { rows:db.assets.filter(item => item.id === params[0]) };
    }
    if (text.includes('factory_asset_id')) return { rows:db.assets.filter(item => item.id === params[0]).map(item => ({ factory_asset_id:item.factory_asset_id })) };
    if (text.includes('FROM users WHERE id=$1')) return { rows:db.users.filter(item => item.id === params[0] && item.active).map(item => ({ id:item.id })) };
    if (text.includes('FROM users u WHERE u.active=true')) return { rows:db.users.filter(item => item.active).map(item => ({ ...item })) };
    if (text.includes('SELECT * FROM')) {
      const tableName = text.match(/FROM (\w+)/)[1];
      return { rows:table(tableName).filter(item => item.id === params[0]).map(item => ({ ...item })) };
    }
    if (text.includes('count(*)::int AS linked')) {
      return { rows:[{ linked:db.work_orders.filter(item => item.req_id === params[0] && !item.deleted_at).length }] };
    }
    const decorate = item => ({ ...item, equipment_id:item.asset_id, equipment_code:item.asset_id ? 'P-01' : null, equipment_name:item.asset_id ? 'پمپ انتقال' : null });
    if (text.includes('FROM requests r') || text.includes('FROM requests WHERE asset_id')) {
      const byId = text.includes('WHERE r.id=$1');
      const rows = db.requests.filter(item => !item.deleted_at && (byId ? item.id === params[0] : (!params[0] || item.asset_id === params[0])));
      return { rows:rows.map(decorate) };
    }
    if (text.includes('FROM work_orders w') || text.includes('FROM work_orders WHERE asset_id')) {
      const byId = text.includes('WHERE w.id=$1');
      const rows = db.work_orders.filter(item => !item.deleted_at && (byId ? item.id === params[0] : (!params[0] || item.asset_id === params[0])));
      return { rows:rows.map(decorate) };
    }
    if (text.includes('FROM pm_plans p') || text.includes('FROM pm_plans WHERE asset_id')) {
      const byId = text.includes('WHERE p.id=$1');
      const rows = db.pm_plans.filter(item => !item.deleted_at && (byId ? item.id === params[0] : (!params[0] || item.asset_id === params[0])));
      return { rows:rows.map(decorate) };
    }
    throw new Error('unexpected sql: ' + text);
  }
  return { db, query, async connect(){ return { query, release(){} }; } };
}

test('workflow rejects illegal status changes and preserves executed work orders', () => {
  assert.throws(() => service.assertTransition(service.WORK_ORDER_FLOW, 'open', 'closed'), error => error.code === 'INVALID_STATUS_TRANSITION');
  assert.doesNotThrow(() => service.assertTransition(service.WORK_ORDER_FLOW, 'doing', 'done'));
  assert.equal(service.hasExecutionHistory({ times:{ start:'2026-10-04T00:00:00Z' }, report:{}, parts:[] }), true);
  assert.equal(service.hasExecutionHistory({ times:{}, report:{}, parts:[] }), false);
  assert.equal(service.LOCKED_WORK_ORDER.has('closed'), true);
  assert.equal(service.isRecipientAllowed({ role:'op', permissions:['request.create'], scopes:[] }, 'work_order.view', 'eq-1', 'factory-1'), false);
  assert.equal(service.isRecipientAllowed({ role:'tech', permissions:['work_order.view'], scopes:[{ scope_type:'factory', scope_id:'other' }] }, 'work_order.view', 'eq-1', 'factory-1'), false);
  assert.equal(service.isRecipientAllowed({ role:'mgr', permissions:['work_order.view'], scopes:[] }, 'work_order.view', 'eq-1', 'factory-1'), false);
  assert.equal(service.isRecipientAllowed({ role:'mgr', permissions:['work_order.view'], scopes:[] }, 'work_order.view', null, null), false);
  assert.equal(service.isRecipientAllowed({ role:'admin', permissions:[], scopes:[] }, 'work_order.view', 'eq-1', 'factory-1'), true);
  assert.equal(service.isRecipientAllowed({ role:'mgr', permissions:['work_order.view'], scopes:[{ scope_type:'company', scope_id:'co-1' }] }, 'work_order.view', null, null), true);
  assert.equal(service.isRecipientAllowed({ role:'tech', permissions:['work_order.view'], scopes:[{ scope_type:'equipment', scope_id:'eq-1' }] }, 'work_order.view', 'eq-1', 'factory-1'), true);
});

test('request, work order and PM stay linked to the same equipment in both directions', async () => {
  const pool = memoryPool();
  const request = await service.createRequest(pool, user, { descr:'نشتی پمپ', assetId:'eq-1', urgency:'high', type:'repair' });
  const plan = await service.createPmPlan(pool, user, { title:'بازدید پمپ', assetId:'eq-1', interval:30, checklist:['نشتی'] });
  const approved = await service.approveRequest(pool, user, request.id, { rowVersion:request.rowVersion, priority:'high' });
  const links = await service.equipmentLinks(pool, 'eq-1');
  assert.equal(links.equipment.id, 'eq-1');
  assert.equal(links.requests.some(item => item.id === request.id), true);
  assert.equal(links.pmPlans.some(item => item.id === plan.id), true);
  assert.equal(links.workOrders.some(item => item.id === approved.workOrder.id), true);
  const storedRequest = await service.getRequest(pool, request.id);
  const storedOrder = await service.getWorkOrder(pool, approved.workOrder.id);
  const storedPlan = await service.getPmPlan(pool, plan.id);
  assert.equal(storedRequest.assetId, 'eq-1');
  assert.equal(storedRequest.equipment.id, 'eq-1');
  assert.equal(storedRequest.workOrderId, approved.workOrder.id);
  assert.equal(storedOrder.assetId, 'eq-1');
  assert.equal(storedOrder.reqId, request.id);
  assert.equal(storedOrder.equipment.name, 'پمپ انتقال');
  assert.equal(storedPlan.assetId, 'eq-1');
  assert.equal(pool.db.work_order_assets.some(link => link.work_order_id === approved.workOrder.id && link.asset_id === 'eq-1'), true);
  const allowed = ['u-admin', 'u-company', 'u-factory'];
  const denied = ['u-empty', 'u-op', 'u-other'];
  assert.equal(pool.db.event_outbox.every(event => {
    const recipients = JSON.parse(event.recipient_ids);
    return allowed.every(id => recipients.includes(id)) && denied.every(id => !recipients.includes(id));
  }), true);
  const bare = await service.createRequest(pool, user, { descr:'درخواست بدون تجهیز' });
  const bareEvent = pool.db.event_outbox.find(event => event.event_type === 'request.created' && JSON.parse(event.payload).id === bare.id);
  assert.deepEqual(JSON.parse(bareEvent.recipient_ids).sort(), ['u-admin', 'u-company']);
  assert.equal(pool.db.audit_x.length > 0, true);
});

test('a PTW requirement on a source request remains pending when legacy approval omits a choice', async () => {
  const pool=memoryPool();
  const request=await service.createRequest(pool,user,{descr:'کار پرخطر روی پمپ',assetId:'eq-1',form:{ptwRequired:true}});
  const approved=await service.approveRequest(pool,user,request.id,{rowVersion:request.rowVersion});
  assert.equal(approved.workOrder.ptw,true);
  assert.equal(approved.workOrder.permitStatus,'pending_issuance');
  assert.equal(approved.workOrder.ptwId,null);
  await assert.rejects(
    ()=>service.updateWorkOrder(pool,user,approved.workOrder.id,{rowVersion:approved.workOrder.rowVersion,ptw:false}),
    error=>error.code==='PTW_REQUIREMENT_CANNOT_BE_REMOVED'
  );
});

test('executed work order is cancelled instead of deleted and closed rows need a correction', async () => {
  const pool = memoryPool();
  const plan = await service.createPmPlan(pool, user, { title:'بازدید پمپ', assetId:'eq-1', interval:30 });
  const created = await service.createWorkOrder(pool, user, { descr:'تعویض سیل', assetId:'eq-1', type:'CM', assignee:'u-tech', pmId:plan.id });
  assert.equal(created.status, 'assigned');
  assert.equal(created.pmId, plan.id);
  const started = await service.transitionWorkOrder(pool, user, created.id, { rowVersion:created.rowVersion, status:'doing' });
  await assert.rejects(() => service.archiveWorkOrder(pool, user, created.id, { rowVersion:started.rowVersion, reason:'اشتباه' }), error => error.code === 'EXECUTED_WORK_ORDER_CANNOT_BE_ARCHIVED');
  assert.equal(pool.db.work_orders[0].deleted_at, null);
  const cancelled = await service.cancelWorkOrder(pool, user, created.id, { rowVersion:started.rowVersion, reason:'قطعه نرسید' });
  assert.equal(cancelled.status, 'cancel');
  assert.equal(pool.db.work_orders.length, 1);
  assert.equal(JSON.parse(pool.db.work_orders[0].times).start != null, true);

  const another = await service.createWorkOrder(pool, user, { descr:'تنظیم کوپلینگ', assetId:'eq-1', assignee:'u-tech' });
  const doing = await service.transitionWorkOrder(pool, user, another.id, { rowVersion:another.rowVersion, status:'doing' });
  const done = await service.transitionWorkOrder(pool, user, another.id, { rowVersion:doing.rowVersion, status:'done', report:{ text:'انجام شد' } });
  await assert.rejects(() => service.cancelWorkOrder(pool, user, another.id, { rowVersion:done.rowVersion, reason:'لغو پس از انجام' }), error => error.code === 'RECORD_LOCKED');
  const closed = await service.transitionWorkOrder(pool, user, another.id, { rowVersion:done.rowVersion, status:'closed' });
  await assert.rejects(() => service.updateWorkOrder(pool, user, another.id, { rowVersion:closed.rowVersion, descr:'بازنویسی مستقیم' }), error => error.code === 'RECORD_LOCKED');
  const corrected = await service.correctRecord(pool, user, 'work_order', another.id, { rowVersion:closed.rowVersion, reason:'اصلاح شرح پس از تأیید', patch:{ descr:'شرح اصلاح‌شده', status:'open' } });
  assert.equal(corrected.status, 'closed');
  assert.equal(corrected.desc, 'شرح اصلاح‌شده');
  assert.equal(pool.db.corrections.length, 1);
  const fresh = await service.createWorkOrder(pool, user, { descr:'نسخه کهنه', assetId:'eq-1' });
  await assert.rejects(() => service.updateWorkOrder(pool, user, fresh.id, { rowVersion:fresh.rowVersion + 4, descr:'ویرایش همزمان' }), error => error.code === 'VERSION_CONFLICT');
});

test('maintenance routes enforce permission before writing and do not broadcast globally', async () => {
  let connected = false;
  const app = express();
  app.use(express.json());
  app.use('/api', createMaintenanceRouter({
    pool:{ async connect(){ connected = true; throw new Error('should not connect'); } },
    security:{
      authenticateToken(req, _res, next){ req.user = { id:'u-tech', role:'tech', name:'تکنسین' }; next(); },
      authorize(permission){ return (_req, res, next) => permission === 'work_order.view' ? next() : res.status(403).json({ error:'PERMISSION_DENIED', permission }); },
      async hasPermission(){ return false; }
    }
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/work-orders`, {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ descr:'نباید نوشته شود' })
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'PERMISSION_DENIED');
    assert.equal(connected, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  const routes = read('server/maintenance-routes.js');
  const domain = read('server/maintenance-service.js');
  assert.doesNotMatch(routes, /io\.emit/);
  assert.doesNotMatch(domain, /DELETE FROM (requests|work_orders|pm_plans)/i);
  assert.match(domain, /event_outbox/);
  assert.match(domain, /INSERT INTO audit_x/);
  assert.match(domain, /row_version/);
});

test('migration and client keep maintenance records on the central server', () => {
  const migration = read('migrations/007_maintenance_workflow.sql');
  const schema = read('schema.sql');
  const client = read('public/platform-v2/maintenance-client.js');
  const server = read('server.js');
  for (const table of ['maintenance_counters', 'maintenance_corrections']) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.doesNotMatch(migration, /\b(DROP|TRUNCATE|DELETE FROM)\b/i);
  assert.match(server, /USE_MAINTENANCE_API/);
  assert.match(server, /createMaintenanceRouter/);
  assert.doesNotMatch(server, /INSERT INTO work_orders/);
  assert.doesNotMatch(server, /SELECT \* FROM work_orders/);
  assert.match(client, /\/api\/requests/);
  assert.match(client, /\/api\/work-orders/);
  assert.match(client, /\/api\/pm-plans/);
  assert.match(client, /LOCAL_MAINTENANCE_WRITE_BLOCKED/);
  assert.doesNotMatch(client, /localStorage\.setItem/);
  assert.doesNotMatch(client, /importBespar|seed\(\)/);
  assert.match(read('public/index.html'), /maintenance-client\.js/);
});
