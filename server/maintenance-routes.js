'use strict';

const express = require('express');
const service = require('./maintenance-service');

function createMaintenanceRouter({ pool, security }) {
  const router = express.Router();
  router.use(security.authenticateToken);

  function send(work) {
    return async (req, res) => {
      try {
        res.json(await work(req));
      } catch (error) {
        const status = error.status && error.status < 500 ? error.status : 500;
        if (status >= 500) console.error('maintenance api', error.code || 'db_error');
        res.status(status).json({ error: status < 500 ? (error.code || 'REQUEST_FAILED') : 'MAINTENANCE_REQUEST_FAILED' });
      }
    };
  }

  router.get('/requests', security.authorize('request.view'), send(async req => ({ data: await service.listRequests(pool, req.query) })));
  router.get('/requests/:id', security.authorize('request.view'), send(async req => ({ data: await service.getRequest(pool, req.params.id) })));
  router.post('/requests', security.authorize('request.create'), send(async req => {
    const data = await service.createRequest(pool, req.user, req.body || {});
    return { data };
  }));
  router.patch('/requests/:id', security.authorize('request.edit'), send(async req => ({ data: await service.updateRequest(pool, req.user, req.params.id, req.body || {}) })));
  router.post('/requests/:id/transition', security.authorize('request.triage'), send(async req => ({ data: await service.transitionRequest(pool, req.user, req.params.id, req.body || {}) })));
  router.post('/requests/:id/approve', security.authorize('request.triage'), send(async req => ({ data: await service.approveRequest(pool, req.user, req.params.id, req.body || {}) })));
  router.post('/requests/:id/archive', security.authorize('request.archive'), send(async req => ({ data: await service.archiveRequest(pool, req.user, req.params.id, req.body || {}) })));
  router.post('/requests/:id/corrections', security.authorize('request.correct'), send(async req => ({ data: await service.correctRecord(pool, req.user, 'request', req.params.id, req.body || {}) })));

  router.get('/work-orders', security.authorize('work_order.view'), send(async req => ({ data: await service.listWorkOrders(pool, req.query) })));
  router.get('/work-orders/:id', security.authorize('work_order.view'), send(async req => ({ data: await service.getWorkOrder(pool, req.params.id) })));
  router.post('/work-orders', security.authorize('work_order.create'), send(async req => ({ data: await service.createWorkOrder(pool, req.user, req.body || {}) })));
  router.patch('/work-orders/:id', security.authorize('work_order.edit'), send(async req => ({ data: await service.updateWorkOrder(pool, req.user, req.params.id, req.body || {}) })));
  router.post('/work-orders/:id/transition', send(async req => {
    const status = String((req.body || {}).status || '');
    const permission = status === 'closed' ? 'work_order.close' : (['seen', 'doing', 'hold', 'done'].includes(status) ? 'work_order.execute' : 'work_order.edit');
    if (!await security.hasPermission(req.user, permission)) {
      const error = new Error('PERMISSION_DENIED');
      error.status = 403;
      error.code = 'PERMISSION_DENIED';
      throw error;
    }
    return { data: await service.transitionWorkOrder(pool, req.user, req.params.id, req.body || {}) };
  }));
  router.post('/work-orders/:id/archive', security.authorize('work_order.archive'), send(async req => ({ data: await service.archiveWorkOrder(pool, req.user, req.params.id, req.body || {}) })));
  router.post('/work-orders/:id/cancel', security.authorize('work_order.cancel'), send(async req => ({ data: await service.cancelWorkOrder(pool, req.user, req.params.id, req.body || {}) })));
  router.post('/work-orders/:id/corrections', security.authorize('work_order.correct'), send(async req => ({ data: await service.correctRecord(pool, req.user, 'work_order', req.params.id, req.body || {}) })));

  router.get('/pm-plans', security.authorize('pm.view'), send(async req => ({ data: await service.listPmPlans(pool, req.query) })));
  router.get('/pm-plans/:id', security.authorize('pm.view'), send(async req => ({ data: await service.getPmPlan(pool, req.params.id) })));
  router.post('/pm-plans', security.authorize('pm.create'), send(async req => ({ data: await service.createPmPlan(pool, req.user, req.body || {}) })));
  router.patch('/pm-plans/:id', security.authorize('pm.edit'), send(async req => ({ data: await service.updatePmPlan(pool, req.user, req.params.id, req.body || {}) })));
  router.post('/pm-plans/:id/archive', security.authorize('pm.archive'), send(async req => ({ data: await service.archivePmPlan(pool, req.user, req.params.id, req.body || {}) })));
  router.post('/pm-plans/:id/cancel', security.authorize('pm.cancel'), send(async req => ({ data: await service.cancelPmPlan(pool, req.user, req.params.id, req.body || {}) })));
  router.post('/pm-plans/:id/generate-work-order', security.authorize('pm.generate'), send(async req => ({ data: await service.generatePmWorkOrder(pool, req.user, req.params.id, req.body || {}) })));
  router.post('/pm-plans/:id/corrections', security.authorize('pm.correct'), send(async req => ({ data: await service.correctRecord(pool, req.user, 'pm_plan', req.params.id, req.body || {}) })));

  router.get('/maintenance/equipment/:id/links', security.authorize('equipment.view'), send(async req => ({ data: await service.equipmentLinks(pool, req.params.id) })));
  return router;
}

module.exports = { createMaintenanceRouter };
