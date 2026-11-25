'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculatePmDue, summarizePmSchedule } = require('../server/maintenance-service');
const { activityFields, checklist, completionResults } = require('../server/pm-planning');

test('monthly Persian recurrence clamps to the final day of the destination month', () => {
  // 1404/06/31 to 1404/07/30, retaining the execution time.
  const result = calculatePmDue({
    schedule_basis:'calendar', interval_days:30, last_completed_at:'2025-09-22T08:00:00Z',
    ext:{calendarFrequency:'monthly'}
  }, '2025-09-23');
  assert.equal(result.nextDueAt, '2025-10-22T08:00:00.000Z');
});

test('PM activity input validates type and preserves existing extension data', async () => {
  const fields = await activityFields({}, 'asset', {
    activityType:'lubrication', requiredPersonnel:2, productionStopRequired:true
  }, {asset_id:'asset',ext:{unrelatedLegacyField:'preserve'}});
  assert.deepEqual(JSON.parse(fields.ext), {unrelatedLegacyField:'preserve',activityType:'lubrication',productionStopRequired:true});
  assert.equal(fields.required_personnel, 2);
  await assert.rejects(activityFields({}, 'asset', {activityType:'invented'}), {code:'PM_ACTIVITY_FIELDS_INVALID'});
});

test('PM completion requires complete measured and classified checklist evidence', () => {
  const checks = checklist([{title:'Pressure',measurementType:'number',min:3,max:5,unit:'bar'}]);
  assert.throws(() => completionResults(checks, []), {code:'PM_CHECKLIST_RESULTS_REQUIRED'});
  assert.throws(() => completionResults(checks, [{status:'healthy',value:6}]), {code:'PM_CHECKLIST_MEASUREMENT_OUTSIDE_RANGE'});
  assert.throws(() => completionResults(checks, [{status:'defective',value:6}]), {code:'PM_CHECKLIST_RESULTS_REQUIRED'});
  assert.deepEqual(completionResults(checks, [{status:'defective',value:6,notes:'Inspect valve'}]),
    [{status:'defective',value:6,notes:'Inspect valve'}]);
});

test('PM report excludes cancelled rows, respects the deadline, and preserves missing durations', () => {
  const dueAt = '2026-10-20T00:00:00Z';
  const deadline = '2026-10-22T23:59:59Z';
  const summary = summarizePmSchedule([
    {status:'completed',dueAt,deadline,completedAt:'2026-10-21T10:00:00Z',plannedMinutes:30,elapsedMinutes:25},
    {status:'scheduled',dueAt,deadline,plannedMinutes:null},
    {status:'cancelled',dueAt,deadline}
  ], Date.parse('2026-10-24T00:00:00Z'));
  assert.deepEqual(summary, {
    planned:2,due:2,completed:1,overdue:1,compliance:0.5,onTimeRate:1,plannedMinutes:null,elapsedMinutes:25
  });
});
