'use strict';

const { v4: uuid } = require('uuid');

/**
 * Audit service — records every important mutation with before/after (Requirement #1)
 * Writes to audit_log (primary) and keeps audit_x for backward compat.
 */
async function recordAudit(pool, { actor, action, mod, entity, entityId, note = '', before = null, after = null, req }) {
  const id = uuid();
  const ip = req?.ip || req?.headers?.['x-forwarded-for'] || null;
  const ua = req?.headers?.['user-agent'] || null;
  try {
    await pool.query(
      `INSERT INTO audit_log(id, t, actor_id, actor_name, actor_role, action, mod, entity, entity_id, note, before, after, ip, user_agent)
       VALUES($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [id, actor?.id || null, actor?.name || actor?.username || 'system', actor?.role || 'system', action, mod, entity, String(entityId), note,
       before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, ip, ua]
    );
  } catch (e) {
    console.warn('[audit] audit_log insert failed, trying audit_x fallback:', e.message);
  }
  // Keep audit_x in sync for legacy frontend that reads auditX table
  try {
    await pool.query(
      `INSERT INTO audit_x(id, t, u, uid, role, action, mod, entity, note, before, after)
       VALUES($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, actor?.name || actor?.username || 'system', actor?.id || null, actor?.role || 'system', action, mod, String(entityId), note,
       before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
    );
  } catch (_) {
    // ignore — audit_x may not exist on fresh installs
  }
  return id;
}

async function listAudit(pool, { mod, entity, entityId, actorId, limit = 100, offset = 0 } = {}) {
  const where = [];
  const vals = [];
  const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
  if (mod) add('mod = ?', mod);
  if (entity) add('entity = ?', entity);
  if (entityId) add('entity_id = ?', String(entityId));
  if (actorId) add('actor_id = ?', actorId);
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  vals.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT id, t, actor_id, actor_name AS u, actor_role AS role, action, mod, entity, entity_id AS entity_id, note, before, after
     FROM audit_log ${w} ORDER BY t DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals
  );
  const count = await pool.query(`SELECT count(*)::int total FROM audit_log ${w}`, vals.slice(0, -2));
  return { data: rows, total: count.rows[0].total };
}

module.exports = { recordAudit, listAudit };
