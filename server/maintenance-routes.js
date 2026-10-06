'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const filePolicy = require('./file-policy');
const service = require('./maintenance-service');

function readBody(req, max) {
  const declared = Number(req.get('content-length') || 0);
  if (declared > max) { req.resume(); return Promise.reject(filePolicy.coded(413, 'FILE_TOO_LARGE')); }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, failed = false;
    const fail = error => { if (!failed) { failed = true; reject(error); } };
    req.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > max) { fail(filePolicy.coded(413, 'FILE_TOO_LARGE')); chunks.length = 0; req.resume(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', fail);
  });
}

function safePath(root, storedName) {
  if (!/^[0-9a-f-]{36}\.[a-z0-9]{1,8}$/i.test(storedName)) throw filePolicy.coded(422, 'FILE_NAME_REJECTED');
  const base = path.resolve(root), full = path.resolve(base, storedName);
  if (!full.startsWith(base + path.sep)) throw filePolicy.coded(422, 'FILE_NAME_REJECTED');
  return full;
}

function createMaintenanceRouter({ pool, security, requestStorageDir }) {
  const root = requestStorageDir || path.join(process.cwd(), 'storage', 'request-files');
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

  const requestWriter = security.authorize('request.create');
  const workOrderWriter = security.authorize('work_order.create');

  router.get('/requests/wizard-drafts', requestWriter, send(async req => ({ data: await service.listWizardDrafts(pool, req.user, 'request') })));
  router.post('/requests/wizard-drafts', requestWriter, send(async req => ({ data: await service.createWizardDraft(pool, req.user, { ...(req.body || {}), wizardType:'request' }) })));
  router.get('/requests/wizard-drafts/:id', requestWriter, send(async req => ({ data: await service.getWizardDraft(pool, req.user, req.params.id, 'request') })));
  router.patch('/requests/wizard-drafts/:id', requestWriter, send(async req => ({ data: await service.updateWizardDraft(pool, req.user, req.params.id, req.body || {}, 'request') })));
  router.post('/requests/wizard-drafts/:id/cancel', requestWriter, send(async req => ({ data: await service.cancelWizardDraft(pool, req.user, req.params.id, req.body || {}, 'request') })));
  router.post('/requests/wizard-drafts/:id/submit', requestWriter, send(async req => ({ data: await service.submitWizardDraft(pool, req.user, req.params.id, req.body || {}, 'request') })));

  router.get('/work-orders/wizard-drafts', workOrderWriter, send(async req => ({ data: await service.listWizardDrafts(pool, req.user, 'work_order') })));
  router.post('/work-orders/wizard-drafts', workOrderWriter, send(async req => ({ data: await service.createWizardDraft(pool, req.user, { ...(req.body || {}), wizardType:'work_order' }) })));
  router.get('/work-orders/wizard-drafts/:id', workOrderWriter, send(async req => ({ data: await service.getWizardDraft(pool, req.user, req.params.id, 'work_order') })));
  router.patch('/work-orders/wizard-drafts/:id', workOrderWriter, send(async req => ({ data: await service.updateWizardDraft(pool, req.user, req.params.id, req.body || {}, 'work_order') })));
  router.post('/work-orders/wizard-drafts/:id/cancel', workOrderWriter, send(async req => ({ data: await service.cancelWizardDraft(pool, req.user, req.params.id, req.body || {}, 'work_order') })));
  router.get('/work-orders/technician-suggestions', workOrderWriter, security.authorize('equipment.view'), send(async req => ({
    data:await service.technicianSuggestions(pool, req.user, req.query.equipmentId, req.query.workOrderType || '')
  })));
  router.post('/work-orders/wizard-drafts/:id/submit', workOrderWriter, async (req, res) => {
    try {
      const draft = await service.getWizardDraft(pool, req.user, req.params.id, 'work_order');
      const requestId = draft.draft && draft.draft.answers && draft.draft.answers.requestId;
      if (requestId && requestId !== '__none__' && !await security.hasPermission(req.user, 'request.triage')) {
        return res.status(403).json({ error:'PERMISSION_DENIED', permission:'request.triage' });
      }
      res.json({ data:await service.submitWizardDraft(pool, req.user, req.params.id, req.body || {}, 'work_order') });
    } catch (error) {
      const status = error.status && error.status < 500 ? error.status : 500;
      if (status >= 500) console.error('maintenance api', error.code || 'db_error');
      res.status(status).json({ error:status < 500 ? (error.code || 'REQUEST_FAILED') : 'MAINTENANCE_REQUEST_FAILED' });
    }
  });

  router.post('/work-orders/:id/permit', security.authorize('work_order.edit'), send(async req => ({ data:await service.linkWorkOrderPermit(pool, req.user, req.params.id, req.body || {}) })));

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
  router.get('/requests/:id/attachments', security.authorize('request.view'), send(async req => ({ data:await service.listRequestFiles(pool, req.params.id) })));
  router.post('/requests/:id/attachments', requestWriter, async (req, res) => {
    let stored = null;
    try {
      const uploadToken = String(req.get('x-upload-token') || '').trim() || null;
      if (uploadToken && !/^[0-9a-f-]{36}$/i.test(uploadToken)) throw filePolicy.coded(422, 'UPLOAD_TOKEN_INVALID');
      if (uploadToken) {
        const existing = await service.getRequestFileByUploadToken(pool, req.user, req.params.id, uploadToken);
        if (existing) return res.json({ data:existing, alreadyUploaded:true });
      }
      let fileName = req.get('x-file-name') || '';
      try { fileName = decodeURIComponent(fileName); } catch (_) { throw filePolicy.coded(422, 'FILE_NAME_REJECTED'); }
      const buffer = await readBody(req, filePolicy.MAX_BYTES);
      const checked = filePolicy.validate({ name:fileName, buffer });
      const id = crypto.randomUUID();
      checked.id = id;
      checked.storedName = `${id}.${checked.ext}`;
      await fs.promises.mkdir(root, { recursive:true });
      stored = safePath(root, checked.storedName);
      await fs.promises.writeFile(stored, checked.buffer, { flag:'wx' });
      const data = await service.saveRequestFile(pool, req.user, req.params.id, checked, uploadToken);
      if (data.id !== id) { await fs.promises.unlink(stored).catch(() => {}); stored = null; }
      res.status(201).json({ data });
    } catch (error) {
      if (stored) await fs.promises.unlink(stored).catch(() => {});
      const status = error.status && error.status < 500 ? error.status : 500;
      if (status >= 500) console.error('request attachment upload', error.code || 'db_error');
      res.status(status).json({ error:status < 500 ? (error.code || 'REQUEST_FAILED') : 'REQUEST_ATTACHMENT_UPLOAD_FAILED' });
    }
  });
  router.get('/requests/:id/attachments/:fileId', security.authorize('request.view'), async (req, res) => {
    try {
      const row = await service.getRequestFile(pool, req.params.id, req.params.fileId);
      const full = safePath(root, row.stored_name);
      const inline = String(row.media_type || '').startsWith('image/');
      const ascii = String(row.original_name).replace(/[^\x20-\x7e]/g, '_') || 'file';
      res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      res.setHeader('Cache-Control','private, no-store');
      res.setHeader('Content-Type',row.media_type);
      res.setHeader('Content-Disposition',`${inline ? 'inline' : 'attachment'}; filename=\"${ascii}\"; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
      fs.createReadStream(full).on('error',() => { if (!res.headersSent) res.status(404).json({ error:'FILE_NOT_FOUND' }); }).pipe(res);
    } catch (error) {
      const status = error.status && error.status < 500 ? error.status : 500;
      if (!res.headersSent) res.status(status).json({ error:status < 500 ? (error.code || 'REQUEST_FAILED') : 'REQUEST_ATTACHMENT_READ_FAILED' });
    }
  });


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
