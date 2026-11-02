'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../server/maintenance-service');

const STARTED_AT = '2026-10-28T07:30:00.000Z';
const GENERATED_AT = '2026-10-27T11:00:00.000Z';
const clone = value => structuredClone(value);

// Entirely in-memory Test fixture: no database connection, operational seed, or persisted records.
function createTransitionFixture(overrides = {}) {
  const state = {
    plan: {
      id:'plan-b3', asset_id:'asset-b3', schedule_basis:'calendar', interval_days:30, tolerance_days:2,
      first_due_at:'2026-10-20T00:00:00.000Z', next_due_at:'2026-10-20T00:00:00.000Z',
      last_completed_at:null, last_run:'2019-01-01T00:00:00.000Z', row_version:10, status:'active', deleted_at:null
    },
    occurrence: {
      id:'occurrence-b3', pm_plan_id:'plan-b3', equipment_id:'asset-b3',
      period_key:'calendar:2026-10-20', due_at:'2026-10-20T00:00:00.000Z',
      status:'work_order_generated', generated_at:GENERATED_AT, started_at:null,
      completed_at:null, completion_source:null, row_version:4, updated_by:'user-b3'
    },
    workOrder: {
      id:'wo-b3', no:'WO-TEST-B3', type:'PM', asset_id:'asset-b3', pm_id:'plan-b3', occurrence_id:'occurrence-b3',
      descr:'PM test fixture', priority:'normal', assignee:null, status:'assigned', row_version:7,
      times:{}, report:{}, ptw:false, permit_status:'not_required', deleted_at:null
    },
    audits:[], events:[], rollbacks:0, occurrenceInserts:0, workOrderInserts:0,
    failPlanUpdate:false, transactionSnapshot:null
  };
  Object.assign(state.plan, overrides.plan || {});
  Object.assign(state.occurrence, overrides.occurrence || {});
  const baseTimes = state.workOrder.times;
  const baseReport = state.workOrder.report;
  Object.assign(state.workOrder, overrides.workOrder || {});
  if (overrides.workOrder?.times) state.workOrder.times = { ...baseTimes, ...overrides.workOrder.times };
  if (overrides.workOrder?.report) state.workOrder.report = { ...baseReport, ...overrides.workOrder.report };
  state.failPlanUpdate = overrides.failPlanUpdate === true;

  const client = {
    async query(sql, values = []) {
      const query = sql.trim();
      if (query === 'BEGIN') {
        state.transactionSnapshot = {
          plan:clone(state.plan), occurrence:clone(state.occurrence), workOrder:clone(state.workOrder),
          audits:clone(state.audits), events:clone(state.events)
        };
        return { rows:[] };
      }
      if (query === 'COMMIT') { state.transactionSnapshot = null; return { rows:[] }; }
      if (query === 'ROLLBACK') {
        if (state.transactionSnapshot) Object.assign(state, clone(state.transactionSnapshot));
        state.transactionSnapshot = null;
        state.rollbacks += 1;
        return { rows:[] };
      }
      if (query.startsWith('SELECT * FROM work_orders WHERE id=$1 FOR UPDATE')) {
        return { rows:state.workOrder.id === values[0] ? [state.workOrder] : [] };
      }
      if (query.startsWith('SELECT * FROM pm_plans WHERE id=$1 FOR UPDATE')) {
        return { rows:state.plan.id === values[0] ? [state.plan] : [] };
      }
      if (query.startsWith('SELECT * FROM pm_occurrences WHERE id=$1 FOR UPDATE')) {
        return { rows:state.occurrence.id === values[0] ? [state.occurrence] : [] };
      }
      if (query.startsWith('UPDATE work_orders SET')) {
        const expectedVersion = Number(values[1]);
        if (state.workOrder.id !== values[0] || Number(state.workOrder.row_version) !== expectedVersion) return { rows:[] };
        const setStart = query.indexOf(' SET ') + 5;
        const setEnd = query.indexOf(', updated_at=now()');
        const assignments = query.slice(setStart, setEnd).split(',');
        assignments.forEach((assignment, index) => {
          const field = assignment.split('=')[0].trim();
          let value = values[index + 2];
          if (['times','report','probable_causes','required_parts'].includes(field) && typeof value === 'string') value = JSON.parse(value);
          state.workOrder[field] = value;
        });
        state.workOrder.updated_by = values[values.length - 1];
        state.workOrder.row_version += 1;
        return { rows:[state.workOrder] };
      }
      if (query.startsWith("UPDATE pm_occurrences SET status='in_progress'")) {
        if (Number(state.occurrence.row_version) !== Number(values[1]) || state.occurrence.status !== 'work_order_generated') return { rows:[] };
        Object.assign(state.occurrence, {
          status:'in_progress', started_at:values[2], updated_by:values[3], row_version:state.occurrence.row_version + 1
        });
        return { rows:[state.occurrence] };
      }
      if (query.startsWith("UPDATE pm_occurrences SET status='completed'")) {
        if (Number(state.occurrence.row_version) !== Number(values[1]) || state.occurrence.status !== 'in_progress') return { rows:[] };
        Object.assign(state.occurrence, {
          status:'completed', completed_at:values[2], completion_source:'work_order',
          updated_by:values[3], row_version:state.occurrence.row_version + 1
        });
        return { rows:[state.occurrence] };
      }
      if (query.startsWith('UPDATE pm_plans SET last_completed_at=')) {
        if (state.failPlanUpdate) throw Object.assign(new Error('test-only database failure'), { code:'23514' });
        if (Number(state.plan.row_version) !== Number(values[1])) return { rows:[] };
        Object.assign(state.plan, {
          last_completed_at:values[2], next_due_at:values[3], updated_by:values[4], row_version:state.plan.row_version + 1
        });
        return { rows:[state.plan] };
      }
      if (query.startsWith('INSERT INTO audit_x')) {
        state.audits.push({ action:values[4], module:values[5], entity:values[6], note:values[7] });
        return { rows:[] };
      }
      if (query.startsWith('WITH RECURSIVE ancestors')) return { rows:[{ factory_asset_id:null }] };
      if (query.startsWith('SELECT u.id, u.role')) return { rows:[] };
      if (query.startsWith('INSERT INTO event_outbox')) {
        state.events.push({ type:values[1], aggregateType:values[2], aggregateId:values[3] });
        return { rows:[] };
      }
      if (query.startsWith('INSERT INTO pm_occurrences')) state.occurrenceInserts += 1;
      if (query.startsWith('INSERT INTO work_orders')) state.workOrderInserts += 1;
      throw new Error(`Unexpected in-memory fixture query: ${query}`);
    },
    release() {}
  };
  return { pool:{ connect:async () => client }, state };
}

