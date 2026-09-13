'use strict';

const express = require('express');
const { createNotification } = require('../services/notification-service');

function createNotificationsRouter({ pool, realtime, authenticateToken }) {
  const router = express.Router();
  router.use(authenticateToken);

  // List for current user — paginated, filters
  router.get('/', async (req, res, next) => {
    try {
      const userId = req.user.id;
      const { unread, kind, priority, limit = 50, offset = 0 } = req.query;
      const where = ['r.user_id = $1'];
      const vals = [userId];
      const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
      if (unread === 'true') where.push('r.is_read = false');
      if (kind) add('n.kind = ?', kind);
      if (priority) add('n.priority = ?', priority);
      const w = where.join(' AND ');
      const total = await pool.query(`SELECT count(*)::int total FROM notifications n JOIN notification_recipients r ON r.notification_id=n.id WHERE ${w}`, vals);
      vals.push(parseInt(limit, 10), parseInt(offset, 10));
      const { rows } = await pool.query(
        `SELECT n.*, r.is_read, r.read_at, r.delivered_at
         FROM notifications n
         JOIN notification_recipients r ON r.notification_id=n.id
         WHERE ${w}
         ORDER BY n.created_at DESC
         LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals
      );
      const unreadCount = await pool.query(`SELECT count(*)::int c FROM notification_recipients WHERE user_id=$1 AND is_read=false`, [userId]);
      res.json({ data: rows, total: total.rows[0].total, unread: unreadCount.rows[0].c });
    } catch (e) { next(e); }
  });

  // Mark read
  router.patch('/:id/read', async (req, res, next) => {
    try {
      const { id } = req.params;
      const { is_read = true } = req.body;
      await pool.query(`UPDATE notification_recipients SET is_read=$2, read_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE notification_id=$1 AND user_id=$3`, [id, !!is_read, req.user.id]);
      if (realtime) realtime.emit('notifications:refresh', { userId: req.user.id });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Mark all read
  router.post('/read-all', async (req, res, next) => {
    try {
      await pool.query(`UPDATE notification_recipients SET is_read=true, read_at=now() WHERE user_id=$1 AND is_read=false`, [req.user.id]);
      if (realtime) realtime.emit('notifications:refresh', { userId: req.user.id });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Admin/system: create notification (for testing & workflow triggers)
  router.post('/', async (req, res, next) => {
    try {
      // Only admin/mgr/planner can create arbitrary notifications
      if (!['admin','mgr','planner'].includes(req.user.role)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
      const { kind = 'system', title, body, priority, targetRole, targetFactory, targetEquipment, explicitUserIds, entity, entityId, meta } = req.body;
      if (!body) return res.status(422).json({ error: 'VALIDATION_ERROR', fields: ['body'] });
      const result = await createNotification(pool, realtime, {
        kind, title, body, priority, actorId: req.user.id, entity, entityId, targetRole, targetFactory, targetEquipment, explicitUserIds, meta: meta || {},
      });
      res.status(201).json(result);
    } catch (e) { next(e); }
  });

  // Health check for debugging the pipeline
  router.get('/_debug/pipeline', async (req, res) => {
    const checks = {
      tableExists: false, realtimeReady: !!realtime, userRoom: `user:${req.user.id}`,
      socketConnected: false, lastNotification: null,
    };
    try {
      const { rows } = await pool.query(`SELECT to_regclass('public.notifications') AS t`);
      checks.tableExists = !!rows[0].t;
      const last = await pool.query(`SELECT id, kind, title, created_at FROM notifications ORDER BY created_at DESC LIMIT 1`);
      checks.lastNotification = last.rows[0] || null;
      const r = await pool.query(`SELECT count(*)::int c FROM notification_recipients WHERE user_id=$1`, [req.user.id]);
      checks.myRecipientCount = r.rows[0].c;
    } catch (e) { checks.error = e.message; }
    res.json(checks);
  });

  return router;
}

module.exports = { createNotificationsRouter };
