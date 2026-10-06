'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAdapter({ session = false, calls = [] } = {}) {
  const window = {
    ...(session ? { BFGBackend: { user: { id: 'user-1' } } } : {}),
    bfgApi: async (route, options) => {
      calls.push({ route, options });
      return { data: { id: 'eq-1' }, committed: true };
    }
  };
  const context = {
    window,
    document: { cookie: '' },
    sessionStorage: { getItem: () => null },
    localStorage: { getItem: () => null, setItem() {} },
    URLSearchParams, fetch: async () => { throw new Error('unexpected fallback fetch'); }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/equipment-v2/equipment-adapter.js'), 'utf8'), context);
  return context;
}

test('equipment adapter fails closed without an authenticated server session', async () => {
  const context = loadAdapter();
  assert.equal(context.window.EquipmentRepository.mode, 'server-required');
  const repository = context.window.EquipmentRepository.current();
  assert.equal(repository.source, 'server-required');
  assert.equal(context.window.EquipmentRepository.local, undefined);
  for (const operation of [
    () => repository.feature(), () => repository.list({ q: 'pump' }),
    () => repository.create({ code: 'EQ-1', name: 'Pump' }),
    () => repository.update('eq-1', { name: 'Pump' }),
    () => repository.remove('eq-1', 'retired', 1)
  ]) await assert.rejects(operation, error => error.message === 'SERVER_REQUIRED');
});

test('equipment adapter sends operational writes only through the authenticated Backend API', async () => {
  const calls = [];
  const context = loadAdapter({ session: true, calls });
  const repository = context.window.EquipmentRepository.current();
  assert.equal(context.window.EquipmentRepository.mode, 'postgresql');
  assert.equal(repository.source, 'postgresql');
  await repository.create({ code: 'EQ-1', name: 'Pump' });
  await repository.update('eq-1', { name: 'Pump 2', rowVersion: 3 });
  await repository.remove('eq-1', 'retired', 4);
  assert.deepEqual(calls.map(call => [call.route, call.options.method]), [
    ['/api/equipment/', 'POST'], ['/api/equipment/eq-1', 'PATCH'], ['/api/equipment/eq-1', 'DELETE']
  ]);
  assert.equal(JSON.parse(calls[1].options.body).rowVersion, 3);
  assert.equal(JSON.parse(calls[2].options.body).rowVersion, 4);
});
