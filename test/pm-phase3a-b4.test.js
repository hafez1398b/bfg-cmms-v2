'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../server/maintenance-service');

const user = { id:'b4-user', name:'B4 test actor', username:'b4-test', role:'admin' };
const ARCHIVE_AT = '2026-10-28T10:00:00.000Z';
const LAST_COMPLETED = '2026-09-20T08:30:00.000Z';
const NEXT_DUE = '2026-10-20T08:30:00.000Z';

function makeFixture(overrides = {}) {
  const state = {
    plan:{
      id:'plan-b4', asset_id:'asset-b4', code:'PM-B4', title:'B4 test plan', status:'active',
      archived_at:null, archived_by:null, archive_reason:null, deleted_at:null,
      last_run:'2026-09-20T08:30:00.000Z', last_completed_at:LAST_COMPLETED,
      next_due_at:NEXT_DUE, updated_at:'2026-10-01T00:00:00.000Z', updated_by:'previous-user',
      row_version:5
    },
    activeRows:[], conflicts:[], uniqueConflict:false,
    occurrences:[{ id:'occ-history', pm_plan_id:'plan-b4', status:'completed', completed_at:LAST_COMPLETED, row_version:3 }],
    workOrders:[{ id:'wo-history', pm_id:'plan-b4', occurrence_id:'occ-history', status:'done', row_version:4 }],
    audits:[], events:[], inserts:0, deletes:0, rollbacks:0, releases:0
  };
  const defaultPlan = structuredClone(state.plan);
  Object.assign(state, overrides);
  if (overrides.plan) state.plan = { ...defaultPlan, ...overrides.plan };

  const client = {
    async query(sql, values = []) {
      const query = sql.trim();
      if (['BEGIN','COMMIT'].includes(query)) return { rows:[] };
      if (query === 'ROLLBACK') { state.rollbacks += 1; return { rows:[] }; }
      if (query === 'SELECT * FROM pm_plans WHERE id=$1 FOR UPDATE') {
        return { rows:values[0] === state.plan.id ? [structuredClone(state.plan)] : [] };
      }
      if (query.startsWith('SELECT id, code, name, deleted_at FROM assets WHERE id=$1')) {
        return { rows:values[0] === state.plan.asset_id ? [{ id:state.plan.asset_id, code:'EQ-B4', name:'B4 test asset', deleted_at:null }] : [] };
      }
      if (query.startsWith('WITH RECURSIVE ancestors')) return { rows:[{ factory_asset_id:null }] };
      if (query === 'SELECT id FROM users WHERE id=$1 AND active=true') {
        return { rows:values[0] === user.id ? [{ id:user.id }] : [] };
      }
      if (query.includes("FROM pm_occurrences o") && query.includes('UNION ALL')) {
        return { rows:state.activeRows.length ? [{ '?column?':1 }] : [] };
      }
      if (query === 'SELECT clock_timestamp() AS archived_at') return { rows:[{ archived_at:ARCHIVE_AT }] };
      if (query.startsWith('SELECT id FROM pm_plans')) {
        return { rows:state.conflicts.map(item => ({ id:item.id })) };
      }
      if (query.startsWith('UPDATE pm_plans')) {
        const [id, rowVersion, timestampOrUser, actorOrUndefined, reason] = values;
        if (id !== state.plan.id || Number(rowVersion) !== Number(state.plan.row_version)) return { rows:[] };
        if (!query.includes('SET archived_at=$3') && state.uniqueConflict) {
          throw Object.assign(new Error('duplicate key value violates unique constraint'), {
            code:'23505', constraint:'idx_pm_plans_active_asset_code_unique'
          });
        }
        if (query.includes('SET archived_at=$3')) {
          Object.assign(state.plan, {
            archived_at:timestampOrUser, archived_by:actorOrUndefined, archive_reason:reason,
            deleted_at:timestampOrUser, updated_at:timestampOrUser, updated_by:actorOrUndefined,
            row_version:state.plan.row_version + 1
          });
        } else {
          Object.assign(state.plan, {
            archived_at:null, archived_by:null, archive_reason:null, deleted_at:null,
            updated_at:ARCHIVE_AT, updated_by:timestampOrUser, row_version:state.plan.row_version + 1
          });
        }
        return { rows:[structuredClone(state.plan)] };
      }
      if (query.startsWith('INSERT INTO audit_x')) {
        state.audits.push({
          action:values[4], module:values[5], entity:values[6], note:values[7],
          before:values[8] ? JSON.parse(values[8]) : null,
          after:values[9] ? JSON.parse(values[9]) : null
        });
        return { rows:[] };
      }
      if (query.startsWith('SELECT u.id, u.role')) return { rows:[] };
      if (query.startsWith('INSERT INTO event_outbox')) { state.events.push(values); return { rows:[] }; }
      throw new Error(`Unexpected B4 test query: ${query}`);
    },
    release() { state.releases += 1; }
  };
  const pool = {
    connect:async () => client,
    async query(sql, values = []) {
      if (sql.startsWith('SELECT id, code, name, deleted_at FROM assets WHERE id=$1')) {
        return { rows:values[0] === state.plan.asset_id ? [{ id:state.plan.asset_id, code:'EQ-B4', name:'B4 test asset', deleted_at:null }] : [] };
      }
      if (sql.startsWith('WITH RECURSIVE ancestors')) return { rows:[{ factory_asset_id:null }] };
      if (sql.includes('FROM pm_plans p LEFT JOIN assets')) {
        const includeArchived = values[sql.includes('WHERE p.id=$1') ? 1 : 0] === true;
        const rowArchived = Boolean(state.plan.archived_at || state.plan.deleted_at);
        return { rows:includeArchived || !rowArchived ? [structuredClone(state.plan)] : [] };
      }
      throw new Error(`Unexpected B4 pool query: ${sql}`);
    }
  };
  return { pool, state };
}

