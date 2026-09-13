'use strict';

const express = require('express');
const { v4: uuid } = require('uuid');
const { recordAudit } = require('../services/audit-service');
const { createNotification } = require('../services/notification-service');
const { checkVersion } = require('../services/concurrency');

function createRequestsRouter({ pool, realtime, authenticateToken }) {
  const router = express.Router();
  router.use(authenticateToken);

  const canCreate = (u) => ['admin','mgr','planner','tech','op'].includes(u.role);
  const canApprove = (u) => ['admin','mgr','planner'].includes(u.role);
  const canView = (u) => !!u;

  // List — role-filtered (op sees own only if configured)
  router.get('/', async (req, res, next) => {
    try {
      const { status, assetId, urgency, q, page = 1, limit = 25 } = req.query;
      const where = [];
      const vals = [];
      const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
      if (status) add('r.status = ?', status);
      if (assetId) add('r.asset_id = ?', assetId);
      if (urgency) add('r.urgency = ?', urgency);
      if (q) { vals.push(`%${q}%`); where.push(`(r.no ILIKE $${vals.length} OR r.descr ILIKE $${vals.length})`); }
      // op visibility restriction example (optional)
      if (req.user.role === 'op' && req.query.scope === 'own') {
        add('r.requester = ?', req.user.name);
      }
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const offset = (parseInt(page,10)-1)*parseInt(limit,10);
      const lim = Math.min(parseInt(limit,10)||25, 100);
      vals.push(lim, offset);
      const { rows } = await pool.query(
        `SELECT r.*, a.name AS asset_name, a.code AS asset_code
         FROM requests r LEFT JOIN assets a ON a.id=r.asset_id
         ${w} ORDER BY r.created_at DESC LIMIT $${vals.length-1} OFFSET $${vals.length}`, vals
      );
      const cntVals = vals.slice(0, -2);
      const count = await pool.query(`SELECT count(*)::int total FROM requests r ${w}`, cntVals);
      res.json({ data: rows, total: count.rows[0].total, page: parseInt(page,10), limit: lim, pages: Math.ceil(count.rows[0].total/lim) });
    } catch (e) { next(e); }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const { rows: [r] } = await pool.query(`SELECT r.*, a.name AS asset_name FROM requests r LEFT JOIN assets a ON a.id=r.asset_id WHERE r.id=$1`, [req.params.id]);
      if (!r) return res.status(404).json({ error: 'NOT_FOUND' });
      await recordAudit(pool, { actor: req.user, action: 'view', mod: 'requests', entity: 'requests', entityId: r.id, req });
      res.json({ data: r });
    } catch (e) { next(e); }
  });

  // Wizard submit — single endpoint for step-by-step (Requirement #5,6)
  router.post('/', async (req, res, next) => {
    const client = await pool.connect();
    try {
      if (!canCreate(req.user)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
      const { assetId, subAssetId, problem, severity, downtime, description, urgency, impact, form, media, _idempotencyKey } = req.body;

      // Idempotency for offline queue (Requirement #19)
      if (_idempotencyKey) {
        const { rows: [existing] } = await client.query(`SELECT response FROM idempotency_keys WHERE key=$1`, [_idempotencyKey]);
        if (existing?.response) return res.status(201).json(existing.response);
      }

      await client.query('BEGIN');
      const id = req.body.id || uuid();
      const no = req.body.no || `WR-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
      const asset_id = assetId || null;
      const descr = description || problem || '';
      const urg = urgency || severity || 'normal';
      const sta = 'new';

      const { rows: [created] } = await client.query(
        `INSERT INTO requests(id, no, type, unit, requester, asset_id, descr, urgency, impact, status, form, history, created_at, row_version)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), 1) RETURNING *`,
        [id, no, req.body.type || 'repair', req.user.unit || req.body.unit || '', req.user.name, asset_id, descr, urg, !!impact, sta, JSON.stringify({ problem, severity, downtime, subAssetId, media, ...form }), JSON.stringify([{ t: new Date().toISOString(), x: `ثبت درخواست توسط ${req.user.name}` }])]
      );
      await recordAudit(client, { actor: req.user, action: 'create', mod: 'requests', entity: 'requests', entityId: id, after: created, req });

      if (_idempotencyKey) {
        await client.query(`INSERT INTO idempotency_keys(key, user_id, response) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING`, [_idempotencyKey, req.user.id, JSON.stringify({ data: created })]);
      }
      await client.query('COMMIT');

      // Data chain
      if (asset_id) {
        try { await pool.query(`INSERT INTO data_chain_links(from_entity, from_id, to_entity, to_id, relation, created_by) VALUES('assets',$1,'requests',$2,'request-for-asset',$3) ON CONFLICT DO NOTHING`, [asset_id, id, req.user.id]); } catch (_) {}
      }

      // Realtime
      try { realtime.dataChanged('requests', id, created, { rooms: ['global'] }); } catch (_) {}
      try { realtime.emit('data-changed', { collection: 'requests', id, data: created }); } catch (_) {}

      // Notifications — targeted, not broadcast (Requirement #4)
      try {
        await createNotification(pool, realtime, {
          kind: urg === 'critical' ? 'critical_failure' : 'approval_required',
          priority: urg === 'critical' ? 'critical' : 'high',
          title: urg === 'critical' ? `درخواست اضطراری ${no}` : `درخواست جدید ${no}`,
          body: `${req.user.name}: ${descr.slice(0,120)}`,
          actorId: req.user.id, entity: 'requests', entityId: id, targetEquipment: asset_id,
          targetRole: urg === 'critical' ? null : 'mgr',
          meta: { no, urgency: urg, assetId: asset_id },
        });
      } catch (e) { console.warn('[requests] notify failed', e.message); }

      res.status(201).json({ data: created });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      next(e);
    } finally { client.release(); }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const { rowVersion, ...patch } = req.body;
      const { rows: [cur] } = await pool.query(`SELECT * FROM requests WHERE id=$1`, [req.params.id]);
      if (!cur) return res.status(404).json({ error: 'NOT_FOUND' });
      checkVersion(cur.row_version, rowVersion);
      const allowed = ['descr','urgency','impact','status','form','asset_id','type','unit'];
      const entries = Object.entries(patch).filter(([k]) => allowed.includes(k));
      if (!entries.length) return res.status(422).json({ error: 'VALIDATION_ERROR', fields: Object.keys(patch) });
      const set = entries.map(([k], i) => `${k} = $${i+2}`).join(', ');
      const vals = entries.map(([,v]) => typeof v === 'object' ? JSON.stringify(v) : v);
      const { rows: [upd] } = await pool.query(`UPDATE requests SET ${set}, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id, ...vals]);
      await recordAudit(pool, { actor: req.user, action: 'edit', mod: 'requests', entity: 'requests', entityId: req.params.id, before: cur, after: upd, req });
      try { realtime.dataChanged('requests', req.params.id, upd); } catch (_) {}
      res.json({ data: upd });
    } catch (e) { next(e); }
  });

  // Approve → creates WO (data chain)
  router.post('/:id/approve', async (req, res, next) => {
    const client = await pool.connect();
    try {
      if (!canApprove(req.user)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
      await client.query('BEGIN');
      const { rows: [r] } = await client.query(`SELECT * FROM requests WHERE id=$1 FOR UPDATE`, [req.params.id]);
      if (!r) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'NOT_FOUND' }); }
      if (!['new','review'].includes(r.status)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'INVALID_STATUS', status: r.status }); }
      const woId = uuid();
      const woNo = `WO-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
      const woType = r.type === 'repair' ? (r.urgency === 'critical' ? 'BD' : 'CM') : r.type === 'fab' ? 'FAB' : 'SRV';
      const { rows: [wo] } = await client.query(
        `INSERT INTO work_orders(id, no, type, asset_id, descr, priority, assignee, status, req_id, times, parts, media, report, est, created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now()) RETURNING *`,
        [woId, woNo, woType, r.asset_id, r.descr, r.urgency || 'normal', null, 'open', r.id, JSON.stringify({}), JSON.stringify([]), JSON.stringify({}), JSON.stringify(null), 4]
      );
      const { rows: [upd] } = await client.query(
        `UPDATE requests SET status='wo', row_version=row_version+1, updated_at=now(), history = history || $2::jsonb WHERE id=$1 RETURNING *`,
        [r.id, JSON.stringify([{ t: new Date().toISOString(), x: `تأیید توسط ${req.user.name}` }, { t: new Date().toISOString(), x: `تبدیل به دستورکار ${woNo}` }])]
      );
      await recordAudit(client, { actor: req.user, action: 'approve', mod: 'requests', entity: 'requests', entityId: r.id, before: r, after: upd, note: `approved → ${woNo}`, req });
      await client.query(`INSERT INTO data_chain_links(from_entity, from_id, to_entity, to_id, relation, created_by) VALUES('requests',$1,'work_orders',$2,'request-to-wo',$3) ON CONFLICT DO NOTHING`, [r.id, woId, req.user.id]);
      await client.query('COMMIT');

      try { realtime.dataChanged('requests', r.id, upd); realtime.dataChanged('wos', woId, wo); } catch (_) {}
      try {
        await createNotification(pool, realtime, {
          kind: 'new_work_order', title: `دستورکار جدید ${woNo}`, body: `از درخواست ${r.no}: ${r.descr.slice(0,100)}`,
          actorId: req.user.id, entity: 'work_orders', entityId: woId, targetEquipment: r.asset_id, explicitUserIds: null, meta: { woNo, reqNo: r.no },
        });
      } catch (_) {}

      res.json({ data: upd, workOrder: wo });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      next(e);
    } finally { client.release(); }
  });

  return router;
}

module.exports = { createRequestsRouter };
