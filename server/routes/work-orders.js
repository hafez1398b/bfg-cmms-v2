'use strict';

const express = require('express');
const { v4: uuid } = require('uuid');
const { recordAudit } = require('../services/audit-service');
const { createNotification } = require('../services/notification-service');
const { checkVersion } = require('../services/concurrency');

function createWorkOrdersRouter({ pool, realtime, authenticateToken }) {
  const router = express.Router();
  router.use(authenticateToken);

  const canView = (u) => !!u;
  const canCreate = (u) => ['admin','mgr','planner'].includes(u.role);
  const canAssign = (u) => ['admin','mgr','planner'].includes(u.role);
  const canClose = (u) => ['admin','mgr'].includes(u.role);

  router.get('/', async (req, res, next) => {
    try {
      const { status, assetId, assignee, priority, type, q, page=1, limit=25 } = req.query;
      const where = [];
      const vals = [];
      const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
      if (status) add('w.status = ?', status);
      if (assetId) add('w.asset_id = ?', assetId);
      if (assignee) add('w.assignee = ?', assignee);
      if (priority) add('w.priority = ?', priority);
      if (type) add('w.type = ?', type);
      if (q) { vals.push(`%${q}%`); where.push(`(w.no ILIKE $${vals.length} OR w.descr ILIKE $${vals.length})`); }
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const lim = Math.min(parseInt(limit,10)||25,100);
      const off = (parseInt(page,10)-1)*lim;
      vals.push(lim, off);
      const { rows } = await pool.query(
        `SELECT w.*, a.name AS asset_name, a.code AS asset_code, u.name AS assignee_name
         FROM work_orders w
         LEFT JOIN assets a ON a.id=w.asset_id
         LEFT JOIN users u ON u.id=w.assignee
         ${w} ORDER BY w.created_at DESC LIMIT $${vals.length-1} OFFSET $${vals.length}`, vals
      );
      const total = await pool.query(`SELECT count(*)::int total FROM work_orders w ${w}`, vals.slice(0,-2));
      res.json({ data: rows, total: total.rows[0].total, page: parseInt(page,10), limit: lim, pages: Math.ceil(total.rows[0].total/lim) });
    } catch (e) { next(e); }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const { rows: [wo] } = await pool.query(`SELECT w.*, a.name AS asset_name FROM work_orders w LEFT JOIN assets a ON a.id=w.asset_id WHERE w.id=$1`, [req.params.id]);
      if (!wo) return res.status(404).json({ error: 'NOT_FOUND' });
      // Also fetch parts details, permits, chain
      const parts = wo.parts || [];
      const history = await pool.query(`SELECT * FROM data_chain_links WHERE (from_entity='work_orders' AND from_id=$1) OR (to_entity='work_orders' AND to_id=$1) ORDER BY created_at`, [req.params.id]);
      res.json({ data: wo, chain: history.rows });
    } catch (e) { next(e); }
  });

  router.post('/', async (req, res, next) => {
    const client = await pool.connect();
    try {
      if (!canCreate(req.user)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
      const { assetId, descr, priority='normal', assignee=null, type='CM', reqId=null, est=2, ptw=false, _idempotencyKey } = req.body;
      if (!descr) return res.status(422).json({ error: 'VALIDATION_ERROR', fields: ['descr'] });
      if (_idempotencyKey) {
        const { rows: [ex] } = await client.query(`SELECT response FROM idempotency_keys WHERE key=$1`, [_idempotencyKey]);
        if (ex?.response) return res.status(201).json(ex.response);
      }
      await client.query('BEGIN');
      const id = req.body.id || uuid();
      const no = req.body.no || `WO-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
      const status = assignee ? 'assigned' : 'open';
      const { rows: [wo] } = await client.query(
        `INSERT INTO work_orders(id, no, type, asset_id, descr, priority, assignee, status, req_id, times, parts, media, report, est, created_at, ptw)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now(), $15) RETURNING *`,
        [id, no, type, assetId || null, descr, priority, assignee, status, reqId, JSON.stringify({}), JSON.stringify([]), JSON.stringify({}), JSON.stringify(null), est, !!ptw]
      );
      await recordAudit(client, { actor: req.user, action: 'create', mod: 'wos', entity: 'work_orders', entityId: id, after: wo, req });
      if (assetId) await client.query(`INSERT INTO work_order_assets(work_order_id, asset_id, relation_type) VALUES($1,$2,'primary') ON CONFLICT DO NOTHING`, [id, assetId]);
      if (_idempotencyKey) await client.query(`INSERT INTO idempotency_keys(key, user_id, response) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [_idempotencyKey, req.user.id, JSON.stringify({ data: wo })]);
      await client.query('COMMIT');

      if (assetId) try { await client.query(`INSERT INTO data_chain_links(from_entity, from_id, to_entity, to_id, relation, created_by) VALUES('assets',$1,'work_orders',$2,'work-for-asset',$3) ON CONFLICT DO NOTHING`, [assetId, id, req.user.id]); } catch(_){}

      try { realtime.dataChanged('wos', id, wo, { rooms: assetId ? [`equipment:${assetId}`] : [] }); } catch(_){}
      const targets = assignee ? [assignee] : null;
      try {
        await createNotification(pool, realtime, {
          kind: assignee ? 'assigned_work_order' : 'new_work_order',
          title: assignee ? `دستورکار تخصیص یافت: ${no}` : `دستورکار جدید: ${no}`,
          body: descr.slice(0,120), actorId: req.user.id, entity: 'work_orders', entityId: id, targetEquipment: assetId,
          explicitUserIds: targets, meta: { no, priority, type },
        });
      } catch(e){ console.warn('[wo] notify', e.message); }

      res.status(201).json({ data: wo });
    } catch (e) { try{await client.query('ROLLBACK')}catch(_){} next(e); } finally { client.release(); }
  });

  // Status transition with times + report
  router.patch('/:id/status', async (req, res, next) => {
    const client = await pool.connect();
    try {
      const { status, report, rowVersion } = req.body;
      const allowed = ['open','assigned','seen','doing','hold','done','closed','cancel'];
      if (!allowed.includes(status)) return res.status(422).json({ error: 'VALIDATION_ERROR', fields: ['status'] });
      await client.query('BEGIN');
      const { rows: [cur] } = await client.query(`SELECT * FROM work_orders WHERE id=$1 FOR UPDATE`, [req.params.id]);
      if (!cur) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'NOT_FOUND' }); }
      checkVersion(cur.row_version, rowVersion);

      // Permission: tech can only move own assigned WO via allowed transitions
      if (req.user.role === 'tech' && cur.assignee !== req.user.id) {
        await client.query('ROLLBACK'); return res.status(403).json({ error: 'PERMISSION_DENIED' });
      }
      if (status === 'closed' && !canClose(req.user)) {
        await client.query('ROLLBACK'); return res.status(403).json({ error: 'PERMISSION_DENIED' });
      }

      const times = cur.times || {};
      const now = new Date().toISOString();
      if (status === 'seen' && !times.seen) times.seen = now;
      if (status === 'doing' && !times.start) times.start = now;
      if (['done','closed'].includes(status) && !times.end) times.end = now;

      const updReport = report !== undefined ? report : cur.report;
      const { rows: [upd] } = await client.query(
        `UPDATE work_orders SET status=$2, times=$3::jsonb, report=$4::jsonb, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
        [req.params.id, status, JSON.stringify(times), JSON.stringify(updReport)]
      );
      await recordAudit(client, { actor: req.user, action: 'status-change', mod: 'wos', entity: 'work_orders', entityId: req.params.id, before: cur, after: upd, note: `status ${cur.status} → ${status}`, req });
      await client.query('COMMIT');

      try { realtime.dataChanged('wos', req.params.id, upd, { rooms: upd.asset_id ? [`equipment:${upd.asset_id}`] : [] }); } catch(_){}
      // Propagate critical done/closed
      if (['done','closed'].includes(status)) {
        try {
          await createNotification(pool, realtime, {
            kind: 'workflow_escalation', title: `وضعیت دستورکار ${upd.no} → ${status}`,
            body: `توسط ${req.user.name}`, actorId: req.user.id, entity: 'work_orders', entityId: upd.id, targetEquipment: upd.asset_id, meta: { status },
          });
        } catch(_){}
      }

      res.json({ data: upd });
    } catch (e) { try{await client.query('ROLLBACK')}catch(_){} next(e); } finally { client.release(); }
  });

  // Assign
  router.patch('/:id/assign', async (req, res, next) => {
    try {
      if (!canAssign(req.user)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
      const { assignee, rowVersion } = req.body;
      const { rows: [cur] } = await pool.query(`SELECT * FROM work_orders WHERE id=$1`, [req.params.id]);
      if (!cur) return res.status(404).json({ error: 'NOT_FOUND' });
      checkVersion(cur.row_version, rowVersion);
      const { rows: [upd] } = await pool.query(`UPDATE work_orders SET assignee=$2, status=CASE WHEN $2 IS NOT NULL THEN 'assigned' ELSE status END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id, assignee || null]);
      await recordAudit(pool, { actor: req.user, action: 'edit', mod: 'wos', entity: 'work_orders', entityId: req.params.id, before: cur, after: upd, note: `assign to ${assignee}`, req });
      try { realtime.dataChanged('wos', req.params.id, upd); } catch(_){}
      if (assignee) {
        try {
          await createNotification(pool, realtime, {
            kind: 'assigned_work_order', title: `دستورکار ${upd.no} به شما تخصیص یافت`,
            body: upd.descr.slice(0,120), actorId: req.user.id, entity: 'work_orders', entityId: upd.id, explicitUserIds: [assignee], meta: { no: upd.no },
          });
        } catch(_){}
      }
      res.json({ data: upd });
    } catch (e) { next(e); }
  });

  // Parts consumption — inventory transaction
  router.post('/:id/parts', async (req, res, next) => {
    const client = await pool.connect();
    try {
      const { itemId, qty } = req.body;
      const q = Number(qty);
      if (!itemId || !Number.isFinite(q) || q <= 0) return res.status(422).json({ error: 'VALIDATION_ERROR', fields: ['itemId','qty'] });
      await client.query('BEGIN');
      const { rows: [wo] } = await client.query(`SELECT * FROM work_orders WHERE id=$1 FOR UPDATE`, [req.params.id]);
      if (!wo) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'NOT_FOUND' }); }
      const { rows: [item] } = await client.query(`SELECT * FROM items WHERE id=$1 FOR UPDATE`, [itemId]);
      if (!item) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'NOT_FOUND', message: 'Item not found' }); }
      if (Number(item.stock) < q) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'INSUFFICIENT_STOCK', stock: item.stock }); }
      await client.query(`UPDATE items SET stock = stock - $2, row_version=row_version+1, updated_at=now() WHERE id=$1`, [itemId, q]);
      const parts = [...(wo.parts || []), { itemId, qty: q, at: new Date().toISOString(), by: req.user.id }];
      const { rows: [upd] } = await client.query(`UPDATE work_orders SET parts=$2::jsonb, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id, JSON.stringify(parts)]);
      const docId = uuid();
      const docNo = `ISS-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
      await client.query(`INSERT INTO stock_docs(id, no, kind, item_id, qty, at, by_name, wo) VALUES($1,$2,'حواله',$3,$4, now(), $5, $6)`, [docId, docNo, itemId, q, req.user.name, wo.no]);
      await recordAudit(client, { actor: req.user, action: 'edit', mod: 'wos', entity: 'work_orders', entityId: wo.id, before: wo, after: upd, note: `consume ${q}×${itemId}`, req });
      await client.query('COMMIT');

      // Check low stock alert
      const { rows: [afterItem] } = await pool.query(`SELECT * FROM items WHERE id=$1`, [itemId]);
      if (Number(afterItem.stock) < Number(afterItem.min_stock)) {
        try {
          await createNotification(pool, realtime, {
            kind: 'inventory_alert', priority: 'high', title: `موجودی زیر نقطه سفارش: ${afterItem.name}`,
            body: `موجودی ${afterItem.stock} ${afterItem.unit} — حداقل ${afterItem.min_stock}`, actorId: req.user.id, entity: 'items', entityId: itemId, targetRole: 'store', meta: { stock: afterItem.stock, min: afterItem.min_stock },
          });
        } catch(_){}
      }
      try { realtime.dataChanged('wos', wo.id, upd); } catch(_){}
      try { realtime.dataChanged('items', itemId, afterItem); } catch(_){}
      res.json({ data: upd, item: afterItem, doc: { id: docId, no: docNo } });
    } catch (e) { try{await client.query('ROLLBACK')}catch(_){} next(e); } finally { client.release(); }
  });

  return router;
}

module.exports = { createWorkOrdersRouter };
