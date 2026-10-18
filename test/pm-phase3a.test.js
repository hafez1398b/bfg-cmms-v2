'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const service = require('../server/maintenance-service');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('regression: new PM plans must not be recorded as already run or completed', () => {
  const source = read('server/maintenance-service.js');
  const create = source.slice(source.indexOf('async function createPmPlan'), source.indexOf('async function listPmPlans'));
  assert.doesNotMatch(create, /INSERT INTO pm_plans\([^)]*last_run/i);
  assert.doesNotMatch(create, /last_completed_at\s*[:=]\s*(?:new Date|now\()/i);
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
