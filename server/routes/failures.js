'use strict';

const express = require('express');
const { v4: uuid } = require('uuid');
const { createFailure, getFailure, listFailures, updateFailure } = require('../services/failure-service');
const { recordAudit } = require('../services/audit-service');
const { createNotification } = require('../services/notification-service');
const { getRealtime } = require('../services/realtime-service');

function createFailuresRouter({ pool, realtime, authenticateToken }) {
  const router = express.Router();
  router.use(authenticateToken);

  const canView = (user) => ['admin','mgr','planner','tech','op','hse'].includes(user.role);
  const canCreate = (user) => ['admin','mgr','planner','tech','op'].includes(user.role);
  const canEdit = (user) => ['admin','mgr','planner','tech'].includes(user.role);

  router.get('/', async (req, res, next) => {
    try {
      if (!canView(req.user)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
      const { assetId, status, severity, q, page, limit } = req.query;
      const result = await listFailures(pool, { assetId, status, severity, q, page: parseInt(page,10)||1, limit: Math.min(parseInt(limit,10)||25, 100) });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      if (!canView(req.user)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
      const data = await getFailure(pool, req.params.id);
      if (!data) return res.status(404).json({ error: 'NOT_FOUND' });
      await recordAudit(pool, { actor: req.user, action: 'view', mod: 'failures', entity: 'failures', entityId: req.params.id, req });
      res.json({ data });
    } catch (e) { next(e); }
  });

  router.post('/', async (req, res, next) => {
    const client = await pool.connect();
    try {
      if (!canCreate(req.user)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
      await client.query('BEGIN');
      // We use pool-based create for now (simple)
      const failure = await createFailure(pool, req.body, req.user);
      await recordAudit(pool, { actor: req.user, action: 'create', mod: 'failures', entity: 'failures', entityId: failure.id, after: failure, req });
      await client.query('COMMIT');

      // Data chain link
      try {
        await pool.query(`INSERT INTO data_chain_links(from_entity, from_id, to_entity, to_id, relation, created_by) VALUES('assets',$1,'failures',$2,'failure-detected',$3) ON CONFLICT DO NOTHING`, [failure.asset_id, failure.id, req.user.id]);
      } catch (_) {}

      // Realtime propagation (Requirement #16)
      try { getRealtime().failureEvent('created', failure, { rooms: [`equipment:${failure.asset_id}`], roles: ['admin','mgr','planner','tech'] }); } catch (_) {}
      try { realtime?.emit('data-changed', { collection: 'failures', id: failure.id, data: failure }); } catch (_) {}

      // Critical alert propagation
      if (failure.severity === 'critical') {
        try {
          await createNotification(pool, realtime, {
            kind: 'critical_failure', priority: 'critical',
            title: `خرابی بحرانی: ${failure.failure_no}`,
            body: failure.description || `خرابی بحرانی در تجهیز ${failure.asset_id}`,
            actorId: req.user.id, entity: 'failures', entityId: failure.id, targetEquipment: failure.asset_id,
            meta: { failure_no: failure.failure_no, severity: failure.severity },
          });
        } catch (e) { console.warn('[failures] critical notification failed', e.message); }
      }

      res.status(201).json({ data: failure });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      next(e);
    } finally { client.release(); }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      if (!canEdit(req.user)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
      const { rowVersion, ...patch } = req.body;
      const { before, after } = await updateFailure(pool, req.params.id, patch, rowVersion);
      await recordAudit(pool, { actor: req.user, action: 'edit', mod: 'failures', entity: 'failures', entityId: req.params.id, before, after, req });
      try { getRealtime().failureEvent('updated', after); } catch (_) {}
      res.json({ data: after });
    } catch (e) { next(e); }
  });

  // RCA
  router.post('/:id/rca', async (req, res, next) => {
    try {
      if (!canEdit(req.user)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
      const { method, content } = req.body;
      if (!method) return res.status(422).json({ error: 'VALIDATION_ERROR', fields: ['method'] });
      const id = uuid();
      const { rows } = await pool.query(
        `INSERT INTO failure_rca(id, failure_id, method, content, created_by) VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [id, req.params.id, method, JSON.stringify(content || {}), req.user.id]
      );
      await recordAudit(pool, { actor: req.user, action: 'create', mod: 'failures', entity: 'failure_rca', entityId: id, after: rows[0], req });
      // Link to history / AI context
      try { await pool.query(`INSERT INTO data_chain_links(from_entity, from_id, to_entity, to_id, relation, created_by) VALUES('failures',$1,'failure_rca',$2,$3,$4) ON CONFLICT DO NOTHING`, [req.params.id, id, `rca:${method}`, req.user.id]); } catch (_) {}
      res.status(201).json({ data: rows[0] });
    } catch (e) { next(e); }
  });

  router.get('/:id/rca', async (req, res, next) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM failure_rca WHERE failure_id=$1 ORDER BY created_at DESC`, [req.params.id]);
      res.json({ data: rows });
    } catch (e) { next(e); }
  });

  // Media
  router.post('/:id/media', async (req, res, next) => {
    try {
      if (!canEdit(req.user)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
      const { kind = 'photo', url, filename, mime, size_bytes, meta } = req.body;
      const id = uuid();
      const { rows } = await pool.query(
        `INSERT INTO failure_media(id, failure_id, kind, url, filename, mime, size_bytes, meta, uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [id, req.params.id, kind, url || null, filename || null, mime || null, size_bytes || null, JSON.stringify(meta || {}), req.user.id]
      );
      res.status(201).json({ data: rows[0] });
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = { createFailuresRouter };
