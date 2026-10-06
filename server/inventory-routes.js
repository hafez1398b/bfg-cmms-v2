'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const filePolicy = require('./file-policy');
const service = require('./inventory-service');

function readBody(req, max) {
  const declared = Number(req.get('content-length') || 0);
  if (declared > max) return Promise.reject(filePolicy.coded(413, 'FILE_TOO_LARGE'));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    const fail = error => { if (!failed) { failed = true; reject(error); } };
    req.on('data', chunk => {
      size += chunk.length;
      if (size > max) {
        fail(filePolicy.coded(413, 'FILE_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', fail);
  });
}

function safePath(root, storedName) {
  if (!/^[0-9a-f-]{36}\.[a-z0-9]{1,8}$/i.test(storedName)) throw filePolicy.coded(422, 'FILE_NAME_REJECTED');
  const base = path.resolve(root);
  const full = path.resolve(base, storedName);
  if (!full.startsWith(base + path.sep)) throw filePolicy.coded(422, 'FILE_NAME_REJECTED');
  return full;
}

function createInventoryRouter({ pool, security, storageDir }) {
  const root = storageDir || path.join(process.cwd(), 'storage', 'work-order-files');
  const router = require('express').Router();
  router.use(security.authenticateToken);

  function send(work) {
    return async (req, res) => {
      try {
        res.json(await work(req));
      } catch (error) {
        const status = error.status && error.status < 500 ? error.status : 500;
        if (status >= 500) console.error('inventory api', error.code || 'db_error');
        res.status(status).json({ error: status < 500 ? (error.code || 'REQUEST_FAILED') : 'INVENTORY_REQUEST_FAILED' });
      }
    };
  }

  router.get('/inventory/items/availability', security.authorize('inventory.view'), send(async () => ({ data:await service.listAvailableItems(pool) })));
  router.get('/items', security.authorize('inventory.view'), send(async () => ({ data: await service.listItems(pool) })));
  router.get('/items/:id', security.authorize('inventory.view'), send(async req => ({ data: await service.getItem(pool, req.params.id) })));
  router.post('/items', security.authorize('inventory.edit'), send(async req => ({ data: await service.createItem(pool, req.user, req.body || {}) })));
  router.patch('/items/:id', security.authorize('inventory.edit'), send(async req => ({ data: await service.updateItem(pool, req.user, req.params.id, req.body || {}) })));
  router.post('/items/:id/archive', security.authorize('inventory.archive'), send(async req => ({ data: await service.archiveItem(pool, req.user, req.params.id, req.body || {}) })));

  router.get('/warehouses', security.authorize('inventory.view'), send(async () => ({ data: await service.listWarehouses(pool) })));
  router.post('/warehouses', security.authorize('inventory.edit'), send(async req => ({ data: await service.createWarehouse(pool, req.user, req.body || {}) })));
  router.post('/warehouses/:id/locations', security.authorize('inventory.edit'), send(async req => ({ data: await service.createLocation(pool, req.user, req.params.id, req.body || {}) })));

  router.get('/inventory/ledger', security.authorize('inventory.view'), send(async req => ({ data: await service.listLedger(pool, req.query) })));
  router.post('/inventory/receipts', security.authorize('inventory.receive'), send(async req => ({ data: await service.receive(pool, req.user, req.body || {}) })));
  router.post('/inventory/issues', security.authorize('inventory.issue'), send(async req => ({ data: await service.issue(pool, req.user, req.body || {}) })));
  router.post('/inventory/reservations', security.authorize('inventory.reserve'), send(async req => ({ data: await service.reserve(pool, req.user, req.body || {}) })));
  router.post('/inventory/reservations/:id/release', security.authorize('inventory.reserve'), send(async req => ({ data: await service.releaseReservation(pool, req.user, req.params.id, req.body || {}) })));
  router.post('/inventory/consumptions', security.authorize('inventory.consume'), send(async req => ({ data: await service.consume(pool, req.user, req.body || {}) })));
  router.post('/inventory/returns', security.authorize('inventory.return'), send(async req => ({ data: await service.returnParts(pool, req.user, req.body || {}) })));

  router.get('/cost-entries', security.authorize('cost.view'), send(async req => ({ data: await service.listCosts(pool, req.query.workOrderId) })));
  router.get('/work-orders/:id/costs', security.authorize('work_order.view'), send(async req => ({ data: await service.listCosts(pool, req.params.id) })));
  router.post('/work-orders/:id/costs', security.authorize('cost.create'), send(async req => ({ data: await service.addCost(pool, req.user, req.params.id, req.body || {}) })));

  router.get('/work-orders/:id/attachments', security.authorize('work_order.view'), send(async req => ({ data: await service.listAttachments(pool, req.params.id) })));
  router.post('/work-orders/:id/attachments', security.authorize('work_order.attach'), async (req, res) => {
    let stored = null;
    try {
      const buffer = await readBody(req, filePolicy.MAX_BYTES);
      const checked = filePolicy.validate({ name: req.get('x-file-name') || '', buffer });
      const id = crypto.randomUUID();
      checked.id = id;
      checked.storedName = `${id}.${checked.ext}`;
      await fs.promises.mkdir(root, { recursive: true });
      stored = safePath(root, checked.storedName);
      await fs.promises.writeFile(stored, checked.buffer, { flag: 'wx' });
      const meta = await service.saveAttachment(pool, req.user, req.params.id, checked, req.get('x-file-phase'));
      res.status(201).json({ data: { id: meta.id, name: meta.name, mediaType: meta.mediaType, byteSize: meta.byteSize, sha256: meta.sha256, phase: meta.phase } });
    } catch (error) {
      if (stored) await fs.promises.unlink(stored).catch(() => {});
      const status = error.status && error.status < 500 ? error.status : 500;
      if (status >= 500) console.error('attachment upload', error.code || 'db_error');
      res.status(status).json({ error: status < 500 ? (error.code || 'REQUEST_FAILED') : 'ATTACHMENT_UPLOAD_FAILED' });
    }
  });
  router.get('/work-orders/:id/attachments/:fileId', security.authorize('work_order.view'), async (req, res) => {
    try {
      const row = await service.getAttachment(pool, req.params.id, req.params.fileId);
      const full = safePath(root, row.stored_name);
      const inline = String(row.media_type || '').startsWith('image/');
      const ascii = String(row.original_name).replace(/[^\x20-\x7e]/g, '_') || 'file';
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', row.media_type);
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
      fs.createReadStream(full).on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'FILE_NOT_FOUND' }); }).pipe(res);
    } catch (error) {
      const status = error.status && error.status < 500 ? error.status : 500;
      if (!res.headersSent) res.status(status).json({ error: status < 500 ? (error.code || 'REQUEST_FAILED') : 'ATTACHMENT_READ_FAILED' });
    }
  });

  router.post('/work-orders/:id/delivery-confirmation', security.authorize('work_order.confirm'), send(async req => ({ data: await service.confirmDelivery(pool, req.user, req.params.id, req.body || {}) })));
  return router;
}

module.exports = { createInventoryRouter, safePath };