const user = { id:'user-b3', name:'B3 test actor', username:'b3-test', role:'admin' };

function inProgressFixture(overrides = {}) {
  return createTransitionFixture({
    workOrder:{ status:'doing', times:{ start:STARTED_AT }, row_version:7 },
    occurrence:{ status:'in_progress', started_at:STARTED_AT, row_version:5 },
    ...overrides
  });
}

test('real PM work-order start moves occurrence to in_progress with the same real transition timestamp', async () => {
  const { pool, state } = createTransitionFixture();
  const result = await service.transitionWorkOrder(pool, user, 'wo-b3', { rowVersion:7, status:'doing' });
  assert.equal(result.status, 'doing');
  assert.equal(state.occurrence.status, 'in_progress');
  assert.ok(Number.isFinite(Date.parse(result.times.start)));
  assert.equal(state.occurrence.started_at, result.times.start);
  assert.equal(state.occurrence.generated_at, GENERATED_AT);
  assert.equal(state.workOrder.row_version, 8);
  assert.equal(state.occurrence.row_version, 5);
  assert.equal(state.plan.row_version, 10);
  assert.equal(state.audits.length, 2);
});

test('repeated PM start preserves timestamps and creates no extra row version or audit', async () => {
  const { pool, state } = createTransitionFixture();
  await service.transitionWorkOrder(pool, user, 'wo-b3', { rowVersion:7, status:'doing' });
  const start = state.occurrence.started_at;
  const versions = [state.workOrder.row_version, state.occurrence.row_version, state.plan.row_version];
  const auditCount = state.audits.length;
  const retry = await service.transitionWorkOrder(pool, user, 'wo-b3', { rowVersion:7, status:'doing' });
  assert.equal(retry.times.start, start);
  assert.equal(state.occurrence.started_at, start);
  assert.deepEqual([state.workOrder.row_version, state.occurrence.row_version, state.plan.row_version], versions);
  assert.equal(state.audits.length, auditCount);
});

test('Work Order without occurrence_id retains the existing transition path', async () => {
  const { pool, state } = createTransitionFixture({ workOrder:{ occurrence_id:null, pm_id:null } });
  const result = await service.transitionWorkOrder(pool, user, 'wo-b3', { rowVersion:7, status:'doing' });
  assert.equal(result.status, 'doing');
  assert.ok(Number.isFinite(Date.parse(result.times.start)));
  assert.equal(state.occurrence.status, 'work_order_generated');
  assert.equal(state.occurrence.row_version, 4);
  assert.equal(state.plan.row_version, 10);
  assert.equal(state.audits.length, 1);
});