test('archive records canonical archive fields, version, and full audit without touching history or completion dates', async () => {
  const { pool, state } = makeFixture();
  const occurrences = structuredClone(state.occurrences);
  const workOrders = structuredClone(state.workOrders);
  const result = await service.archivePmPlan(pool, user, 'plan-b4', { rowVersion:5, reason:'Program retired by maintenance lead' });
  assert.deepEqual(result, { archived:true, historyPreserved:true });
  assert.equal(state.plan.archived_at, ARCHIVE_AT);
  assert.equal(state.plan.deleted_at, ARCHIVE_AT);
  assert.equal(state.plan.archived_by, user.id);
  assert.equal(state.plan.archive_reason, 'Program retired by maintenance lead');
  assert.equal(state.plan.row_version, 6);
  assert.equal(state.plan.updated_at, ARCHIVE_AT);
  assert.equal(state.plan.updated_by, user.id);
  assert.equal(state.plan.last_run, '2026-09-20T08:30:00.000Z');
  assert.equal(state.plan.last_completed_at, LAST_COMPLETED);
  assert.equal(state.plan.next_due_at, NEXT_DUE);
  assert.deepEqual(state.occurrences, occurrences);
  assert.deepEqual(state.workOrders, workOrders);
  assert.equal(state.deletes, 0);
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].action, 'archive');
  assert.equal(state.audits[0].entity, 'plan-b4');
  assert.equal(state.audits[0].before.archived_at, null);
  assert.equal(state.audits[0].after.archived_at, ARCHIVE_AT);
  assert.equal(state.rollbacks, 0);
});

test('active occurrences and open Work Orders block archive without changing Plan state', async () => {
  for (const activeRow of [
    { type:'occurrence', status:'in_progress' },
    { type:'work_order', status:'assigned' },
    { type:'work_order', status:'doing' }
  ]) {
    const { pool, state } = makeFixture({ activeRows:[activeRow] });
    const before = structuredClone(state.plan);
    await assert.rejects(
      service.archivePmPlan(pool, user, 'plan-b4', { rowVersion:5, reason:'Archive attempt' }),
      error => error.code === 'PM_HAS_ACTIVE_WORK'
    );
    assert.deepEqual(state.plan, before);
    assert.equal(state.audits.length, 0);
    assert.equal(state.events.length, 0);
    assert.equal(state.rollbacks, 1);
  }
});

