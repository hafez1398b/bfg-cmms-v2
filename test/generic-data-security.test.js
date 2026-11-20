'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { createGenericDataHandlers } = require('../server/generic-data');
const { createUserRouter } = require('../server/user-routes');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

async function listen(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function genericApp({ pool, hasPermission, user = { id:'u-1', name:'کاربر', role:'tech' } }) {
  const app = express();
  app.use(express.json());
  const handlers = createGenericDataHandlers({ pool, hasPermission });
  const authenticate = (req, _res, next) => { req.user = user; next(); };
  app.get('/api/data/:collection', authenticate, handlers.read);
  app.post('/api/data/:collection', authenticate, handlers.rejectWrite);
  app.put('/api/data/:collection/:id', authenticate, handlers.rejectWrite);
  app.delete('/api/data/:collection/:id', authenticate, handlers.rejectWrite);
  return app;
}

function noQueryPool() {
  return {
    calls:[],
    async query(...args) {
      this.calls.push(args);
      throw new Error('data query must not execute');
    }
  };
}

test('authenticated users without permission cannot read users or auditX and no data query executes', async () => {
  const pool = noQueryPool();
  const checked = [];
  const app = genericApp({ pool, hasPermission:async (_user, permission) => { checked.push(permission); return false; } });
  await listen(app, async base => {
    for (const collection of ['users','auditX']) {
      const response = await fetch(`${base}/api/data/${collection}`);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, 'PERMISSION_DENIED');
    }
  });
  assert.deepEqual(checked, ['users.view','audit.view']);
  assert.equal(pool.calls.length, 0);
});

test('allowed compatibility reads use fixed approved columns only', async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql);
      if (/FROM users/.test(sql)) return { rows:[{ id:'tech-1', name:'تکنسین', role:'tech' }] };
      if (/FROM audit_x/.test(sql)) return { rows:[{ id:'audit-1', action:'create', mod:'users', entity:'user-1' }] };
      throw new Error('unexpected query');
    }
  };
  const app = genericApp({ pool, user:{ id:'admin-1', name:'مدیر', role:'admin' }, hasPermission:async () => true });
  await listen(app, async base => {
    const users = await (await fetch(`${base}/api/data/users`)).json();
    assert.deepEqual(users, [{ id:'tech-1', name:'تکنسین', role:'tech' }]);
    const audit = await (await fetch(`${base}/api/data/auditX`)).json();
    assert.deepEqual(audit, [{ id:'audit-1', action:'create', mod:'users', entity:'user-1' }]);
  });
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[0], /\b(?:username|unit|phone|hr|pass_hash)\b/i);
  assert.doesNotMatch(calls[1], /\b(?:before|after)\b/i);
  assert.ok(calls.every(sql => !/SELECT\s+\*/i.test(sql)));
});

test('generic POST rejects users, arbitrary collections and arbitrary columns before database access', async () => {
  const pool = noQueryPool();
  let permissionChecks = 0;
  const app = genericApp({ pool, hasPermission:async () => { permissionChecks += 1; return true; } });
  await listen(app, async base => {
    const userCreate = await fetch(`${base}/api/data/users`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ username:'attacker', password:'long-enough-password', role:'admin' })
    });
    assert.equal(userCreate.status, 403);
    assert.equal((await userCreate.json()).error, 'GENERIC_USER_CREATE_FORBIDDEN');

    const arbitrary = await fetch(`${base}/api/data/caller_table`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ 'caller_column; DROP TABLE users; --':'value' })
    });
    assert.equal(arbitrary.status, 400);
    assert.equal((await arbitrary.json()).error, 'COLLECTION_NOT_WRITABLE');
  });
  assert.equal(permissionChecks, 0);
  assert.equal(pool.calls.length, 0);
});

