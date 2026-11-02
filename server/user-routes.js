'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { USER_DIRECTORY_SQL } = require('./generic-data');

const USER_ROLES = Object.freeze(['admin','mgr','planner','tech','op','store','hse','cal']);
const USER_ROLE_SET = new Set(USER_ROLES);
const MIN_PASSWORD_LENGTH = 12;

function text(value, maxLength) {
  return String(value == null ? '' : value).trim().slice(0, maxLength);
}

function publicCreatedUser(row) {
  return {
    id:row.id,
    name:row.name,
    role:row.role,
    active:row.active === true
  };
}

function createUserRouter({
  pool,
  authenticateToken,
  hasPermission,
  hashPassword = password => bcrypt.hash(password, 12),
  generateId = () => crypto.randomUUID()
}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new Error('USER_ROUTE_POOL_REQUIRED');
  if (typeof authenticateToken !== 'function') throw new Error('USER_ROUTE_AUTH_REQUIRED');
  if (typeof hasPermission !== 'function') throw new Error('USER_ROUTE_PERMISSION_CHECK_REQUIRED');

  const router = express.Router();
  router.use(authenticateToken);

  async function hasDirectoryPermission(user) {
    return await hasPermission(user, 'work_order.view') || await hasPermission(user, 'pm.view');
  }

  router.get('/directory', async (req, res) => {
    try {
      if (!(await hasDirectoryPermission(req.user))) {
        return res.status(403).json({
          error:'PERMISSION_DENIED',
          permission:'work_order.view|pm.view',
          message:'مجوز مشاهده فهرست تخصیص کار وجود ندارد.'
        });
      }
      const { rows } = await pool.query(USER_DIRECTORY_SQL);
      return res.json({ data:rows, source:'postgresql' });
    } catch (error) {
      const postgresCode = typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : 'unknown';
      console.error(`[users-api] directory_failed postgres_code=${postgresCode}`);
      return res.status(500).json({ error:'USER_DIRECTORY_FAILED', message:'دریافت فهرست کاربران انجام نشد.' });
    }
  });

  router.post('/', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const role = text(body.role, 32);

    // Validate role and the high-risk administrator transition before any database access.
    if (!USER_ROLE_SET.has(role)) {
      return res.status(422).json({ error:'USER_ROLE_INVALID', message:'نقش انتخاب‌شده مجاز نیست.' });
    }
    if (role === 'admin' && req.user?.role !== 'admin') {
      return res.status(403).json({
        error:'SYSTEM_ADMIN_REQUIRED',
        message:'فقط مدیر سیستم می‌تواند مدیر سیستم دیگری ایجاد کند.'
      });
    }

    try {
      if (!(await hasPermission(req.user, 'users.create'))) {
        return res.status(403).json({
          error:'PERMISSION_DENIED',
          permission:'users.create',
          message:'مجوز ساخت کاربر وجود ندارد.'
        });
      }
    } catch (error) {
      return res.status(500).json({ error:'PERMISSION_CHECK_FAILED', message:'بررسی مجوز انجام نشد.' });
    }

    const username = text(body.username, 64);
    const name = text(body.name, 160);
    const unit = text(body.unit, 160) || null;
    const phone = text(body.phone, 40) || null;
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
      return res.status(422).json({ error:'USERNAME_INVALID', message:'نام کاربری باید ۳ تا ۶۴ نویسه مجاز داشته باشد.' });
    }
    if (!name) {
      return res.status(422).json({ error:'USER_NAME_REQUIRED', message:'نام کاربر الزامی است.' });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(422).json({
        error:'PASSWORD_POLICY_FAILED',
        message:`رمز عبور باید حداقل ${MIN_PASSWORD_LENGTH} نویسه باشد.`
      });
    }

    let passwordHash;
    try {
      passwordHash = await hashPassword(password);
    } catch (_) {
      return res.status(500).json({ error:'USER_CREATE_FAILED', message:'ساخت کاربر انجام نشد.' });
    }

    let client;
    try {
      client = await pool.connect();
    } catch (_) {
      return res.status(500).json({ error:'USER_CREATE_FAILED', message:'ساخت کاربر انجام نشد.' });
    }
    try {
      await client.query('BEGIN');
      const id = generateId();
      const created = await client.query(
        `INSERT INTO users(id,username,pass_hash,name,role,unit,phone,active)
         VALUES($1,$2,$3,$4,$5,$6,$7,true)
         RETURNING id,name,role,active`,
        [id, username, passwordHash, name, role, unit, phone]
      );
      const safeUser = publicCreatedUser(created.rows[0]);
      await client.query(
        `INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after)
         VALUES($1,now(),$2,$3,$4,'create','users',$5,$6,NULL,$7)`,
        [
          generateId(), req.user.name || req.user.username, req.user.id, req.user.role,
          safeUser.id, 'ایجاد کاربر از مسیر اختصاصی کاربران', JSON.stringify(safeUser)
        ]
      );
      await client.query('COMMIT');
      return res.status(201).json({ data:safeUser });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error?.code === '23505') {
        return res.status(409).json({ error:'USERNAME_ALREADY_EXISTS', message:'این نام کاربری قبلاً ثبت شده است.' });
      }
      const postgresCode = typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : 'unknown';
      console.error(`[users-api] create_failed postgres_code=${postgresCode}`);
      return res.status(500).json({ error:'USER_CREATE_FAILED', message:'ساخت کاربر انجام نشد.' });
    } finally {
      client.release();
    }
  });

  return router;
}

module.exports = { USER_ROLES, MIN_PASSWORD_LENGTH, publicCreatedUser, createUserRouter };
