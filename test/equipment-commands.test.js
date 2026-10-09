'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createEquipment, completeEquipment } = require('../server/equipment-commands');

const user = { id: 'user-1', name: 'Tester', role: 'planner' };

function createClient(asset) {
  const calls = [];
  return {
    calls,
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/SELECT \* FROM assets WHERE id=\$1/.test(sql)) return { rows: [asset] };
      if (/INSERT INTO assets/.test(sql)) return { rows: [{ id: 'eq-new', ...asset, ...Object.fromEntries([]) }] };
      if (/UPDATE assets SET/.test(sql)) return { rows: [{ ...asset, record_status: 'complete', row_version: Number(asset.row_version || 1) + 1 }] };
      if (/INSERT INTO audit_x/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    }
  };
}

test('manual equipment creation stores profile fields and Gregorian installation date in PostgreSQL', async () => {
  const client = createClient({});
  const result = await createEquipment(client, user, {
    nodeKind: 'equipment', name: 'Pump', code: 'P-1', recordStatus: 'complete',
    installDate: '2024-02-29', technicalSpecification: '۳۰۰ کیلووات', capacity: '1200 m3/h',
    activityType: 'پمپاژ', manufacturerCountry: 'ایران'
  });
  assert.equal(result.id, 'eq-new');
  const insert = client.calls.find(call => /INSERT INTO assets/.test(call.sql));
  assert.match(insert.sql, /install_date/);
  assert.match(insert.sql, /activity_type/);
  assert.equal(insert.values[12], '2024-02-29', 'legacy text stays Gregorian-compatible');
  assert.equal(insert.values[13], '2024-02-29', 'DATE column stores the Gregorian date');
  const ext = JSON.parse(insert.values[16]);
  assert.equal(ext.technicalSpecification, '۳۰۰ کیلووات');
  assert.equal(ext.capacity, '1200 m3/h');
  assert.equal(client.calls.at(-1).sql.includes('audit_x'), true);
});

test('equipment completion enforces row_version, preserves profile extensions and promotes drafts', async () => {
  const old = {
    id: 'eq-1', name: 'Pump', code: 'P-1', row_version: 4, record_status: 'draft',
    ext: { capacity: '100', legacyField: 'preserve' }
  };
  const client = createClient(old);
  const result = await completeEquipment(client, user, 'eq-1', {
    recordStatus: 'complete', installDate: '2025-01-31', technicalSpecification: 'مشخصه ثبت‌شده'
  }, 4);
  assert.equal(result.record_status, 'complete');
  const update = client.calls.find(call => /UPDATE assets SET/.test(call.sql));
  assert.match(update.sql, /install_date=/);
  assert.match(update.sql, /install=/);
  assert.match(update.sql, /record_status=/);
  assert.match(update.sql, /row_version=row_version\+1/);
  assert.match(update.sql, /updated_by=/);
  const extension = update.values.find(value => typeof value === 'string' && value.includes('technicalSpecification'));
  assert.equal(JSON.parse(extension).technicalSpecification, 'مشخصه ثبت‌شده');
  assert.equal(JSON.parse(extension).locationDescription, undefined);
  assert.match(client.calls.at(-1).sql, /audit_x/);
});

test('completion rejects stale row versions and cannot mark a record complete without required identity', async () => {
  const missingIdentity = createClient({ id: 'eq-1', name: '', code: '', row_version: 2, record_status: 'draft', ext: {} });
  await assert.rejects(
    () => completeEquipment(missingIdentity, user, 'eq-1', { recordStatus: 'complete' }, 2),
    error => error.code === 'REQUIRED_FIELDS_MISSING'
  );
  assert.equal(missingIdentity.calls.some(call => /UPDATE assets SET/.test(call.sql)), false);

  const stale = createClient({ id: 'eq-1', name: 'Pump', code: 'P-1', row_version: 5, record_status: 'draft', ext: {} });
  await assert.rejects(
    () => completeEquipment(stale, user, 'eq-1', { recordStatus: 'complete' }, 4),
    error => error.code === 'VERSION_CONFLICT'
  );
  assert.equal(stale.calls.some(call => /UPDATE assets SET/.test(call.sql)), false);
});

test('asset equipment codes retain the database unique constraint', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS assets\([\s\S]*?code TEXT UNIQUE/);
});