test('operational generic writes and reads are redirected to fixed domain APIs without a query', async () => {
  const pool = noQueryPool();
  const app = genericApp({ pool, hasPermission:async () => true });
  const expected = new Map([
    ['assets','/api/equipment'],
    ['requests','/api/requests'], ['wos','/api/work-orders'], ['work_orders','/api/work-orders'],
    ['pms','/api/pm-plans'], ['pm_plans','/api/pm-plans'],
    ['items','/api/items'], ['stock_docs','/api/inventory/ledger'], ['stockDocs','/api/inventory/ledger'],
    ['costEntries','/api/cost-entries'], ['cost_entries','/api/cost-entries'], ['warehouses','/api/warehouses'],
    ['inventory','/api/inventory/ledger']
  ]);
  await listen(app, async base => {
    for (const [collection, endpoint] of expected) {
      const response = await fetch(`${base}/api/data/${collection}`, {
        method:'POST', headers:{ 'content-type':'application/json' }, body:'{}'
      });
      assert.equal(response.status, 409, collection);
      assert.equal((await response.json()).endpoint, endpoint, collection);
    }
    const assetRead = await fetch(`${base}/api/data/assets`);
    assert.equal(assetRead.status, 409);
    assert.equal((await assetRead.json()).endpoint, '/api/equipment');
  });
  assert.equal(pool.calls.length, 0);
});

test('compatibility operational collections fail closed when equipment/factory scope cannot be proven', async () => {
  const pool = noQueryPool();
  let permissionChecks = 0;
  const app = genericApp({ pool, user:{ id:'cal-1', name:'کالیبراسیون', role:'cal' }, hasPermission:async () => { permissionChecks += 1; return true; } });
  await listen(app, async base => {
    for (const collection of ['tools','instruments','permits','leaves','planEvents','comments']) {
      const response = await fetch(`${base}/api/data/${collection}`);
      assert.equal(response.status, 403, collection);
      assert.equal((await response.json()).error, 'SCOPE_DENIED', collection);
    }
  });
  assert.equal(permissionChecks, 0);
  assert.equal(pool.calls.length, 0);
});

test('unknown generic reads are rejected before permission or data queries', async () => {
  const pool = noQueryPool();
  let permissionChecks = 0;
  const app = genericApp({ pool, hasPermission:async () => { permissionChecks += 1; return true; } });
  await listen(app, async base => {
    const response = await fetch(`${base}/api/data/not_a_collection`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'COLLECTION_NOT_ALLOWED');
  });
  assert.equal(permissionChecks, 0);
  assert.equal(pool.calls.length, 0);
});

test('generic data implementation contains no caller-derived SQL identifiers', () => {
  const source = read('server/generic-data.js');
  const server = read('server.js');
  assert.doesNotMatch(source, /Object\.keys\s*\(\s*(?:data|req\.body)/);
  assert.doesNotMatch(source, /\+\s*collection|collection\s*\+/);
  assert.doesNotMatch(source, /\$\{\s*collection\s*\}/);
  assert.doesNotMatch(server, /Object\.keys\s*\(\s*data\s*\)/);
  assert.doesNotMatch(server, /SELECT\s+\*\s+FROM\s*['"`]\s*\+|INSERT\s+INTO\s*['"`]\s*\+/i);
  assert.match(server, /app\.post\('\/api\/data\/:collection', authenticateToken, genericData\.rejectWrite\)/);
});

function userPool() {
  const state = { poolQueries:[], clientQueries:[], connected:0, released:0 };
  const client = {
    async query(sql, params=[]) {
      state.clientQueries.push({ sql, params });
      if (/INSERT INTO users/.test(sql)) {
        return { rows:[{ id:params[0], name:params[3], role:params[4], unit:params[5], phone:params[6], active:true }] };
      }
      return { rows:[] };
    },
    release() { state.released += 1; }
  };
  return {
    state,
    async query(sql) {
      state.poolQueries.push(sql);
      return { rows:[{ id:'tech-1', name:'تکنسین', role:'tech' }] };
    },
    async connect() { state.connected += 1; return client; }
  };
}

function usersApp({ pool, hasPermission, user, hashPassword, generateId }) {
  const app = express();
  app.use(express.json());
  app.use('/api/users', createUserRouter({
    pool,
    authenticateToken(req, _res, next) { req.user = user || { id:'actor-1', name:'مدیر', username:'admin', role:'admin' }; next(); },
    hasPermission,
    hashPassword,
    generateId
  }));
  return app;
}

test('dedicated user directory enforces permission and returns only assignment fields', async () => {
  const deniedPool = userPool();
  await listen(usersApp({ pool:deniedPool, hasPermission:async () => false }), async base => {
    const response = await fetch(`${base}/api/users/directory`);
    assert.equal(response.status, 403);
  });
  assert.equal(deniedPool.state.poolQueries.length, 0);

  const allowedPool = userPool();
  await listen(usersApp({ pool:allowedPool, hasPermission:async (_user, permission) => permission === 'pm.view' }), async base => {
    const response = await fetch(`${base}/api/users/directory`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, [{ id:'tech-1', name:'تکنسین', role:'tech' }]);
  });
  assert.equal(allowedPool.state.poolQueries.length, 1);
  assert.doesNotMatch(allowedPool.state.poolQueries[0], /\b(?:username|unit|phone|hr|pass_hash)\b/i);
});

test('dedicated user creation rejects missing permission, unlisted roles and non-admin administrator creation before insert', async () => {
  const deniedPool = userPool();
  await listen(usersApp({ pool:deniedPool, hasPermission:async () => false }), async base => {
    const response = await fetch(`${base}/api/users`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ username:'new.user', password:'a-secure-password', name:'کاربر', role:'tech' })
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'PERMISSION_DENIED');
  });
  assert.equal(deniedPool.state.connected, 0);

  const rolePool = userPool();
  let checks = 0;
  const app = usersApp({
    pool:rolePool,
    user:{ id:'mgr-1', name:'مدیر نت', role:'mgr' },
    hasPermission:async () => { checks += 1; return true; }
  });
  await listen(app, async base => {
    const admin = await fetch(`${base}/api/users`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ username:'bad.admin', password:'a-secure-password', name:'مهاجم', role:'admin' })
    });
    assert.equal(admin.status, 403);
    assert.equal((await admin.json()).error, 'SYSTEM_ADMIN_REQUIRED');
    const unknown = await fetch(`${base}/api/users`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ username:'bad.role', password:'a-secure-password', name:'مهاجم', role:'root' })
    });
    assert.equal(unknown.status, 422);
    assert.equal((await unknown.json()).error, 'USER_ROLE_INVALID');
  });
  assert.equal(checks, 0);
  assert.equal(rolePool.state.connected, 0);
});

