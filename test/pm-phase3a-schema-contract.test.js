'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'migrations/018_pm_occurrences_and_due_schedule.sql'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');
const phase3aMarker = '-- Phase 3-A: PM schedule integrity, occurrence ledger and idempotent PM work orders.';

test('Migration 018 uses the canonical one-way work-order occurrence relationship', () => {
  assert.doesNotMatch(migration, /\bwork_order_id\b/i, 'occurrences must not store a reverse work-order reference');
  assert.doesNotMatch(migration, /FOREIGN\s+KEY\s*\([^)]*\)\s*REFERENCES\s+work_orders\s*\(/i);
  assert.doesNotMatch(migration, /\bidx_pm_occurrences_work_order_unique\b/i);
  assert.doesNotMatch(migration, /\bidx_pm_occurrences_work_order\b/i);

  assert.match(migration, /ALTER\s+TABLE\s+work_orders\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+occurrence_id\s+TEXT/i);
  assert.match(migration, /work_orders_occurrence_fk\s+FOREIGN\s+KEY\s*\(occurrence_id\)\s+REFERENCES\s+pm_occurrences\s*\(id\)/i);
  assert.match(migration, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_work_orders_occurrence_unique\s+ON\s+work_orders\s*\(occurrence_id\)\s+WHERE\s+occurrence_id\s+IS\s+NOT\s+NULL/i);
  assert.match(migration, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_pm_occurrences_plan_period_unique\s+ON\s+pm_occurrences\s*\(pm_plan_id\s*,\s*period_key\)/i);
});

test('PM codes are unique only per active asset-scoped plan', () => {
  assert.doesNotMatch(migration, /\bidx_pm_plans_code_unique\b/i);
  assert.doesNotMatch(migration, /CREATE\s+UNIQUE\s+INDEX\b[^;]*\bON\s+pm_plans\s*\(\s*code\s*\)/i);
  assert.match(migration, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_pm_plans_active_asset_code_unique\s+ON\s+pm_plans\s*\(asset_id\s*,\s*code\)\s+WHERE\s+code\s+IS\s+NOT\s+NULL\s+AND\s+archived_at\s+IS\s+NULL\s+AND\s+deleted_at\s+IS\s+NULL/i);
});

test('Migration 018 grants scheduling and restore permissions without destructive SQL', () => {
  assert.match(migration, /\('mgr','pm\.restore'\)/);
  assert.match(migration, /\('mgr','pm\.schedule'\)/);
  assert.match(migration, /\('planner','pm\.restore'\)/);
  assert.match(migration, /\('planner','pm\.schedule'\)/);
  assert.doesNotMatch(migration, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(migration, /^\s*TRUNCATE\b/im);
  assert.doesNotMatch(migration, /^\s*DROP\b/im);
});

test('legacy last_run alone is not accepted as completion evidence', () => {
  assert.match(migration, /Only a completed\/closed PM work order with a valid end timestamp and report is trusted/i);
  assert.match(migration, /w\.status\s+IN\s*\('done','closed','completed'\)/i);
  assert.match(migration, /NULLIF\(btrim\(w\.report->>'text'\),''\)/i);
  assert.match(migration, /w\.times->>'end'[\s\S]*?\)\s*::timestamptz/i);
  assert.match(migration, /Do not infer a completion from legacy last_run/i);
});

test('schema.sql contains exactly one contract block identical to Migration 018', () => {
  const markerCount = schema.split(phase3aMarker).length - 1;
  assert.equal(markerCount, 1, 'schema.sql must not retain duplicate old/new Phase 3-A blocks');
  const start = schema.lastIndexOf(phase3aMarker);
  assert.notEqual(start, -1);
  const contractBlock = schema.slice(start).trim();
  assert.equal(contractBlock, migration.trim());

  for (const source of [contractBlock]) {
    assert.doesNotMatch(source, /\bwork_order_id\b/i);
    assert.doesNotMatch(source, /\bidx_pm_occurrences_work_order_unique\b/i);
    assert.doesNotMatch(source, /\bidx_pm_occurrences_work_order\b/i);
    assert.match(source, /work_orders_occurrence_fk\s+FOREIGN\s+KEY\s*\(occurrence_id\)\s+REFERENCES\s+pm_occurrences\s*\(id\)/i);
    assert.match(source, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_work_orders_occurrence_unique\s+ON\s+work_orders\s*\(occurrence_id\)\s+WHERE\s+occurrence_id\s+IS\s+NOT\s+NULL/i);
    assert.match(source, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_pm_plans_active_asset_code_unique\s+ON\s+pm_plans\s*\(asset_id\s*,\s*code\)\s+WHERE\s+code\s+IS\s+NOT\s+NULL\s+AND\s+archived_at\s+IS\s+NULL\s+AND\s+deleted_at\s+IS\s+NULL/i);
  }
});
