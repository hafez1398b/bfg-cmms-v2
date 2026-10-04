'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveRuntimeConfig, SERVER_ONLY, LOCAL_DEVELOPMENT } = require('../server/runtime-config');
const policy = require('../public/platform-v2/runtime-policy');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: key => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
    setItem(key, value) { data[key] = String(value); },
    removeItem(key) { delete data[key]; },
    dump: () => ({ ...data })
  };
}

test('production runtime is server-only even if local compatibility is requested', () => {
  const config = resolveRuntimeConfig({
    NODE_ENV: 'production',
    EXECUTION_MODE: 'local-development',
    ALLOW_LOCAL_COMPATIBILITY: 'true'
  });
  assert.equal(config.executionMode, SERVER_ONLY);
  assert.equal(config.allowLocalCompatibility, false);
  assert.equal(config.apiBasePath, '/api');
  assert.equal(config.host, undefined);
  assert.equal(config.baseUrl, undefined);
});

test('development does not imply a local database unless both explicit switches are set', () => {
  assert.equal(resolveRuntimeConfig({}).executionMode, SERVER_ONLY);
  assert.equal(resolveRuntimeConfig({ NODE_ENV: 'development' }).allowLocalCompatibility, false);
  assert.equal(resolveRuntimeConfig({
    NODE_ENV: 'development',
    ALLOW_LOCAL_COMPATIBILITY: 'true'
  }).executionMode, SERVER_ONLY);
  assert.equal(resolveRuntimeConfig({
    NODE_ENV: 'development',
    EXECUTION_MODE: LOCAL_DEVELOPMENT
  }).executionMode, SERVER_ONLY);
  const explicit = resolveRuntimeConfig({
    NODE_ENV: 'development',
    EXECUTION_MODE: LOCAL_DEVELOPMENT,
    ALLOW_LOCAL_COMPATIBILITY: 'true'
  });
  assert.equal(explicit.executionMode, LOCAL_DEVELOPMENT);
  assert.equal(explicit.allowLocalCompatibility, true);
});

test('server route receives execution mode from the runtime resolver', () => {
  const source = read('server.js');
  assert.match(source, /resolveRuntimeConfig\(process\.env\)/);
  assert.doesNotMatch(source, /allowLocalCompatibility:process\.env\.ALLOW_LOCAL_COMPATIBILITY==='true'\|\|process\.env\.NODE_ENV!=='production'/);
});