test('dedicated user creation enforces the current password policy before hashing or insert', async () => {
  const pool = userPool();
  let hashCalls = 0;
  await listen(usersApp({
    pool,
    hasPermission:async (_user, permission) => permission === 'users.create',
    hashPassword:async () => { hashCalls += 1; return 'must-not-run'; }
  }), async base => {
    const response = await fetch(`${base}/api/users`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ username:'short.pass', password:'too-short', name:'کاربر', role:'tech' })
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, 'PASSWORD_POLICY_FAILED');
  });
  assert.equal(hashCalls, 0);
  assert.equal(pool.state.connected, 0);
});

test('system administrator creation uses a server id, role allowlist and secret-free response/audit', async () => {
  const pool = userPool();
  const ids = ['server-user-id','audit-id'];
  await listen(usersApp({
    pool,
    hasPermission:async (_user, permission) => permission === 'users.create',
    hashPassword:async password => { assert.equal(password, 'a-secure-password'); return 'bcrypt-hash-value'; },
    generateId:() => ids.shift()
  }), async base => {
    const response = await fetch(`${base}/api/users`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ id:'caller-id', username:'new.admin', password:'a-secure-password', name:'مدیر جدید', role:'admin', unit:'مدیریت', phone:'09120000000' })
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.deepEqual(body.data, { id:'server-user-id', name:'مدیر جدید', role:'admin', active:true });
    assert.equal(JSON.stringify(body).includes('new.admin'), false);
    assert.equal(JSON.stringify(body).includes('password'), false);
    assert.equal(JSON.stringify(body).includes('hash'), false);
  });

  const insert = pool.state.clientQueries.find(call => /INSERT INTO users/.test(call.sql));
  const audit = pool.state.clientQueries.find(call => /INSERT INTO audit_x/.test(call.sql));
  assert.ok(insert);
  assert.deepEqual(insert.params.slice(0, 3), ['server-user-id','new.admin','bcrypt-hash-value']);
  assert.ok(audit);
  const auditText = JSON.stringify(audit.params);
  assert.equal(auditText.includes('a-secure-password'), false);
  assert.equal(auditText.includes('bcrypt-hash-value'), false);
  assert.equal(auditText.includes('new.admin'), false);
  assert.match(audit.sql, /'create','users'/);
  assert.equal(pool.state.released, 1);
});