test('Work Order row_version conflicts are rejected before any linked record changes', async () => {
  const { pool, state } = createTransitionFixture();
  await assert.rejects(
    service.transitionWorkOrder(pool, user, 'wo-b3', { rowVersion:6, status:'doing' }),
    error => error.code === 'VERSION_CONFLICT'
  );
  assert.equal(state.workOrder.status, 'assigned');
  assert.equal(state.occurrence.status, 'work_order_generated');
  assert.equal(state.plan.row_version, 10);
  assert.equal(state.audits.length, 0);
});

test('PM Completion without required report evidence is rejected without writes', async () => {
  const { pool, state } = inProgressFixture();
  await assert.rejects(
    service.transitionWorkOrder(pool, user, 'wo-b3', { rowVersion:7, status:'done' }),
    error => error.code === 'REPORT_REQUIRED'
  );
  assert.equal(state.workOrder.status, 'doing');
  assert.equal(state.occurrence.status, 'in_progress');
  assert.equal(state.plan.last_completed_at, null);
  assert.equal(state.audits.length, 0);
  assert.equal(state.rollbacks, 1);
});

test('real Completion atomically completes occurrence and plan from Work Order evidence', async () => {
  const { pool, state } = inProgressFixture();
  const generatedAt = state.occurrence.generated_at;
  const startedAt = state.occurrence.started_at;
  const lastRun = state.plan.last_run;
  const result = await service.transitionWorkOrder(pool, user, 'wo-b3', {
    rowVersion:7, status:'done', report:{ text:'Completed physical inspection and recorded findings.' }
  });
  const completionAt = result.times.end;
  const expected = new Date(completionAt);
  expected.setUTCDate(expected.getUTCDate() + 30);
  assert.equal(result.status, 'done');
  assert.equal(state.occurrence.status, 'completed');
  assert.equal(state.occurrence.completed_at, completionAt);
  assert.equal(state.occurrence.completion_source, 'work_order');
  assert.equal(state.occurrence.started_at, startedAt);
  assert.equal(state.occurrence.generated_at, generatedAt);
  assert.equal(state.plan.last_completed_at, completionAt);
  assert.equal(state.plan.next_due_at, expected.toISOString());
  assert.equal(state.plan.last_run, lastRun);
  assert.equal(state.workOrder.row_version, 8);
  assert.equal(state.occurrence.row_version, 6);
  assert.equal(state.plan.row_version, 11);
  assert.equal(state.occurrenceInserts, 0);
  assert.equal(state.workOrderInserts, 0);
  assert.equal(state.audits.filter(entry => entry.action === 'complete').length, 2);
});

test('Completion retry replays the existing completion without advancing rows or auditing again', async () => {
  const { pool, state } = inProgressFixture();
  const first = await service.transitionWorkOrder(pool, user, 'wo-b3', {
    rowVersion:7, status:'done', report:{ text:'Work completed with verified evidence.' }
  });
  const snapshot = {
    end:first.times.end, nextDueAt:state.plan.next_due_at,
    versions:[state.workOrder.row_version, state.occurrence.row_version, state.plan.row_version], audits:state.audits.length
  };
  const retry = await service.transitionWorkOrder(pool, user, 'wo-b3', {
    rowVersion:7, status:'done', report:{ text:'Work completed with verified evidence.' }
  });
  assert.equal(retry.times.end, snapshot.end);
  assert.equal(state.occurrence.completed_at, snapshot.end);
  assert.equal(state.plan.next_due_at, snapshot.nextDueAt);
  assert.deepEqual([state.workOrder.row_version, state.occurrence.row_version, state.plan.row_version], snapshot.versions);
  assert.equal(state.audits.length, snapshot.audits);
});

test('closing a completed PM Work Order does not complete or advance PM data again', async () => {
  const { pool, state } = inProgressFixture();
  await service.transitionWorkOrder(pool, user, 'wo-b3', {
    rowVersion:7, status:'done', report:{ text:'Work completed once.' }
  });
  const versions = [state.occurrence.row_version, state.plan.row_version];
  const completedAt = state.occurrence.completed_at;
  const completionAudits = state.audits.filter(entry => entry.action === 'complete').length;
  const result = await service.transitionWorkOrder(pool, user, 'wo-b3', { rowVersion:8, status:'closed' });
  assert.equal(result.status, 'closed');
  assert.equal(state.occurrence.completed_at, completedAt);
  assert.deepEqual([state.occurrence.row_version, state.plan.row_version], versions);
  assert.equal(state.audits.filter(entry => entry.action === 'complete').length, completionAudits);
});

test('non-calendar Completion records the real completion but leaves next_due_at NULL', async () => {
  const { pool, state } = inProgressFixture({ plan:{ schedule_basis:'meter', next_due_at:null } });
  await service.transitionWorkOrder(pool, user, 'wo-b3', {
    rowVersion:7, status:'done', report:{ text:'Completed; meter reading not available.' }
  });
  assert.ok(state.plan.last_completed_at);
  assert.equal(state.plan.next_due_at, null);
  assert.equal(state.occurrence.completion_source, 'work_order');
});

