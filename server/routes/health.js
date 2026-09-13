'use strict';

const express = require('express');
const { calculateHealth, getHealth } = require('../services/health-service');

function createHealthRouter({ pool, realtime, authenticateToken }) {
  const router = express.Router();
  router.use(authenticateToken);

  router.get('/:assetId', async (req, res, next) => {
    try {
      const data = await getHealth(pool, req.params.assetId);
      res.json(data);
    } catch (e) { next(e); }
  });

  router.post('/:assetId/recalculate', async (req, res, next) => {
    try {
      // Only planner+ can force recalc
      if (!['admin','mgr','planner'].includes(req.user.role)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
      const data = await calculateHealth(pool, req.params.assetId);
      if (realtime) realtime.healthUpdated(req.params.assetId, data);
      res.json(data);
    } catch (e) { next(e); }
  });

  // Bulk list with scores
  router.get('/', async (req, res, next) => {
    try {
      const { crit, status, limit = 100, offset = 0 } = req.query;
      const where = ['a.type = \'eq\'', 'a.deleted_at IS NULL'];
      const vals = [];
      const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
      if (crit) add('a.crit = ?', crit);
      if (status) add('a.status = ?', status);
      const w = where.join(' AND ');
      vals.push(parseInt(limit,10), parseInt(offset,10));
      const { rows } = await pool.query(
        `SELECT a.id, a.code, a.name, a.status, a.crit, a.health_score, a.health_trend, a.mtbf_hours, a.mttr_hours, a.updated_at
         FROM assets a WHERE ${w} ORDER BY a.health_score ASC NULLS FIRST, a.code LIMIT $${vals.length-1} OFFSET $${vals.length}`, vals
      );
      const count = await pool.query(`SELECT count(*)::int total FROM assets a WHERE ${w}`, vals.slice(0,-2));
      res.json({ data: rows, total: count.rows[0].total });
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = { createHealthRouter };
