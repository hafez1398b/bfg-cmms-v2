'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAdapter() {
  const context = {
    window: {},
    sessionStorage: { getItem: () => null },
    localStorage: { getItem: () => null, setItem() {} },
    DB: {
      assets: [
        { id: 'root', parent: null, code: 'ROOT', name: 'Root', type: 'site', ext: { nodeKind: 'company' } },
        { id: 'factory-1', parent: 'root', code: 'F-1', name: 'Factory', type: 'site', ext: { nodeKind: 'factory' } },
        { id: 'cat-1', parent: 'factory-1', code: 'PROD', name: 'Production', type: 'unit', ext: { nodeKind: 'category' } },
        { id: 'area', parent: 'cat-1', code: 'AREA', name: 'Area', type: 'unit', ext: { nodeKind: 'location' } },
        { id: 'eq-1', parent: 'area', code: 'EQ-1', name: 'Pump', type: 'eq', status: 'active', crit: 'A', categoryId: 'cat-1' }
      ],
      pms: [], wos: [], auditX: [], featureFlags: {}
    },
    ME: { id: 'user-1', name: 'Tester', role: 'admin' },
    save() {}, uid: () => 'generated-id',
    URLSearchParams, Date, console, fetch: async () => { throw new Error('remote fetch must not run'); }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/equipment-v2/equipment-adapter.js'), 'utf8'), context);
  return context;
}

test('adapter selects explicit local compatibility mode when no JWT exists', async () => {
  const context = loadAdapter();
  assert.equal(context.window.EquipmentRepository.mode, 'local-compatibility');
  const repository = context.window.EquipmentRepository.current();
  assert.equal(repository.source, 'local-compatibility');
  assert.equal((await repository.feature()).enabled, true);
  const result = await repository.list({ q: 'pump', page: 1, limit: 25 });
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].health_score, null);
  assert.equal(result.data[0].maintenance_cost, null);
  assert.deepEqual(Array.from(result.data[0].pm_plans), []);
  assert.deepEqual(Array.from(result.data[0].maintenance_history), []);
  assert.deepEqual(Array.from(result.data[0].spare_parts), []);
});

test('shared local registry resolves bookmark codes and supplies path/filter context', async () => {
  const repository = loadAdapter().window.EquipmentRepository.local;
  const detail = (await repository.get('EQ-1')).data;
  assert.equal(detail.id, 'eq-1');
  assert.deepEqual(Array.from(detail.path, node => node.id), ['root', 'factory-1', 'cat-1', 'area', 'eq-1']);
  assert.equal(detail.factory_id, 'factory-1');
  assert.equal(detail.category_id, 'cat-1');
  assert.deepEqual(Array.from(detail.children), []);
  const filters = await repository.filters();
  assert.equal(filters.factories[0].id, 'factory-1');
  assert.equal(filters.categories[0].id, 'cat-1');
});

test('local compatibility adapter prevents a cyclic tree move', async () => {
  const repository = loadAdapter().window.EquipmentRepository.local;
  await assert.rejects(() => repository.move('root', { parentId: 'eq-1' }), /TREE_CYCLE/);
});