test('cancelled Work Order does not mark the PM occurrence or plan completed', async () => {
  const { pool, state } = inProgressFixture();
  const planVersion = state.plan.row_version;
  const planLastCompleted = state.plan.last_completed_at;
  const result = await service.cancelWorkOrder(pool, user, 'wo-b3', { rowVersion:7, reason:'Cancelled by authorized operator.' });
  assert.equal(result.status, 'cancel');
  assert.equal(state.occurrence.status, 'in_progress');
  assert.equal(state.occurrence.completed_at, null);
  assert.equal(state.plan.last_completed_at, planLastCompleted);
  assert.equal(state.plan.row_version, planVersion);
});

test('completed, cancelled, and skipped occurrences reject a new start or Completion', async () => {
  for (const finalStatus of ['completed','cancelled','skipped']) {
    const startFixture = createTransitionFixture({ occurrence:{ status:finalStatus } });
    await assert.rejects(
      service.transitionWorkOrder(startFixture.pool, user, 'wo-b3', { rowVersion:7, status:'doing' }),
      error => error.code === 'PM_OCCURRENCE_NOT_STARTABLE'
    );
    const completionFixture = inProgressFixture({ occurrence:{ status:finalStatus } });
    await assert.rejects(
      service.transitionWorkOrder(completionFixture.pool, user, 'wo-b3', {
        rowVersion:7, status:'done', report:{ text:'Attempted completion.' }
      }),
      error => error.code === 'PM_OCCURRENCE_ALREADY_FINAL'
    );
    assert.equal(completionFixture.state.plan.last_completed_at, null);
  }
});

test('mismatched Plan/Equipment linkage fails with a domain error', async () => {
  const { pool, state } = createTransitionFixture({ occurrence:{ equipment_id:'other-asset' } });
  await assert.rejects(
    service.transitionWorkOrder(pool, user, 'wo-b3', { rowVersion:7, status:'doing' }),
    error => error.code === 'PM_OCCURRENCE_LINK_MISMATCH'
  );
  assert.equal(state.workOrder.status, 'assigned');
  assert.equal(state.occurrence.status, 'work_order_generated');
  assert.equal(state.audits.length, 0);
});

test('database failure rolls Work Order, Occurrence, Plan, audits and events back atomically', async () => {
  const { pool, state } = inProgressFixture({ failPlanUpdate:true });
  const originalWorkOrder = clone(state.workOrder);
  const originalOccurrence = clone(state.occurrence);
  const originalPlan = clone(state.plan);
  await assert.rejects(
    service.transitionWorkOrder(pool, user, 'wo-b3', {
      rowVersion:7, status:'done', report:{ text:'Valid report before simulated failure.' }
    }),
    error => error.code === 'PM_TRANSACTION_FAILED' && !/23514|test-only database failure/.test(error.message)
  );
  assert.deepEqual(state.workOrder, originalWorkOrder);
  assert.deepEqual(state.occurrence, originalOccurrence);
  assert.deepEqual(state.plan, originalPlan);
  assert.equal(state.audits.length, 0);
  assert.equal(state.events.length, 0);
  assert.equal(state.rollbacks, 1);
});

test('completed PM Work Order cannot be reopened and inconsistent completion cannot be silently repaired', async () => {
  const { pool, state } = inProgressFixture();
  await service.transitionWorkOrder(pool, user, 'wo-b3', {
    rowVersion:7, status:'done', report:{ text:'Completion record.' }
  });
  await assert.rejects(
    service.transitionWorkOrder(pool, user, 'wo-b3', { rowVersion:8, status:'doing' }),
    error => error.code === 'INVALID_STATUS_TRANSITION'
  );
  const completionAt = '2026-10-28T08:30:00.000Z';
  const inconsistent = inProgressFixture({
    workOrder:{ status:'done', row_version:8, times:{ start:STARTED_AT, end:completionAt }, report:{ text:'Recorded Completion.' } },
    occurrence:{ status:'completed', started_at:STARTED_AT, completed_at:completionAt, completion_source:'work_order' },
    plan:{ last_completed_at:null, next_due_at:null }
  });
  await assert.rejects(
    service.transitionWorkOrder(inconsistent.pool, user, 'wo-b3', { rowVersion:7, status:'done' }),
    error => error.code === 'PM_COMPLETION_INCONSISTENT'
  );
  assert.equal(inconsistent.state.plan.last_completed_at, null);
  assert.equal(inconsistent.state.audits.length, 0);
});
