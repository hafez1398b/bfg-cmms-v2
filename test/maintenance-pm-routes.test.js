'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const service = require('../server/maintenance-service');
const { createMaintenanceRouter } = require('../server/maintenance-routes');

const root = path.join(__dirname, '..');
const USER = { id:'route-user', name:'Route tester', username:'route-test', role:'mgr' };
const AS_OF = '2026-10-28T12:00:00.000Z';

function clone(value) { return structuredClone(value); }

function makeSecurity(permissions = [], authenticated = true) {
  const grants = new Set(permissions);
  return {
    authenticateToken(req, res, next) {
      if (!authenticated || req.get('authorization') !== 'Bearer test-token') {
        return res.status(401).json({ error:'AUTHENTICATION_REQUIRED' });
      }
      req.user = { ...USER };
      return next();
    },
    authorize(permission) {
      return (req, res, next) => grants.has(permission)
        ? next()
        : res.status(403).json({ error:'PERMISSION_DENIED', permission });
    },
    async hasPermission(_user, permission) { return grants.has(permission); }
  };
}

async function withApi(pool, permissions, run, authenticated = true) {
  const app = express();
  app.use(express.json());
  app.use('/api', createMaintenanceRouter({ pool, security:makeSecurity(permissions, authenticated) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}/api`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function requestOptions(method = 'GET', body) {
  return {
    method,
    headers:{ authorization:'Bearer test-token', ...(body === undefined ? {} : { 'content-type':'application/json' }) },
    ...(body === undefined ? {} : { body:JSON.stringify(body) })
  };
}

async function withServiceStub(name, implementation, work) {
  const original = service[name];
  service[name] = implementation;
  try { await work(); } finally { service[name] = original; }
}

function coded(status, code) {
  return Object.assign(new Error(code), { status, code });
}

function makeScopePool() {
  const plans = [
    { id:'plan-in', asset_id:'asset-1', title:'Scoped plan', code:'PM-1', status:'active', row_version:1,
      archived_at:null, deleted_at:null, schedule_basis:'calendar', interval_days:30,
      first_due_at:'2026-10-30T00:00:00.000Z', next_due_at:'2026-10-30T00:00:00.000Z',
      last_run:null, last_completed_at:null, tolerance_days:1 },
    { id:'plan-out', asset_id:'asset-2', title:'Out of scope', code:'PM-2', status:'active', row_version:1,
      archived_at:null, deleted_at:null, schedule_basis:'calendar', interval_days:30,
      first_due_at:'2026-10-30T00:00:00.000Z', next_due_at:'2026-10-30T00:00:00.000Z',
      last_run:null, last_completed_at:null, tolerance_days:1 }
  ];
  const occurrences = [
    { id:'occ-in', pm_plan_id:'plan-in', equipment_id:'asset-1', period_key:'calendar:2026-10-30',
      due_at:'2026-10-30T00:00:00.000Z', status:'scheduled', row_version:1, completed_at:null },
    { id:'occ-out', pm_plan_id:'plan-out', equipment_id:'asset-2', period_key:'calendar:2026-10-30',
      due_at:'2026-10-30T00:00:00.000Z', status:'scheduled', row_version:1, completed_at:null }
  ];
  const state = { plans, occurrences, writes:0, occurrenceInserts:0, audits:0, outbox:0 };
  const scopes = [{ scope_type:'equipment', scope_id:'asset-1' }];
  function asset(id) {
    return id === 'asset-1' ? { id, code:'EQ-1', name:'Equipment 1', deleted_at:null } :
      id === 'asset-2' ? { id, code:'EQ-2', name:'Equipment 2', deleted_at:null } : null;
  }
  async function query(sql, values = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (['BEGIN','COMMIT','ROLLBACK'].includes(text)) return { rows:[] };
    if (text === 'SELECT id, code, name, deleted_at FROM assets WHERE id=$1') return { rows:[asset(values[0])].filter(Boolean) };
    if (text.startsWith('SELECT scope_type,scope_id FROM user_scopes')) return { rows:clone(scopes) };
    if (text.startsWith('WITH RECURSIVE ancestors')) return { rows:[{ factory_asset_id:values[0] === 'asset-1' ? 'factory-1' : 'factory-2' }] };
    if (text.startsWith('SELECT * FROM pm_plans WHERE id=$1 FOR UPDATE')) return { rows:plans.filter(row => row.id === values[0]).map(clone) };
    if (text.startsWith('SELECT pm_plan_id FROM pm_occurrences WHERE id=$1')) return { rows:occurrences.filter(row => row.id === values[0]).map(row => ({ pm_plan_id:row.pm_plan_id })) };
    if (text.startsWith('SELECT * FROM pm_occurrences WHERE id=$1 AND pm_plan_id=$2 FOR UPDATE')) {
      return { rows:occurrences.filter(row => row.id === values[0] && row.pm_plan_id === values[1]).map(clone) };
    }
    if (text.startsWith('SELECT * FROM pm_occurrences WHERE id=$1 FOR UPDATE')) return { rows:occurrences.filter(row => row.id === values[0]).map(clone) };
    if (text.startsWith('SELECT o.*, w.id AS linked_work_order_id')) {
      return { rows:occurrences.filter(row => row.pm_plan_id === values[0]
        && (!text.includes('o.period_key=$2') || row.period_key === values[1])).map(row => ({ ...clone(row), linked_work_order_id:null })) };
    }
    if (text.startsWith('SELECT u.id, u.role,')) return { rows:[] };
    if (text.startsWith('INSERT INTO pm_occurrences')) {
      state.writes += 1;
      state.occurrenceInserts += 1;
      const row = { id:values[0], pm_plan_id:values[1], equipment_id:values[2], period_key:values[3],
        due_at:values[4], status:values[5], provenance_status:'verified', row_version:1,
        created_by:values[6], updated_by:values[6], linked_work_order_id:null };
      occurrences.push(row);
      return { rows:[clone(row)] };
    }
    if (text.startsWith('UPDATE pm_occurrences SET status=$3')) {
      state.writes += 1;
      const row = occurrences.find(item => item.id === values[0] && Number(item.row_version) === Number(values[1]));
      if (!row) return { rows:[] };
      row.status = values[2];
      row.updated_by = values[3];
      row.row_version += 1;
      return { rows:[clone(row)] };
    }
    if (text.startsWith('INSERT INTO audit_x')) { state.writes += 1; state.audits += 1; return { rows:[] }; }
    if (text.startsWith('INSERT INTO event_outbox')) { state.writes += 1; state.outbox += 1; return { rows:[] }; }
    if (text.startsWith('SELECT p.*, a.id AS equipment_id')) {
      const single = text.includes('WHERE p.id=$1');
      const includeArchived = single ? values[1] === true : values[0] === true;
      const selectedPlans = plans.filter(row => (includeArchived || (!row.archived_at && !row.deleted_at))
        && (single ? row.id === values[0] : (!values[1] || row.asset_id === values[1])));
      return { rows:selectedPlans.map(row => ({
        ...clone(row), equipment_id:row.asset_id, equipment_code:row.asset_id === 'asset-1' ? 'EQ-1' : 'EQ-2',
        equipment_name:row.asset_id === 'asset-1' ? 'Equipment 1' : 'Equipment 2'
      })) };
    }
    if (text.startsWith('SELECT o.*, p.asset_id AS plan_asset_id')) {
      const [occurrenceId, planId, includeArchived] = values;
      const occurrence = occurrences.find(row => row.id === occurrenceId && row.pm_plan_id === planId);
      const plan = plans.find(row => row.id === planId);
      if (!occurrence || !plan || (!includeArchived && (plan.archived_at || plan.deleted_at))) return { rows:[] };
      return { rows:[{ ...clone(occurrence), plan_asset_id:plan.asset_id, linked_work_order_id:null }] };
    }
    if (text.startsWith('SELECT o.*, w.id AS linked_work_order_id')) {
      return { rows:occurrences.filter(row => row.pm_plan_id === values[0]).map(row => ({ ...clone(row), linked_work_order_id:null })) };
    }
    if (text.startsWith('INSERT') || text.startsWith('UPDATE') || text.startsWith('DELETE')) state.writes += 1;
    throw new Error(`Unexpected scope-pool query: ${text}`);
  }
  const client = { query, release() {} };
  const pool = { query, async connect() { return client; } };
  return { pool, state };
}

test('PM Route authentication and pm.view permission are enforced before Service calls', async () => {
  const pool = { async query() { throw new Error('must not reach database'); }, async connect() { throw new Error('must not reach database'); } };
  await withServiceStub('listPmPlans', async () => { throw new Error('service must not run'); }, async () => {
    await withApi(pool, ['pm.view'], async base => {
      const response = await fetch(`${base}/pm-plans`);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, 'AUTHENTICATION_REQUIRED');
    }, false);
    await withApi(pool, [], async base => {
      const response = await fetch(`${base}/pm-plans`, requestOptions());
      assert.equal(response.status, 403);
      assert.equal((await response.json()).permission, 'pm.view');
    });
  });
});

test('PM Routes require pm.schedule and pm.restore, and ignore client-supplied actor/equipment identity', async () => {
  const pool = {};
  const calls = [];
  await withServiceStub('createPmOccurrence', async (...args) => { calls.push(['createPmOccurrence', ...args]); return { occurrence:{ id:'occ-1' }, idempotentReplay:true }; }, async () => {
    await withApi(pool, ['pm.view'], async base => {
      const response = await fetch(`${base}/pm-plans/plan-1/occurrences`, requestOptions('POST', { rowVersion:4, evaluatedAt:AS_OF, equipmentId:'forged-equipment', created_by:'forged-user' }));
      assert.equal(response.status, 403);
    });
    await withApi(pool, ['pm.view','pm.schedule'], async base => {
      const body = { rowVersion:4, evaluatedAt:AS_OF, periodKey:'calendar:2026-10-30', equipmentId:'forged-equipment', created_by:'forged-user' };
      const response = await fetch(`${base}/pm-plans/plan-1/occurrences`, requestOptions('POST', body));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { data:{ occurrence:{ id:'occ-1' }, idempotentReplay:true } });
    });
  });
  const createCall = calls[0];
  assert.equal(createCall[2].id, USER.id);
  assert.equal(createCall[3], 'plan-1');
  assert.deepEqual(createCall[4], { rowVersion:4, evaluatedAt:AS_OF, periodKey:'calendar:2026-10-30' });

  await withServiceStub('restorePmPlan', async (...args) => { calls.push(['restorePmPlan', ...args]); return { restored:true }; }, async () => {
    await withApi(pool, ['pm.view'], async base => {
      const response = await fetch(`${base}/pm-plans/plan-1/restore`, requestOptions('POST', { rowVersion:7, archived_by:'forged-user', created_by:'forged-user' }));
      assert.equal(response.status, 403);
    });
    await withApi(pool, ['pm.restore'], async base => {
      const response = await fetch(`${base}/pm-plans/plan-1/restore`, requestOptions('POST', { rowVersion:7, archived_by:'forged-user', auditUser:'forged-user' }));
      assert.equal(response.status, 200);
    });
  });
  const restoreCall = calls.find(call => call[0] === 'restorePmPlan');
  assert.equal(restoreCall[2].id, USER.id);
  assert.equal(restoreCall[3], 'plan-1');
  assert.deepEqual(restoreCall[4], { rowVersion:7 });
});

test('includeArchived requires pm.restore in addition to pm.view', async () => {
  const calls = [];
  await withServiceStub('listPmPlans', async (...args) => { calls.push(args); return []; }, async () => {
    await withApi({}, ['pm.view'], async base => {
      const response = await fetch(`${base}/pm-plans?includeArchived=true`, requestOptions());
      assert.equal(response.status, 403);
      assert.equal((await response.json()).permission, 'pm.restore');
    });
    await withApi({}, ['pm.view','pm.restore'], async base => {
      const response = await fetch(`${base}/pm-plans?includeArchived=true`, requestOptions());
      assert.equal(response.status, 200);
    });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].id, USER.id);
  assert.equal(calls[0][2].includeArchived, true);
});

test('PM permission matrix preserves view/create/edit/archive/cancel/generate/correct grants', async () => {
  const cases = [
    ['GET','/pm-plans','pm.view','listPmPlans'],
    ['GET','/pm-plans/plan-1','pm.view','getPmPlan'],
    ['POST','/pm-plans','pm.create','createPmPlan'],
    ['PATCH','/pm-plans/plan-1','pm.edit','updatePmPlan'],
    ['POST','/pm-plans/plan-1/archive','pm.archive','archivePmPlan'],
    ['POST','/pm-plans/plan-1/cancel','pm.cancel','cancelPmPlan'],
    ['POST','/pm-plans/plan-1/generate-work-order','pm.generate','generatePmWorkOrder'],
    ['POST','/pm-plans/plan-1/corrections','pm.correct','correctRecord'],
    ['GET','/pm-plans/plan-1/due','pm.schedule','getPmDue'],
    ['GET','/pm-plans/plan-1/occurrences','pm.view','listPmOccurrences'],
    ['GET','/pm-plans/plan-1/occurrences/occ-1','pm.view','getPmOccurrence'],
    ['PATCH','/pm-plans/plan-1/occurrences/occ-1/due-status','pm.schedule','updatePmOccurrenceDueStatus'],
    ['POST','/pm-plans/plan-1/restore','pm.restore','restorePmPlan']
  ];
  for (const [method,pathName,permission,serviceName] of cases) {
    await withServiceStub(serviceName, async () => ({ ok:true }), async () => {
      await withApi({}, [], async base => {
        const response = await fetch(`${base}${pathName}`, method === 'GET' ? requestOptions(method) : requestOptions(method, {}));
        assert.equal(response.status, 403, `${method} ${pathName} must require ${permission}`);
        assert.equal((await response.json()).permission, permission);
      });
    });
  }
});

test('Service enforces equipment scope for Plan and Occurrence reads/writes and filters lists', async () => {
  const { pool, state } = makeScopePool();
  const user = { id:USER.id, role:'mgr' };
  const visible = await service.listPmPlans(pool, user);
  assert.deepEqual(visible.map(row => row.id), ['plan-in']);
  assert.equal((await service.getPmPlan(pool, user, 'plan-in')).id, 'plan-in');
  await assert.rejects(service.getPmPlan(pool, user, 'plan-out'), error => error.code === 'EQUIPMENT_SCOPE_DENIED');
  state.plans[0].archived_at = '2026-10-01T00:00:00.000Z';
  state.plans[0].deleted_at = state.plans[0].archived_at;
  assert.deepEqual(await service.listPmPlans(pool, user), []);
  assert.deepEqual((await service.listPmPlans(pool, user, { includeArchived:true })).map(row => row.id), ['plan-in']);
  state.plans[0].archived_at = null;
  state.plans[0].deleted_at = null;
  await assert.rejects(service.getPmDue(pool, user, 'plan-out', { evaluatedAt:AS_OF }), error => error.code === 'EQUIPMENT_SCOPE_DENIED');
  await assert.rejects(service.listPmOccurrences(pool, user, 'plan-out'), error => error.code === 'EQUIPMENT_SCOPE_DENIED');
  await assert.rejects(service.getPmOccurrence(pool, user, 'plan-out', 'occ-out'), error => error.code === 'EQUIPMENT_SCOPE_DENIED');

  const writeAttempts = [
    () => service.createPmPlan(pool, user, { title:'Out of scope', assetId:'asset-2', intervalDays:30 }),
    () => service.updatePmPlan(pool, user, 'plan-out', { rowVersion:1, title:'Edited' }),
    () => service.archivePmPlan(pool, user, 'plan-out', { rowVersion:1, reason:'Archive' }),
    () => service.restorePmPlan(pool, user, 'plan-out', { rowVersion:1 }),
    () => service.cancelPmPlan(pool, user, 'plan-out', { rowVersion:1, reason:'Cancel' }),
    () => service.generatePmWorkOrder(pool, user, 'plan-out', { rowVersion:1 }),
    () => service.correctRecord(pool, user, 'pm_plan', 'plan-out', { rowVersion:1, reason:'Correction', patch:{ title:'Corrected' } }),
    () => service.createPmOccurrence(pool, user, 'plan-out', { rowVersion:1, evaluatedAt:AS_OF }),
    () => service.updatePmOccurrenceDueStatus(pool, user, 'plan-out', 'occ-out', { rowVersion:1, evaluatedAt:AS_OF })
  ];
  for (const attempt of writeAttempts) {
    await assert.rejects(attempt, error => error.code === 'EQUIPMENT_SCOPE_DENIED');
  }
  assert.equal(state.writes, 0);
});

test('Plan asset moves require both old and new Equipment scopes', async () => {
  const { pool, state } = makeScopePool();
  await assert.rejects(
    service.updatePmPlan(pool, { id:USER.id, role:'mgr' }, 'plan-in', { rowVersion:1, assetId:'asset-2', title:'Move' }),
    error => error.code === 'EQUIPMENT_SCOPE_DENIED'
  );
  assert.equal(state.writes, 0);
});

test('Explicit occurrence creation is idempotent; due evaluation is Service-only and terminal states stay immutable', async () => {
  const { pool, state } = makeScopePool();
  const user = { id:USER.id, role:'mgr' };
  const due = await service.getPmDue(pool, user, 'plan-in', { evaluatedAt:AS_OF });
  assert.equal(due.dueStatus, 'scheduled');
  await assert.rejects(service.getPmDue(pool, user, 'plan-in', { asOf:AS_OF }), error => error.code === 'PM_EVALUATED_AT_REQUIRED');
  await assert.rejects(service.getPmDue(pool, user, 'plan-in', { evaluatedAt:'not-a-date' }), error => error.code === 'PM_EVALUATED_AT_INVALID');
  assert.equal(state.writes, 0, 'a due read must not insert or mutate Occurrences');
  state.occurrences.splice(0, state.occurrences.length, ...state.occurrences.filter(row => row.id !== 'occ-in'));

  const input = { rowVersion:1, evaluatedAt:AS_OF, periodKey:'calendar:2026-10-30' };
  const created = await service.createPmOccurrence(pool, user, 'plan-in', input);
  const replay = await service.createPmOccurrence(pool, user, 'plan-in', input);
  assert.equal(created.idempotentReplay, false);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(created.occurrence.id, replay.occurrence.id);
  assert.equal(created.occurrence.equipmentId, 'asset-1', 'Equipment is resolved from the Plan, not the request');
  assert.equal(state.occurrenceInserts, 1);
  assert.equal(state.audits, 1, 'an idempotent retry must not create a second audit');
  assert.equal(state.outbox, 1, 'an idempotent retry must not emit a second event');

  const evaluated = await service.updatePmOccurrenceDueStatus(pool, user, 'plan-in', created.occurrence.id,
    { rowVersion:1, evaluatedAt:'2026-11-02T12:00:00.000Z' });
  assert.equal(evaluated.occurrence.status, 'overdue');
  const auditCount = state.audits;
  const eventCount = state.outbox;
  const writes = state.writes;
  const reevaluation = await service.updatePmOccurrenceDueStatus(pool, user, 'plan-in', created.occurrence.id,
    { rowVersion:2, evaluatedAt:'2026-11-02T12:00:00.000Z' });
  assert.equal(reevaluation.idempotentReplay, true);
  assert.equal(state.audits, auditCount);
  assert.equal(state.outbox, eventCount);
  assert.equal(state.writes, writes);

  state.occurrences.find(row => row.id === created.occurrence.id).status = 'completed';
  await assert.rejects(service.updatePmOccurrenceDueStatus(pool, user, 'plan-in', created.occurrence.id,
    { rowVersion:2, evaluatedAt:'2026-11-02T12:00:00.000Z' }), error => error.code === 'PM_OCCURRENCE_FINAL');
  assert.equal(state.writes, writes, 'final Occurrence status must not be rewritten');
});

test('Route maps Domain conflicts and not-found distinctly, and does not contain SQL', async () => {
  await withServiceStub('restorePmPlan', async () => { throw coded(409, 'PM_CODE_CONFLICT'); }, async () => {
    await withApi({}, ['pm.restore'], async base => {
      const response = await fetch(`${base}/pm-plans/p/restore`, requestOptions('POST', { rowVersion:2 }));
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, 'PM_CODE_CONFLICT');
    });
  });
  await withServiceStub('getPmPlan', async () => { throw coded(404, 'RECORD_NOT_FOUND'); }, async () => {
    await withApi({}, ['pm.view'], async base => {
      const response = await fetch(`${base}/pm-plans/missing`, requestOptions());
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error, 'RECORD_NOT_FOUND');
    });
  });
  const routes = fs.readFileSync(path.join(root, 'server/maintenance-routes.js'), 'utf8');
  const pmRoutes = routes.slice(routes.indexOf("router.get('/pm-plans'"), routes.indexOf("router.get('/maintenance/equipment"));
  assert.doesNotMatch(pmRoutes, /\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i);
});

test('Due reads are Service-backed and occurrence route retry response stays idempotent', async () => {
  const calls = [];
  await withServiceStub('getPmDue', async (...args) => {
    calls.push(args);
    return { nextDueAt:null, dueStatus:'insufficient_data', reason:'first_or_next_due_at_missing', evaluatedAt:AS_OF };
  }, async () => {
    await withApi({}, ['pm.schedule'], async base => {
      const response = await fetch(`${base}/pm-plans/plan-1/due?evaluatedAt=${encodeURIComponent(AS_OF)}`, requestOptions());
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.data.dueStatus, 'insufficient_data');
      assert.equal(body.data.reason, 'first_or_next_due_at_missing');
    });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].id, USER.id);
  assert.equal(calls[0][3].evaluatedAt, AS_OF);

  await withServiceStub('generatePmWorkOrder', async () => ({ workOrder:{ id:'wo-1' }, idempotentReplay:true }), async () => {
    await withApi({}, ['pm.generate'], async base => {
      const first = await fetch(`${base}/pm-plans/p/generate-work-order`, requestOptions('POST', { rowVersion:1 }));
      const retry = await fetch(`${base}/pm-plans/p/generate-work-order`, requestOptions('POST', { rowVersion:1 }));
      assert.equal(first.status, 200);
      const firstBody = await first.json();
      const retryBody = await retry.json();
      assert.deepEqual(firstBody, retryBody);
      assert.equal(retryBody.data.idempotentReplay, true);
    });
  });
});
