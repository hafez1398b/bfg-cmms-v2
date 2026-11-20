'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rootDir = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(rootDir, file), 'utf8');

function createClientHarness({ pms, assets, wos } = {}) {
  const DB = {
    pms: Array.isArray(pms) ? [...pms] : [],
    assets: Array.isArray(assets) ? [...assets] : [],
    wos: Array.isArray(wos) ? [...wos] : []
  };
  const window = {
    BFGMaintenance: {
      installed: false,
      writing: false,
      originals: {},
      pm: { includeArchived: false, selectedId: null, loading: false, loaded: false, error: null, busy: new Set(), details: null, occurrenceDetails: null }
    },
    BFGRuntime: { state: { config: { apiBasePath: '/api' } }, isServerOnly: () => true },
    bfgApi: async () => { return { data: [] }; },
    toast: () => {}
  };
  const context = vm.createContext({ window, DB, Date, Set, Map, Number, String, Array, Object, Promise, JSON });
  vm.runInContext(read('public/platform-v2/maintenance-client.js'), context, { filename: 'maintenance-client.js' });
  return { window, DB, BFGMaintenance: window.BFGMaintenance };
}

test('maintenance-client getCollection exposes real lexical store for pms, assets, wos', () => {
  const pms = [{ id: 'plan-1', title: 'PM One' }];
  const assets = [{ id: 'asset-1', name: 'Asset One' }];
  const wos = [{ id: 'wo-1', no: 'WO-001' }];
  const { window, BFGMaintenance } = createClientHarness({ pms, assets, wos });

  // window.DB must not be defined
  assert.ok(!('DB' in window));
  assert.ok(BFGMaintenance.getCollection);

  assert.deepEqual(BFGMaintenance.getCollection('pms'), pms);
  assert.deepEqual(BFGMaintenance.getCollection('assets'), assets);
  assert.deepEqual(BFGMaintenance.getCollection('wos'), wos);
});

test('getCollection returns defensive copies that do not mutate the lexical store', () => {
  const pms = [{ id: 'plan-1', title: 'PM One' }];
  const { BFGMaintenance, DB } = createClientHarness({ pms });

  const copy = BFGMaintenance.getCollection('pms');
  assert.notStrictEqual(copy, DB.pms);
  copy.push({ id: 'plan-injected', title: 'Injected' });
  assert.deepEqual(BFGMaintenance.getCollection('pms'), pms);
  assert.deepEqual(DB.pms, pms);
});

test('getCollection returns empty array for invalid/non-allowlisted collections', () => {
  const { BFGMaintenance } = createClientHarness();

  for (const name of ['requests', 'users', '', null]) {
    const result = BFGMaintenance.getCollection(name);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 0);
  }
  // Valid collection with no data returns empty array copy
  const pmsResult = BFGMaintenance.getCollection('pms');
  assert.ok(Array.isArray(pmsResult));
  assert.strictEqual(pmsResult.length, 0);
  assert.notStrictEqual(pmsResult, undefined);
});

test('getCollection returns empty array when collection is not an array', () => {
  const { BFGMaintenance } = createClientHarness({ pms: null });

  assert.deepEqual(BFGMaintenance.getCollection('pms'), []);
});