test('repeated archive at the current version is idempotent and does not rewrite timestamp or audit', async () => {
  const { pool, state } = makeFixture();
  await service.archivePmPlan(pool, user, 'plan-b4', { rowVersion:5, reason:'Archive once' });
  const archivedAt = state.plan.archived_at;
  const auditCount = state.audits.length;
  const result = await service.archivePmPlan(pool, user, 'plan-b4', { rowVersion:6, reason:'Retry archive' });
  assert.equal(result.idempotent, true);
  assert.equal(state.plan.archived_at, archivedAt);
  assert.equal(state.plan.row_version, 6);
  assert.equal(state.audits.length, auditCount);
});

test('restore clears canonical and legacy archive markers while preserving history and completion data', async () => {
  const legacyDeletedAt = '2025-04-01T00:00:00.000Z';
  const { pool, state } = makeFixture({
    plan:{ archived_at:null, archived_by:'legacy-user', archive_reason:null, deleted_at:legacyDeletedAt }
  });
  const occurrences = structuredClone(state.occurrences);
  const workOrders = structuredClone(state.workOrders);
  const beforeLastRun = state.plan.last_run;
  const beforeLastCompleted = state.plan.last_completed_at;
  const beforeNextDue = state.plan.next_due_at;
  const result = await service.restorePmPlan(pool, user, 'plan-b4', { rowVersion:5 });
  assert.deepEqual(result, { restored:true, historyPreserved:true });
  assert.equal(state.plan.archived_at, null);
  assert.equal(state.plan.archived_by, null);
  assert.equal(state.plan.archive_reason, null);
  assert.equal(state.plan.deleted_at, null);
  assert.equal(state.plan.row_version, 6);
  assert.equal(state.plan.updated_by, user.id);
  assert.equal(state.plan.last_run, beforeLastRun);
  assert.equal(state.plan.last_completed_at, beforeLastCompleted);
  assert.equal(state.plan.next_due_at, beforeNextDue);
  assert.deepEqual(state.occurrences, occurrences);
  assert.deepEqual(state.workOrders, workOrders);
  assert.equal(state.inserts, 0);
  assert.equal(state.deletes, 0);
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].action, 'restore');
  assert.equal(state.audits[0].before.deleted_at, legacyDeletedAt);
  assert.equal(state.audits[0].after.deleted_at, null);
});

test('repeated restore of an active Plan is idempotent and creates no extra audit or version', async () => {
  const { pool, state } = makeFixture({ plan:{ archived_at:'2026-01-01T00:00:00.000Z', deleted_at:'2026-01-01T00:00:00.000Z' } });
  await service.restorePmPlan(pool, user, 'plan-b4', { rowVersion:5 });
  const version = state.plan.row_version;
  const audits = state.audits.length;
  const updatedAt = state.plan.updated_at;
  const result = await service.restorePmPlan(pool, user, 'plan-b4', { rowVersion:version });
  assert.equal(result.idempotent, true);
  assert.equal(state.plan.row_version, version);
  assert.equal(state.plan.updated_at, updatedAt);
  assert.equal(state.audits.length, audits);
});

test('restore rejects active (asset_id, code) conflicts before writes', async () => {
  const { pool, state } = makeFixture({
    plan:{ archived_at:'2026-01-01T00:00:00.000Z', archived_by:'old-user', archive_reason:'old reason', deleted_at:'2026-01-01T00:00:00.000Z' },
    conflicts:[{ id:'another-active-plan' }]
  });
  const before = structuredClone(state.plan);
  await assert.rejects(
    service.restorePmPlan(pool, user, 'plan-b4', { rowVersion:5 }),
    error => error.code === 'PM_CODE_CONFLICT'
  );
  assert.deepEqual(state.plan, before);
  assert.equal(state.audits.length, 0);
  assert.equal(state.events.length, 0);
  assert.equal(state.rollbacks, 1);
});

