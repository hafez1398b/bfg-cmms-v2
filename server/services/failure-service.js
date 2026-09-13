'use strict';

const { v4: uuid } = require('uuid');

function nextFailureNo(seq = Date.now()) {
  const now = new Date();
  const jy = now.getFullYear(); // simplified
  return `FL-${jy}-${String(seq).slice(-6)}`;
}

async function createFailure(pool, data, actor) {
  const id = data.id || uuid();
  const no = data.failure_no || `FL-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
  const {
    asset_id, sub_asset_id = null, component = null,
    occurred_at = new Date().toISOString(),
    condition = null, symptoms = [], description = '', failure_type = null,
    failure_mode = null, failure_code = null, cause = null, effect = null,
    severity = 'medium', frequency = null, detectability = null,
    risk_score = null, downtime_hours = 0, technician_report = null,
    provenance = 'verified', ext = {},
  } = data;

  if (!asset_id) {
    const e = new Error('asset_id is required');
    e.status = 422; e.fields = ['asset_id']; throw e;
  }

  const { rows } = await pool.query(
    `INSERT INTO failures(id, failure_no, asset_id, sub_asset_id, component, occurred_at, reported_by, condition, symptoms, description, failure_type, failure_mode, failure_code, cause, effect, severity, frequency, detectability, risk_score, downtime_hours, technician_report, provenance, ext)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
    [id, no, asset_id, sub_asset_id, component, occurred_at, actor?.id || null, condition, JSON.stringify(symptoms), description, failure_type, failure_mode, failure_code, cause, effect, severity, frequency, detectability, risk_score, downtime_hours, technician_report, provenance, JSON.stringify(ext)]
  );
  return rows[0];
}

async function getFailure(pool, id) {
  const { rows } = await pool.query(
    `SELECT f.*, a.name AS asset_name, a.code AS asset_code, sa.name AS sub_asset_name
     FROM failures f
     LEFT JOIN assets a ON a.id = f.asset_id
     LEFT JOIN assets sa ON sa.id = f.sub_asset_id
     WHERE f.id = $1`, [id]
  );
  if (!rows[0]) return null;
  const f = rows[0];
  const media = await pool.query(`SELECT * FROM failure_media WHERE failure_id=$1 ORDER BY created_at DESC`, [id]);
  const measurements = await pool.query(`SELECT * FROM failure_measurements WHERE failure_id=$1 ORDER BY measured_at DESC`, [id]);
  const rca = await pool.query(`SELECT * FROM failure_rca WHERE failure_id=$1 ORDER BY created_at DESC`, [id]);
  return { ...f, media: media.rows, measurements: measurements.rows, rca: rca.rows };
}

async function listFailures(pool, { assetId, status, severity, q, page = 1, limit = 25 } = {}) {
  const where = [];
  const vals = [];
  const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
  if (assetId) add('f.asset_id = ?', assetId);
  if (status) add('f.status = ?', status);
  if (severity) add('f.severity = ?', severity);
  if (q) { vals.push(`%${q}%`); where.push(`(f.failure_no ILIKE $${vals.length} OR f.description ILIKE $${vals.length} OR f.failure_mode ILIKE $${vals.length})`); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const offset = (page - 1) * limit;
  vals.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT f.*, a.name AS asset_name, a.code AS asset_code
     FROM failures f LEFT JOIN assets a ON a.id=f.asset_id
     ${w} ORDER BY f.occurred_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals
  );
  const countVals = vals.slice(0, -2);
  const count = await pool.query(`SELECT count(*)::int total FROM failures f ${w}`, countVals);
  return { data: rows, total: count.rows[0].total, page, limit, pages: Math.ceil(count.rows[0].total / limit) };
}

async function updateFailure(pool, id, patch, expectedVersion) {
  const current = await pool.query(`SELECT * FROM failures WHERE id=$1`, [id]);
  if (!current.rows[0]) { const e = new Error('Failure not found'); e.status = 404; throw e; }
  if (expectedVersion !== undefined && Number(expectedVersion) !== Number(current.rows[0].row_version)) {
    const e = new Error('Version conflict — record was modified by another user');
    e.status = 409; e.code = 'VERSION_CONFLICT'; e.current = current.rows[0].row_version; throw e;
  }
  const allowed = ['condition','symptoms','description','failure_type','failure_mode','failure_code','cause','effect','severity','frequency','detectability','risk_score','downtime_hours','technician_report','status','provenance','ext','component','sub_asset_id'];
  const entries = Object.entries(patch).filter(([k]) => allowed.includes(k));
  if (!entries.length) { const e = new Error('No editable fields'); e.status = 422; throw e; }
  const set = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
  const vals = [id, ...entries.map(([, v]) => (k => typeof v === 'object' ? JSON.stringify(v) : v)(entries.find(([kk]) => kk === k)?.[0]))];
  // Properly map values
  const values = entries.map(([, v]) => typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
  const { rows } = await pool.query(`UPDATE failures SET ${set}, row_version = row_version + 1, updated_at = now() WHERE id = $1 RETURNING *`, [id, ...values]);
  return { before: current.rows[0], after: rows[0] };
}

module.exports = { createFailure, getFailure, listFailures, updateFailure, nextFailureNo };