test('client storage policy fails closed and never keeps AI keys', () => {
  const storage = memoryStorage({ bfg_cmms_v1: '{"users":[{"u":"admin"}]}', bfg_theme: 'dark' });
  policy.installStorageGuard(storage);
  assert.equal(policy.allowsSampleData(), false);
  assert.equal(policy.shouldPersistOperationalData(), false);
  const blocked = policy.block('BACKEND_UNREACHABLE');
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.executionMode, null);
  assert.equal(blocked.allowLocalCompatibility, false);
  assert.equal(storage.getItem('bfg_cmms_v1'), null);
  storage.setItem('bfg_cmms_v1', '{"assets":[{"id":"sample"}]}');
  assert.equal(storage.getItem('bfg_cmms_v1'), null);
  assert.equal(policy.emptyOperationalStore().users.length, 0);
  assert.equal(policy.emptyOperationalStore().__mfSeed, 1);
  const memory = { users: [{ u: 'admin' }], assets: [{ id: 'sample' }], perms: { enforce: true, roles: { tech: { tree: {} } }, v: 9 }, chats: { g1: { msgs: [1] } }, settings: { ai: { key: 'sk-live' } } };
  policy.resetStore(memory);
  assert.equal(memory.users.length, 0);
  assert.equal(memory.assets.length, 0);
  assert.equal(memory.perms.v, 9);
  assert.deepEqual(memory.chats, {});
  assert.equal(memory.settings.ai.key, '');
  assert.equal(policy.CONNECTION_ERROR_MESSAGE.includes('هیچ داده عملیاتی محلی'), true);

  const applied = policy.applyConfig({ environment: 'production', executionMode: 'server-only', allowLocalCompatibility: true });
  assert.equal(applied.executionMode, 'server-only');
  assert.equal(applied.allowLocalCompatibility, false);
  assert.equal(applied.config.apiBasePath, '/api');
  storage.setItem('bfg_theme', 'light');
  storage.setItem('bfg_lang', 'fa');
  storage.setItem('bfg_sb_mini', '1');
  storage.setItem('bfg_theme', 'sk-live-key');
  storage.setItem('bfg_lang', 'secret-token');
  storage.setItem('ai_api_key', 'sk-live-key');
  assert.equal(storage.getItem('bfg_theme'), 'light');
  assert.equal(storage.getItem('bfg_lang'), 'fa');
  assert.equal(storage.getItem('bfg_sb_mini'), '1');
  assert.equal(storage.getItem('ai_api_key'), null);
  assert.equal(storage.getItem('bfg_cmms_v1'), null);

  policy.applyConfig({ environment: 'development', executionMode: 'local-development', allowLocalCompatibility: true });
  storage.setItem('bfg_cmms_v1', JSON.stringify({
    settings: { ai: { key: 'sk-browser', model: 'demo' } },
    aiCfg: { apiKey: 'sk-browser', sttKey: 'stt-secret', provider: 'openai' }
  }));
  const saved = JSON.parse(storage.getItem('bfg_cmms_v1'));
  assert.equal(saved.settings.ai.key, '');
  assert.equal(saved.settings.ai.model, 'demo');
  assert.equal(saved.aiCfg.apiKey, '');
  assert.equal(saved.aiCfg.sttKey, '');
  assert.equal(policy.isAiSecretField('apiKey'), true);
  assert.equal(policy.isAiSecretField('key', 'ai'), true);
  assert.equal(policy.isAiSecretField('model', 'ai'), false);

  for (const config of [null, {}, { executionMode: 'local' }, { executionMode: 'local-development', allowLocalCompatibility: false }]) {
    const result = policy.applyConfig(config);
    assert.equal(result.status, 'blocked');
    assert.equal(result.allowLocalCompatibility, false);
    assert.equal(policy.allowsSampleData(), false);
    assert.equal(storage.getItem('bfg_cmms_v1'), null);
  }
});

test('client sources do not hardcode a backend address or revive local mode after a failed config fetch', () => {
  const html = read('public/index.html');
  const client = read('public/platform-v2/backend-client.js');
  const adapter = read('public/equipment-v2/equipment-adapter.js');
  const importer = read('public/data/besepar1-data.js');
  const cleanup = read('public/data/equipment-demo-cleanup.js');
  const compose = read('docker-compose.company.yml');
  assert.equal(html.includes('2.179.95.13'), false);
  assert.ok(html.indexOf('/platform-v2/runtime-policy.js') < html.indexOf('async function load()'));
  assert.match(html, /function bfgUseServerStore\(\)\{return !window\.BFGRuntime\|\|!window\.BFGRuntime\.shouldPersistOperationalData\(\);\}/);
  assert.match(html, /if\(bfgUseServerStore\(\)\)/);
  assert.match(html, /allowsSampleData\(\)/);
  assert.doesNotMatch(client, /allowLocalCompatibility\s*:\s*true/);
  assert.match(client, /fetch\('\/api\/runtime-config'/);
  assert.match(client, /showConnectionError/);
  assert.match(client, /policy\.block/);
  assert.match(adapter, /server-required/);
  assert.match(importer, /allowsSampleData/);
  assert.match(cleanup, /allowsSampleData/);
  assert.match(compose, /EXECUTION_MODE: server-only/);
  assert.match(read('.env.example'), /EXECUTION_MODE=server-only/);
});
