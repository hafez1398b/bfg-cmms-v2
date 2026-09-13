'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createEquipmentRouter } = require('../server/equipment-routes');

async function withApi(pool, role, run) {
  const app = express();
  app.use(express.json());
  app.use('/api/equipment', createEquipmentRouter({
    pool,
    io: { emit() {} },
    authenticateToken(req, _res, next) {
      req.user = { id: 'test-user', username: 'tester', name: 'Tester', role };
      next();
    }
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}/api/equipment`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('feature endpoint returns the persisted Equipment V2 flag', async () => {
  const pool = { query: async sql => {
    assert.match(sql, /feature_flags/);
    return { rows: [{ key: 'equipment_v2', enabled: true, rollout_percent: 100 }] };
  }};
  await withApi(pool, 'admin', async base => {
    const response = await fetch(`${base}/feature`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).enabled, true);
  });
});

test('route-level RBAC blocks technician mutation before database access', async () => {
  const pool = {
    query: async () => { throw new Error('database must not be called'); },
    connect: async () => { throw new Error('database must not be called'); }
  };
  await withApi(pool, 'tech', async base => {
    const response = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'EQ-1', name: 'Pump', nodeKind: 'equipment' }) });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'EQUIPMENT_PERMISSION_DENIED');
  });
});

test('detail route derives passport sections and an ancestry breadcrumb', async () => {
  const pool = { query: async (sql, values) => {
    assert.deepEqual(values, ['eq-1']);
    if (/WITH RECURSIVE ancestry/.test(sql)) return { rows: [{ id: 'factory-1', code: 'B1', name: 'بسپار ۱', type: 'site', nodeKind: 'factory', depth: 1 }, { id: 'eq-1', code: 'EQ-1', name: 'Pump', type: 'eq', nodeKind: 'equipment', depth: 0 }] };
    assert.match(sql, /pm_plans/);
    assert.match(sql, /asset_spare_parts/);
    assert.match(sql, /maintenance_history/);
    assert.match(sql, /lower\(a\.code\)=lower\(\$1\)/);
    return { rows: [{ id: 'eq-1', code: 'EQ-1', ext: {}, pm_plans: [], work_orders: [], maintenance_history: [], requests: [], spare_parts: [], children: [], documents: [] }] };
  }};
  await withApi(pool, 'tech', async base => {
    const response = await fetch(`${base}/eq-1`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.pm_plans, []);
    assert.deepEqual(body.data.maintenance_history, []);
    assert.equal(body.data.path[0].id, 'factory-1');
    assert.deepEqual(body.data.children, []);
  });
});

test('filter endpoint returns factories and normalized category ownership', async () => {
  let call = 0;
  const pool = { query: async () => ++call === 1
    ? { rows: [{ id: 'factory-1', code: 'B1', name: 'بسپار ۱' }] }
    : { rows: [{ id: 'cat-1', code: 'PROD', name: 'تولید', factory_asset_id: 'factory-1' }] }
  };
  await withApi(pool, 'planner', async base => {
    const response = await fetch(`${base}/filters`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.factories[0].id, 'factory-1');
    assert.equal(body.categories[0].factory_id, 'factory-1');
  });
});

test('list route uses bounded pagination parameters and reports PostgreSQL source', async () => {
  const calls = [];
  const pool = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (/count\(\*\)::int total/.test(sql)) return { rows: [{ total: 1 }] };
    return { rows: [{ id: 'eq-1', code: 'EQ-1', name: 'Pump' }] };
  }};
  await withApi(pool, 'planner', async base => {
    const response = await fetch(`${base}?limit=9999&page=2&sort=unsafe&direction=desc&q=pump`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, 'postgresql');
    assert.equal(body.pagination.limit, 200);
    assert.equal(body.pagination.page, 2);
    assert.deepEqual(calls[1].values.slice(-2), [200, 200]);
    assert.match(calls[1].sql, /ORDER BY a\.sort_order DESC/);
  });
});
