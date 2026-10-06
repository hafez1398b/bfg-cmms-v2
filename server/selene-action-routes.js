'use strict';

const { canEquipment } = require('./equipment-service');
const { applyControlledAction } = require('./equipment-commands');
const { createSeleneActions, pgRepository } = require('./selene-actions');

function sendError(res, error) {
  const status = error && error.status && error.status < 500 ? error.status : 500;
  if (status >= 500) console.error('selene action', error && error.code ? error.code : 'db_error');
  res.status(status).json({ error: status < 500 ? (error.code || 'REQUEST_FAILED') : 'SELENE_ACTION_FAILED' });
}

function createSeleneActionRouter({ pool, service, io }) {
  const actions = service || createSeleneActions({
    repository: pgRepository(pool),
    commands: { apply: applyControlledAction },
    authorize: (user, operation) => canEquipment(user, operation)
  });
  const router = require('express').Router();

  router.post('/drafts', async (req, res) => {
    try { res.status(201).json({ data: await actions.createDraft(req.user, req.body || {}) }); }
    catch (error) { sendError(res, error); }
  });
  router.get('/drafts/:id', async (req, res) => {
    try { res.json({ data: await actions.getDraft(req.user, req.params.id) }); }
    catch (error) { sendError(res, error); }
  });
  router.patch('/drafts/:id', async (req, res) => {
    try { res.json({ data: await actions.editDraft(req.user, req.params.id, req.body || {}) }); }
    catch (error) { sendError(res, error); }
  });
  router.post('/drafts/:id/confirm', async (req, res) => {
    try { res.status(201).json({ data: await actions.confirmDraft(req.user, req.params.id) }); }
    catch (error) { sendError(res, error); }
  });
  router.post('/drafts/:id/reject', async (req, res) => {
    try { res.json({ data: await actions.rejectDraft(req.user, req.params.id) }); }
    catch (error) { sendError(res, error); }
  });
  router.get('/drafts/:id/evidence', async (req, res) => {
    try { res.json({ data: await actions.evidenceOf(req.user, req.params.id) }); }
    catch (error) { sendError(res, error); }
  });
  router.post('/drafts/:id/execute', async (req, res) => {
    try {
      const result = await actions.executeDraft(req.user, req.params.id, req.body || {});
      if (result.committed && result.data) io?.emit('equipment-changed', { action: 'selene-save', id: result.data.id });
      res.json(result);
    } catch (error) { sendError(res, error); }
  });
  return router;
}

module.exports = { createSeleneActionRouter };
