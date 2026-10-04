'use strict';

const crypto = require('crypto');
const catalog = require('./module-catalog');

function coded(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function isSystemAdmin(user) {
  return Boolean(user && user.role === 'admin');
}

function createModuleService({ cacheMs = 2000 } = {}) {
  const cache = { at: 0, rows: null };

  function invalidate() {
    cache.at = 0;
    cache.rows = null;
  }

  async function loadStates(pool) {
    if (cache.rows && cacheMs > 0 && Date.now() - cache.at < cacheMs) return cache.rows;
    try {
      const { rows } = await pool.query('SELECT id, enabled, row_version, updated_at FROM app_modules');
      cache.rows = rows;
      cache.at = Date.now();
      return rows;
    } catch (error) {
      if (error && error.code === '42P01') return null;
      throw error;
    }
  }

  async function list(pool) {
    const states = await loadStates(pool);
    const byId = new Map((states || []).map(row => [row.id, row]));
    return catalog.modules().map(module => {
      const state = byId.get(module.id);
      if (!state) return module;
      return catalog.publicModule(catalog.get(module.id), state);
    });
  }

  async function isEnabled(pool, moduleId) {
    const found = (await list(pool)).find(module => module.id === moduleId);
    return !found || found.enabled === true;
  }

  async function setEnabled(pool, user, moduleId, body) {
    if (!isSystemAdmin(user)) throw coded(403, 'MODULE_ADMIN_REQUIRED');
    const module = catalog.get(moduleId);
    if (!module) throw coded(404, 'MODULE_NOT_IN_RELEASE');
    if (!body || typeof body.enabled !== 'boolean') throw coded(422, 'MODULE_ENABLED_REQUIRED');
    if (body.scriptUrl || body.code || body.src || body.url) throw coded(422, 'REMOTE_MODULE_REJECTED');
    const rowVersion = Number(body.rowVersion ?? body.row_version);
    if (!Number.isInteger(rowVersion) || rowVersion < 1) throw coded(422, 'ROW_VERSION_REQUIRED');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT id, enabled, row_version FROM app_modules WHERE id=$1 FOR UPDATE', [moduleId]);
      const before = current.rows[0] || null;
      if (before && Number(before.row_version) !== rowVersion) {
        await client.query('ROLLBACK');
        throw coded(409, 'VERSION_CONFLICT');
      }
      if (!before && rowVersion !== 1) {
        await client.query('ROLLBACK');
        throw coded(409, 'VERSION_CONFLICT');
      }
      const updated = before
        ? await client.query(
          'UPDATE app_modules SET enabled=$2, updated_by=$3, updated_at=now(), row_version=row_version+1 WHERE id=$1 AND row_version=$4 RETURNING id, enabled, row_version',
          [moduleId, body.enabled, user.id, rowVersion]
        )
        : await client.query(
          'INSERT INTO app_modules(id, enabled, row_version, updated_by) VALUES($1,$2,2,$3) RETURNING id, enabled, row_version',
          [moduleId, body.enabled, user.id]
        );
      if (!updated.rows[0]) {
        await client.query('ROLLBACK');
        throw coded(409, 'VERSION_CONFLICT');
      }
      const after = updated.rows[0];
      await client.query(
        'INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after) VALUES($1,now(),$2,$3,$4,\'module_toggle\',\'modules\',$5,$6,$7,$8)',
        [crypto.randomUUID(), user.name || user.username, user.id, user.role, moduleId,
          body.enabled ? 'فعال‌سازی ماژول' : 'غیرفعال‌سازی ماژول',
          before ? JSON.stringify(before) : null, JSON.stringify(after)]
      );
      const users = await client.query('SELECT id FROM users WHERE active=true');
      await client.query(
        'INSERT INTO event_outbox(id,event_type,aggregate_type,aggregate_id,actor_id,payload,recipient_ids) VALUES($1,\'module.updated\',\'module\',$2,$3,$4,$5)',
        [crypto.randomUUID(), moduleId, user.id,
          JSON.stringify({ id: moduleId, enabled: after.enabled === true, rowVersion: Number(after.row_version) }),
          JSON.stringify(users.rows.map(row => row.id))]
      );
      await client.query('COMMIT');
      invalidate();
      return catalog.publicModule(module, { enabled: after.enabled === true, rowVersion: Number(after.row_version) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error && error.code === '42P01') throw coded(503, 'MODULE_REGISTRY_UNAVAILABLE');
      throw error;
    } finally {
      client.release();
    }
  }

  function publish() {
    throw coded(405, 'MODULE_PUBLISH_REQUIRES_SIGNED_RELEASE');
  }

  return { list, isEnabled, setEnabled, publish, invalidate, isSystemAdmin };
}

module.exports = { createModuleService, isSystemAdmin };