test('a unique-index race on restore maps to PM_CODE_CONFLICT and rolls back safely', async () => {
  const { pool, state } = makeFixture({
    plan:{ archived_at:'2026-01-01T00:00:00.000Z', deleted_at:'2026-01-01T00:00:00.000Z' },
    uniqueConflict:true
  });
  const before = structuredClone(state.plan);
  await assert.rejects(
    service.restorePmPlan(pool, user, 'plan-b4', { rowVersion:5 }),
    error => error.code === 'PM_CODE_CONFLICT' && !String(error.message).includes('duplicate key')
  );
  assert.deepEqual(state.plan, before);
  assert.equal(state.audits.length, 0);
  assert.equal(state.rollbacks, 1);
});

test('missing records and stale row versions are distinct and roll back without writes', async () => {
  const { pool, state } = makeFixture();
  const before = structuredClone(state.plan);
  await assert.rejects(
    service.archivePmPlan(pool, user, 'missing-plan', { rowVersion:5, reason:'No such plan' }),
    error => error.code === 'RECORD_NOT_FOUND'
  );
  await assert.rejects(
    service.archivePmPlan(pool, user, 'plan-b4', { rowVersion:4, reason:'Stale archive attempt' }),
    error => error.code === 'VERSION_CONFLICT'
  );
  assert.deepEqual(state.plan, before);
  assert.equal(state.audits.length, 0);
  assert.equal(state.rollbacks, 2);

  const archived = makeFixture({ plan:{ archived_at:ARCHIVE_AT, deleted_at:ARCHIVE_AT } });
  const archivedBefore = structuredClone(archived.state.plan);
  await assert.rejects(
    service.restorePmPlan(archived.pool, user, 'plan-b4', { rowVersion:4 }),
    error => error.code === 'VERSION_CONFLICT'
  );
  assert.deepEqual(archived.state.plan, archivedBefore);
  assert.equal(archived.state.audits.length, 0);
  assert.equal(archived.state.rollbacks, 1);
});

test('Plan DTO exposes archive metadata and reads hide archived Plans unless includeArchived is explicit', async () => {
  const { pool, state } = makeFixture();
  state.plan.archived_at = ARCHIVE_AT;
  state.plan.archived_by = user.id;
  state.plan.archive_reason = 'Read DTO test';
  state.plan.deleted_at = ARCHIVE_AT;
  await assert.rejects(service.getPmPlan(pool, user, 'plan-b4'), error => error.code === 'RECORD_NOT_FOUND');
  const dto = await service.getPmPlan(pool, user, 'plan-b4', { includeArchived:true });
  assert.equal(dto.archivedAt, ARCHIVE_AT);
  assert.equal(dto.archivedBy, user.id);
  assert.equal(dto.archiveReason, 'Read DTO test');
  assert.equal(dto.rowVersion, 5);
  assert.deepEqual(await service.listPmPlans(pool, user), []);
  assert.equal((await service.listPmPlans(pool, user, { includeArchived:true })).length, 1);
});

test('archive and restore require row versions and archive requires a non-empty reason', async () => {
  const { pool, state } = makeFixture();
  await assert.rejects(service.archivePmPlan(pool, user, 'plan-b4', { reason:'   ' }), error => error.code === 'ROW_VERSION_REQUIRED');
  await assert.rejects(service.archivePmPlan(pool, user, 'plan-b4', { rowVersion:5, reason:'  ' }), error => error.code === 'ARCHIVE_REASON_REQUIRED');
  await assert.rejects(service.restorePmPlan(pool, user, 'plan-b4', {}), error => error.code === 'ROW_VERSION_REQUIRED');
  assert.equal(state.audits.length, 0);
  assert.equal(state.rollbacks, 0);
});
