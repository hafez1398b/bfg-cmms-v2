'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createSessionService, ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS } = require('../server/session');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const secret = 'test-secret-at-least-32-characters';

function mockRes() {
  return { headers: [], append(name, value) { this.headers.push([name, value]); } };
}

function setCookies(res) {
  return res.headers.filter(([name]) => name.toLowerCase() === 'set-cookie').map(([, value]) => value);
}

function cookieValue(res, name) {
  const line = setCookies(res).find(item => item.startsWith(`${name}=`));
  if (!line) return '';
  return decodeURIComponent(line.slice(name.length + 1).split(';')[0]);
}

function request({ cookies = {}, headers = {}, body = {}, ip = '203.0.113.10' } = {}) {
  const cookie = Object.entries(cookies).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('; ');
  const all = { cookie };
  Object.entries(headers).forEach(([key, value]) => { all[key.toLowerCase()] = value; });
  return { ip, body, headers: all, get(name) { return all[String(name).toLowerCase()] || ''; } };
}

function memoryPool() {
  const sessions = [];
  const attempts = [];
  const users = [{
    id: 'u1', username: 'admin', name: 'حافظ بایرامیان', role: 'admin', unit: 'مدیریت سیستم', active: true,
    pass_hash: bcrypt.hashSync('correct-password', 4)
  }];
  return {
    sessions, attempts, users,
    async query(sql, params = []) {
      const text = String(sql);
      if (text.includes('lower(username)')) {
        const username = String(params[0] || '').toLowerCase();
        return { rows: users.filter(user => user.username.toLowerCase() === username) };
      }
      if (text.includes('FROM users') && text.includes('WHERE id=$1')) {
        return { rows: users.filter(user => user.id === params[0] && user.active) };
      }
      if (text.includes('INSERT INTO auth_sessions')) {
        sessions.push({
          id: params[0], user_id: params[1], refresh_token_hash: params[2], csrf_token_hash: params[3],
          absolute_expires_at: params[4], user_agent: params[5], ip_hash: params[6],
          previous_refresh_token_hash: null, revoked_at: null
        });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('previous_refresh_token_hash=refresh_token_hash')) {
        const row = sessions.find(session => session.id === params[0] && session.refresh_token_hash === params[3] && !session.revoked_at);
        if (!row) return { rows: [], rowCount: 0 };
        row.previous_refresh_token_hash = row.refresh_token_hash;
        row.refresh_token_hash = params[1];
        row.csrf_token_hash = params[2];
        return { rows: [{ id: row.id, absolute_expires_at: row.absolute_expires_at }], rowCount: 1 };
      }
      if (text.includes('UPDATE auth_sessions') && text.includes('WHERE user_id=$1')) {
        let count = 0;
        sessions.forEach(session => {
          if (session.user_id === params[0] && !session.revoked_at) {
            session.revoked_at = new Date().toISOString();
            session.revoked_reason = params[1];
            count += 1;
          }
        });
        return { rows: [], rowCount: count };
      }
      if (text.includes('UPDATE auth_sessions') && text.includes('WHERE id=$1')) {
        const row = sessions.find(session => session.id === params[0] && !session.revoked_at);
        if (row) {
          row.revoked_at = new Date().toISOString();
          row.revoked_reason = params[1];
        }
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      if (text.includes('WHERE previous_refresh_token_hash=$1')) {
        return { rows: sessions.filter(session => session.previous_refresh_token_hash === params[0]) };
      }
      if (text.includes('WHERE refresh_token_hash=$1')) {
        return { rows: sessions.filter(session => session.refresh_token_hash === params[0]) };
      }
      if (text.includes('FROM auth_sessions WHERE id=$1')) {
        return { rows: sessions.filter(session => session.id === params[0]) };
      }
      if (text.includes('FROM login_attempts')) {
        const fails = attempts.filter(attempt => attempt.subject_hash === params[0] && attempt.ip_hash === params[1] && attempt.succeeded === false).length;
        return { rows: [{ fails }] };
      }
      if (text.includes('INSERT INTO login_attempts')) {
        attempts.push({ subject_hash: params[1], ip_hash: params[2], succeeded: params[3] });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('DELETE FROM login_attempts')) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected sql: ${text}`);
    }
  };
}

function serviceFor(pool, env = { NODE_ENV: 'test' }, clock) {
  return createSessionService({ pool, jwtSecret: secret, env, clock });
}

async function login(service, poolEnv = {}) {
  const issued = service.ensureCsrfCookie({ headers: {} }, mockRes());
  const req = request({
    cookies: { bfg_csrf: issued },
    headers: { 'x-csrf-token': issued },
    body: { username: 'admin', password: 'correct-password', ...poolEnv.body }
  });
  const res = mockRes();
  const result = await service.login(req, res);
  return { req, res, result, csrf: cookieValue(res, 'bfg_csrf'), access: cookieValue(res, 'bfg_access'), refresh: cookieValue(res, 'bfg_refresh') };
}

test('session migration is additive and bootstrap schema contains the same tables', () => {
  const migration = read('migrations/006_auth_sessions.sql');
  const schema = read('schema.sql');
  for (const table of ['auth_sessions', 'login_attempts']) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /refresh_token_hash/);
  assert.match(migration, /previous_refresh_token_hash/);
  assert.doesNotMatch(migration, /\b(DROP|TRUNCATE|DELETE FROM)\b/i);
  assert.equal(ACCESS_TTL_SECONDS, 15 * 60);
  assert.equal(REFRESH_TTL_SECONDS, 12 * 60 * 60);
});

test('login sets host-only cookies and stores only a hashed refresh token', async () => {
  const pool = memoryPool();
  const service = serviceFor(pool, { NODE_ENV: 'production' });
  const { res, result, access, refresh } = await login(service);
  assert.equal(result.token, undefined);
  assert.equal(result.user.name, 'حافظ بایرامیان');
  assert.equal(JSON.stringify(result).includes('pass_hash'), false);
  assert.equal(JSON.stringify(result).includes(refresh), false);
  const accessLine = setCookies(res).find(item => item.startsWith('bfg_access='));
  const refreshLine = setCookies(res).find(item => item.startsWith('bfg_refresh='));
  const csrfLine = setCookies(res).find(item => item.startsWith('bfg_csrf='));
  assert.match(accessLine, /HttpOnly/);
  assert.match(accessLine, /Secure/);
  assert.match(accessLine, /SameSite=Strict/);
  assert.match(accessLine, /Path=\//);
  assert.match(accessLine, /Max-Age=900/);
  assert.doesNotMatch(accessLine, /Domain=/);
  assert.match(refreshLine, /HttpOnly/);
  assert.match(refreshLine, /Secure/);
  assert.match(refreshLine, /SameSite=Strict/);
  assert.match(refreshLine, /Path=\/api\/auth/);
  assert.match(refreshLine, /Max-Age=43200/);
  assert.doesNotMatch(csrfLine, /HttpOnly/);
  assert.match(csrfLine, /Secure/);
  assert.match(csrfLine, /SameSite=Strict/);
  const claims = jwt.decode(access);
  assert.equal(claims.typ, 'access');
  assert.equal(claims.sub, 'u1');
  assert.equal(claims.exp - claims.iat, 900);
  assert.notEqual(pool.sessions[0].refresh_token_hash, refresh);
  assert.equal(pool.sessions[0].refresh_token_hash, service.hmac(refresh));
  assert.notEqual(pool.sessions[0].ip_hash, '203.0.113.10');
  assert.equal(JSON.stringify(pool.attempts).includes('admin'), false);
  assert.equal(JSON.stringify(pool.attempts).includes('correct-password'), false);
});

test('development cookies are not Secure and mutating requests require CSRF', async () => {
  const pool = memoryPool();
  const service = serviceFor(pool, { NODE_ENV: 'development' });
  const { res } = await login(service);
  const accessLine = setCookies(res).find(item => item.startsWith('bfg_access='));
  assert.match(accessLine, /HttpOnly/);
  assert.match(accessLine, /SameSite=Strict/);
  assert.doesNotMatch(accessLine, /Secure/);
  const guard = service.mutationGuard();
  let status = 0;
  let body = null;
  await guard(
    { method: 'POST', path: '/data/assets', originalUrl: '/api/data/assets', headers: {}, get() { return ''; } },
    { status(code) { status = code; return this; }, json(payload) { body = payload; } },
    () => { throw new Error('csrf guard must reject'); }
  );
  assert.equal(status, 403);
  assert.equal(body.error, 'CSRF_FAILED');
  await assert.rejects(
    () => service.login(request({ body: { username: 'admin', password: 'correct-password' } }), mockRes()),
    error => error.code === 'CSRF_FAILED' && error.status === 403
  );
});

test('refresh rotates the hashed token and reuse revokes every device', async () => {
  const pool = memoryPool();
  const service = serviceFor(pool);
  const first = await login(service);
  const second = await login(service);
  assert.equal(pool.sessions.length, 2);
  const refreshed = mockRes();
  const rotated = await service.refresh(request({
    cookies: { bfg_refresh: first.refresh, bfg_csrf: first.csrf },
    headers: { 'x-csrf-token': first.csrf }
  }), refreshed);
  assert.equal(rotated.user.username, 'admin');
  const nextRefresh = cookieValue(refreshed, 'bfg_refresh');
  assert.notEqual(nextRefresh, first.refresh);
  assert.equal(pool.sessions[0].previous_refresh_token_hash, service.hmac(first.refresh));
  assert.equal(pool.sessions[0].refresh_token_hash, service.hmac(nextRefresh));
  await assert.rejects(
    () => service.refresh(request({
      cookies: { bfg_refresh: first.refresh, bfg_csrf: 'reuse-csrf-token' },
      headers: { 'x-csrf-token': 'reuse-csrf-token' }
    }), mockRes()),
    error => error.code === 'SESSION_REVOKED'
  );
  assert.ok(pool.sessions.every(session => session.revoked_at));
  assert.equal(pool.sessions.find(session => session.user_id === 'u1' && session.id !== pool.sessions[0].id).revoked_reason, 'refresh_reuse');
  await assert.rejects(
    () => service.refresh(request({
      cookies: { bfg_refresh: nextRefresh, bfg_csrf: cookieValue(refreshed, 'bfg_csrf') },
      headers: { 'x-csrf-token': cookieValue(refreshed, 'bfg_csrf') }
    }), mockRes()),
    error => error.code === 'SESSION_REVOKED'
  );
  await assert.rejects(
    () => service.authenticate(request({ cookies: { bfg_access: second.access } })),
    error => error.code === 'SESSION_REVOKED'
  );
});

test('logout revokes one session and logout-all revokes the account', async () => {
  const pool = memoryPool();
  const service = serviceFor(pool);
  const first = await login(service);
  const second = await login(service);
  const loggedOut = mockRes();
  await service.logout(request({ cookies: { bfg_refresh: first.refresh, bfg_access: first.access } }), loggedOut);
  assert.equal(pool.sessions[0].revoked_reason, 'logout');
  assert.equal(pool.sessions[1].revoked_at, null);
  assert.match(setCookies(loggedOut).find(item => item.startsWith('bfg_access=')), /Max-Age=0/);
  await assert.rejects(
    () => service.authenticate(request({ cookies: { bfg_access: first.access } })),
    error => error.code === 'SESSION_REVOKED'
  );
  await service.logoutAll({ user: { id: 'u1' }, headers: {} }, mockRes());
  assert.equal(pool.sessions[1].revoked_reason, 'logout_all');
  await assert.rejects(
    () => service.authenticate(request({ cookies: { bfg_access: second.access } })),
    error => error.code === 'SESSION_REVOKED'
  );
});

test('refresh cannot extend the absolute 12-hour session', async () => {
  const pool = memoryPool();
  let now = Date.parse('2026-10-04T08:00:00Z');
  const service = serviceFor(pool, { NODE_ENV: 'test' }, () => new Date(now));
  const started = await login(service);
  const originalExpiry = pool.sessions[0].absolute_expires_at;
  now += 60 * 60 * 1000;
  const refreshed = mockRes();
  await service.refresh(request({
    cookies: { bfg_refresh: started.refresh, bfg_csrf: started.csrf },
    headers: { 'x-csrf-token': started.csrf }
  }), refreshed);
  assert.equal(pool.sessions[0].absolute_expires_at, originalExpiry);
  now += 12 * 60 * 60 * 1000;
  await assert.rejects(
    () => service.refresh(request({
      cookies: { bfg_refresh: cookieValue(refreshed, 'bfg_refresh'), bfg_csrf: cookieValue(refreshed, 'bfg_csrf') },
      headers: { 'x-csrf-token': cookieValue(refreshed, 'bfg_csrf') }
    }), mockRes()),
    error => error.code === 'SESSION_REVOKED'
  );
  assert.equal(pool.sessions[0].absolute_expires_at, originalExpiry);
});

test('five failed logins lock the subject and database errors stay generic', async () => {
  const pool = memoryPool();
  const service = serviceFor(pool);
  const csrf = service.ensureCsrfCookie({ headers: {} }, mockRes());
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      () => service.login(request({
        cookies: { bfg_csrf: csrf },
        headers: { 'x-csrf-token': csrf },
        body: { username: 'admin', password: 'wrong-password' }
      }), mockRes()),
      error => error.code === 'INVALID_CREDENTIALS' && !String(error.message).includes('wrong-password')
    );
  }
  await assert.rejects(
    () => service.login(request({
      cookies: { bfg_csrf: csrf },
      headers: { 'x-csrf-token': csrf },
      body: { username: 'admin', password: 'correct-password' }
    }), mockRes()),
    error => error.code === 'LOGIN_RATE_LIMITED' && error.status === 429
  );
  pool.query = async sql => {
    const text = String(sql);
    if (text.includes('FROM login_attempts')) return { rows: [{ fails: 0 }] };
    if (text.includes('FROM users')) throw new Error('duplicate key password=SuperSecret token=abc');
    throw new Error(`unexpected sql: ${text}`);
  };
  await assert.rejects(
    () => service.login(request({
      cookies: { bfg_csrf: csrf },
      headers: { 'x-csrf-token': csrf },
      body: { username: 'admin', password: 'correct-password' }
    }), mockRes()),
    error => error.code === 'AUTHENTICATION_UNAVAILABLE' && !String(error.message).includes('SuperSecret')
  );
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try { service.logSafe('authentication failed', Object.assign(new Error('password=SuperSecret token=abc'), { code: '23505' })); }
  finally { console.error = original; }
  assert.match(lines[0], /23505/);
  assert.doesNotMatch(lines[0], /SuperSecret/);
  assert.doesNotMatch(lines[0], /token=abc/);
});

test('browser and server sources no longer expose a readable login token', () => {
  const client = read('public/platform-v2/backend-client.js');
  const adapter = read('public/equipment-v2/equipment-adapter.js');
  const ai = read('public/ai/ai-client.js');
  const html = read('public/index.html');
  const server = read('server.js');
  const realtime = read('server/realtime.js');
  assert.doesNotMatch(client, /setItem\('bfg_token'/);
  assert.match(client, /removeItem\('bfg_token'/);
  assert.match(client, /credentials:\s*'same-origin'/);
  assert.match(client, /x-csrf-token/);
  assert.match(client, /\/api\/auth\/logout-all/);
  assert.match(client, /showLoginPage/);
  assert.doesNotMatch(client, /Authorization/);
  assert.doesNotMatch(client, /auth:\s*\{\s*token/);
  assert.doesNotMatch(adapter, /bfg_token/);
  assert.doesNotMatch(adapter, /Authorization/);
  assert.match(adapter, /credentials:'same-origin'|window\.bfgApi/);
  assert.doesNotMatch(ai, /bfg_token/);
  assert.doesNotMatch(html, /bfg_token/);
  assert.match(html, /logoutAllDevices/);
  assert.doesNotMatch(server, /expiresIn:\s*'7d'/);
  assert.doesNotMatch(server, /err\.message/);
  assert.doesNotMatch(server, /error\.message/);
  assert.match(server, /sessions\.login/);
  assert.match(server, /\/api\/auth\/logout-all/);
  assert.doesNotMatch(realtime, /handshake\.auth/);
  assert.doesNotMatch(realtime, /error\.message/);
  assert.doesNotMatch(read('server/equipment-routes.js'), /message:e\.message/);
  assert.doesNotMatch(read('server/notification-routes.js'), /console\.error\('Notification API:',error\)/);
});
