'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_FAIL_LIMIT = 5;
const ACCESS_COOKIE = 'bfg_access';
const REFRESH_COOKIE = 'bfg_refresh';
const CSRF_COOKIE = 'bfg_csrf';
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('bfg-invalid-login-placeholder', 10);

function createSessionService({ pool, jwtSecret, env = process.env, clock = () => new Date() } = {}) {
  function isProduction() {
    return env.NODE_ENV === 'production';
  }

  function coded(status, code) {
    const error = new Error(code);
    error.status = status;
    error.code = code;
    return error;
  }

  function secret() {
    if (!jwtSecret || String(jwtSecret).length < 32) throw coded(500, 'AUTHENTICATION_UNAVAILABLE');
    return String(jwtSecret);
  }

  function hmac(value) {
    return crypto.createHmac('sha256', secret()).update(String(value)).digest('hex');
  }

  function safeEqual(left, right) {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    if (!a.length || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  function parseCookies(header) {
    const out = {};
    String(header || '').split(';').forEach(part => {
      const idx = part.indexOf('=');
      if (idx < 1) return;
      const name = part.slice(0, idx).trim();
      try { out[name] = decodeURIComponent(part.slice(idx + 1).trim()); }
      catch (_) { out[name] = part.slice(idx + 1).trim(); }
    });
    return out;
  }

  function readCookie(req, name) {
    return parseCookies(req.headers && (req.headers.cookie || req.headers.Cookie))[name] || '';
  }

  function header(req, name) {
    if (typeof req.get === 'function') return req.get(name) || '';
    const headers = req.headers || {};
    return headers[name.toLowerCase()] || headers[name] || '';
  }

  function clientIp(req) {
    return String(req.ip || 'unknown').trim().slice(0, 64) || 'unknown';
  }

  function setCookie(res, name, value, path, { httpOnly, maxAge }) {
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `Max-Age=${maxAge}`, 'SameSite=Strict'];
    if (httpOnly) parts.push('HttpOnly');
    if (isProduction()) parts.push('Secure');
    const line = parts.join('; ');
    if (typeof res.append === 'function') res.append('Set-Cookie', line);
    else if (typeof res.setHeader === 'function') {
      const current = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : undefined;
      res.setHeader('Set-Cookie', current ? [].concat(current, line) : line);
    }
  }

  function clearCookie(res, name, path, httpOnly) {
    setCookie(res, name, '', path, { httpOnly, maxAge: 0 });
  }

  function clearAuthCookies(res) {
    clearCookie(res, ACCESS_COOKIE, '/', true);
    clearCookie(res, REFRESH_COOKIE, '/api/auth', true);
  }

  function issueCsrf(res, maxAge = REFRESH_TTL_SECONDS) {
    const token = crypto.randomBytes(32).toString('base64url');
    setCookie(res, CSRF_COOKIE, token, '/', { httpOnly: false, maxAge });
    return token;
  }

  function ensureCsrfCookie(req, res) {
    const existing = readCookie(req, CSRF_COOKIE);
    if (existing) return existing;
    return issueCsrf(res);
  }

  function assertCsrf(req) {
    const presented = String(header(req, 'x-csrf-token') || '');
    const cookie = readCookie(req, CSRF_COOKIE);
    if (!presented || !cookie || !safeEqual(presented, cookie)) throw coded(403, 'CSRF_FAILED');
    return presented;
  }

  function publicUser(user) {
    return { id: user.id, username: user.username, name: user.name, role: user.role, unit: user.unit };
  }

  function secondsUntil(expiresAt) {
    const remainingMs = new Date(expiresAt).getTime() - clock().getTime();
    return Math.max(0, Math.ceil(remainingMs / 1000));
  }

  function active(session) {
    if (!session || session.revoked_at) return false;
    return secondsUntil(session.absolute_expires_at) > 0;
  }

  async function resolveUser(id) {
    const { rows } = await pool.query(
      'SELECT id, username, name, role, unit, active FROM users WHERE id=$1 AND active=true',
      [id]
    );
    return rows[0] || null;
  }

  async function loadSession(id) {
    const { rows } = await pool.query(
      `SELECT id, user_id, refresh_token_hash, previous_refresh_token_hash, csrf_token_hash, absolute_expires_at, revoked_at
       FROM auth_sessions WHERE id=$1`,
      [id]
    );
    return rows[0] || null;
  }

  async function findByHash(column, hash) {
    if (column !== 'refresh_token_hash' && column !== 'previous_refresh_token_hash') throw coded(500, 'AUTHENTICATION_UNAVAILABLE');
    const { rows } = await pool.query(
      `SELECT id, user_id, refresh_token_hash, previous_refresh_token_hash, csrf_token_hash, absolute_expires_at, revoked_at
       FROM auth_sessions WHERE ${column}=$1`,
      [hash]
    );
    return rows[0] || null;
  }

  function signAccess(user, sessionId, ttl) {
    return jwt.sign(
      { sub: user.id, sid: sessionId, typ: 'access' },
      secret(),
      { algorithm: 'HS256', expiresIn: ttl }
    );
  }

  function verifyAccess(token) {
    try {
      const claims = jwt.verify(token, secret(), { algorithms: ['HS256'] });
      if (claims.typ !== 'access' || !claims.sid || !claims.sub) throw coded(403, 'INVALID_ACCESS_TOKEN');
      return claims;
    } catch (error) {
      if (error.code === 'INVALID_ACCESS_TOKEN') throw error;
      throw coded(error.name === 'TokenExpiredError' ? 401 : 403, 'INVALID_ACCESS_TOKEN');
    }
  }

  function bearer(req) {
    const value = header(req, 'authorization');
    return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
  }

  function accessToken(req) {
    return readCookie(req, ACCESS_COOKIE) || bearer(req);
  }

  function writeSessionCookies(res, user, sessionId, refreshToken, csrfToken, absoluteExpiresAt) {
    const refreshTtl = Math.min(REFRESH_TTL_SECONDS, secondsUntil(absoluteExpiresAt));
    const accessTtl = Math.min(ACCESS_TTL_SECONDS, refreshTtl);
    setCookie(res, ACCESS_COOKIE, signAccess(user, sessionId, accessTtl), '/', { httpOnly: true, maxAge: accessTtl });
    setCookie(res, REFRESH_COOKIE, refreshToken, '/api/auth', { httpOnly: true, maxAge: refreshTtl });
    setCookie(res, CSRF_COOKIE, csrfToken, '/', { httpOnly: false, maxAge: refreshTtl });
  }

  async function createSession(user, csrfToken, req) {
    const sessionId = crypto.randomUUID();
    const refreshToken = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(clock().getTime() + REFRESH_TTL_SECONDS * 1000);
    await pool.query(
      `INSERT INTO auth_sessions
        (id, user_id, refresh_token_hash, csrf_token_hash, absolute_expires_at, user_agent, ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        sessionId,
        user.id,
        hmac(refreshToken),
        hmac(csrfToken),
        expires.toISOString(),
        String(header(req, 'user-agent') || '').slice(0, 256),
        hmac(clientIp(req))
      ]
    );
    return { sessionId, refreshToken, expiresAt: expires.toISOString() };
  }

  async function revokeSession(id, reason) {
    await pool.query(
      'UPDATE auth_sessions SET revoked_at=now(), revoked_reason=$2 WHERE id=$1 AND revoked_at IS NULL',
      [id, reason]
    );
  }

  async function revokeAllForUser(userId, reason) {
    await pool.query(
      'UPDATE auth_sessions SET revoked_at=now(), revoked_reason=$2 WHERE user_id=$1 AND revoked_at IS NULL',
      [userId, reason]
    );
  }

  async function authenticate(req) {
    const token = accessToken(req);
    if (!token) throw coded(401, 'AUTHENTICATION_REQUIRED');
    const claims = verifyAccess(token);
    const session = await loadSession(claims.sid);
    if (!active(session) || session.user_id !== claims.sub) throw coded(401, 'SESSION_REVOKED');
    const user = await resolveUser(claims.sub);
    if (!user) throw coded(401, 'USER_INACTIVE_OR_MISSING');
    req.sessionId = session.id;
    req.session = session;
    return user;
  }

  async function assertSessionCsrf(req) {
    const csrf = assertCsrf(req);
    const token = accessToken(req);
    if (!token) throw coded(401, 'AUTHENTICATION_REQUIRED');
    const claims = verifyAccess(token);
    const session = await loadSession(claims.sid);
    if (!active(session) || session.user_id !== claims.sub) throw coded(401, 'SESSION_REVOKED');
    if (!safeEqual(hmac(csrf), session.csrf_token_hash)) throw coded(403, 'CSRF_FAILED');
    req.session = session;
    req.sessionId = session.id;
    return session;
  }

  async function presentedRefresh(req) {
    const refreshToken = readCookie(req, REFRESH_COOKIE);
    if (!refreshToken) return { refreshToken: '', current: null, reused: null };
    const hash = hmac(refreshToken);
    const current = await findByHash('refresh_token_hash', hash);
    if (current) return { refreshToken, current, reused: null };
    const reused = await findByHash('previous_refresh_token_hash', hash);
    if (reused) await revokeAllForUser(reused.user_id, 'refresh_reuse');
    return { refreshToken, current: null, reused };
  }

  async function assertRefreshCsrf(req) {
    const csrf = assertCsrf(req);
    const found = await presentedRefresh(req);
    if (found.reused || !found.refreshToken) throw coded(401, 'SESSION_REVOKED');
    if (!active(found.current)) throw coded(401, 'SESSION_REVOKED');
    if (!safeEqual(hmac(csrf), found.current.csrf_token_hash)) throw coded(403, 'CSRF_FAILED');
    req.session = found.current;
    req.sessionId = found.current.id;
    return found.current;
  }

  async function assertLogoutCsrf(req) {
    const csrf = assertCsrf(req);
    const found = await presentedRefresh(req);
    if (found.reused) throw coded(401, 'SESSION_REVOKED');
    let session = active(found.current) ? found.current : null;
    if (!session) {
      const token = accessToken(req);
      if (token) {
        try {
          const claims = verifyAccess(token);
          const loaded = await loadSession(claims.sid);
          if (active(loaded) && loaded.user_id === claims.sub) session = loaded;
        } catch (_) {}
      }
    }
    if (!session || !safeEqual(hmac(csrf), session.csrf_token_hash)) throw coded(403, 'CSRF_FAILED');
    req.session = session;
    req.sessionId = session.id;
    return session;
  }

  function subjectHash(username) {
    return hmac(String(username || '').trim().toLowerCase());
  }

  async function assertNotLimited(username, ip) {
    try {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS fails FROM login_attempts
         WHERE subject_hash=$1 AND ip_hash=$2 AND succeeded=false
           AND attempted_at > now() - interval '15 minutes'`,
        [subjectHash(username), hmac(ip)]
      );
      if (Number(rows[0] && rows[0].fails) >= LOGIN_FAIL_LIMIT) throw coded(429, 'LOGIN_RATE_LIMITED');
    } catch (error) {
      if (error.code === 'LOGIN_RATE_LIMITED') throw error;
      throw coded(500, 'AUTHENTICATION_UNAVAILABLE');
    }
  }

  async function recordAttempt(username, ip, succeeded) {
    try {
      await pool.query(
        'INSERT INTO login_attempts (id, subject_hash, ip_hash, succeeded) VALUES ($1,$2,$3,$4)',
        [crypto.randomUUID(), subjectHash(username), hmac(ip), succeeded]
      );
    } catch (_) {
      throw coded(500, 'AUTHENTICATION_UNAVAILABLE');
    }
  }

  async function login(req, res) {
    assertCsrf(req);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) throw coded(400, 'CREDENTIALS_REQUIRED');
    if (password.length > 200) throw coded(401, 'INVALID_CREDENTIALS');
    const ip = clientIp(req);
    await assertNotLimited(username, ip);
    let user = null;
    try {
      const result = await pool.query(
        'SELECT id, username, name, role, unit, active, pass_hash FROM users WHERE lower(username)=lower($1)',
        [username]
      );
      user = result.rows[0] || null;
    } catch (_) {
      throw coded(500, 'AUTHENTICATION_UNAVAILABLE');
    }
    const passwordOk = await bcrypt.compare(password, user && user.pass_hash ? user.pass_hash : DUMMY_PASSWORD_HASH);
    if (!user || !user.active || !passwordOk) {
      await recordAttempt(username, ip, false);
      throw coded(401, 'INVALID_CREDENTIALS');
    }
    await recordAttempt(username, ip, true);
    try {
      await pool.query(
        'DELETE FROM login_attempts WHERE subject_hash=$1 AND ip_hash=$2 AND succeeded=false',
        [subjectHash(username), hmac(ip)]
      );
    } catch (_) {}
    const csrf = crypto.randomBytes(32).toString('base64url');
    const issued = await createSession(user, csrf, req);
    writeSessionCookies(res, user, issued.sessionId, issued.refreshToken, csrf, issued.expiresAt);
    return { user: publicUser(user) };
  }

  async function refresh(req, res) {
    const csrf = assertCsrf(req);
    const found = await presentedRefresh(req);
    if (found.reused || !found.refreshToken) throw coded(401, 'SESSION_REVOKED');
    const current = found.current;
    if (!active(current)) throw coded(401, 'SESSION_REVOKED');
    if (!safeEqual(hmac(csrf), current.csrf_token_hash)) throw coded(403, 'CSRF_FAILED');
    const user = await resolveUser(current.user_id);
    if (!user) {
      await revokeSession(current.id, 'user_inactive');
      throw coded(401, 'USER_INACTIVE_OR_MISSING');
    }
    const nextRefresh = crypto.randomBytes(32).toString('base64url');
    const nextCsrf = crypto.randomBytes(32).toString('base64url');
    const updated = await pool.query(
      `UPDATE auth_sessions
       SET previous_refresh_token_hash=refresh_token_hash, refresh_token_hash=$2, csrf_token_hash=$3, rotated_at=now()
       WHERE id=$1 AND refresh_token_hash=$4 AND revoked_at IS NULL
       RETURNING id, absolute_expires_at`,
      [current.id, hmac(nextRefresh), hmac(nextCsrf), hmac(found.refreshToken)]
    );
    if (!updated.rowCount) throw coded(401, 'SESSION_REVOKED');
    writeSessionCookies(res, user, current.id, nextRefresh, nextCsrf, updated.rows[0].absolute_expires_at);
    return { user: publicUser(user) };
  }

  async function logout(req, res) {
    const found = await presentedRefresh(req);
    if (found.current) await revokeSession(found.current.id, 'logout');
    else {
      const token = accessToken(req);
      if (token) {
        try {
          const claims = verifyAccess(token);
          await revokeSession(claims.sid, 'logout');
        } catch (_) {}
      }
    }
    clearAuthCookies(res);
    issueCsrf(res);
    return { ok: true };
  }

  async function logoutAll(req, res) {
    const user = req.user || await authenticate(req);
    await revokeAllForUser(user.id, 'logout_all');
    clearAuthCookies(res);
    issueCsrf(res);
    return { ok: true };
  }

  async function socketUser(handshake) {
    const cookies = parseCookies(handshake && handshake.headers && handshake.headers.cookie);
    const token = cookies[ACCESS_COOKIE] || '';
    if (!token) return null;
    const claims = verifyAccess(token);
    const session = await loadSession(claims.sid);
    if (!active(session) || session.user_id !== claims.sub) return null;
    return resolveUser(claims.sub);
  }

  function pathOf(req) {
    return String(req.originalUrl || req.url || req.path || '').split('?')[0];
  }

  function isExact(req, suffix) {
    const path = pathOf(req);
    return path === suffix || path === `/api${suffix}` || req.path === suffix;
  }

  function mutationGuard() {
    return async function csrfGuard(req, res, next) {
      if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
      try {
        if (isExact(req, '/auth/login')) assertCsrf(req);
        else if (isExact(req, '/auth/refresh')) await assertRefreshCsrf(req);
        else if (isExact(req, '/auth/logout')) await assertLogoutCsrf(req);
        else await assertSessionCsrf(req);
        next();
      } catch (error) {
        const status = error.status && error.status < 500 ? error.status : 403;
        res.status(status).json({ error: status < 500 ? (error.code || 'CSRF_FAILED') : 'REQUEST_FAILED' });
      }
    };
  }

  function logSafe(message, error) {
    console.error(message, error && (error.code || error.name) || 'error');
  }

  return {
    ACCESS_TTL_SECONDS,
    REFRESH_TTL_SECONDS,
    LOGIN_FAIL_LIMIT,
    LOGIN_WINDOW_MINUTES,
    ACCESS_COOKIE,
    REFRESH_COOKIE,
    CSRF_COOKIE,
    authenticate,
    assertCsrf,
    assertSessionCsrf,
    ensureCsrfCookie,
    login,
    refresh,
    logout,
    logoutAll,
    socketUser,
    publicUser,
    logSafe,
    hmac,
    mutationGuard,
    isProduction
  };
}

module.exports = {
  createSessionService,
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  CSRF_COOKIE
};
