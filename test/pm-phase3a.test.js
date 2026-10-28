'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const service = require('../server/maintenance-service');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('regression: new PM plans keep legacy last_run and completion timestamps NULL', () => {
  const source = read('server/maintenance-service.js');
  const create = source.slice(source.indexOf('async function createPmPlan'), source.indexOf('async function listPmPlans'));
  assert.match(create, /last_run/);
  assert.match(create, /last_completed_at/);
  assert.match(create, /VALUES/);
  assert.doesNotMatch(create, /input.lastRun|input.lastCompletedAt/);
});

test('regression: a single deterministic backend service owns PM due calculation', () => {
  assert.equal(typeof service.calculatePmDue, 'function');
  const plan = { schedule_basis:'calendar', interval_days:30, first_due_at:'2026-10-20T00:00:00.000Z', tolerance_days:2, status:'active' };
  const first = service.calculatePmDue(plan, new Date('2026-10-20T00:00:00.000Z'));
  const second = service.calculatePmDue(plan, new Date('2026-10-20T00:00:00.000Z'));
  assert.deepEqual(first, second);
  assert.equal(first.nextDueAt, '2026-10-20T00:00:00.000Z');
  assert.equal(first.dueStatus, 'due');
});

test('createPmPlan leaves legacy completion fields NULL and ignores completion inputs', async () => {
  let inserted;
  const client = {
    async query(sql, values = []) {
      if (['BEGIN','COMMIT','ROLLBACK'].includes(sql.trim())) return { rows:[] };
      if (sql.includes('FROM assets WHERE id=$1')) return { rows:[{ id:'asset-1', code:'A-1', name:'Asset', deleted_at:null }] };
      if (sql.includes('WITH RECURSIVE ancestors')) return { rows:[{ factory_asset_id:null }] };
      if (sql.trimStart().startsWith('INSERT INTO pm_plans')) {
        inserted = { sql, values };
        const [id, assetId, title, intervalDays, , owner, kind, checklist, scheduleBasis, firstDueAt, nextDueAt, toleranceDays] = values;
        return { rows:[{
          id, asset_id:assetId, title, interval_days:intervalDays, last_run:null, last_completed_at:null,
          schedule_basis:scheduleBasis, first_due_at:firstDueAt, next_due_at:nextDueAt, tolerance_days:toleranceDays,
          owner, kind, checklist:JSON.parse(checklist), status:'active', row_version:1
        }] };
      }
      if (sql.includes('FROM users u WHERE u.active=true')) return { rows:[] };
      if (sql.includes('INSERT INTO audit_x') || sql.includes('INSERT INTO event_outbox')) return { rows:[] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {}
  };
  await service.createPmPlan({ connect:async () => client }, { id:'user-1', name:'B1', role:'admin' }, {
    assetId:'asset-1', title:'B1 Plan', intervalDays:30,
    firstDueAt:'2026-10-20', lastRun:'2020-01-01T00:00:00Z', lastCompletedAt:'2020-01-01T00:00:00Z'
  });
  assert.match(inserted.sql, /last_run/);
  assert.match(inserted.sql, /last_completed_at/);
  assert.ok(inserted.sql.includes("VALUES($1,$2,$3,$4,NULL,$5,$6,$7,$8,'active',$9,$10,$11,NULL,$12)"));
  assert.equal(inserted.values.includes('2020-01-01T00:00:00Z'), false);
  assert.equal(inserted.values[9], '2026-10-20T00:00:00.000Z');
  assert.equal(inserted.values[10], '2026-10-20T00:00:00.000Z');
});

test('PM due calculation ignores last_run and returns explicit insufficient data', () => {
  const result = service.calculatePmDue({ schedule_basis:'calendar', interval_days:30, last_run:'2026-10-01T00:00:00Z' }, '2026-10-20T00:00:00Z');
  assert.deepEqual(result, { nextDueAt:null, dueStatus:'insufficient_data', reason:'first_or_next_due_at_missing' });
  assert.throws(() => service.calculatePmDue({ schedule_basis:'calendar', first_due_at:'2026-02-30' }, '2026-10-20'), error => error.code === 'PM_FIRST_DUE_AT_INVALID');
  assert.throws(() => service.calculatePmDue({ schedule_basis:'calendar', first_due_at:'2026-10-20' }, 'not-a-date'), error => error.code === 'PM_EVALUATED_AT_INVALID');
});

test('PM due calculation derives a deterministic date only from verified completion', () => {
  const plan = { schedule_basis:'calendar', interval_days:30, last_completed_at:'2026-09-20T00:00:00Z', tolerance_days:2 };
  const asOf = '2026-10-20T00:00:00Z';
  const first = service.calculatePmDue(plan, asOf);
  const second = service.calculatePmDue(plan, asOf);
  assert.deepEqual(first, second);
  assert.equal(first.nextDueAt, '2026-10-20T00:00:00.000Z');
  assert.equal(first.dueStatus, 'due');
  assert.equal(service.calculatePmDue(plan, '2026-10-23T00:00:00Z').dueStatus, 'overdue');
  assert.equal(service.calculatePmDue({ ...plan, last_completed_at:null, first_due_at:'2026-10-25' }, asOf).dueStatus, 'scheduled');
});

test('periodKeyForDueDate is UTC-stable and rejects invalid dates', () => {
  assert.equal(typeof service.periodKeyForDueDate, 'function');
  assert.equal(service.periodKeyForDueDate('2026-10-20'), 'calendar:2026-10-20');
  assert.equal(service.periodKeyForDueDate('2026-10-20T02:00:00+02:00'), 'calendar:2026-10-20');
  assert.throws(() => service.periodKeyForDueDate('2026-02-30'), error => error.code === 'PM_DUE_DATE_INVALID');
});

test('regression: PM generation cannot update last_run and must link an occurrence', () => {
  const source = read('server/maintenance-service.js');
  const generate = source.slice(source.indexOf('async function generatePmWorkOrder'), source.indexOf('async function equipmentLinks'));
  assert.doesNotMatch(generate, /last_run\s*:/);
  assert.match(generate, /pm_occurrences|occurrence_id/i);
  assert.match(generate, /idempotency_keys/);
});

test('regression: PM Compliance has no hardcoded 91 percent or frontend due arithmetic', () => {
  const html = read('public/index.html');
  assert.doesNotMatch(html, /PM Compliance.{0,120}(?:91|۹۱)|(?:91|۹۱).{0,120}PM Compliance/i);
  assert.doesNotMatch(html, /new Date\(p\.(?:last|lastRun)\)[\s\S]{0,100}p\.interval/);
  assert.match(html, /N\/A — داده کافی ثبت نشده است/);
});
